module.exports = function (io, streams, app) {
    const clients = {};
    const reflected = [];
    const User = require('./models/user');
    // const Friend = require('./models/friend');
    const kurento = require('kurento-client');

    // Kurento client
    /// TODO Kurento client
    let kurentoClient = null;
    let pipelines = {};
    let candidatesQueue = {};
    let idCounter = 0;

    function nextUniqueId() {
        idCounter++;
        return idCounter.toString();
    }

    CallMediaPipeline.prototype.createPipeline = function (callerId, calleeId, callback) {
        let self = this;
        getKurentoClient(function (error, kurentoClient) {
            if (error) {
                return callback(error);
            }

            kurentoClient.create('MediaPipeline', function (error, pipeline) {
                if (error) {
                    return callback(error);
                }

                pipeline.create('WebRtcEndpoint', function (error, callerWebRtcEndpoint) {
                    if (error) {
                        pipeline.release();
                        return callback(error);
                    }

                    if (candidatesQueue[callerId]) {
                        while (candidatesQueue[callerId].length) {
                            let candidate = candidatesQueue[callerId].shift();
                            callerWebRtcEndpoint.addIceCandidate(candidate);
                        }
                    }

                    callerWebRtcEndpoint.on('OnIceCandidate', function (event) {
                        let candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                        const otherClient = io.sockets.connected[clients[callerId]];
                        io.to(clients[callerId]).emit('iceCandidate', JSON.stringify({
                            id: 'iceCandidate',
                            candidate: candidate
                        }));
                    });

                    pipeline.create('WebRtcEndpoint', function (error, calleeWebRtcEndpoint) {
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }

                        if (candidatesQueue[calleeId]) {
                            while (candidatesQueue[calleeId].length) {
                                let candidate = candidatesQueue[calleeId].shift();
                                calleeWebRtcEndpoint.addIceCandidate(candidate);
                            }
                        }

                        calleeWebRtcEndpoint.on('OnIceCandidate', function (event) {
                            let candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                            // const otherClient = io.sockets.connected[clients[calleeId]];
                            io.to(clients[calleeId]).emit('iceCandidate', JSON.stringify({
                                id: 'iceCandidate',
                                candidate: candidate
                            }));
                        });

                        callerWebRtcEndpoint.connect(calleeWebRtcEndpoint, function (error) {
                            if (error) {
                                pipeline.release();
                                return callback(error);
                            }

                            calleeWebRtcEndpoint.connect(callerWebRtcEndpoint, function (error) {
                                if (error) {
                                    pipeline.release();
                                    return callback(error);
                                }
                            });

                            self.pipeline = pipeline;
                            self.webRtcEndpoint[callerId] = callerWebRtcEndpoint;
                            self.webRtcEndpoint[calleeId] = calleeWebRtcEndpoint;
                            callback(null);
                        });
                    });
                });
            });
        })
    };

    CallMediaPipeline.prototype.generateSdpAnswer = function (id, sdpOffer, callback) {
        this.webRtcEndpoint[id].processOffer(sdpOffer, callback);
        this.webRtcEndpoint[id].gatherCandidates(function (error) {
            if (error) {
                return callback(error);
            }
        });
    };

    CallMediaPipeline.prototype.release = function () {
        if (this.pipeline) this.pipeline.release();
        this.pipeline = null;
    };


    // Represents a B2B active call
    function CallMediaPipeline() {
        this.pipeline = null;
        this.webRtcEndpoint = {};
    }


    // Recover kurentoClient for the first time.
    function getKurentoClient(callback) {
        if (kurentoClient !== null) {
            return callback(null, kurentoClient);
        }

        kurento(argv.ws_uri, function (error, _kurentoClient) {
            if (error) {
                let message = 'Coult not find media server at address ' + argv.ws_uri;
                return callback(message + ". Exiting with error " + error);
            }

            kurentoClient = _kurentoClient;
            callback(null, kurentoClient);
        });
    }

    function stop(sessionId) {
        if (!pipelines[sessionId]) {
            return;
        }

        let pipeline = pipelines[sessionId];
        delete pipelines[sessionId];
        pipeline.release();
        let stoppedUser = io.sockets.connected[sessionId];

        if (stoppedUser) {
            stoppedUser.peer = null;
            delete pipelines[stoppedUser.id];
            let message = {
                id: 'stopCommunication',
                message: 'remote user hanged out'
            };
            stoppedUser.emit('stopCommunication', message);
        }

        clearCandidatesQueue(sessionId);
    }

    function incomingCallResponse(calleeId, from, to, callResponse, calleeSdp) {
        console.log('incomingCallResponse');
        clearCandidatesQueue(calleeId);

        function onError(callerReason, calleeReason) {
            if (pipeline) pipeline.release();
            if (caller) {
                let callerMessage = {
                    id: 'callResponse',
                    response: 'rejected'
                };
                if (callerReason) callerMessage.message = callerReason;
                io.to(clients[from]).emit('ejectcall',callerMessage);
            }

            let calleeMessage = {
                id: 'stopCommunication'
            };
            if (calleeReason) calleeMessage.message = calleeReason;
            io.to(clients[to]).emit('stopCommunication', calleeMessage);
        }

        // let callee = userRegistry.getById(calleeId);
        if (!from) {
            return onError(null, 'unknown from = ' + from);
        }
        // let caller = userRegistry.getByName(from);

        if (callResponse === 'accept') {
            let pipeline = new CallMediaPipeline();
            pipelines[from] = pipeline;
            pipelines[to] = pipeline;

            pipeline.createPipeline(from, to, function (error) {
                if (error) {
                    return onError(error, error);
                }

                pipeline.generateSdpAnswer(from, to, function (error, callerSdpAnswer) {
                    if (error) {
                        return onError(error, error);
                    }

                    pipeline.generateSdpAnswer(to, calleeSdp, function (error, calleeSdpAnswer) {
                        if (error) {
                            return onError(error, error);
                        }

                        let message = {
                            id: 'startCommunication',
                            sdpAnswer: calleeSdpAnswer
                        };
                        let calleeClient = io.sockets.connected[clients[to]];
                        calleeClient.emit('startCommunication', message);

                        message = {
                            id: 'callResponse',
                            response: 'accepted',
                            sdpAnswer: callerSdpAnswer
                        };
                        let callerClient = io.sockets.connected[clients[from]];
                        callerClient.emit('acceptcall', message);
                    });
                });
            });
        } else {
            let decline = {
                id: 'callResponse',
                response: 'rejected',
                message: 'user declined'
            };
            let callerClient = io.sockets.connected[clients[from]];
            callerClient.emit('ejectcall', decline);
        }
    }

    function call(callerId, to, from, sdpOffer) {
        clearCandidatesQueue(callerId);

        // let caller = userRegistry.getById(callerId);
        let rejectCause = 'User ' + to + ' is not registered';
        if (to) {
            // let callee = userRegistry.getByName(to);
            // caller.sdpOffer = sdpOffer;
            // callee.peer = from;
            // caller.peer = to;
            let message = {
                id: 'incomingCall',
                from: from
            };
            try {
                return io.to(clients[to]).emit('incomingCall', message);
            } catch (exception) {
                rejectCause = "Error " + exception;
            }
        }
        let message = {
            id: 'callResponse',
            response: 'rejected: ',
            message: rejectCause
        };
        io.to(clients[from]).emit('ejectcall', message);
    }

    function clearCandidatesQueue(sessionId) {
        let user = getKeyByValue(clients, sessionId);
        if (candidatesQueue[user]) {
            delete candidatesQueue[user];
        }
    }

    function onIceCandidate(sessionId, _candidate) {
        let candidate = kurento.getComplexType('IceCandidate')(_candidate);
        let user = getKeyByValue(clients, sessionId);

        if (pipelines[user] && pipelines[user].webRtcEndpoint && pipelines[user].webRtcEndpoint[user]) {
            let webRtcEndpoint = pipelines[user].webRtcEndpoint[user];
            webRtcEndpoint.addIceCandidate(candidate);
        } else {
            if (!candidatesQueue[user]) {
                candidatesQueue[user] = [];
            }
            candidatesQueue[user].push(candidate);
        }
    }

    io.on('connection', function (client) {
        console.log('-- ' + client.id + ' joined --');
        const sessionId = client.id;
        let text = "";
        let possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

        for (let i = 0; i < 5; i++)
            text += possible.charAt(Math.floor(Math.random() * possible.length));

        if (clients.hasOwnProperty(text)) {
            let text = "";
            let possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            for (let i = 0; i < 5; i++)
                text += possible.charAt(Math.floor(Math.random() * possible.length));
            //clients[text] = client.id;
        } else {
            //clients[text] = client.id;
        }

        client.on('readyToStream', function (options) {
            console.log('-- ' + client.id + ' is ready to stream --');
            streams.addStream(client.id, options.name);
        });

        client.on('update', function (options) {
            streams.update(client.id, options.name);
        });

        client.on('resetId', function (options) {
            clients[options.myId] = client.id;
            client.emit('id', options.myId);
            console.log('resetId');
            console.log(options.myId);
            reflected[text] = options.myId;
        });

        client.on('message', function (details) {
            console.log('onMessage');
            let otherClient = io.sockets.connected[clients[details.to]];
            if (!otherClient) {
                return;
            }

            delete details.to;
            details.from = reflected[text];

            otherClient.emit('message', details);
        });

        client.on('startclient', function (details) {
            console.log("detail");
            console.log(details);
            console.log(reflected);
            User.findOne({
                id: reflected[text]
            }, function (err, user) {
                if (user) {
                    let otherClient = io.sockets.connected[clients[details.to]];
                    details.from = reflected[text];
                    details.name = user.name;
                    console.log(details);
                    otherClient.emit('receiveCall', details);
                } else {
                    let otherClient = io.sockets.connected[clients[details.to]];
                    details.from = reflected[text];
                    console.log(details);
                    otherClient.emit('receiveCall', details);
                }

            });

        });

        client.on('ejectcall', function (details) {
            let otherClient = io.sockets.connected[clients[details.callerId]];
            otherClient.emit("ejectcall");
            console.log('--------------------------------------dasdas-------------------------');
        });

        client.on('removecall', function (details) {
            console.log('--------------------------------------dasdas-------------------------');
            let otherClient = io.sockets.connected[clients[details.callerId]];
            otherClient.emit("removecall");
        });

        // client.on('removevideo', function (details) {
        //   let otherClient = io.sockets.connected[clients[details.other]];
        //   otherClient.emit("removevideo");

        // });

        client.on('acceptcall', function (details) {
            console.log('acceptcall');
            let otherClient = io.sockets.connected[clients[details.callerId]];
            otherClient.emit("acceptcall", details);

        });

        client.on('onIceCandidate', function (details) {
            onIceCandidate(sessionId, details.candidate);

        });

        client.on('chat', function (options) {
            let otherClient = io.sockets.connected[clients[options.to]];
            otherClient.emit('chat', options);
        });

        client.on('call', function (message) {
            call(sessionId, message.to, message.from, message.sdpOffer);
        });

        client.on('incomingCallResponse', function (message) {
            console.log('incomingCallResponse');
            console.log(message);
            incomingCallResponse(sessionId, message.from, message.callResponse, message.sdpOffer);
        });

        client.on('stop', function (message) {
            stop(sessionId);
        });

        function leave() {
            console.log('-- ' + client.id + ' left --');
            streams.removeStream(client.id);
        }

        client.on('disconnect', leave);
        client.on('leave', leave);
    });

    let getStatus = function (req, res) {
        let clientid = clients[req.params.id];
        //console.log("lien minh get user statys"+clientid+ " "+req.params.id);
        if (io.sockets.connected[clientid]) {
            res.send({
                status: 1
            });
        } else {
            res.send({
                status: -1
            });
        }
    };

    app.get('/status/:id', getStatus);

    function getKeyByValue(object, value) {
        return Object.keys(object).find(key => object[key] === value);
    }
};