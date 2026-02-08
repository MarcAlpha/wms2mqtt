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
let mqttUrl = 'mqtt://core-mosquitto:1883'; // Standard HA Broker Host
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

// Sicherstellen, dass ignoredDevices ein sauberes Array ist
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

// --- Rest des Codes (registerDevice, callback, etc.) bleibt gleich ---
// ... (hier dein restlicher Code) ...

// Stick Initialisierung erst NACHDEM die Config geladen wurde
const stickUsb = new warema(settingsPar.wmsSerialPort, settingsPar.wmsChannel, settingsPar.wmsPanid, settingsPar.wmsKey, {}, callback);

if (settingsPar.wmsPanid === 'FFFF') {
    log.warn('PAN-ID is FFFF. Add-on is in JOIN mode.');
}

const client = mqtt.connect(mqttUrl, {
    username: mqttUser, password: mqttPassword, protocolVersion: 4,
    will: { topic: 'warema/bridge/state', payload: 'offline', retain: true }
});

client.on('connect', function () {
    log.info('Connected to MQTT Broker.');
    client.subscribe(['warema/+/set', 'warema/+/set_position', 'warema/+/set_tilt']);
    setInterval(pollWeatherData, pollingInterval);
});

// ... (MQTT Message Handler) ...
