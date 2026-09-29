import { describe, it, expect } from 'vitest';
import { formatHexWithColons, parseAtConfig, REGION_NAMES } from '../../src/lib/ble/h2AtClient';

describe('H2AtClient helpers', () => {
  it('formats hex strings with colons correctly for 8-byte DevEUI/JoinEUI', () => {
    const raw = '0123456789abcdef';
    const formatted = formatHexWithColons(raw, 8);
    expect(formatted).toBe('01:23:45:67:89:AB:CD:EF');
  });

  it('formats hex strings with colons correctly for 16-byte AppKey', () => {
    const raw = '00112233445566778899aabbccddeeff';
    const formatted = formatHexWithColons(raw, 16);
    expect(formatted).toBe('00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF');
  });

  it('ignores existing colons, spaces, and dashes during formatting', () => {
    const raw = '00-11-22:33 44 55 66 77';
    const formatted = formatHexWithColons(raw, 8);
    expect(formatted).toBe('00:11:22:33:44:55:66:77');
  });

  it('throws when hex character length does not match expected byte count', () => {
    expect(() => formatHexWithColons('1234', 8)).toThrow(/Invalid length/);
    expect(() => formatHexWithColons('001122334455667788', 8)).toThrow(/Invalid length/);
  });

  it('correctly parses AT+CONFIG=? JSON response', () => {
    const sampleConfig = `{deviceModel: "WS2001",deviceEui: "24:E1:24:12:8A:00:11:22",appEui: "70:B3:D5:7E:D0:00:12:34",version: "v1.2.0",classType: "A",electricity: "3.1V",collectInterval: 3,gpsUplinkInterval: 1440,frequency: 8,subBand: 1,'3c': 0,joinType: 1,nwkSkey: "...",appSkey: "...",devAddr: "...",devCode: "...",platform: 0,devKey: "..."}`;

    const parsed = parseAtConfig(sampleConfig);
    expect(parsed.deviceModel).toBe('WS2001');
    expect(parsed.deviceEui).toBe('24E124128A001122');
    expect(parsed.formattedDevEui).toBe('24:E1:24:12:8A:00:11:22');
    expect(parsed.appEui).toBe('70B3D57ED0001234');
    expect(parsed.version).toBe('v1.2.0');
    expect(parsed.uploadInterval).toBe(3);
    expect(parsed.frequencyBand).toBe(8);
    expect(parsed.frequencyName).toBe('US915');
    expect(parsed.subBand).toBe(1);
    expect(parsed.battery).toBe('3.1V');
  });

  it('handles EU868 region mapping correctly', () => {
    expect(REGION_NAMES[5]).toBe('EU868');
    expect(REGION_NAMES[8]).toBe('US915');
    expect(REGION_NAMES[1]).toBe('AU915');
    expect(REGION_NAMES[15]).toBe('AS923-1 (Standard TTN/ChirpStack)');
  });
});
