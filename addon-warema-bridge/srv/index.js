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
const forceDevices = (haOptions.force_devices || process.env.FORCE_DEVICES || "").split(',').map(s => s.trim()).filter(d => d);
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
const rawMessageCache = new Map(); 

log.info(`Config: Port=${settingsPar.wmsSerialPort}, Channel=${settingsPar.wmsChannel}, PAN-ID=${settingsPar.wmsPanid}`);

function isDuplicateRawMessage(stickCmd, snr) {
    const currentTime = Date.now();
    const messageKey = `${snr}_${stickCmd}`;
    const cachedMessage = rawMessageCache.get(messageKey);
    if (cachedMessage && (currentTime - cachedMessage.timestamp) < 1000) return true;
    rawMessageCache.set(messageKey, { timestamp: currentTime });
    return false;
}

function pollWeatherData() {
    try {
        const weatherData = stickUsb.getLastWeatherBroadcast();
        if (weatherData && weatherData.snr) {
            const weatherHash = `${weatherData.temp}_${weatherData.wind}_${weatherData.lumen}_${weatherData.rain}`;
            const cachedWeather = weatherCache.get(weatherData.snr);
            if (!cachedWeather || cachedWeather.hash !== weatherHash || (Date.now() - cachedWeather.timestamp) > 5000) {
                if (!devices[weatherData.snr]) registerDevice({snr: weatherData.snr, type: "63"});
                if (typeof client !== 'undefined' && client.connected) {
                    client.publish('warema/' + weatherData.snr + '/illuminance/state', weatherData.lumen.toString(), {retain: true});
                    client.publish('warema/' + weatherData.snr + '/temperature/state', weatherData.temp.toString(), {retain: true});
                    client.publish('warema/' + weatherData.snr + '/wind/state', weatherData.wind.toString(), {retain: true});
                    client.publish('warema/' + weatherData.snr + '/rain/state', weatherData.rain ? 'ON' : 'OFF', {retain: true});
                }
                weatherCache.set(weatherData.snr, { hash: weatherHash, timestamp: Date.now() });
            }
        }
    } catch (error) { log.error('Error polling weather: ' + error.toString()); }
}

function registerDevice(element) {
    var availability_topic = 'warema/' + element.snr + '/availability';
    var base_payload = { availability: [{topic: 'warema/bridge/state'}, {topic: availability_topic}], unique_id: element.snr, device: { identifiers: element.snr, manufacturer: "Warema", name: element.snr } };

    switch (element.type) {
        case "63":
            devices[element.snr] = {};
            if (typeof client !== 'undefined' && client.connected) client.publish(availability_topic, 'online', {retain: true});
            return;
        case "20":
        case "21":
        case "25":
            devices[element.snr] = {};
            stickUsb.vnBlindAdd(parseInt(element.snr), element.snr.toString());
            if (typeof client !== 'undefined' && client.connected) client.publish(availability_topic, 'online', {retain: true});
            break;
        default:
            log.warn('Device type ' + element.type + ' not fully supported yet.');
    }
}

function callback(err, msg) {
    if (err) { log.error(err); return; }
    if (msg) {
        switch (msg.topic) {
            case 'wms-vb-init-completion':
                stickUsb.setPosUpdInterval(pollingInterval);
                stickUsb.setWatchMovingBlindsInterval(movingInterval);
                stickUsb.scanDevices({autoAssignBlinds: false});
                break;
            case 'wms-vb-scanned-devices':
                msg.payload.devices.forEach(element => registerDevice(element));
                break;
            case 'wms-vb-blind-position-update':
                if (typeof msg.payload.position !== "undefined") {
                    client.publish('warema/' + msg.payload.snr + '/position', '' + msg.payload.position, {retain: true});
                }
                break;
        }
        if (typeof client !== 'undefined' && client.connected) client.publish('warema/bridge/state', 'online', {retain: true});
    }
}

const stickUsb = new warema(settingsPar.wmsSerialPort, settingsPar.wmsChannel, settingsPar.wmsPanid, settingsPar.wmsKey, {}, callback);

if (settingsPar.wmsPanid === 'FFFF') return;

const client = mqtt.connect(mqttServer, {
    username: mqttUser,
    password: mqttPassword,
    protocolVersion: 4,
    will: { topic: 'warema/bridge/state', payload: 'offline', retain: true }
});

client.on('connect', function () {
    log.info('Connected to MQTT');
    client.subscribe(['warema/+/set', 'warema/+/set_position']);
    setInterval(pollWeatherData, pollingInterval);
});

client.on('message', function (topic, message) {
    let [scope, device, command] = topic.split('/');
    message = message.toString();
    if (command === 'set') {
        if (message === 'CLOSE') stickUsb.vnBlindSetPosition(device, 100, 0);
        else if (message === 'OPEN') stickUsb.vnBlindSetPosition(device, 0, 0);
        else if (message === 'STOP') stickUsb.vnBlindStop(device);
    } else if (command === 'set_position') {
        stickUsb.vnBlindSetPosition(device, parseInt(message));
    }
}); // <--- Hier war die schließende Klammer kritisch!
