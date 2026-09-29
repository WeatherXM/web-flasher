import { describe, it, expect } from 'vitest';
import { decodeH2Telemetry, TTN_PAYLOAD_DECODER, CHIRPSTACK_PAYLOAD_DECODER } from '../../src/lib/ble/h2Decoder';

describe('H2 Payload Decoder', () => {
  it('correctly decodes standard SenseCAP 8-in-1 Big-Endian telemetry packet', () => {
    // Construct test payload:
    // Tag 0x01 (10 bytes):
    // Temp = 23.5°C (235 = 0x00EB)
    // Hum = 65% (0x41)
    // Lux = 10000 lx (0x00002710)
    // UV = 5 (0x05)
    // Wind Speed = 3.2 m/s (32 = 0x0020)
    // Tag 0x02 (8 bytes):
    // Wind Dir = 180° (0x00B4)
    // Rain = 12.5 mm/h (125 = 0x0000007D)
    // Baro Pressure = 1013.2 hPa (10132 = 0x2794)
    // Tag 0x03 (1 byte):
    // Battery = 95% (0x5F)

    const payload = new Uint8Array([
      0x01,
      0x00, 0xEB, // Temp 23.5
      0x41,       // Hum 65
      0x00, 0x00, 0x27, 0x10, // Lux 10000
      0x05,       // UV 5
      0x00, 0x20, // Wind Speed 3.2
      0x02,
      0x00, 0xB4, // Wind Dir 180
      0x00, 0x00, 0x00, 0x7D, // Rain 12.5
      0x27, 0x94, // Pressure 1013.2
      0x03,
      0x5F,       // Battery 95
    ]);

    const decoded = decodeH2Telemetry(payload);

    expect(decoded.temperature).toBe(23.5);
    expect(decoded.humidity).toBe(65);
    expect(decoded.lux).toBe(10000);
    expect(decoded.uvIndex).toBe(5);
    expect(decoded.windSpeed).toBe(3.2);
    expect(decoded.windDirection).toBe(180);
    expect(decoded.rainIntensity).toBe(12.5);
    expect(decoded.pressure).toBe(1013.2);
    expect(decoded.battery).toBe(95);
  });

  it('handles negative temperatures correctly (signed int16)', () => {
    // -5.4°C = -54 = 0xFFCA
    const payload = new Uint8Array([
      0x01,
      0xFF, 0xCA, // -5.4
      0x50,       // 80%
      0x00, 0x00, 0x00, 0x64, // 100 lux
      0x01,       // UV 1
      0x00, 0x0A, // 1.0 m/s
    ]);

    const decoded = decodeH2Telemetry(payload);
    expect(decoded.temperature).toBe(-5.4);
    expect(decoded.humidity).toBe(80);
  });

  it('provides valid JS code in TTN and ChirpStack snippet templates', () => {
    expect(TTN_PAYLOAD_DECODER).toContain('function decodeUplink');
    expect(TTN_PAYLOAD_DECODER).toContain('port !== 3');
    expect(CHIRPSTACK_PAYLOAD_DECODER).toContain('function decodeUplink');
  });
});
