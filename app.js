var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var path = require('path');
var	streams = require('./streams.js')();

var favicon = require('serve-favicon');
var	logger = require('morgan');
var	methodOverride = require('method-override');
var	bodyParser = require('body-parser');
var	errorHandler = require('errorhandler');

require('./config/config');

var indexRouter = require('./routes/index');
// var usersRouter = require('./routes/users');

var app = express();

app.set('view engine', 'html');
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use(favicon(__dirname + '/public/images/favicon.ico'));
app.use(logger('dev'));
app.use(methodOverride());
app.set('view engine', 'html');

// development only
if ('development' == app.get('env')) {
    app.use(errorHandler());
}


app.use('/', indexRouter);

const models = require('./models');

require('./routes/routes.js')(app, streams);

module.exports = app;
