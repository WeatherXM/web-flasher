import { describe, it, expect } from 'vitest';
import { buildTtnEndDevice, ttnFrequencyPlan, ttnImportJson, ttnImportFileName } from '../../src/lib/ble/ws2001TtnExport';
import { WS2001_UPLINK_DECODER } from '../../src/lib/ble/ws2001UplinkDecoder';

const base = {
  devEui: '2C:F7:F1:C0:44:80:00:E6',
  joinEui: '0000000000000000',
  appKey: '00112233445566778899aabbccddeeff',
  band: 5,
};

describe('WS2001 TTN import JSON', () => {
  it('builds an OTAA LoRaWAN 1.0.4 / RP002 1.0.3 end device', () => {
    const d = buildTtnEndDevice(base);
    expect(d.ids).toEqual({ device_id: 'ws2001-8000e6', dev_eui: '2CF7F1C0448000E6', join_eui: '0000000000000000' });
    expect(d.lorawan_version).toBe('MAC_V1_0_4');
    expect(d.lorawan_phy_version).toBe('RP002_V1_0_3');
    expect(d.frequency_plan_id).toBe('EU_863_870_TTN');
    expect(d.supports_join).toBe(true);
    expect(d.root_keys.app_key.key).toBe('00112233445566778899AABBCCDDEEFF');
    expect(d.description).toMatch(/Weather frame on FPort 99: 20 bytes from firmware V5\.1/);
    expect(d.description).toMatch(/16 bytes on V4\.9-V4\.10, 24 bytes on V4\.8 and earlier/);
  });

  it('maps regions and US/AU sub-bands to TTN frequency plans', () => {
    expect(ttnFrequencyPlan(8, 1)).toBe('US_902_928_FSB_2');
    expect(ttnFrequencyPlan(1, 0)).toBe('AU_915_928_FSB_1');
    expect(ttnFrequencyPlan(15)).toBe('AS_923');
    expect(ttnFrequencyPlan(7)).toBe('IN_865_867');
    expect(ttnFrequencyPlan(6)).toBe('KR_920_923_TTN');
    expect(ttnFrequencyPlan(9)).toBe('RU_864_870_TTN');
    expect(ttnFrequencyPlan(10)).toBeNull();
  });

  it('rejects malformed keys and unsupported regions', () => {
    expect(() => buildTtnEndDevice({ ...base, appKey: '1234' })).toThrow(/AppKey/);
    expect(() => buildTtnEndDevice({ ...base, band: 10 })).toThrow(/frequency plan/);
  });

  it('attaches the WS2001 uplink decoder as the JavaScript uplink formatter', () => {
    const d = JSON.parse(ttnImportJson(base));
    expect(d.formatters.up_formatter).toBe('FORMATTER_JAVASCRIPT');
    expect(d.formatters.up_formatter_parameter).toBe(WS2001_UPLINK_DECODER);

    // The formatter survives the JSON round trip and decodes the 16-byte Open Edition frame (V4.9+) on FPort 99,
    // here an uplink a station sent to TTN.
    const decodeUplink = new Function(`${d.formatters.up_formatter_parameter}; return decodeUplink;`)();
    const open = Array.from(Buffer.from('a8c6be00000000006627000000003013', 'hex'));
    const openDecoded = decodeUplink({ bytes: open, fPort: 99 }).data;
    expect(openDecoded.frame).toBe('weather');
    expect(openDecoded.humidity).toBe(84);
    expect(openDecoded.wind_direction).toBe(198);
    expect(openDecoded.temperature).toBe(19);
    expect(openDecoded.rain_accumulated).toBe(1008.6);
    expect(openDecoded.pressure).toBe(491.2);
    expect(openDecoded.wind_direction_sigma).toBeUndefined();

    // ...the 20-byte frame of V5.1+: the same 16 bytes, then spread 47 deg, range 180..270 deg, gust direction 182 deg
    const open20 = open.concat([47, 90, 135, 91]);
    const open20Decoded = decodeUplink({ bytes: open20, fPort: 99 }).data;
    expect(open20Decoded.temperature).toBe(19);
    expect(open20Decoded.wind_direction_sigma).toBe(47);
    expect(open20Decoded.wind_direction_range_start).toBe(180);
    expect(open20Decoded.wind_direction_range_end).toBe(270);
    expect(open20Decoded.wind_direction_range_width).toBe(90);
    expect(open20Decoded.wind_gust_direction).toBe(182);

    // ...and the 24-byte WeatherXM frame that V4.8 and earlier send.
    const frame = new Array(24).fill(0);
    frame[0] = 0xf0;
    frame[1] = 0x49; // V4.9
    frame[5] = 235 & 0xff; frame[6] = 235 >> 8; // 23.5 C
    const { data } = decodeUplink({ bytes: frame, fPort: 99 });
    expect(data.frame).toBe('weather');
    expect(data.firmware_version).toBe('4.9');
    expect(data.temperature).toBe(23.5);
  });

  it('produces a single JSON object and a per-station file name', () => {
    expect(JSON.parse(ttnImportJson(base)).ids.device_id).toBe('ws2001-8000e6');
    expect(ttnImportFileName(base)).toBe('ttn-import-ws2001-8000e6.json');
  });
});
