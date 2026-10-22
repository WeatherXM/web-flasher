/**
 * Uplink payload decoders for the WeatherXM WS2001 / WS2000.
 *
 * The network-server decoders (TTN v3, ChirpStack v4, ChirpStack v3) are one shared script,
 * generated from the firmware repository (see ws2001UplinkDecoder.ts). It decodes the frames on FPort 99
 * (default, with wind gust and rain total): the 24-byte WeatherXM frame and the Open Edition frame (16 bytes in
 * V4.9 - V4.10, 20 bytes with wind direction spread, range and gust direction from V5.1), and the legacy
 * "Open LoRaWAN" TLV on FPort 3.
 *
 * decodeWs2001Telemetry() below previews the legacy FPort 3 TLV only.
 */
import { WS2001_UPLINK_DECODER } from './ws2001UplinkDecoder';

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

/** One script for The Things Stack v3 and ChirpStack v4 (decodeUplink) and ChirpStack v3 (Decode). */
export const TTN_PAYLOAD_DECODER = WS2001_UPLINK_DECODER;
export const CHIRPSTACK_V4_PAYLOAD_DECODER = WS2001_UPLINK_DECODER;
export const CHIRPSTACK_PAYLOAD_DECODER = WS2001_UPLINK_DECODER;
export const CHIRPSTACK_V3_PAYLOAD_DECODER = WS2001_UPLINK_DECODER;
export const DECODER_DOWNLOAD_PATH = '/decoders/ws2001_uplink_decoder.js';
