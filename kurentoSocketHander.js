module.exports = function (io, streams, app) {
    var minimist = require('minimist');
    var clients = {};
    var reflected = [];
    const User = require('./models/user');
    var argv = minimist(process.argv.slice(2), {
        default: {
            as_uri: "https://localhost:6008/",
            ws_uri: "ws://184.72.115.87:8888/kurento"
        }
    });
    // var Friend = require('./model/friend');

    var kurento = require('kurento-client');

    /*
 * Definition of global variables.
 */

    var kurentoClient = null;
    var userRegistry = new UserRegistry();
    var pipelines = {};
    var candidatesQueue = {};
    var idCounter = 0;

    function nextUniqueId() {
        idCounter++;
        return idCounter.toString();
    }

    /*
 * Definition of helper classes
 */

// Represents caller and callee sessions
    function UserSession(id, name) {
        this.id = id;
        this.name = name;
        this.peer = null;
        this.sdpOffer = null;
    }

    UserSession.prototype.sendMessage = function (event, message) {
        io.to(this.id).emit(event, JSON.stringify(message));
    }

// Represents registrar of users
    function UserRegistry() {
        this.usersById = {};
        this.usersByName = {};
    }

    UserRegistry.prototype.register = function (user) {
        this.usersById[user.id] = user;
        this.usersByName[user.name] = user;
    }

    UserRegistry.prototype.unregister = function (id) {
        var user = this.getById(id);
        if (user) delete this.usersById[id]
        if (user && this.getByName(user.name)) delete this.usersByName[user.name];
    }

    UserRegistry.prototype.getById = function (id) {
        return this.usersById[id];
    }

    UserRegistry.prototype.getByName = function (name) {
        return this.usersByName[name];
    }

    UserRegistry.prototype.removeById = function (id) {
        var userSession = this.usersById[id];
        if (!userSession) return;
        delete this.usersById[id];
        delete this.usersByName[userSession.name];
    }

// Represents a B2B active call
    function CallMediaPipeline() {
        this.pipeline = null;
        this.webRtcEndpoint = {};
    }

    CallMediaPipeline.prototype.createPipeline = function (callerId, calleeId, callback) {
        var self = this;
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
                            var candidate = candidatesQueue[callerId].shift();
                            callerWebRtcEndpoint.addIceCandidate(candidate);
                        }
                    }

                    callerWebRtcEndpoint.on('OnIceCandidate', function (event) {
                        var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                        userRegistry.getById(callerId).sendMessage('iceCandidate', {
                            id: 'iceCandidate',
                            candidate: candidate
                        });
                    });

                    pipeline.create('WebRtcEndpoint', function (error, calleeWebRtcEndpoint) {
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }

                        if (candidatesQueue[calleeId]) {
                            while (candidatesQueue[calleeId].length) {
                                var candidate = candidatesQueue[calleeId].shift();
                                calleeWebRtcEndpoint.addIceCandidate(candidate);
                            }
                        }

                        calleeWebRtcEndpoint.on('OnIceCandidate', function (event) {
                            var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                            userRegistry.getById(calleeId).sendMessage('iceCandidate', {
                                id: 'iceCandidate',
                                candidate: candidate
                            });
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
    }

    CallMediaPipeline.prototype.generateSdpAnswer = function (id, sdpOffer, callback) {
        this.webRtcEndpoint[id].processOffer(sdpOffer, callback);
        this.webRtcEndpoint[id].gatherCandidates(function (error) {
            if (error) {
                return callback(error);
            }
        });
    }

    CallMediaPipeline.prototype.release = function () {
        if (this.pipeline) this.pipeline.release();
        this.pipeline = null;
    }

// Recover kurentoClient for the first time.
    function getKurentoClient(callback) {
        if (kurentoClient !== null) {
            return callback(null, kurentoClient);
        }

        kurento(argv.ws_uri, function (error, _kurentoClient) {
            if (error) {
                var message = 'Coult not find media server at address ' + argv.ws_uri;
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

        var pipeline = pipelines[sessionId];
        delete pipelines[sessionId];
        pipeline.release();
        var stopperUser = userRegistry.getById(sessionId);
        var stoppedUser = userRegistry.getByName(stopperUser.peer);
        stopperUser.peer = null;

        if (stoppedUser) {
            stoppedUser.peer = null;
            delete pipelines[stoppedUser.id];
            var message = {
                id: 'stopCommunication',
                message: 'remote user hanged out'
            }
            stoppedUser.sendMessage('stopCommunication', message);
        }
        clearCandidatesQueue(sessionId);
    }

    function incomingCallResponse(calleeId, from, callResponse, calleeSdp) {

        clearCandidatesQueue(calleeId);

        function onError(callerReason, calleeReason) {
            if (pipeline) pipeline.release();
            if (caller) {
                var callerMessage = {
                    id: 'callResponse',
                    response: 'rejected'
                }
                if (callerReason) callerMessage.message = callerReason;
                caller.sendMessage('callResponse', callerMessage);
            }

            var calleeMessage = {
                id: 'stopCommunication'
            };
            if (calleeReason) calleeMessage.message = calleeReason;
            callee.sendMessage('stopCommunication', calleeMessage);
        }

        var callee = userRegistry.getById(calleeId);
        if (!from || !userRegistry.getByName(from)) {
            return onError(null, 'unknown from = ' + from);
        }
        var caller = userRegistry.getByName(from);

        if (callResponse === 'accept') {
            var pipeline = new CallMediaPipeline();
            pipelines[caller.id] = pipeline;
            pipelines[callee.id] = pipeline;

            pipeline.createPipeline(caller.id, callee.id, function (error) {
                if (error) {
                    return onError(error, error);
                }

                pipeline.generateSdpAnswer(caller.id, caller.sdpOffer, function (error, callerSdpAnswer) {
                    if (error) {
                        return onError(error, error);
                    }

                    pipeline.generateSdpAnswer(callee.id, calleeSdp, function (error, calleeSdpAnswer) {
                        if (error) {
                            return onError(error, error);
                        }

                        var message = {
                            id: 'startCommunication',
                            sdpAnswer: calleeSdpAnswer
                        };
                        callee.sendMessage('startCommunication', message);

                        message = {
                            id: 'callResponse',
                            response: 'accepted',
                            sdpAnswer: callerSdpAnswer
                        };
                        caller.sendMessage('callResponse', message);
                    });
                });
            });
        } else {
            var decline = {
                id: 'callResponse',
                response: 'rejected',
                message: 'user declined'
            };
            caller.sendMessage('callResponse', decline);
        }
    }

    function call(callerId, to, from, sdpOffer) {
        clearCandidatesQueue(callerId);

        var caller = userRegistry.getById(callerId);
        var rejectCause = 'User ' + to + ' is not registered';
        if (userRegistry.getByName(to)) {
            var callee = userRegistry.getByName(to);
            caller.sdpOffer = sdpOffer;
            callee.peer = from;
            caller.peer = to;
            var message = {
                id: 'incomingCall',
                from: from
            };
            try {
                return callee.sendMessage('incomingCall', message);
            } catch (exception) {
                rejectCause = "Error " + exception;
            }
        }
        var message = {
            id: 'callResponse',
            response: 'rejected: ',
            message: rejectCause
        };
        caller.sendMessage('callResponse', message);
    }

    function register(id, name) {
        function onError(error) {
            io.to(id).emit(JSON.stringify({
                id: 'registerResponse',
                response: 'rejected ',
                message: error
            }));
        }

        if (!name) {
            return onError("empty user name");
        }

        if (userRegistry.getByName(name)) {
            console.log(userRegistry.getByName(name));
            return onError("User " + name + " is already registered");
        }

        userRegistry.register(new UserSession(id, name));
        try {
            io.to(id).emit(JSON.stringify({
                id: 'registerResponse',
                response: 'accepted'
            }));
            // ws.send(JSON.stringify({
            //     id: 'registerResponse',
            //     response: 'accepted'
            // }));
        } catch (exception) {
            onError(exception);
        }
    }

    function clearCandidatesQueue(sessionId) {
        if (candidatesQueue[sessionId]) {
            delete candidatesQueue[sessionId];
        }
    }

    function onIceCandidate(sessionId, _candidate) {
        var candidate = kurento.getComplexType('IceCandidate')(_candidate);
        var user = userRegistry.getById(sessionId);

        if (pipelines[user.id] && pipelines[user.id].webRtcEndpoint && pipelines[user.id].webRtcEndpoint[user.id]) {
            var webRtcEndpoint = pipelines[user.id].webRtcEndpoint[user.id];
            webRtcEndpoint.addIceCandidate(candidate);
        } else {
            if (!candidatesQueue[user.id]) {
                candidatesQueue[user.id] = [];
            }
            candidatesQueue[sessionId].push(candidate);
        }
    }


    io.on('connection', function (client) {
        console.log('-- ' + client.id + ' joined --');
        const sessionId = client.id;
        var text = "";
        var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

        for (var i = 0; i < 5; i++)
            text += possible.charAt(Math.floor(Math.random() * possible.length));

        if (clients.hasOwnProperty(text)) {
            var text = "";
            var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            for (var i = 0; i < 5; i++)
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
            reflected[text] = options.myId;
        });

        client.on('message', function (details) {
            var otherClient = io.sockets.connected[clients[details.to]];
            if (!otherClient) {
                return;
            }

            delete details.to;
            details.from = reflected[text];

            otherClient.emit('message', details);
        });

        client.on('startclient', function (details) {
            User.findOne({
                id: reflected[text]
            }, function (err, user) {
                if (user) {
                    var otherClient = io.sockets.connected[clients[details.to]];
                    details.from = reflected[text];
                    details.name = user.name;
                    otherClient.emit('receiveCall', details);
                } else {
                    var otherClient = io.sockets.connected[clients[details.to]];
                    details.from = reflected[text];
                    otherClient.emit('receiveCall', details);
                }

            });

        });

        client.on('ejectcall', function (details) {
            var otherClient = io.sockets.connected[clients[details.callerId]];
            otherClient.emit("ejectcall");
            console.log('--------------------------------------dasdas-------------------------');
        });

        client.on('removecall', function (details) {
            console.log('--------------------------------------dasdas-------------------------');
            var otherClient = io.sockets.connected[clients[details.callerId]];
            otherClient.emit("removecall");
        });

        // client.on('removevideo', function (details) {
        //   var otherClient = io.sockets.connected[clients[details.other]];
        //   otherClient.emit("removevideo");

        // });

        client.on('acceptcall', function (details) {

            var otherClient = io.sockets.connected[clients[details.callerId]];
            otherClient.emit("acceptcall", details);

        });

        client.on('chat', function (options) {
            var otherClient = io.sockets.connected[clients[options.to]];
            otherClient.emit('chat', options);
        });

        // TODO Kurento

        client.on('register', function (message) {
            console.log('register');
            register(sessionId, message.name);
        });

        client.on('call', function (message) {
            console.log('call');
            call(sessionId, message.to, message.from, message.sdpOffer);
        });

        client.on('incomingCallResponse', function (message) {
            incomingCallResponse(sessionId, message.from, message.callResponse, message.sdpOffer);
        });

        client.on('stop', function (message) {
            stop(sessionId);
        });

        client.on('onIceCandidate', function (message) {
            onIceCandidate(sessionId, message.candidate);
        });


        function leave() {
            console.log('-- ' + client.id + ' left --');
            userRegistry.unregister(client.id);
            streams.removeStream(client.id);
        }


        client.on('disconnect', leave);
        client.on('leave', leave);
    });

    var getStatus = function (req, res) {
        var clientid = clients[req.params.id];
        //console.log("lien minh get user statys"+clientid+ " "+req.params.id);
        if (io.sockets.connected[clientid] != undefined) {
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
};