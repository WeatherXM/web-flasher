import { describe, it, expect } from 'vitest';
import {
  decodeWs2001Telemetry,
  TTN_PAYLOAD_DECODER,
  CHIRPSTACK_V4_PAYLOAD_DECODER,
  CHIRPSTACK_V3_PAYLOAD_DECODER,
} from '../../src/lib/ble/ws2001Decoder';

describe('WS2001 Payload Decoder', () => {
  it('correctly decodes standard SenseCAP 8-in-1 Big-Endian telemetry packet', () => {
    // Construct test payload:
    // Tag 0x01 (10 bytes):
    // Temp = 23.5°C (235 = 0x00EB)
    // Hum = 65% (0x41)
    // Lux = 10000 lx (0x00002710)
    // UV = 5.0 (50 = 0x32)
    // Wind Speed = 3.2 m/s (32 = 0x0020)
    // Tag 0x02 (8 bytes):
    // Wind Dir = 180° (0x00B4)
    // Rain Rate = 1.25 mm/h (1250 = 0x000004E2 / 1000)
    // Baro Pressure = 1013.2 hPa (10132 = 0x2794)
    // Tag 0x03 (1 byte):
    // Battery = 95% (0x5F)

    const payload = new Uint8Array([
      0x01,
      0x00, 0xEB, // Temp 23.5
      0x41,       // Hum 65
      0x00, 0x00, 0x27, 0x10, // Lux 10000
      0x32,       // UV 5.0 (50 / 10)
      0x00, 0x20, // Wind Speed 3.2
      0x02,
      0x00, 0xB4, // Wind Dir 180
      0x00, 0x00, 0x04, 0xE2, // Rain Rate 1.25 (1250 / 1000)
      0x27, 0x94, // Pressure 1013.2
      0x03,
      0x5F,       // Battery 95
    ]);

    const decoded = decodeWs2001Telemetry(payload);

    expect(decoded.temperature).toBe(23.5);
    expect(decoded.humidity).toBe(65);
    expect(decoded.lux).toBe(10000);
    expect(decoded.uvIndex).toBe(5.0);
    expect(decoded.windSpeed).toBe(3.2);
    expect(decoded.windDirection).toBe(180);
    expect(decoded.rainIntensity).toBe(1.25);
    expect(decoded.pressure).toBe(1013.2);
    expect(decoded.pressurePa).toBe(101320);
    expect(decoded.battery).toBe(95);
  });

  it('handles negative temperatures correctly (signed int16)', () => {
    // -5.4°C = -54 = 0xFFCA
    const payload = new Uint8Array([
      0x01,
      0xFF, 0xCA, // -5.4
      0x50,       // 80%
      0x00, 0x00, 0x00, 0x64, // 100 lux
      0x0A,       // UV 1.0 (10 / 10)
      0x00, 0x0A, // 1.0 m/s
    ]);

    const decoded = decodeWs2001Telemetry(payload);
    expect(decoded.temperature).toBe(-5.4);
    expect(decoded.humidity).toBe(80);
    expect(decoded.lux).toBe(100);
    expect(decoded.uvIndex).toBe(1.0);
    expect(decoded.windSpeed).toBe(1.0);
  });

  it('decodes boot / diagnostic frame (Tag 0x04)', () => {
    // Tag 0x04 (9 bytes):
    // Battery = 100% (0x64)
    // HW Version = 1.1 (0x01, 0x01)
    // FW Version = 2.4 (0x02, 0x04)
    // Upload Interval = 3 min (0x0003)
    // GPS Interval = 1440 min (0x05A0)
    const payload = new Uint8Array([
      0x04,
      0x64,
      0x01, 0x01,
      0x02, 0x04,
      0x00, 0x03,
      0x05, 0xA0,
    ]);

    const decoded = decodeWs2001Telemetry(payload);
    expect(decoded.battery).toBe(100);
    expect(decoded.hwVersion).toBe('1.1');
    expect(decoded.firmwareVersion).toBe('2.4');
    expect(decoded.uploadIntervalMin).toBe(3);
    expect(decoded.gpsIntervalMin).toBe(1440);
  });

  it('provides executable TTN v3 decoder script', () => {
    const fn = new Function(`${TTN_PAYLOAD_DECODER}; return decodeUplink;`)();
    const result = fn({
      bytes: [
        0x01, 0x00, 0xEB, 0x2A, 0x00, 0x00, 0x3A, 0x98, 0x0F, 0x00, 0x23,
        0x02, 0x00, 0xB4, 0x00, 0x00, 0x04, 0xE2, 0x27, 0x94,
        0x03, 0x64
      ],
      fPort: 3,
    });

    expect(result.data.temperature).toBe(23.5);
    expect(result.data.humidity).toBe(42);
    expect(result.data.lux).toBe(15000);
    expect(result.data.uv_index).toBe(1.5);
    expect(result.data.wind_speed).toBe(3.5);
    expect(result.data.wind_direction).toBe(180);
    expect(result.data.rain_rate).toBe(1.25);
    expect(result.data.pressure).toBe(1013.2);
    expect(result.data.pressure_pa).toBe(101320);
    expect(result.data.battery).toBe(100);
  });

  it('provides executable ChirpStack v4 codec script', () => {
    const fn = new Function(`${CHIRPSTACK_V4_PAYLOAD_DECODER}; return decodeUplink;`)();
    const result = fn({
      bytes: [
        0x01, 0x00, 0xEB, 0x2A, 0x00, 0x00, 0x3A, 0x98, 0x0F, 0x00, 0x23,
        0x02, 0x00, 0xB4, 0x00, 0x00, 0x04, 0xE2, 0x27, 0x94,
      ],
      fPort: 3,
    });

    expect(result.data.temperature).toBe(23.5);
    expect(result.data.rain_rate).toBe(1.25);
  });

  it('provides executable ChirpStack v3 codec script', () => {
    const fn = new Function(`${CHIRPSTACK_V3_PAYLOAD_DECODER}; return Decode;`)();
    const result = fn(3, [
      0x01, 0x00, 0xEB, 0x2A, 0x00, 0x00, 0x3A, 0x98, 0x0F, 0x00, 0x23,
      0x02, 0x00, 0xB4, 0x00, 0x00, 0x04, 0xE2, 0x27, 0x94,
      0x03, 0x64
    ], {});

    expect(result.temperature).toBe(23.5);
    expect(result.pressure).toBe(1013.2);
    expect(result.battery).toBe(100);
  });
});
