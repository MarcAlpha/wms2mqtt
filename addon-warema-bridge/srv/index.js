const warema = require('./warema-wms-venetian-blinds');
const log = require('./logger');
const mqtt = require('mqtt');
const fs = require('fs');

process.on('SIGINT', function () {
    process.exit(0);
});

// --- Home Assistant Options Loader ---
// Liest die im UI eingegebenen Werte aus der /data/options.json
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
// Priorität: 1. HA-Optionen (UI), 2. Umgebungsvariablen (ENV), 3. Defaults
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

// Logge die geladenen Parameter (ohne den Key voll anzuzeigen aus Sicherheitsgründen)
log.info(`Config: Port=${settingsPar.wmsSerialPort}, Channel=${settingsPar.wmsChannel}, PAN-ID=${settingsPar.wmsPanid}`);

function isDuplicateRawMessage(stickCmd, snr) {
    const currentTime = Date.now();
    const messageKey = `${snr}_${stickCmd}`;
    const cachedMessage = rawMessageCache.get(messageKey);
    const minTimeDiff = 1000; 
    
    if (cachedMessage && (currentTime - cachedMessage.timestamp) < minTimeDiff) {
        return true; 
    }
    
    rawMessageCache.set(messageKey, {
        timestamp: currentTime
    });
    
    for (const [key, value] of rawMessageCache.entries()) {
        if ((currentTime - value.timestamp) > 10000) {
            rawMessageCache.delete(key);
        }
    }
    
    return false;
}

function pollWeatherData() {
    try {
        const weatherData = stickUsb.getLastWeatherBroadcast();
        
        if (weatherData && weatherData.snr) {
            const weatherKey = weatherData.snr;
            const currentTime = Date.now();
            const weatherHash = `${weatherData.temp}_${weatherData.wind}_${weatherData.lumen}_${weatherData.rain}`;
            
            const cachedWeather = weatherCache.get(weatherKey);
            const minTimeDiff = 5000; 
            
            if (!cachedWeather || 
                cachedWeather.hash !== weatherHash || 
                (currentTime - cachedWeather.timestamp) > minTimeDiff) {
                
                log.info('Publishing weather data for ' + weatherKey + ' (hash: ' + weatherHash + ') via polling');
                
                if (!devices[weatherData.snr]) {
                    registerDevice({snr: weatherData.snr, type: "63"});
                }
                
                if (typeof client !== 'undefined' && client.connected) {
                    client.publish('warema/' + weatherData.snr + '/illuminance/state', weatherData.lumen.toString(), {retain: true})
                    client.publish('warema/' + weatherData.snr + '/temperature/state', weatherData.temp.toString(), {retain: true})
                    client.publish('warema/' + weatherData.snr + '/wind/state', weatherData.wind.toString(), {retain: true})
                    client.publish('warema/' + weatherData.snr + '/rain/state', weatherData.rain ? 'ON' : 'OFF', {retain: true})
                } else {
                    log.warn('MQTT client not connected, skipping weather data publish for ' + weatherKey);
                }
                
                weatherCache.set(weatherKey, {
                    hash: weatherHash,
                    timestamp: currentTime
                });
            } else {
                log.debug('Skipping duplicate weather data for ' + weatherKey + ' (hash: ' + weatherHash + ') via polling');
            }
        }
    } catch (error) {
        log.error('Error polling weather data: ' + error.toString());
    }
}

function registerDevice(element) {
    log.debug('Registering ' + element.snr + ' with type: ' + element.type)
    var availability_topic = 'warema/' + element.snr + '/availability'

    var base_payload = {
        availability: [
            {topic: 'warema/bridge/state'},
            {topic: availability_topic}
        ],
        unique_id: element.snr,
        name: null
    }

    var base_device = {
        identifiers: element.snr,
        manufacturer: "Warema",
        name: element.snr
    }

    var model
    var payload
    switch (element.type) {
        case "63":
            model = 'Weather station pro'
            payload = {
                ...base_payload,
                device: {
                    ...base_device,
                    model: model
                }
            }

            const illuminance_payload = {
                ...payload,
                state_topic: 'warema/' + element.snr + '/illuminance/state',
                device_class: 'illuminance',
                unique_id: element.snr + '_illuminance',
                object_id: element.snr + '_illuminance',
                unit_of_measurement: 'lx',
            };
            
            const temperature_payload = {
                ...payload,
                state_topic: 'warema/' + element.snr + '/temperature/state',
                device_class: 'temperature',
                unique_id: element.snr + '_temperature',
                object_id: element.snr + '_temperature',
                unit_of_measurement: '°C',
            }
            
            const wind_payload = {
                ...payload,
                state_topic: 'warema/' + element.snr + '/wind/state',
                device_class: 'wind_speed',
                unique_id: element.snr + '_wind',
                object_id: element.snr + '_wind',
                unit_of_measurement: 'm/s',
            }
            
            const rain_payload = {
                ...payload,
                state_topic: 'warema/' + element.snr + '/rain/state',
                device_class: 'moisture',
                unique_id: element.snr + '_rain',
                object_id: element.snr + '_rain',
            }
            
            if (typeof client !== 'undefined' && client.connected) {
                client.publish(availability_topic, 'online', {retain: true})
            }

            devices[element.snr] = {};
            log.info('Weather device registered. ' + element.snr + ' (Type ' + element.type + ')') 

            return;
        case "07":
            return;
        case "09":
            return;
        case "20":
            model = 'Plug receiver'
            payload = {
                ...base_payload,
                device: { ...base_device, model: model },
                position_open: 0,
                position_closed: 100,
                command_topic: 'warema/' + element.snr + '/set',
                state_topic: 'warema/' + element.snr + '/state',
                position_topic: 'warema/' + element.snr + '/position',
                tilt_status_topic: 'warema/' + element.snr + '/tilt',
                set_position_topic: 'warema/' + element.snr + '/set_position',
                tilt_command_topic: 'warema/' + element.snr + '/set_tilt',
                tilt_closed_value: -100,
                tilt_opened_value: 100,
                tilt_min: -100,
                tilt_max: 100,
            }
            break;
        case "21":
            model = 'Actuator UP'
            payload = {
                ...base_payload,
                device: { ...base_device, model: model },
                position_open: 0,
                position_closed: 100,
                command_topic: 'warema/' + element.snr + '/set',
                position_topic: 'warema/' + element.snr + '/position',
                tilt_status_topic: 'warema/' + element.snr + '/tilt',
                set_position_topic: 'warema/' + element.snr + '/set_position',
                tilt_command_topic: 'warema/' + element.snr + '/set_tilt',
                tilt_closed_value: -100,
                tilt_opened_value: 100,
                tilt_min:
