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

var all_ready = false;

var events = require("events");
var em = null;

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

getWebsCommand = (color, light, brightness, enable, id) => {
  var ret = JSON.stringify({
    "id": id,
    "type": "call_service",
    "domain": "light",
    "service": enable ? "turn_on" : "turn_off",
    "service_data": {
      "rgb_color": color,
      //"brightness": (color[0] + color[1] + color[2]) / 3
      "brightness": brightness
    },
    "target": {
      "entity_id": light
    }
  });
  if(config.debug) {
    if(config.debug) console.log("Brightness:", brightness);
    console.log(`WEBS Command: "${ret}"`);
  }
  return ret;
}

checkready = () => {
  if(udp_ready && webs_ready && webserver_ready && nwint_ready) {
    all_ready = true;
    module.exports.running = true;
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
        config.devices[d].color = [0,0,0];
        config.devices[d].brightness = getBrightness(config.devices[d].color);
        var webscmd = getWebsCommand(config.devices[d].color, config.devices[d].entity, config.devices[d].brightness, false, webs_id++);
        globalconnection.send(webscmd);
      }
    }
    res.send(JSON.stringify(config.xres));
  });
}

//Hyperion "WLED" UDP Server
bindUDPserver = () => {
  udpserver.on("message", (msg, info) => {
    if(config.xres.state.on && webs_ready && config.devices.length <= msg.length / 3) {
      var start = 0;
      for(var d = 0; d < config.devices.length; d++) {
        var color = [];
        var end = start + 3;
        for(i = start; i < end; i++) {
          color.push(msg[i]);
        }
        if(!config.devices[d].color.equals(color)) {
          webs_id++
          config.devices[d].color = color;
          config.devices[d].brightness = getBrightness(config.devices[d].color);
          if(config.debug) console.log(`Updating ID ${d}'s color, ID: ${webs_id}, Color: ${config.devices[d].color}, Brightness: ${config.devices[d].brightness}`);
          
          var webscmd = getWebsCommand(config.devices[d].color, config.devices[d].entity, config.devices[d].brightness, true, webs_id);
          globalconnection.send(webscmd);
          if(config.debug) {
            sendEvent("entitydata", {devices: config.devices})
          }
        }
        start = end;
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
    config.xres.info.mac = interface.mac_address.replace(/:/g,'');
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
  module.exports.started = true;
  //config = require('./config.js');
  var config_string = fs.readFileSync(path.join("..", "config.json"));
  config = JSON.parse(config_string);
  config.xres.info.count = config.devices.length;
  getNetworkInterface();
  if(!em) {
    em = new events.EventEmitter();
    module.exports.events = em;
  }

  // Ensuring the order in the array matches its ID which would match the Hyperion pixel index.
  var tempdevs = [...config.devices];
  config.devices = [];
  tempdevs.forEach(device => {
    config.devices[device.id] = device;
  });
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

  bindWebsocketClient();
  wclient.connect(`ws://${config.hass.host}/api/websocket`);

  console.log(`Version: ${version}`);
  console.log("Hyperion HTTP: LED State:", JSON.stringify(config.xres.state.on));
}

shutdown = () => {
  console.log("Shutting down WLED Webserver...");
  webserver.close();
  webserver = null;
  console.log("Shutting down WLED UDP Server...");
  udpserver.close();
  udpserver = null;
  console.log("Shutting down HASS Websocket...");
  globalconnection.close();
  wclient = null;
  config = null;
  udp_ready = false;
  webs_ready = false;
  webserver_ready = false;
  nwint_ready = false;
  all_ready = false;
  module.exports.running = false;
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

    if(all_ready) {
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

getState = () => {
  return { devices: config.devices };
};

module.exports = { 
  main: main, 
  shutdown: shutdown,
  events: null,
  restart: restart,
  running: false,
  started: false,
  getState: getState
};