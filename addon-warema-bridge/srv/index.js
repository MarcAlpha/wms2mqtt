const warema = require('./warema-wms-venetian-blinds');
const log = require('./logger');
const mqtt = require('mqtt');
const fs = require('fs');

process.on('SIGINT', () => process.exit(0));

// --- Variablen initialisieren ---
let haOptions = {};
let mqttUrl = 'mqtt://core-mosquitto:1883';
let mqttUser = null;
let mqttPassword = null;

// --- HA Options laden ---
try {
    if (fs.existsSync('/data/options.json')) {
        haOptions = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
        mqttUser = haOptions.mqtt_user || null;
        mqttPassword = haOptions.mqtt_password || null;
    }
} catch (e) { log.error("Fehler beim Laden der Optionen: " + e.message); }

// --- MQTT Services laden (HA interner Broker) ---
if (fs.existsSync('/data/services.json')) {
    try {
        const services = JSON.parse(fs.readFileSync('/data/services.json', 'utf8'));
        if (services.mqtt) {
            mqttUrl = `mqtt://${services.mqtt.host}:${services.mqtt.port}`;
            mqttUser = services.mqtt.username;
            mqttPassword = services.mqtt.password;
        }
    } catch (e) { log.error("Fehler beim Laden der MQTT-Services: " + e.message); }
}

const settingsPar = {
    wmsChannel: parseInt(haOptions.wms_channel) || 17,
    wmsKey: haOptions.wms_key || '00112233445566778899AABBCCDDEEFF',
    wmsPanid: haOptions.wms_pan_id || 'FFFF',
    wmsSerialPort: haOptions.wms_serial_port || '/dev/ttyUSB0',
};

const devices = {};

// --- Discovery Hilfsfunktion ---
function publishSensorConfig(snr, type, name, unit, deviceClass, icon, baseDevice) {
    const topic = `homeassistant/sensor/${snr}_${type}/config`;
    const payload = {
        name: `Warema ${snr} ${name}`,
        unique_id: `warema_${snr}_${type}`,
        state_topic: `warema/${snr}/${type}/state`,
        unit_of_measurement: unit,
        device_class: deviceClass,
        icon: icon,
        device: baseDevice,
        availability: [{ topic: 'warema/bridge/state' }, { topic: `warema/${snr}/availability` }]
    };
    client.publish(topic, JSON.stringify(payload), { retain: true });
}

// --- Geräte-Registrierung ---
function registerDevice(element) {
    const snr = element.snr.toString().toUpperCase();
    if (devices[snr]) return;

    const baseDevice = {
        identifiers: [snr],
        manufacturer: "Warema",
        name: `Warema ${snr}`
    };

    let discoveryType = "cover";
    let deviceClass = "shutter";
    let hasTilt = false;

    switch (element.type) {
        case "20":
            baseDevice.model = "WMS Zwischenstecker (Raffstore)";
            hasTilt = true;
            break;
        case "21":
            baseDevice.model = "WMS Aktor UP (Raffstore)";
            hasTilt = true;
            break;
        case "25":
            baseDevice.model = "WMS Markisen-Aktor";
            deviceClass = "awning";
            break;
        case "2A":
            baseDevice.model = "WMS Lamellendach";
            hasTilt = true;
            break;
        case "24":
            baseDevice.model = "WMS Steckdose / Schalter";
            discoveryType = "switch";
            break;
        case "06":
        case "63":
            baseDevice.model = "WMS Wetterstation plus";
            discoveryType = "sensor";
            break;
        default:
            baseDevice.model = `WMS Gerät (Typ ${element.type})`;
    }

    if (discoveryType === "cover") {
        const payload = {
            name: `Warema ${snr}`,
            unique_id: `warema_${snr}_cover`,
            device: baseDevice,
            state_topic: `warema/${snr}/state`,
            command_topic: `warema/${snr}/set`,
            position_topic: `warema/${snr}/position`,
            set_position_topic: `warema/${snr}/set_position`,
            device_class: deviceClass,
            payload_open: "OPEN", payload_close: "CLOSE", payload_stop: "STOP",
            position_open: 0, position_closed: 100,
            availability: [{ topic: 'warema/bridge/state' }, { topic: `warema/${snr}/availability` }]
        };
        if (hasTilt) {
            payload.tilt_status_topic = `warema/${snr}/tilt`;
            payload.tilt_command_topic = `warema/${snr}/set_tilt`;
            payload.tilt_closed_value = 100;
            payload.tilt_opened_value = 0;
        }
        client.publish(`homeassistant/cover/${snr}/config`, JSON.stringify(payload), { retain: true });
        stickUsb.vnBlindAdd(snr, snr);
    } else if (discoveryType === "sensor") {
        publishSensorConfig(snr, 'temperature', 'Temperatur', '°C', 'temperature', 'mdi:thermometer', baseDevice);
        publishSensorConfig(snr, 'luminance', 'Helligkeit', 'lx', 'illuminance', 'mdi:brightness-5', baseDevice);
        publishSensorConfig(snr, 'wind', 'Windgeschwindigkeit', 'm/s', 'wind_speed', 'mdi:weather-windy', baseDevice);
        publishSensorConfig(snr, 'rain', 'Regen', '', '', 'mdi:weather-rainy', baseDevice);
    } else if (discoveryType === "switch") {
        const payload = {
            name: `Warema ${snr} Schalter`,
            unique_id: `warema_${snr}_switch`,
            device: baseDevice,
            state_topic: `warema/${snr}/state`,
            command_topic: `warema/${snr}/set`,
            payload_on: "ON", payload_off: "OFF",
            availability: [{ topic: 'warema/bridge/state' }, { topic: `warema/${snr}/availability` }]
        };
        client.publish(`homeassistant/switch/${snr}/config`, JSON.stringify(payload), { retain: true });
    }

    devices[snr] = { type: element.type, position: 0, tilt: 0 };
    client.publish(`warema/${snr}/availability`, 'online', { retain: true });
}

// --- Callback Logic ---
function callback(err, msg) {
    if (err || !msg) return;
    
    // WICHTIG: Wir loggen hier einmal kurz, was reinkommt, um zu sehen ob Funk-Antworten da sind
    if (msg.topic === 'wms-vb-blind-position-update' || msg.topic === 'wms-vb-weather-update') {
        log.info(`Antwort erhalten: ${msg.topic} für SNR: ${msg.payload.snr}`);
    }

    // Wir stellen sicher, dass die SNR immer als sauberer String verglichen wird
    const snr = msg.payload && msg.payload.snr ? msg.payload.snr.toString().toUpperCase() : null;
    
    switch (msg.topic) {
        case 'wms-vb-init-completion':
            stickUsb.scanDevices({autoAssignBlinds: false});
            break;
        case 'wms-vb-scanned-devices':
            msg.payload.devices.forEach(d => registerDevice(d));
            break;
        case 'wms-vb-blind-position-update':
            if (snr && client.connected) {
                // Wir prüfen, ob wir das Gerät kennen (Groß/Kleinschreibung beachten)
                if (msg.payload.position !== undefined) {
                    const pos = Math.round(msg.payload.position);
                    client.publish(`warema/${snr}/position`, pos.toString(), {retain: true});
                    client.publish(`warema/${snr}/state`, pos > 0 ? 'closed' : 'open', {retain: true});
                    if (devices[snr]) devices[snr].position = pos;
                }
                if (msg.payload.angle !== undefined) {
                    const tilt = Math.round(msg.payload.angle);
                    client.publish(`warema/${snr}/tilt`, tilt.toString(), {retain: true});
                    if (devices[snr]) devices[snr].tilt = tilt;
                }
            }
            break;
        case 'wms-vb-weather-update':
            if (snr && client.connected) {
                if (msg.payload.temp !== undefined) client.publish(`warema/${snr}/temperature/state`, msg.payload.temp.toString(), {retain: true});
                if (msg.payload.lumi !== undefined) client.publish(`warema/${snr}/luminance/state`, msg.payload.lumi.toString(), {retain: true});
                if (msg.payload.wind !== undefined) client.publish(`warema/${snr}/wind/state`, msg.payload.wind.toString(), {retain: true});
                if (msg.payload.rain !== undefined) client.publish(`warema/${snr}/rain/state`, msg.payload.rain ? "ON" : "OFF", {retain: true});
            }
            break;
    }
}

// --- Initialisierung & Connect ---
const stickUsb = new warema(settingsPar.wmsSerialPort, settingsPar.wmsChannel, settingsPar.wmsPanid, settingsPar.wmsKey, {}, callback);
const client = mqtt.connect(mqttUrl, { username: mqttUser, password: mqttPassword });

client.on('connect', () => {
    log.info('MQTT verbunden.');
    client.publish('warema/bridge/state', 'online', {retain: true});
    client.subscribe(['warema/+/set', 'warema/+/set_position', 'warema/+/set_tilt']);
});

client.on('message', (topic, message) => {
    const parts = topic.split('/');
    const snr = parts[1];
    const cmd = parts[2];
    if (!devices[snr]) return;
    const payload = message.toString().trim();

    if (cmd === 'set') {
        if (payload === 'CLOSE') stickUsb.vnBlindSetPosition(snr, 100, 0);
        else if (payload === 'OPEN') stickUsb.vnBlindSetPosition(snr, 0, 0);
        else if (payload === 'STOP') stickUsb.vnBlindStop(snr);
        else if (payload === 'ON') stickUsb.vnBlindSetPosition(snr, 100, 0);
        else if (payload === 'OFF') stickUsb.vnBlindSetPosition(snr, 0, 0);
    } else if (cmd === 'set_position') {
        const currentTilt = devices[snr].tilt || 0;
        stickUsb.vnBlindSetPosition(snr, parseInt(payload), currentTilt);
    } else if (cmd === 'set_tilt') {
        const currentPos = devices[snr].position || 0;
        stickUsb.vnBlindSetPosition(snr, currentPos, parseInt(payload));
    }
});
