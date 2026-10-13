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
    expect(data.upload_interval_min).toBe(5);
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
