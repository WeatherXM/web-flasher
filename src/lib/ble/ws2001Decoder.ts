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
  battery?: number;          // %
  sensorState?: number;
}

export type DecodedH2Telemetry = DecodedWs2001Telemetry;

/**
 * Pure decoder function for tests and UI preview.
 */
export function decodeWs2001Telemetry(bytes: Uint8Array): DecodedWs2001Telemetry {
  const result: DecodedWs2001Telemetry = {};
  let i = 0;

  while (i < bytes.length) {
    const id = bytes[i++];
    if (id === 0x01 && i + 10 <= bytes.length) {
      // 0x01: Temp (2B int16), Hum (1B uint8), Lux (4B uint32), UV (1B uint8), Wind Speed (2B uint16)
      const view = new DataView(bytes.buffer, bytes.byteOffset + i, 10);
      result.temperature = Number((view.getInt16(0, false) / 10).toFixed(1));
      result.humidity = view.getUint8(2);
      result.lux = view.getUint32(3, false);
      result.uvIndex = view.getUint8(7);
      result.windSpeed = Number((view.getUint16(8, false) / 10).toFixed(1));
      i += 10;
    } else if (id === 0x02 && i + 8 <= bytes.length) {
      // 0x02: Wind Dir (2B uint16), Rain (4B uint32 / 10), Baro Pressure (2B uint16 / 10)
      const view = new DataView(bytes.buffer, bytes.byteOffset + i, 8);
      result.windDirection = view.getUint16(0, false);
      result.rainIntensity = Number((view.getUint32(2, false) / 10).toFixed(1));
      result.pressure = Number((view.getUint16(6, false) / 10).toFixed(1));
      i += 8;
    } else if (id === 0x03 && i + 1 <= bytes.length) {
      // 0x03: Battery (1B uint8 0-100)
      result.battery = bytes[i++];
    } else if (id === 0x06 && i + 1 <= bytes.length) {
      // 0x06: Sensor error state
      result.sensorState = bytes[i++];
    } else {
      // Unknown or variable length tag; break or skip
      break;
    }
  }

  return result;
}

export const decodeH2Telemetry = decodeWs2001Telemetry;

/**
 * Ready-to-paste JavaScript decoder script for The Things Network (TTN v3 / The Things Stack).
 */
export const TTN_PAYLOAD_DECODER = `// The Things Network v3 / The Things Stack Uplink Decoder
// For WeatherXM WS2001 in Open LoRaWAN Mode (FPort 3)
function decodeUplink(input) {
  var bytes = input.bytes;
  var port = input.fPort;
  var data = {};
  var warnings = [];

  if (port !== 3) {
    return { data: data, warnings: ["Unexpected FPort " + port] };
  }

  var i = 0;
  while (i < bytes.length) {
    var id = bytes[i++];
    if (id === 0x01 && i + 10 <= bytes.length) {
      var rawTemp = (bytes[i] << 8) | bytes[i + 1];
      if (rawTemp & 0x8000) rawTemp -= 0x10000; // int16 signed
      data.temperature = +(rawTemp / 10).toFixed(1);
      data.humidity = bytes[i + 2];
      data.lux = (bytes[i + 3] << 24) | (bytes[i + 4] << 16) | (bytes[i + 5] << 8) | bytes[i + 6];
      data.uv_index = bytes[i + 7];
      data.wind_speed = +(((bytes[i + 8] << 8) | bytes[i + 9]) / 10).toFixed(1);
      i += 10;
    } else if (id === 0x02 && i + 8 <= bytes.length) {
      data.wind_direction = (bytes[i] << 8) | bytes[i + 1];
      var rawRain = (bytes[i + 2] << 24) | (bytes[i + 3] << 16) | (bytes[i + 4] << 8) | bytes[i + 5];
      data.rain_rate = +(rawRain / 10).toFixed(1);
      data.pressure = +(((bytes[i + 6] << 8) | bytes[i + 7]) / 10).toFixed(1);
      i += 8;
    } else if (id === 0x03 && i + 1 <= bytes.length) {
      data.battery = bytes[i++];
    } else if (id === 0x06 && i + 1 <= bytes.length) {
      data.sensor_state = bytes[i++];
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
 * Ready-to-paste JavaScript decoder script for ChirpStack v4.
 */
export const CHIRPSTACK_PAYLOAD_DECODER = `// ChirpStack v4 Uplink Codec
// For WeatherXM WS2001 in Open LoRaWAN Mode (FPort 3)
function decodeUplink(input) {
  var bytes = input.bytes;
  var fPort = input.fPort;
  var obj = {};

  if (fPort !== 3) {
    return { data: obj };
  }

  var i = 0;
  while (i < bytes.length) {
    var id = bytes[i++];
    if (id === 0x01 && i + 10 <= bytes.length) {
      var rawTemp = (bytes[i] << 8) | bytes[i + 1];
      if (rawTemp & 0x8000) rawTemp -= 0x10000;
      obj.temperature = +(rawTemp / 10).toFixed(1);
      obj.humidity = bytes[i + 2];
      obj.lux = (bytes[i + 3] << 24) | (bytes[i + 4] << 16) | (bytes[i + 5] << 8) | bytes[i + 6];
      obj.uv_index = bytes[i + 7];
      obj.wind_speed = +(((bytes[i + 8] << 8) | bytes[i + 9]) / 10).toFixed(1);
      i += 10;
    } else if (id === 0x02 && i + 8 <= bytes.length) {
      obj.wind_direction = (bytes[i] << 8) | bytes[i + 1];
      var rawRain = (bytes[i + 2] << 24) | (bytes[i + 3] << 16) | (bytes[i + 4] << 8) | bytes[i + 5];
      obj.rain_rate = +(rawRain / 10).toFixed(1);
      obj.pressure = +(((bytes[i + 6] << 8) | bytes[i + 7]) / 10).toFixed(1);
      i += 8;
    } else if (id === 0x03 && i + 1 <= bytes.length) {
      obj.battery = bytes[i++];
    } else if (id === 0x06 && i + 1 <= bytes.length) {
      obj.sensor_state = bytes[i++];
    } else {
      break;
    }
  }

  return {
    data: obj
  };
}
`;
