import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TTN_PAYLOAD_DECODER, CHIRPSTACK_V3_PAYLOAD_DECODER } from '../../src/lib/ble/ws2001Decoder';
import { WS2001_UPLINK_DECODER } from '../../src/lib/ble/ws2001UplinkDecoder';
import { parseNetProfile } from '../../src/lib/ble/ws2001AtClient';

// Packs a frame the way the firmware does (sensor_data.c update_sensor_data_v_wxm).
function weatherFrame(tag = 0xf0): number[] {
  const b = new Array(24).fill(0);
  b[0] = tag;
  b[1] = 0x45; // V4.5
  b[2] = 14 | (2 << 5); // tx power 14, HW 1.1
  b[3] = 5; // 5-minute interval
  b[4] = 25; // samples
  b[5] = 235 & 0xff; b[6] = 235 >> 8; // 23.5 C
  const hd = (56 << 9) | 270; b[7] = hd >> 8; b[8] = hd & 0xff;
  const uw = (3 << 11) | 31; b[9] = uw >> 8; b[10] = uw & 0xff;
  b[11] = 52; b[12] = 0; // gust 5.2 m/s
  const rain = 12345; b[13] = rain & 0xff; b[14] = rain >> 8;
  b[17] = 12; // 1.2 mm/h
  const lux = 54321; b[19] = lux & 0xff; b[20] = (lux >> 8) & 0xff; b[21] = lux >> 16;
  b[22] = 10132 & 0xff; b[23] = 10132 >> 8; // 1013.2 hPa
  return b;
}

function openWeatherFrame(lowBat = true): number[] {
  const b = new Array(16).fill(0);
  const hd = (56 << 9) | 270; b[0] = hd >> 8; b[1] = hd & 0xff; // 56% RH, 270 deg
  b[2] = 235 & 0xff; b[3] = 235 >> 8; // 23.5 C
  const buw = (lowBat ? 0x8000 : 0) | (3 << 11) | 31; b[4] = buw >> 8; b[5] = buw & 0xff;
  b[6] = 52; b[7] = 0; // gust 5.2 m/s
  const rain = 123; b[8] = rain & 0xff; b[9] = rain >> 8; // 12.3 mm (0.1 mm steps)
  b[10] = 12; b[11] = 0; // 1.2 mm/h
  const lux = 5432; b[12] = lux & 0xff; b[13] = lux >> 8; // 54320 lux (10 lux steps)
  b[14] = 10132 & 0xff; b[15] = 10132 >> 8; // 1013.2 hPa
  return b;
}

describe('WS2001 uplink decoder (shared with the firmware repo)', () => {
  it('matches the downloadable public/decoders copy', () => {
    const file = readFileSync(path.join(__dirname, '../../public/decoders/ws2001_uplink_decoder.js'), 'utf8');
    expect(WS2001_UPLINK_DECODER).toBe(file.replace(/\r\n/g, '\n'));
  });

  it('decodes the 24-byte WeatherXM frame on FPort 99, including wind gust', () => {
    const decodeUplink = new Function(`${TTN_PAYLOAD_DECODER}; return decodeUplink;`)();
    const { data } = decodeUplink({ bytes: weatherFrame(), fPort: 99 });
    expect(data.frame).toBe('weather');
    expect(data.firmware_version).toBe('4.5');
    expect(data.temperature).toBe(23.5);
    expect(data.humidity).toBe(56);
    expect(data.wind_direction).toBe(270);
    expect(data.wind_speed).toBe(3.1);
    expect(data.wind_gust).toBe(5.2);
    expect(data.rain_accumulated).toBe(12.345);
    expect(data.rain_rate).toBe(1.2);
    expect(data.lux).toBe(54321);
    expect(data.pressure).toBe(1013.2);
    expect(data.pressure_pa).toBeUndefined();
    expect(data.upload_interval_min).toBe(5);
  });

  it('decodes the 16-byte Open Edition frame on FPort 99 with battery_low mixed into uv_index', () => {
    const decodeUplink = new Function(`${TTN_PAYLOAD_DECODER}; return decodeUplink;`)();
    const { data } = decodeUplink({ bytes: openWeatherFrame(true), fPort: 99 });
    expect(data.frame).toBe('weather');
    expect(data.firmware_version).toBeUndefined();
    expect(data.battery_low).toBe(true);
    expect(data.temperature).toBe(23.5);
    expect(data.humidity).toBe(56);
    expect(data.wind_direction).toBe(270);
    expect(data.uv_index).toBe(3);
    expect(data.wind_speed).toBe(3.1);
    expect(data.wind_gust).toBe(5.2);
    expect(data.rain_accumulated).toBe(12.3);
    expect(data.rain_rate).toBe(1.2);
    expect(data.lux).toBe(54320);
    expect(data.pressure).toBe(1013.2);
    expect(data.pressure_pa).toBeUndefined();
  });

  it('decodes signed frames and works as a ChirpStack v3 codec', () => {
    const Decode = new Function(`${CHIRPSTACK_V3_PAYLOAD_DECODER}; return Decode;`)();
    const data = Decode(99, weatherFrame(0xf1).concat(new Array(64).fill(0x11)), {});
    expect(data.frame).toBe('weather_signed');
    expect(data.signature).toHaveLength(128);
    expect(data.wind_gust).toBe(5.2);
  });
});

describe('AT+NETPROFILE parsing', () => {
  it('parses the V4.5 response', () => {
    expect(parseNetProfile("{active: 1, weatherxm: 'stored', custom: 'stored'}\r\n\r\nOK\r\n")).toEqual({
      active: 1, weatherxmStored: true, customStored: true,
    });
    expect(parseNetProfile("{active: 0, weatherxm: 'stored', custom: 'empty'}\r\nOK\r\n")?.customStored).toBe(false);
  });

  it('returns null on firmware without profiles', () => {
    expect(parseNetProfile('\r\nAT_ERROR\r\n')).toBeNull();
  });
});

describe('AT log redaction', () => {
  it('hides AppKey writes and key fields in AT+CONFIG output', async () => {
    const { redactAtLog } = await import('../../src/lib/ble/ws2001AtClient');
    expect(redactAtLog('AT+APPKEY=00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF')).toBe('AT+APPKEY=<hidden>');
    const cfg = "{appEui: '80:00:00:00:00:00:00:09',nwkSkey: '00:11',appSkey: '22:33',devKey: 'B6:BC:61'}";
    const out = redactAtLog(cfg);
    expect(out).toContain("appEui: '80:00:00:00:00:00:00:09'");
    expect(out).not.toMatch(/B6:BC|00:11|22:33/);
  });
});
