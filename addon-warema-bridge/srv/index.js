const warema = require('./warema-wms-venetian-blinds');
const log = require('./logger');
const mqtt = require('mqtt');
const fs = require('fs');

process.on('SIGINT', () => process.exit(0));

let haOptions = {};
let mqttUrl = 'mqtt://core-mosquitto:1883';
let mqttUser = null;
let mqttPassword = null;

try {
    if (fs.existsSync('/data/options.json')) {
        haOptions = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
        mqttUser = haOptions.mqtt_user || null;
        mqttPassword = haOptions.mqtt_password || null;
    }
} catch (e) { log.error("Fehler Optionen: " + e.message); }

if (fs.existsSync('/data/services.json')) {
    try {
        const services = JSON.parse(fs.readFileSync('/data/services.json', 'utf8'));
        if (services.mqtt) {
            mqttUrl = `mqtt://${services.mqtt.host}:${services.mqtt.port}`;
            mqttUser = services.mqtt.username;
            mqttPassword = services.mqtt.password;
        }
    } catch (e) { log.error("Fehler MQTT Services: " + e.message); }
}

const settingsPar = {
    wmsChannel: parseInt(haOptions.wms_channel) || 17,
    wmsKey: haOptions.wms_key || '00112233445566778899AABBCCDDEEFF',
    wmsPanid: haOptions.wms_pan_id || 'FFFF',
    wmsSerialPort: haOptions.wms_serial_port || '/dev/ttyUSB0',
};

const devices = {};

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

function registerDevice(element) {
    const snr = element.snr.toString().toUpperCase();
    if (devices[snr]) return;

    const baseDevice = {
        identifiers: [snr],
        manufacturer: "Warema",
        name: `Warema ${snr}`
    };

    let discoveryType = "cover";
    let hasTilt = false;

    if (["20", "21", "2A"].includes(element.type)) {
        discoveryType = "cover";
        hasTilt = true;
    } else if (["06", "63"].includes(element.type)) {
        discoveryType = "sensor";
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
            device_class: "shutter",
            payload_open: "OPEN", payload_close: "CLOSE", payload_stop: "STOP",
            position_open: 0, position_closed: 100,
            availability: [{ topic: 'warema/bridge/state' }, { topic: `warema/${snr}/availability` }]
        };
        if (hasTilt) {
            payload.tilt_status_topic = `warema/${snr}/tilt`;
            payload.tilt_command_topic = `warema/${snr}/set_tilt`;
        }
        client.publish(`homeassistant/cover/${snr}/config`, JSON.stringify(payload), { retain: true });
        stickUsb.vnBlindAdd(snr, snr);
        // Sofort Status abfragen nach Registrierung
        setTimeout(() => stickUsb.vnBlindGetPosition(snr), 2000);
    } else if (discoveryType === "sensor") {
        publishSensorConfig(snr, 'temperature', 'Temperatur', '°C', 'temperature', 'mdi:thermometer', baseDevice);
        publishSensorConfig(snr, 'luminance', 'Helligkeit', 'lx', 'illuminance', 'mdi:brightness-5', baseDevice);
        publishSensorConfig(snr, 'wind', 'Windgeschwindigkeit', 'm/s', 'wind_speed', 'mdi:weather-windy', baseDevice);
        publishSensorConfig(snr, 'rain', 'Regen', '', '', 'mdi:weather-rainy', baseDevice);
    }

    devices[snr] = { position: 0, tilt: 0 };
    client.publish(`warema/${snr}/availability`, 'online', { retain: true });
}

function callback(err, msg) {
    if (err || !msg) return;
    const snr = (msg.payload && msg.payload.snr) ? msg.payload.snr.toString().toUpperCase() : null;
    
    switch (msg.topic) {
        case 'wms-vb-init-completion':
            stickUsb.scanDevices({autoAssignBlinds: false});
            break;
        case 'wms-vb-scanned-devices':
            msg.payload.devices.forEach(d => registerDevice(d));
            break;
        case 'wms-vb-blind-position-update':
            if (snr && client.connected) {
                log.info(`Position Update für ${snr}: Pos ${msg.payload.position}%`);
                if (msg.payload.position !== undefined) {
                    client.publish(`warema/${snr}/position`, Math.round(msg.payload.position).toString(), {retain: true});
                }
                if (msg.payload.angle !== undefined) {
                    client.publish(`warema/${snr}/tilt`, Math.round(msg.payload.angle).toString(), {retain: true});
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

const stickUsb = new warema(settingsPar.wmsSerialPort, settingsPar.wmsChannel, settingsPar.wmsPanid, settingsPar.wmsKey, {}, callback);
const client = mqtt.connect(mqttUrl, { username: mqttUser, password: mqttPassword });

client.on('connect', () => {
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
    } else if (cmd === 'set_position') {
        stickUsb.vnBlindSetPosition(snr, parseInt(payload), devices[snr].tilt || 0);
    } else if (cmd === 'set_tilt') {
        stickUsb.vnBlindSetPosition(snr, devices[snr].position || 0, parseInt(payload));
    }
    
    // Nach jedem Befehl den Status nach 15 Sekunden abfragen (Zeit für die Fahrt)
    setTimeout(() => {
        if (stickUsb && snr) stickUsb.vnBlindGetPosition(snr);
    }, 15000);
});
