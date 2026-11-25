import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { decodeBthome, decodeCombinedPacket, decodeFramePacket, decodeInfoPacket, secondsToNextBurst } from '../../src/lib/ble/ws2001Beacon';

// The downloadable decoders (public/decoders, synced from ws2001-firmware by scripts/sync-ws2001-beacon.mjs)
const dir = path.join(__dirname, '../../public/decoders');
const ctx: Record<string, any> = {};
vm.createContext(ctx);
vm.runInContext(readFileSync(path.join(dir, 'ws2001_uplink_decoder.js'), 'utf8'), ctx);
vm.runInContext(readFileSync(path.join(dir, 'ws2001_beacon_decoder.js'), 'utf8'), ctx);

const bytes = (hex: string) => (hex.match(/../g) ?? []).map((h) => parseInt(h, 16));
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

// Captured off the air from two stations running V5.2
const FRAME_WXM = '11023cf0524e0a18bb005e1e00000000fa0200000000130100d927';
const FRAME_OPEN = '11043cff08ff7f80000000450000000900ffffffffffff';
const INFO = '153c2cf7f1c0424000375200004e011000d008076b0000fa020000';
const BTHOME_0 = '40002002260704848e012e304400004400005eb80b';
const BTHOME_1 = '40002305781e001500460050d008076b5f4500f2000205';

describe('WS2001 beacon: downloadable JavaScript decoder agrees with the page', () => {
  it.each([['WeatherXM 24-byte', FRAME_WXM], ['Open Edition 20-byte', FRAME_OPEN]])('frame packet, %s frame', (_n, hex) => {
    const js = ctx.wxmBeaconDecodeManufacturerData(bytes(hex));
    const ts = decodeFramePacket(new Uint8Array(bytes(hex)))!;
    expect(js.packet).toBe('frame');
    expect([js.utc_aligned, js.stale, js.frame_counter, js.period_s, js.frame_hex]).toEqual([ts.utcAligned, ts.stale, ts.frameCounter, ts.periodS, ts.frameHex]);
    for (const key of ['temperature', 'humidity', 'wind_speed', 'wind_gust', 'wind_direction', 'rain_accumulated', 'rain_rate', 'lux', 'uv_index', 'pressure', 'battery_low'] as const) {
      expect([key, js.data[key]]).toEqual([key, ts.data![key]]);
    }
  });

  it('info packet', () => {
    const js = ctx.wxmBeaconDecodeManufacturerData(bytes(INFO));
    const ts = decodeInfoPacket(new Uint8Array(bytes(INFO)))!;
    expect(plain(js)).toEqual({
      packet: 'info', utc_aligned: ts.utcAligned, period_s: ts.periodS, dev_eui: ts.devEui, name_suffix: ts.nameSuffix,
      firmware_version: ts.firmwareVersion, network_profile: ts.networkProfile, tx_power_dbm: ts.txPowerDbm,
      burst_offset_ms: ts.burstOffsetMs, uptime_min: ts.uptimeMin, unix_time: ts.unixTime, rain_rate: ts.rainRate, rain_total: ts.rainTotal,
    });
    expect(js.name_suffix).toBe('400037');
    expect(js.burst_offset_ms).toBe(334);
  });

  it('time to the next broadcast', () => {
    const js = ctx.wxmBeaconDecodeManufacturerData(bytes(INFO));
    for (const since of [0, 1000, 59000, 61000]) {
      expect(ctx.wxmBeaconMsToNextBurst(js, since) / 1000).toBeCloseTo(secondsToNextBurst(js.period_s, 0, js.burst_offset_ms, since), 6);
    }
  });

  it.each([['even', BTHOME_0], ['odd', BTHOME_1]])('BTHome packet, %s id', (_n, hex) => {
    const js = plain(ctx.wxmBeaconDecodeBthome(bytes(hex)));
    const ts = plain(decodeBthome(new Uint8Array(bytes(hex)))) as Record<string, unknown>;
    expect(js.packet_id).toBe(ts.packetId);
    delete js.packet_id;
    delete ts.packetId;
    expect(js).toEqual(ts);
  });

  it('long-range packet', () => {
    const info = bytes(INFO);
    info[0] = (info[0] & 0xf3) | (2 << 2);
    const frame = bytes(FRAME_WXM).slice(3);
    const packet = [...info, 7, frame.length, ...frame];
    const js = ctx.wxmBeaconDecodeManufacturerData(packet);
    const ts = decodeCombinedPacket(new Uint8Array(packet))!;
    expect(js.packet).toBe('long_range');
    expect(ts.map((p) => p.packet)).toEqual(['info', 'frame']);
    expect([js.name_suffix, js.burst_offset_ms, js.rain_total]).toEqual([(ts[0] as any).nameSuffix, (ts[0] as any).burstOffsetMs, (ts[0] as any).rainTotal]);
    expect([js.frame_counter, js.frame_hex, js.data.temperature]).toEqual([(ts[1] as any).frameCounter, (ts[1] as any).frameHex, (ts[1] as any).data.temperature]);
  });

  it('rejects data that is not a beacon', () => {
    expect(ctx.wxmBeaconDecodeManufacturerData(bytes('4c000215'))).toBeNull();
    expect(ctx.wxmBeaconDecodeBthome(bytes('410001'))).toBeNull();
  });
});

describe('WS2001 beacon: downloadable Python listener', () => {
  it('is the public copy, with install and reference pointers', () => {
    const py = readFileSync(path.join(dir, 'ws2001_beacon.py'), 'utf8');
    expect(py).toContain('pip install bleak');
    expect(py).toContain('https://flash.weatherxm.com/ws2001/beacon/reference');
    expect(py).toContain('def decode_combined_packet');
  });
});
