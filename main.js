var version = "1.5.0";

const fs = require('fs');
const path = require('path');

var udp = require('dgram');
var udpserver = null;//udp.createSocket('udp4');;
var udp_ready = false;

var network = require('network');
var nwint_ready = false;
var config;

var express = require("express");
const bodyParser = require("body-parser");
const router = express.Router();
var app = express();
//Hyperion doesn't set a content-type head on PUT requests, so we insert it.
app.use((req, res, next) => {
  req.headers['content-type'] = 'application/json';
  next();
});
app.use(express.json());
app.use('/', router);
var webserver = null;
var webserver_ready = false

var WebSocketClient = require('websocket').client;
var wclient = null;//new WebSocketClient();
var globalconnection;
var webs_ready = false;
var webs_id = 0;

var events = require("events");
var em = null;

var States = {
  RUNNING: 0,
  STARTED: 1,
  SHUTDOWN: 3,
  NONE: 4
}

var current_state = States.NONE;

Array.prototype.equals = function(array) {
  if(this.length == array.length) {
    for(var i = 0; i < this.length; i++) {
      if(this[i] != array[i]) {
        return false;
      }
    }
    return true;
  }
  return false;
}

getBrightness = (color) => {
  var ret = [];
  var bc = config.brightness_calcs[config.brightness_calc];
  if(bc.maj) {
    if(bc.maj == "sqrt") {
      if(bc.min) {
        var r = eval(`(${color[0]} * ${bc.r})${bc.min}`);
        var g = eval(`(${color[1]} * ${bc.g})${bc.min}`);
        var b = eval(`(${color[2]} * ${bc.b})${bc.min}`);
        if(config.debug) console.log(`Color derived brightness: r: ${r}, g:${g}, b:${b}`);
        ret = Math.sqrt(r + g + b);
      }
      else {
        ret = Math.sqrt((color[0] * bc.r) + color[1] * bc.g + color[2] * b);
      }
    }
    else if(bc.maj == "avg") {
      ret = ((color[0] + color[1] + color[2]) / 3);
    }
  }
  else {
    ret = ((color[0] * bc.r) + color[1] * bc.g + (color[2] * bc.b));
  }
  return ret;
}

getHSFromRGB = (rgb) => {
  if(config.debug) console.log(`RGB In: ${JSON.stringify(rgb)}`);
  var out = { hue: 0, sat: 0};
  var r = rgb[0];
  var g = rgb[1];
  var b = rgb[2];
  var M = Math.max(r, g, b);
  var m = Math.min(r, g, b);
  var d = (M - m) / 255;
  var L = ((1/2) * (M + m)) / 255
  
  if(L > 0) {
    out.sat = 100 * (d / (1 - Math.abs((2 * L) - 1)));
  }
  if(L == 0) {
    out.sat = 0;
  }
  
  var commondeg = Math.acos((r - ((1/2) * g) - ((1/2) * b)) / Math.sqrt(Math.pow(r, 2) + Math.pow(g, 2) + Math.pow(b, 2) - (r * g) - (r * b) - (g * b))) * (180 / Math.PI);
  if(g >= b) {
    out.hue = commondeg
  }
  if(b > g) {
    out.hue = 360 - commondeg;
  }
  if(config.debug) console.log(`HS out: ${JSON.stringify(out)}`);
  return out;
};

getWebsCommand = (color, light, brightness, enable, id, type) => {
  var cmdtemplate = {
    "id": id,
    "type": "call_service",
    "domain": "light",
    "service": enable ? "turn_on" : "turn_off",
    "service_data": {
      "brightness": brightness
    },
    "target": {
      "entity_id": light
    }
  };
  if(type == 'hs') {
    var hs = getHSFromRGB(color)
    color = [hs.hue, hs.sat];
  }
  else if(type != "rgb") {
    color.push(0);
    color.push(0);
  }
  cmdtemplate.service_data[`${type}_color`] = color;
  var ret = JSON.stringify(cmdtemplate);
  if(config.debug) {
    if(config.debug) console.log("Brightness:", brightness);
    console.log(`WEBS Command: "${ret}"`);
  }
  return ret;
}

checkready = () => {
  if(udp_ready && webs_ready && webserver_ready && nwint_ready) {
    module.exports.running_state = States.RUNNING;
    console.log("All services ready.");
    sendEvent("allready", config.debug);
  }
}

sendEvent = (ev, data) => {
  em.emit(ev, data);
} 

//WLED JSON Webserver
bindWebserver = () => {
  router.put('/json/state', (req, res) => {
    if(config.debug) console.log("Hyperion HTTP:", JSON.stringify(req.body));
    console.log("Hyperion HTTP: LED State:", JSON.stringify(req.body.on));

    var stateconfig_file = path.join("..", "config.json");
    var config_string = fs.readFileSync(stateconfig_file);
    stateconfig = JSON.parse(config_string);
    stateconfig.xres.state.on = req.body.on;
    fs.writeFileSync(stateconfig_file, JSON.stringify(stateconfig));

    config.xres.state.on = req.body.on;
    config.xres.info.live = req.body.live;
    if(!config.xres.state.on && webs_ready) {
      for(var d = 0; d < config.devices.length; d++) {
        var device = config.devices[d];
        device.color = [0,0,0];
        device.brightness = getBrightness(device.color);
        var webscmd = getWebsCommand(device.color, device.entity, device.brightness, false, webs_id++, device.rgbplus);
        globalconnection.send(webscmd);
      }
    }
    res.send(JSON.stringify(config.xres));
  });
  
  router.get('/json',(req, res) => {
    console.log(`Hyperion config request received. ${JSON.stringify(config.xres.info)}`);
    res.send(JSON.stringify(config.xres));
  });
}

//Hyperion "WLED" UDP Server
bindUDPserver = () => {
  udpserver.on("message", (msg, info) => {
    if(config.xres.state.on && webs_ready) {
      for(var d = 0; d < config.devices.length; d++) {
        var color = [];
        var device = config.devices[d];
        var id = device.id;
        for(var i = id * 3; i < ((id * 3) + 3); i++) {
          color.push(msg[i]);
        }
        
        if(!device.color.equals(color)) {
          webs_id++
          device.color = color;
          device.brightness = getBrightness(device.color);
          if(device.bm > 0) {
            device.brightness *= device.bm;
          }

          if(config.debug) console.log(`Updating from Hyperion LED ID ${id}'s color, Entity: ${device.entity}, WSID: ${webs_id}, Color: ${device.color}, Brightness: ${device.brightness}, Colormode: ${device.colormode}`);
          
          var webscmd = getWebsCommand(device.color, device.entity, device.brightness, true, webs_id, device.colormode);
          globalconnection.send(webscmd);
          if(config.debug) {
            sendEvent("entitydata", {devices: config.devices})
          }
        }
      }
    }
  });

  udpserver.on("listening", () => {
    console.log("Hyperion UDP Server Listening...");
    udp_ready = true;
    checkready();
  });
  udpserver.on('error', (err) => {
    console.log(`Hyperion UDP server error:\n${err.stack}`);
    udpserver.close();
  });
}


//HASS Websocket Control
bindWebsocketClient = () => {
  wclient.on("connect", (connection) => {
    console.log("HASS Websocket Connected.");
    if(connection) {
      connection.on("message", (msg) => {
        var message = JSON.parse(msg.utf8Data);
        var rmsg;
        //if(config.debug) console.log(`WEBS MESSAGE:`, message);
        if(message.type == "auth_required") {
          console.log("HASS Websocket Auth requested...");
          rmsg = JSON.stringify({
            "type": "auth",
            "access_token": config.hass.token
          });
          connection.send(rmsg)
        }
        if(message.type == "auth_ok") {
          console.log("HASS Websocket Auth Completed");
          webs_ready = true;
          globalconnection = connection;
          checkready();
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
}

getNetworkInterface = () => {
  setNetworkInfo = (interface) => {
    config.xres.info.mac = interface.mac_address.replace(/:/g,'').toLowerCase();
    config.xres.info.ip = interface.ip_address;
    console.log(`Using interface ${interface.name}, ${interface.ip_address}`);
    nwint_ready = true;
    checkready();
  };
  network.get_interfaces_list((err, list) => {
    var found = false;
    if(!err) {
      for(var i = 0; i < list.length; i++) {
        var interface = list[i];
        if(interface.status == 'active') {
          setNetworkInfo(interface);
          found = true;
          break;
        }
      }
      if(!found) {
        setNetworkInfo(list[0]);
        found = true;
      }
    }
    if(!found) {
      console.log("No active network interfaces found!");
    }
  });
}

main = () => {
  module.exports.running_state = States.STARTED;
  //config = require('./config.js');
  var config_string = fs.readFileSync(path.join("..", "config.json"));
  config = JSON.parse(config_string);
  config.xres.info.leds.count = config.devices.length;
  getNetworkInterface();
  if(!em) {
    em = new events.EventEmitter();
    module.exports.events = em;
  }

    if(!webserver) {
    bindWebserver();
    webserver = app.listen(config.rest_port, () => {
      console.log(`WLED JSON Server running on port ${config.rest_port}`);
      webserver_ready = true;
      checkready();
    });
  }

  if(!udpserver) {
    udpserver = udp.createSocket('udp4');
  }
  bindUDPserver();
  udpserver.bind(config.xres.info.udpport);

  if(!wclient) {
    wclient = new WebSocketClient();
  }
  if(config.hass.token) {
    bindWebsocketClient();
  }
  wclient.connect(`ws://${config.hass.host}/api/websocket`);

  console.log(`Version: ${version}`);
  console.log("Hyperion HTTP: LED State:", JSON.stringify(config.xres.state.on));
}

shutdown = () => {
  if(webserver) {
    console.log("Shutting down WLED Webserver...");
    webserver.close();
    webserver = null;
  }
  if(udpserver) {
    console.log("Shutting down WLED UDP Server...");
    udpserver.close();
    udpserver = null;
  }
  if(globalconnection) {
    console.log("Shutting down HASS Websocket...");
    globalconnection.close();
  }
  wclient = null;
  config = null;
  udp_ready = false;
  webs_ready = false;
  webserver_ready = false;
  nwint_ready = false;
  module.exports.running_state = States.SHUTDOWN;
  sendEvent("shutdown_complete", null);
}

restart = () => {
  if(em) {
    var restart_complete = false;
    var arcb;

    var sdcb = (data) => {
      if(!restart_complete) {
        restart_complete = true;
        if(arcb) {
          em.removeListener("allready", arcb);
        }
        main();
      }
    }
    em.on("shutdown_complete", sdcb);

    if(module.exports.running_state == States.STARTED ||
      module.exports.running_state == States.RUNNING) {
      shutdown();
    }
    else {
      arcb = (data) => {
        shutdown();
      }
      em.on("allready", arcb);
    }
  }
}

getDevices = () => {
  return { devices: config.devices };
};

module.exports = { 
  main: main, 
  shutdown: shutdown,
  events: null,
  restart: restart,
  running_state: States.SHUTDOWN,
  getDevices: getDevices,
  States: States
};