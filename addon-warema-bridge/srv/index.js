const warema = require('./warema-wms-venetian-blinds');
const log = require('./logger');
const mqtt = require('mqtt');
const fs = require('fs');

process.on('SIGINT', function () {
    process.exit(0);
});

// --- Home Assistant Options Loader ---
let haOptions = {};
try {
    if (fs.existsSync('/data/options.json')) {
        haOptions = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
        log.info('Home Assistant options loaded successfully.');
    }
} catch (err) {
    log.error('Failed to load /data/options.json: ' + err.message);
}

// Konfigurations-Mapping
const mqttServer = haOptions.mqtt_server || process.env.MQTT_SERVER || 'mqtt://localhost';
const mqttUser = haOptions.mqtt_user || process.env.MQTT_USER || null;
const mqttPassword = haOptions.mqtt_password || process.env.MQTT_PASSWORD || null;

const ignoredDevices = (haOptions.ignored_devices || process.env.IGNORED_DEVICES || "").split(',').map(s => s.trim()).filter(d => d);
const pollingInterval = parseInt(haOptions.polling_interval || process.env.POLLING_INTERVAL || 30000);
const movingInterval = parseInt(haOptions.moving_interval || process.env.MOVING_INTERVAL || 1000);

const settingsPar = {
    wmsChannel: parseInt(haOptions.wms_channel || process.env.WMS_CHANNEL || 17),
    wmsKey: haOptions.wms_key || process.env.WMS_KEY || '00112233445566778899AABBCCDDEEFF',
    wmsPanid: haOptions.wms_pan_id || process.env.WMS_PAN_ID || 'FFFF',
    wmsSerialPort: haOptions.wms_serial_port || process.env.WMS_SERIAL_PORT || '/dev/ttyUSB0',
};

const devices = [];
const weatherCache = new Map(); 

log.info(`Config: Port=${settingsPar.wmsSerialPort}, Channel=${settingsPar.wmsChannel}, PAN-ID=${settingsPar.wmsPanid}`);

/**
 * Hilfsfunktion zum Senden der Wetterdaten
 */
function publishWeatherData(snr, data) {
    if (typeof client !== 'undefined' && client.connected) {
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

/**
 * Registriert das Gerät bei Home Assistant via MQTT Discovery
 */
function registerDevice(element) {
    if (devices[element.snr]) return;
    if (ignoredDevices.includes(element.snr.toString())) {
        log.info(`Device ${element.snr} is ignored per config.`);
        return;
    }

    const availability_topic = `warema/${element.snr}/availability`;
    const bridge_state_topic = 'warema/bridge/state';
    
    let modelName = "Unknown WMS Device";
    let discoveryType = "cover"; 
    let extraConfig = {};

    // Typerkennung
    switch (element.type) {
        case "06": modelName = "WMS Weather Station (basic)"; discoveryType = "sensor"; break;
        case "20": modelName = "WMS Plug receiver"; break;
        case "21": modelName = "WMS Actuator UP"; break;
        case "25": modelName = "WMS Vertical awning"; break;
        case "2A": 
            modelName = "WMS Slat roof"; 
            extraConfig = { 
                tilt_status_topic: `warema/${element.snr}/tilt`, 
                tilt_command_topic: `warema/${element.snr}/set_tilt`,
                tilt_closed_value: 100, tilt_opened_value: 0
            };
            break;
        case "24": modelName = "WMS Smart socket"; discoveryType = "switch"; break;
        case "28": modelName = "WMS LED"; discoveryType = "light"; break;
        case "63": modelName = "WMS Weather station pro"; discoveryType = "sensor"; break;
        default:
            log.warn(`Unrecognized type ${element.type} for ${element.snr}. Defaulting to cover.`);
    }

    const base_device = { 
        identifiers: [element.snr], 
        manufacturer: "Warema", 
        name: `Warema ${element.snr}`, 
        model: modelName 
    };

    if (discoveryType === "sensor") {
        // Discovery für Wetter-Sensoren
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
        // Discovery für Aktoren (Rolladen, Licht, Schalter)
        const payload = {
            name: `${base_device.name}`,
            unique_id: `${element.snr}_${discoveryType}`,
            state_topic: `warema/${element.snr}/state`,
            command_topic: `warema/${element.snr}/set`,
            availability: [{ topic: bridge_state_topic }, { topic: availability_topic }],
            device: base_device,
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

    devices[element.snr] = { type: element.type };
    if (element.type !== "63" && element.type !== "06") {
        stickUsb.vnBlindAdd(parseInt(element.snr), element.snr.toString());
    }
    
    if (client.connected) {
        client.publish(availability_topic, 'online', { retain: true });
    }
    log.info(`Successfully registered ${modelName} (${element.snr})`);
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
                if (typeof msg.payload.position !== "undefined") {
                    client.publish(`warema/${msg.payload.snr}/position`, msg.payload.position.toString(), {retain: true});
                    if (msg.payload.moving === false) {
                        let state = (msg.payload.position === 0) ? 'open' : (msg.payload.position === 100 ? 'closed' : 'stopped');
                        client.publish(`warema/${msg.payload.snr}/state`, state, {retain: true});
                    }
                }
                if (typeof msg.payload.angle !== "undefined") {
                    client.publish(`warema/${msg.payload.snr}/tilt`, msg.payload.angle.toString(), {retain: true});
                }
                break;
        }
        if (client && client.connected) client.publish('warema/bridge/state', 'online', {retain: true});
    }
}

// Stick Initialisierung
const stickUsb = new warema(settingsPar.wmsSerialPort, settingsPar.wmsChannel, settingsPar.wmsPanid, settingsPar.wmsKey, {}, callback);

if (settingsPar.wmsPanid === 'FFFF') {
    log.warn('PAN-ID is FFFF. Add-on is in JOIN mode. Check logs for network parameters.');
    return;
}

// MQTT Verbindung
const client = mqtt.connect(mqttServer, {
    username: mqttUser, password: mqttPassword, protocolVersion: 4,
    will: { topic: 'warema/bridge/state', payload: 'offline', retain: true }
});

client.on('connect', function () {
    log.info('Connected to MQTT Broker.');
    client.subscribe(['warema/+/set', 'warema/+/set_position', 'warema/+/set_tilt']);
    setInterval(pollWeatherData, pollingInterval);
});

client.on('message', function (topic, message) {
    let [scope, device, command] = topic.split('/');
    message = message.toString();
    log.debug(`MQTT Message: ${device} -> ${command} (${message})`);

    if (command === 'set') {
        switch (message) {
            case 'CLOSE': stickUsb.vnBlindSetPosition(device, 100, 0); break;
            case 'OPEN': stickUsb.vnBlindSetPosition(device, 0, 0); break;
            case 'STOP': stickUsb.vnBlindStop(device); break;
            case 'ON': stickUsb.vnBlindSetPosition(device, 100); break;
            case 'OFF': stickUsb.vnBlindSetPosition(device, 0); break;
        }
    } else if (command === 'set_position') {
        stickUsb.vnBlindSetPosition(device, parseInt(message));
    } else if (command === 'set_tilt') {
        // Für Lamellendächer: Position beibehalten, nur Winkel ändern
        const currentPos = (devices[device] && devices[device].position) || 0;
        stickUsb.vnBlindSetPosition(device, parseInt(currentPos), parseInt(message));
    }
});
