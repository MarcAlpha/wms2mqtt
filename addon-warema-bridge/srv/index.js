const warema = require('./warema-wms-venetian-blinds');
const log = require('./logger');
const mqtt = require('mqtt');
const fs = require('fs');

process.on('SIGINT', function () {
    process.exit(0);
});

// --- Home Assistant Options Loader ---
let haOptions = {};
if (fs.existsSync('/data/options.json')) {
    try {
        haOptions = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
        log.info('Home Assistant options loaded successfully.');
    } catch (err) {
        log.error('Failed to parse /data/options.json: ' + err.message);
    }
}

// --- MQTT Konfiguration ---
let mqttUrl = 'mqtt://core-mosquitto:1883';
let mqttUser = haOptions.mqtt_user || null;
let mqttPassword = haOptions.mqtt_password || null;

if (fs.existsSync('/data/services.json')) {
    try {
        const services = JSON.parse(fs.readFileSync('/data/services.json', 'utf8'));
        if (services.mqtt) {
            mqttUrl = `mqtt://${services.mqtt.host}:${services.mqtt.port}`;
            mqttUser = services.mqtt.username;
            mqttPassword = services.mqtt.password;
            log.info(`MQTT credentials auto-loaded for user: ${mqttUser}`);
        }
    } catch (err) {
        log.error('Failed to parse /data/services.json');
    }
}

const ignoredDevices = haOptions.ignored_devices 
    ? haOptions.ignored_devices.split(',').map(s => s.trim()).filter(d => d !== "")
    : [];

const pollingInterval = parseInt(haOptions.polling_interval) || 30000;
const movingInterval = parseInt(haOptions.moving_interval) || 1000;

const settingsPar = {
    wmsChannel: parseInt(haOptions.wms_channel) || 17,
    wmsKey: haOptions.wms_key || '00112233445566778899AABBCCDDEEFF',
    wmsPanid: haOptions.wms_pan_id || 'FFFF',
    wmsSerialPort: haOptions.wms_serial_port || '/dev/ttyUSB0',
};

const devices = [];
const weatherCache = new Map(); 

log.info(`Config: Port=${settingsPar.wmsSerialPort}, Channel=${settingsPar.wmsChannel}, PAN-ID=${settingsPar.wmsPanid}`);

/**
 * Hilfsfunktionen
 */
function publishWeatherData(snr, data) {
    if (typeof client !== 'undefined' && client && client.connected) {
        client.publish(`warema/${snr}/illuminance/state`, data.lumen.toString(), {retain: true});
        client.publish(`warema/${snr}/temperature/state`, data.temp.toString(), {retain: true});
        client.publish(`warema/${snr}/wind/state`, data.wind.toString(), {retain: true});
        client.publish(`warema/${snr}/rain/state`, data.rain ? 'ON' : 'OFF', {retain: true});
    }
}

function pollWeatherData() {
    try {
        const weatherData = stickUsb.getLastWeatherBroadcast();
        if (weatherData && weatherData.snr) {
            if (!devices[weatherData.snr]) registerDevice({snr: weatherData.snr, type: "63"});
            
            const weatherHash = `${weatherData.temp}_${weatherData.wind}_${weatherData.lumen}_${weatherData.rain}`;
            const cached = weatherCache.get(weatherData.snr);
            
            if (!cached || cached.hash !== weatherHash || (Date.now() - cached.timestamp) > 10000) {
                publishWeatherData(weatherData.snr, weatherData);
                weatherCache.set(weatherData.snr, { hash: weatherHash, timestamp: Date.now() });
            }
        }
    } catch (error) { log.error('Error polling weather: ' + error.toString()); }
}

function registerDevice(element) {
    if (devices[element.snr]) return;
    if (ignoredDevices.includes(element.snr.toString())) {
        log.info(`Device ${element.snr} is ignored.`);
        return;
    }

    const availability_topic = `warema/${element.snr}/availability`;
    const bridge_state_topic = 'warema/bridge/state';
    
    let modelName = "Unknown WMS Device";
    let discoveryType = "cover"; 
    let deviceClass = "shutter"; 
    let extraConfig = {};

    switch (element.type) {
        case "06": modelName = "WMS Weather Station (basic)"; discoveryType = "sensor"; break;
        case "20": 
            modelName = "WMS Plug receiver (Raffstore)"; 
            deviceClass = "blind";
            // Tilt-Konfiguration hinzugefügt:
            extraConfig = { 
                tilt_status_topic: `warema/${element.snr}/tilt`, 
                tilt_command_topic: `warema/${element.snr}/set_tilt`,
                tilt_closed_value: 100, tilt_opened_value: 0
            };
            break;
        case "21": 
            modelName = "WMS Actuator UP (Raffstore)"; 
            deviceClass = "blind";
            // Tilt-Konfiguration hinzugefügt:
            extraConfig = { 
                tilt_status_topic: `warema/${element.snr}/tilt`, 
                tilt_command_topic: `warema/${element.snr}/set_tilt`,
                tilt_closed_value: 100, tilt_opened_value: 0
            };
            break;
        case "25": 
            modelName = "WMS Vertical awning"; 
            deviceClass = "awning"; 
            break;
        case "2A": 
            modelName = "WMS Slat roof"; 
            deviceClass = "blind"; 
            extraConfig = { 
                tilt_status_topic: `warema/${element.snr}/tilt`, 
                tilt_command_topic: `warema/${element.snr}/set_tilt`,
                tilt_closed_value: 100, tilt_opened_value: 0
            };
            break;
        case "24": modelName = "WMS Smart socket"; discoveryType = "switch"; break;
        case "28": modelName = "WMS LED"; discoveryType = "light"; break;
        case "63": modelName = "WMS Weather station pro"; discoveryType = "sensor"; break;
    }

    const base_device = { identifiers: [element.snr], manufacturer: "Warema", name: `Warema ${element.snr}`, model: modelName };

    if (discoveryType === "sensor") {
        const sensors = [
            { id: 'temperature', name: 'Temperature', unit: '°C', class: 'temperature' },
            { id: 'illuminance', name: 'Illuminance', unit: 'lx', class: 'illuminance' },
            { id: 'wind', name: 'Wind Speed', unit: 'm/s', class: 'wind_speed' },
            { id: 'rain', name: 'Rain', unit: null, class: 'moisture' }
        ];
        sensors.forEach(s => {
            const payload = {
                name: `${base_device.name} ${s.name}`,
                unique_id: `${element.snr}_${s.id}`,
                state_topic: `warema/${element.snr}/${s.id}/state`,
                unit_of_measurement: s.unit,
                device_class: s.class,
                device: base_device,
                availability: [{ topic: bridge_state_topic }, { topic: availability_topic }]
            };
            client.publish(`homeassistant/sensor/${element.snr}_${s.id}/config`, JSON.stringify(payload), { retain: true });
        });
    } else {
        const payload = {
            name: `${base_device.name}`,
            unique_id: `${element.snr}_${discoveryType}`,
            state_topic: `warema/${element.snr}/state`,
            command_topic: `warema/${element.snr}/set`,
            availability: [{ topic: bridge_state_topic }, { topic: availability_topic }],
            device: base_device,
            device_class: deviceClass,
            ...extraConfig
        };
        if (discoveryType === "cover") {
            payload.position_topic = `warema/${element.snr}/position`;
            payload.set_position_topic = `warema/${element.snr}/set_position`;
            payload.payload_open = "OPEN"; payload.payload_close = "CLOSE"; payload.payload_stop = "STOP";
            payload.position_open = 0; payload.position_closed = 100;
        }
        client.publish(`homeassistant/${discoveryType}/${element.snr}/config`, JSON.stringify(payload), { retain: true });
    }

    devices[element.snr] = { type: element.type, position: 0 };
    if (element.type !== "63" && element.type !== "06") {
        stickUsb.vnBlindAdd(parseInt(element.snr), element.snr.toString());
    }
    
    if (client.connected) {
        client.publish(availability_topic, 'online', { retain: true });
    }
}

function callback(err, msg) {
    if (err) { log.error(err); return; }
    if (msg) {
        switch (msg.topic) {
            case 'wms-vb-init-completion':
                log.info('Warema WMS initialized.');
                stickUsb.setPosUpdInterval(pollingInterval);
                stickUsb.setWatchMovingBlindsInterval(movingInterval);
                stickUsb.scanDevices({autoAssignBlinds: false});
                break;
            case 'wms-vb-scanned-devices':
                log.info(`Scan finished. Found ${msg.payload.devices.length} devices.`);
                msg.payload.devices.forEach(element => registerDevice(element));
                break;
            case 'wms-vb-rcv-weather-broadcast':
                if (!devices[msg.payload.weather.snr]) registerDevice({snr: msg.payload.weather.snr, type: "63"});
                publishWeatherData(msg.payload.weather.snr, msg.payload.weather);
                break;
            case 'wms-vb-blind-position-update':
                if (typeof msg.payload.position !== "undefined" && client && client.connected) {
                    client.publish(`warema/${msg.payload.snr}/position`, msg.payload.position.toString(), {retain: true});
                    if (devices[msg.payload.snr]) devices[msg.payload.snr].position = msg.payload.position;
                }
                if (typeof msg.payload.angle !== "undefined" && client && client.connected) {
                    client.publish(`warema/${msg.payload.snr}/tilt`, msg.payload.angle.toString(), {retain: true});
                }
                break;
        }
    }
}

// --- Initialisierung ---
const stickUsb = new warema(settingsPar.wmsSerialPort, settingsPar.wmsChannel, settingsPar.wmsPanid, settingsPar.wmsKey, {}, callback);

const client = mqtt.connect(mqttUrl, {
    username: mqttUser, password: mqttPassword, protocolVersion: 4,
    will: { topic: 'warema/bridge/state', payload: 'offline', retain: true }
});

client.on('connect', function () {
    log.info('Connected to MQTT Broker.');
    client.publish('warema/bridge/state', 'online', {retain: true});
    client.subscribe(['warema/+/set', 'warema/+/set_position', 'warema/+/set_tilt']);
    setInterval(pollWeatherData, pollingInterval);
});

client.on('message', function (topic, message) {
    const topicArray = topic.split('/');
    const deviceSnr = topicArray[1];
    const command = topicArray[2];
    const payload = message.toString().trim();

    log.info(`MQTT Received -> Device: ${deviceSnr}, Command: ${command}, Payload: ${payload}`);

    if (command === 'set') {
        switch (payload) {
            case 'CLOSE': stickUsb.vnBlindSetPosition(deviceSnr, 100, 0); break;
            case 'OPEN':  stickUsb.vnBlindSetPosition(deviceSnr, 0, 0); break;
            case 'STOP':  stickUsb.vnBlindStop(deviceSnr); break;
        }
    } else if (command === 'set_position') {
        const pos = parseInt(payload);
        stickUsb.vnBlindSetPosition(deviceSnr, pos);
    } else if (command === 'set_tilt') {
        const tilt = parseInt(payload);
        const currentPos = (devices[deviceSnr] && devices[deviceSnr].position) || 0;
        log.info(`Setting tilt to ${tilt}% at current position ${currentPos}%`);
        stickUsb.vnBlindSetPosition(deviceSnr, currentPos, tilt);
    }
});
