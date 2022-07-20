# WLED Receiver for HomeAssistant RGB LED Control v1.5.0
----
This small server allows you to accept WLED ([Aircookie](https://github.com/Aircoookie/WLED)) data and convert it to control HomeAssistant RGB LEDs. This was mainly developed to allow Hyperion(HyperHDR) HDMI Amiblighting to control RGB LEDs in HomeAssistant.

This can be run on the Hyperion instance or another machine. This guide is mostly focused around a linux server. It also works on the Hyperion(HyperHDR) RPi linux images.

This most likely will be ported to a HASS integration in the future.

----

![Screenshot](/screenshot.png?raw=true "Config Page Screenshot")

## Config

Example: You have a RGB LED on the left and right side of the room or screen. You have 2 LEDs setup in Hyperion sampling the entire left and ride sides of the the image. Left is LED ID 0 and Right is LED ID 1. So your left light would be `LED ID: 0` and your right light would be `LED ID: 1` in this list.

`HomeAssistant Host` and  `HomeAssistant Acces Token` are required to assign LED IDs to lights in HomeAssistant. You will need to enter the hostname/port and the Access Token. Once you do that you can click `Get Entities` and then you can add deviecs to the map. The HASS device pulldowns will be automatically populated with compatible lights to map.

To create a token in HASS:
1. Access your Home Assistant UI, for example homeassistant.local:8123.
2. Open your user profile page and navigate to the Long-Lived Access Tokens section.
3. Generate a new token and copy it.

`brightness_calc` equation for generating brightness/luminence for RGB LEDs. Default is `bt709` but you can play with what works for you.
Possible calculations:
* `bt601` - BT601 luma
* `bt701` - BT709 luma
* `hsp` - HSP calc
* `avg` - just average of all LED levels
  
`debug` turns on debug logging, viewable via `journalctl` on linux, or just in the CLI where you ran the server.js.
`WLED HTTP Port` this is the port configured in Hyperion. Note: WLED negotiation and config protocol defaults to 80. This server defaults to 8989 so either change it to 80 in the config or make sure in the Hyperion LED Hardware config that the _Target IP/Hostname_ includes the port like this: _hostname_:8989 (or whatever port you choose). Again, not required in Hyperion if you configure this server for port 80.

## Install
1. Install NodeJS
2. `npm install` Install required libs
3. `cd ui`
4. `node server.js` Run the server

The web UI is running on http://_hostname/ip_:3299

### Linux Service Install
Installing on your Hyperion instance (RPi etc) is a matter of copying the files in this repo, along with you config to the device running Hyperion, best is via SFTP. The target location can be anywhere

A linux systemctl service file is included in the repo as well. For running it as a service on Windows, google is your friend (sorry, I'm lazy).

1. Modify these locations to where you plan to copy the server to in `wled-ha-rgb.service`:
   * `ExecStart=/usr/bin/node /home/pi/wled-ha-rgb/ui/server.js`
   * `WorkingDirectory=/home/pi/wled-ha-rgb/ui/`
2. Copy the `wled-ha-rgb.service` to `/etc/systemd/system`
3. Run this command: `sudo systemctl start wled-ha-rgb`
4. And then this to make sure it starts with the system: `sudo systemctl enable wled-has-rgb`

## Hyperion Setup
Setup is like a normal WLED LED Instance. Configure the LEDs for the space you want to sample from. Then just make note of the LED IDs for the config of this server. Also a major note is to make sure when you enter the `Target IP/Hostname`, it includes the port. EX: `192.168.1.11:8989`