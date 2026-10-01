/**
 * Uplink payload decoders for WeatherXM WS2001 in Open LoRaWAN mode (TestMode 1).
 * In this mode, telemetry is sent on LoRaWAN FPort 3 in SenseCAP 8-in-1 Big-Endian TLV format.
 */

export interface DecodedWs2001Telemetry {
  temperature?: number;      // °C
  humidity?: number;         // %
  lux?: number;              // lx
  uvIndex?: number;          // UV index
  windSpeed?: number;        // m/s
  windDirection?: number;    // degrees (0-359)
  rainIntensity?: number;    // mm/h
  pressure?: number;         // hPa
  pressurePa?: number;       // Pa
  battery?: number;          // %
  hwVersion?: string;        // e.g. "1.1"
  firmwareVersion?: string;  // e.g. "2.4"
  uploadIntervalMin?: number;// min
  gpsIntervalMin?: number;   // min
  sensorState?: number;
  sensorStateDesc?: string;
}

export type DecodedH2Telemetry = DecodedWs2001Telemetry;

const ERROR_DESCRIPTIONS: Record<number, string> = {
  0x00: 'NONE',
  0x01: 'SENSOR_NOT_FOUND',
  0x02: 'WAKEUP_ERROR',
  0x03: 'NOT_RESPONSE',
  0x04: 'DATA_EMPTY',
  0x05: 'DATA_HEAD_ERROR',
  0x06: 'DATA_CRC_ERROR',
  0x0C: 'VALUE_TOO_HIGH',
  0x0D: 'VALUE_TOO_LOW',
  0x0E: 'VALUE_MISSED',
  0xFF: 'UNKNOWN_ERROR',
};

/**
 * Pure decoder function for tests and UI preview.
 */
export function decodeWs2001Telemetry(bytes: Uint8Array): DecodedWs2001Telemetry {
  const result: DecodedWs2001Telemetry = {};
  let i = 0;

  while (i < bytes.length) {
    const id = bytes[i++];
    if (id === 0x01 && i + 10 <= bytes.length) {
      // 0x01: Temp (2B int16), Hum (1B uint8), Lux (4B uint32), UV (1B uint8 / 10), Wind Speed (2B uint16 / 10)
      const view = new DataView(bytes.buffer, bytes.byteOffset + i, 10);
      result.temperature = Number((view.getInt16(0, false) / 10).toFixed(1));
      result.humidity = view.getUint8(2);
      result.lux = view.getUint32(3, false);
      result.uvIndex = Number((view.getUint8(7) / 10).toFixed(1));
      result.windSpeed = Number((view.getUint16(8, false) / 10).toFixed(1));
      i += 10;
    } else if (id === 0x02 && i + 8 <= bytes.length) {
      // 0x02: Wind Dir (2B uint16), Rain Rate (4B uint32 / 1000), Baro Pressure (2B uint16 / 10)
      const view = new DataView(bytes.buffer, bytes.byteOffset + i, 8);
      result.windDirection = view.getUint16(0, false);
      result.rainIntensity = Number((view.getUint32(2, false) / 1000).toFixed(2));
      const rawPressure = view.getUint16(6, false);
      result.pressure = Number((rawPressure / 10).toFixed(1));
      result.pressurePa = rawPressure * 10;
      i += 8;
    } else if (id === 0x03 && i + 1 <= bytes.length) {
      // 0x03: Battery (1B uint8 0-100)
      result.battery = bytes[i++];
    } else if (id === 0x04 && i + 9 <= bytes.length) {
      // 0x04: Boot/Status Info Frame
      result.battery = bytes[i];
      result.hwVersion = `${bytes[i + 1]}.${bytes[i + 2]}`;
      result.firmwareVersion = `${bytes[i + 3]}.${bytes[i + 4]}`;
      const view = new DataView(bytes.buffer, bytes.byteOffset + i + 5, 4);
      result.uploadIntervalMin = view.getUint16(0, false);
      result.gpsIntervalMin = view.getUint16(2, false);
      i += 9;
    } else if (id === 0x05 && i + 4 <= bytes.length) {
      // 0x05: Interval downlink echo
      const view = new DataView(bytes.buffer, bytes.byteOffset + i, 4);
      result.uploadIntervalMin = view.getUint16(0, false);
      result.gpsIntervalMin = view.getUint16(2, false);
      i += 4;
    } else if (id === 0x06 && i + 1 <= bytes.length) {
      // 0x06: Sensor error state
      const err = bytes[i++];
      result.sensorState = err;
      result.sensorStateDesc = ERROR_DESCRIPTIONS[err] || `ERROR_0x${err.toString(16).toUpperCase()}`;
    } else {
      break;
    }
  }

  return result;
}

export const decodeH2Telemetry = decodeWs2001Telemetry;

/**
 * JavaScript Uplink Decoder for The Things Network v3 / The Things Stack.
 */
export const TTN_PAYLOAD_DECODER = `// The Things Network v3 / The Things Stack Uplink Payload Formatter
// For WeatherXM WS2001 (SenseCAP 8-in-1 Weather Station) in Open LoRaWAN Mode
function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;
  var data = {};
  var warnings = [];

  // Basics Modem Device Management (Clock sync, status)
  if (fPort === 199) {
    return { data: { dm_event: "Basics Modem DM Frame" } };
  }
  // Standard telemetry is sent on FPort 3
  if (fPort !== 3) {
    return { data: data, warnings: ["Unexpected FPort " + fPort] };
  }

  var i = 0;
  while (i < bytes.length) {
    var id = bytes[i++];
    if (id === 0x01 && i + 10 <= bytes.length) {
      // Weather Part 1: Temp (2B), Hum (1B), Lux (4B), UV (1B), Wind Speed (2B)
      var rawTemp = (bytes[i] << 8) | bytes[i + 1];
      if (rawTemp & 0x8000) rawTemp -= 0x10000;
      data.temperature = +(rawTemp / 10).toFixed(1);
      data.humidity = bytes[i + 2];
      data.lux = ((bytes[i + 3] << 24) >>> 0) | (bytes[i + 4] << 16) | (bytes[i + 5] << 8) | bytes[i + 6];
      data.uv_index = +(bytes[i + 7] / 10).toFixed(1);
      data.wind_speed = +(((bytes[i + 8] << 8) | bytes[i + 9]) / 10).toFixed(1);
      i += 10;
    } else if (id === 0x02 && i + 8 <= bytes.length) {
      // Weather Part 2: Wind Direction (2B), Rain Rate (4B), Pressure (2B)
      data.wind_direction = (bytes[i] << 8) | bytes[i + 1];
      var rawRain = ((bytes[i + 2] << 24) >>> 0) | (bytes[i + 3] << 16) | (bytes[i + 4] << 8) | bytes[i + 5];
      data.rain_rate = +(rawRain / 1000).toFixed(2);
      var rawPress = (bytes[i + 6] << 8) | bytes[i + 7];
      data.pressure = +(rawPress / 10).toFixed(1); // hPa
      data.pressure_pa = rawPress * 10;           // Pa
      i += 8;
    } else if (id === 0x03 && i + 1 <= bytes.length) {
      // Battery percentage
      data.battery = bytes[i++];
    } else if (id === 0x04 && i + 9 <= bytes.length) {
      // Boot / status diagnostic frame
      data.battery = bytes[i];
      data.hw_version = bytes[i + 1] + "." + bytes[i + 2];
      data.firmware_version = bytes[i + 3] + "." + bytes[i + 4];
      data.upload_interval_min = (bytes[i + 5] << 8) | bytes[i + 6];
      data.gps_interval_min = (bytes[i + 7] << 8) | bytes[i + 8];
      i += 9;
    } else if (id === 0x05 && i + 4 <= bytes.length) {
      data.upload_interval_min = (bytes[i] << 8) | bytes[i + 1];
      data.gps_interval_min = (bytes[i + 2] << 8) | bytes[i + 3];
      i += 4;
    } else if (id === 0x06 && i + 1 <= bytes.length) {
      var err = bytes[i++];
      data.sensor_error_code = err;
      var errMap = {
        0x00: "NONE", 0x01: "SENSOR_NOT_FOUND", 0x02: "WAKEUP_ERROR", 0x03: "NOT_RESPONSE",
        0x04: "DATA_EMPTY", 0x05: "DATA_HEAD_ERROR", 0x06: "DATA_CRC_ERROR",
        0x0C: "VALUE_TOO_HIGH", 0x0D: "VALUE_TOO_LOW", 0x0E: "VALUE_MISSED", 0xFF: "UNKNOWN"
      };
      data.sensor_error_desc = errMap[err] || ("ERROR_0x" + err.toString(16).toUpperCase());
    } else {
      break;
    }
  }

  return {
    data: data,
    warnings: warnings
  };
}
`;

/**
 * JavaScript Uplink Codec for ChirpStack v4.
 */
export const CHIRPSTACK_V4_PAYLOAD_DECODER = `// ChirpStack v4 Uplink Codec
// For WeatherXM WS2001 (SenseCAP 8-in-1 Weather Station) in Open LoRaWAN Mode
function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;
  var data = {};

  if (fPort === 199 || fPort !== 3) {
    return { data: data };
  }

  var i = 0;
  while (i < bytes.length) {
    var id = bytes[i++];
    if (id === 0x01 && i + 10 <= bytes.length) {
      var rawTemp = (bytes[i] << 8) | bytes[i + 1];
      if (rawTemp & 0x8000) rawTemp -= 0x10000;
      data.temperature = +(rawTemp / 10).toFixed(1);
      data.humidity = bytes[i + 2];
      data.lux = ((bytes[i + 3] << 24) >>> 0) | (bytes[i + 4] << 16) | (bytes[i + 5] << 8) | bytes[i + 6];
      data.uv_index = +(bytes[i + 7] / 10).toFixed(1);
      data.wind_speed = +(((bytes[i + 8] << 8) | bytes[i + 9]) / 10).toFixed(1);
      i += 10;
    } else if (id === 0x02 && i + 8 <= bytes.length) {
      data.wind_direction = (bytes[i] << 8) | bytes[i + 1];
      var rawRain = ((bytes[i + 2] << 24) >>> 0) | (bytes[i + 3] << 16) | (bytes[i + 4] << 8) | bytes[i + 5];
      data.rain_rate = +(rawRain / 1000).toFixed(2);
      var rawPress = (bytes[i + 6] << 8) | bytes[i + 7];
      data.pressure = +(rawPress / 10).toFixed(1);
      data.pressure_pa = rawPress * 10;
      i += 8;
    } else if (id === 0x03 && i + 1 <= bytes.length) {
      data.battery = bytes[i++];
    } else if (id === 0x04 && i + 9 <= bytes.length) {
      data.battery = bytes[i];
      data.hw_version = bytes[i + 1] + "." + bytes[i + 2];
      data.firmware_version = bytes[i + 3] + "." + bytes[i + 4];
      data.upload_interval_min = (bytes[i + 5] << 8) | bytes[i + 6];
      data.gps_interval_min = (bytes[i + 7] << 8) | bytes[i + 8];
      i += 9;
    } else if (id === 0x05 && i + 4 <= bytes.length) {
      data.upload_interval_min = (bytes[i] << 8) | bytes[i + 1];
      data.gps_interval_min = (bytes[i + 2] << 8) | bytes[i + 3];
      i += 4;
    } else if (id === 0x06 && i + 1 <= bytes.length) {
      var err = bytes[i++];
      data.sensor_error_code = err;
    } else {
      break;
    }
  }

  return { data: data };
}
`;

export const CHIRPSTACK_PAYLOAD_DECODER = CHIRPSTACK_V4_PAYLOAD_DECODER;

/**
 * JavaScript Uplink Codec for ChirpStack v3 (Legacy).
 */
export const CHIRPSTACK_V3_PAYLOAD_DECODER = `// ChirpStack v3 (Legacy) Uplink Codec
// For WeatherXM WS2001 (SenseCAP 8-in-1 Weather Station) in Open LoRaWAN Mode
function Decode(fPort, bytes, variables) {
  var data = {};

  if (fPort === 199 || fPort !== 3) {
    return data;
  }

  var i = 0;
  while (i < bytes.length) {
    var id = bytes[i++];
    if (id === 0x01 && i + 10 <= bytes.length) {
      var rawTemp = (bytes[i] << 8) | bytes[i + 1];
      if (rawTemp & 0x8000) rawTemp -= 0x10000;
      data.temperature = +(rawTemp / 10).toFixed(1);
      data.humidity = bytes[i + 2];
      data.lux = ((bytes[i + 3] << 24) >>> 0) | (bytes[i + 4] << 16) | (bytes[i + 5] << 8) | bytes[i + 6];
      data.uv_index = +(bytes[i + 7] / 10).toFixed(1);
      data.wind_speed = +(((bytes[i + 8] << 8) | bytes[i + 9]) / 10).toFixed(1);
      i += 10;
    } else if (id === 0x02 && i + 8 <= bytes.length) {
      data.wind_direction = (bytes[i] << 8) | bytes[i + 1];
      var rawRain = ((bytes[i + 2] << 24) >>> 0) | (bytes[i + 3] << 16) | (bytes[i + 4] << 8) | bytes[i + 5];
      data.rain_rate = +(rawRain / 1000).toFixed(2);
      var rawPress = (bytes[i + 6] << 8) | bytes[i + 7];
      data.pressure = +(rawPress / 10).toFixed(1);
      data.pressure_pa = rawPress * 10;
      i += 8;
    } else if (id === 0x03 && i + 1 <= bytes.length) {
      data.battery = bytes[i++];
    } else if (id === 0x04 && i + 9 <= bytes.length) {
      data.battery = bytes[i];
      data.hw_version = bytes[i + 1] + "." + bytes[i + 2];
      data.firmware_version = bytes[i + 3] + "." + bytes[i + 4];
      data.upload_interval_min = (bytes[i + 5] << 8) | bytes[i + 6];
      data.gps_interval_min = (bytes[i + 7] << 8) | bytes[i + 8];
      i += 9;
    } else if (id === 0x05 && i + 4 <= bytes.length) {
      data.upload_interval_min = (bytes[i] << 8) | bytes[i + 1];
      data.gps_interval_min = (bytes[i + 2] << 8) | bytes[i + 3];
      i += 4;
    } else if (id === 0x06 && i + 1 <= bytes.length) {
      data.sensor_error_code = bytes[i++];
    } else {
      break;
    }
  }

  return data;
}
`;
