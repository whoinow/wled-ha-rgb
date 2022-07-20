
var express = require("express");
const bodyParser = require("body-parser");
const router = express.Router();
var app = express();
const fs = require('fs');
const path = require('path');
//const { config } = require("process");
var wled_ha_rgb = require(path.join("..", "main.js"));

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

router.get('/', (req, res) => {
    var wp = fs.readFileSync('index.html').toString();
    
    res.send(wp);
});

router.get('/client.js', (req, res) => {
    res.sendFile('client.js', {root: '.'});
});

var config = {};
var restport = 3299;

var WebSocketClient = require('websocket').client;
var WebSocketServer = require('websocket').server;
var wclient = new WebSocketClient();
var wserver = new WebSocketServer();
var wserver_started = false;
var wshttpserver = null;

var globalconnectionc;
var globalconnections;
var webs_id = 0;

router.post('/setconfig', (req, res) => {
    var config_path = path.join("..", "config.json");
    if(!fs.existsSync(config_path)) {
        fs.copyFileSync(path.join("..", "config_template.json"), config_path);
    }
    var config_string = fs.readFileSync(config_path);
    var config = JSON.parse(config_string);
    config.devices =  req.body.devices;
    config.hass =  req.body.hass;
    config.brightness_calc =  req.body.brightness_calc;
    config.debug =  req.body.debug;
    config.rest_port =  req.body.rest_port;
    var set_config_string = JSON.stringify(config);
    fs.writeFileSync(config_path, set_config_string);

       
    
    if(wled_ha_rgb.running_state == wled_ha_rgb.States.RUNNING || 
        wled_ha_rgb.running_state == wled_ha_rgb.States.STARTED) {
        wled_ha_rgb.restart();
    }
    else {
        wled_ha_rgb.main();
    }
    wled_ha_rgb.events.removeAllListeners();
    wled_ha_rgb.events.on("allready", (data) => {
        res.send("Server restarted with new config!");
        startWSServer(data); 
    });
});

router.get('/getconfig', (req, res) => {
    res.send(getConfig());
});

router.post('/getentities', (req, res) => {
    config.hass = req.body;
    getEntities(res);
});

app.use('/', router);

app.listen(restport, () => {
    console.log(`Server running on port ${restport}`);
});

getConfig = () => {
    var config_path = path.join("..", "config.json");
    if(!fs.existsSync(config_path)) {
        fs.copyFileSync(path.join("..", "config_template.json"), config_path);
    }
    var config_string = fs.readFileSync(config_path);
    config = JSON.parse(config_string);
    return config_string;
}

getEntities = (res) => {
    if(config.hass && config.hass.token) {
        wclient.on("connect", (connection) => {
            console.log("HASS Websocket Connected for Entity list retrieval.");
            if(connection) {
                connection.on("message", (msg) => {
                    var message = JSON.parse(msg.utf8Data);
                    var rmsg;
                    //if(config.debug) console.log(`WEBS MESSAGE:`, message);
                    if(message.type == "auth_required") {
                        console.log("Server: HASS Websocket Auth requested...");
                        rmsg = JSON.stringify({
                            "type": "auth",
                            "access_token": config.hass.token
                        });
                        connection.send(rmsg);
                    }
                    if(message.type == "auth_ok") {
                        console.log("Server: HASS Websocket Auth Completed");
                        webs_ready = true;
                        globalconnectionc = connection;
                        var req = JSON.stringify({
                            id: ++webs_id,
                            type: "get_states"
                        });
                        connection.send(req);
                    }
                    if(message.type == "result" && message.success) {
                        console.log("Server: HASS Websocket Entities Retrieved, populating and sending list...");
                        var entities = [];
                        message.result.forEach(function(k, v) {
                            if(k.entity_id && k.entity_id.indexOf("light") > -1 && 
                            k.state != "unavailable" &&
                            (k.attributes.color_mode == 'rgb' || 
                            (k.attributes.supported_color_modes && k.attributes.supported_color_modes.indexOf("rgb") > -1)))
                            {
                                entities.push({friendly_name:k.attributes.friendly_name, entity: k.entity_id});
                            }
                        });
                        res.send(JSON.stringify(entities));
                        connection.removeAllListeners();
                        connection.close();
                        wclient.removeAllListeners();
                        wclient.abort();
                    }
                });
            }
        });

        wclient.on("error", (err) => {
            console.log(`HASS Websocket ERRER: ${JSON.stringify(err)}`);
        });

        wclient.on('connectFailed', (error) => {
            console.log('Connect Error: ' + error.toString());
        });
        wclient.connect(`ws://${config.hass.host}/api/websocket`);
    }
    else {
        res.send(JSON.stringify([]));
    }
}

startWSServer = (start) => {
    entityDataCB = (data) => {
        if(globalconnections) {
            globalconnections.sendUTF(JSON.stringify(data));
        }
    }
    if(start && !wserver_started) {
        wserver_started = true;
        var http = require('http');

        wshttpserver = http.createServer(function(request, response) {
            console.log((new Date()) + ' Received request for ' + request.url);
            response.writeHead(404);
            response.end();
        });
        wshttpserver.listen(3298, function() {
            console.log("Debug Websocket Server started on port 3298");
        });

        wserver.mount({httpServer: wshttpserver, autoAcceptConnections: true});

        wserver.on("error", function(err) {
            console.log(err);
        });
        
        wserver.on("connect", function(connection) {
            
            connection.on('message', function(message) {
                console.log(message);
                
            });
            connection.sendUTF(JSON.stringify(wled_ha_rgb.getDevices()));
            wled_ha_rgb.events.on("entitydata", entityDataCB);
            
            globalconnections = connection;
        });
        wserver.on("close", function(e) {
            wled_ha_rgb.events.removeListener("entitydata", entityDataCB);
        });
        wserver.on('request', function(request) {
            var connection = request.accept('echo-protocol', request.origin);
            console.log((new Date()) + ' Connection accepted.');
            connection.on('message', function(message) {
                console.log(message);
            });
        });
    }
    else {
        if(wserver && wshttpserver) {
            wserver_started = false;
            wserver.removeAllListeners();
            wserver.unmount();
            wserver.shutDown();
            if(globalconnections) {
                globalconnections.removeAllListeners();
                globalconnections.close();
            }
            wserver.closeAllConnections();
            wshttpserver.close();
        }
    }
}
getConfig();
wled_ha_rgb.main();
startWSServer(config.debug);

