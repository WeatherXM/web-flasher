import { describe, it, expect } from 'vitest';
import { WS2001_UPLINK_DECODER } from '../../src/lib/ble/ws2001UplinkDecoder';
import {
  BEACON_COMPANY_ID,
  BTHOME_SERVICE_UUID,
  beaconCommand,
  beaconTimeCommand,
  decodeAdvertisement,
  decodeBthome,
  decodeCombinedPacket,
  decodeFramePacket,
  decodeInfoPacket,
  decodeManufacturerData,
  decodePeriod,
  decodeWeatherFrame,
  isValidBeaconPeriod,
  parseBeaconSettings,
  secondsToNextBurst,
} from '../../src/lib/ble/ws2001Beacon';

const bytes = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

// The published LoRaWAN decoder (source of truth for the weather frame)
const decodeUplink = new Function(`${WS2001_UPLINK_DECODER}; return decodeUplink;`)() as (input: {
  bytes: number[];
  fPort: number;
}) => { data: Record<string, unknown> };

// 24-byte WeatherXM frame: 21.5 C, 55 %, 270 deg, UV 3, 4.2 m/s, gust 7.9, 12.345 mm, 1.5 mm/h, 54321 lux, 1013.2 hPa
function weatherXmFrame(): number[] {
  const hd = (55 << 9) | 270;
  const uw = (3 << 11) | 42;
  return [0xf0, 0x52, 0x4e, 0x83, 15, ...u16(215), hd >> 8, hd & 0xff, uw >> 8, uw & 0xff, ...u16(79), ...u32(12345), ...u16(15),
    54321 & 0xff, (54321 >> 8) & 0xff, 54321 >> 16, ...u16(10132)];
}

// 20-byte Open Edition frame captured from a V5.2 station (sensor without temperature/humidity/pressure)
const OPEN_FRAME = 'fefdff7f000000003a0000000000ffffffffffff';

// 20-byte Open Edition frame with every field set
function openFrame(): number[] {
  const hd = (56 << 9) | 270;
  const buw = 0x8000 | (3 << 11) | 31;
  return [hd >> 8, hd & 0xff, ...u16(0x10000 - 35), buw >> 8, buw & 0xff, ...u16(52), ...u16(58), ...u16(12), ...u16(5432), ...u16(10132), 17, 120, 150, 135];
}

describe('WS2001 beacon: weather frame', () => {
  const shared = ['temperature', 'humidity', 'wind_speed', 'wind_gust', 'wind_direction', 'rain_accumulated', 'rain_rate', 'lux', 'uv_index', 'pressure', 'battery_low'] as const;

  it.each([
    ['WeatherXM 24-byte', weatherXmFrame()],
    ['Open Edition 20-byte', openFrame()],
    ['Open Edition 20-byte, captured', Array.from(bytes(OPEN_FRAME))],
    ['Open Edition 16-byte', openFrame().slice(0, 16)],
  ])('decodes the %s frame like the published LoRaWAN decoder', (_name, frame) => {
    const ours = decodeWeatherFrame(new Uint8Array(frame))!;
    const reference = decodeUplink({ bytes: frame, fPort: 99 }).data;
    expect(ours).not.toBeNull();
    for (const key of shared) expect([key, ours[key]]).toEqual([key, reference[key]]);
    if (frame.length >= 20 && frame[0] !== 0xf0) {
      expect(ours.wind_direction_sigma).toEqual(reference.wind_direction_sigma);
      expect(ours.wind_direction_range_start).toEqual(reference.wind_direction_range_start);
      expect(ours.wind_direction_range_end).toEqual(reference.wind_direction_range_end);
      expect(ours.wind_gust_direction).toEqual(reference.wind_gust_direction);
    }
  });

  it('reads the values of the WeatherXM frame', () => {
    const d = decodeWeatherFrame(new Uint8Array(weatherXmFrame()))!;
    expect(d).toMatchObject({ format: 'weatherxm', firmware_version: '5.2', upload_interval_min: 3, battery_low: true, temperature: 21.5, humidity: 55, wind_direction: 270, uv_index: 3, wind_speed: 4.2, wind_gust: 7.9, rain_accumulated: 12.345, rain_rate: 1.5, lux: 54321, pressure: 1013.2 });
  });

  it('rejects boot frames and short data', () => {
    expect(decodeWeatherFrame(bytes('f2520e0000000000000000'))).toBeNull();
    expect(decodeWeatherFrame(bytes('0102'))).toBeNull();
  });
});

describe('WS2001 beacon: manufacturer data packets', () => {
  it('decodes the frame packet header', () => {
    const p = decodeFramePacket(bytes(`10010a${OPEN_FRAME}`))!;
    expect(p).toMatchObject({ packet: 'frame', utcAligned: false, stale: false, frameCounter: 1, periodS: 10, frameHex: OPEN_FRAME });
    expect(p.data).toMatchObject({ format: 'open', wind_direction: 253, humidity: null, rain_accumulated: 5.8 });
    expect(decodeFramePacket(bytes(`13ff85${OPEN_FRAME}`))).toMatchObject({ utcAligned: true, stale: true, frameCounter: 255, periodS: 300 });
  });

  it('decodes the period byte', () => {
    expect(decodePeriod(127)).toBe(127);
    expect(decodePeriod(0x80 | 3)).toBe(180);
    expect(decodePeriod(0x80 | 60)).toBe(3600);
  });

  it('decodes the info packet', () => {
    const info = new Uint8Array([0x15, 60, ...bytes('2CF7F1C0448000E6'), 0x52, 1, 8, ...u32(3600), ...u32(1795564800)]);
    expect(info.length + 4).toBeLessThanOrEqual(31);
    expect(decodeInfoPacket(info)).toEqual({ packet: 'info', utcAligned: true, periodS: 60, devEui: '2CF7F1C0448000E6', nameSuffix: '8000E6', firmwareVersion: '5.2', networkProfile: 'custom', txPowerDbm: 8, uptimeS: 3600, unixTime: 1795564800 });
    const noTime = new Uint8Array([0x14, 0x85, ...bytes('2CF7F1C0448000E6'), 0x52, 0, 0xf8, ...u32(12), ...u32(0), 0xaa]);
    expect(decodeInfoPacket(noTime)).toMatchObject({ utcAligned: false, periodS: 300, networkProfile: 'weatherxm', txPowerDbm: -8, unixTime: null });
  });

  it('reads the rain fields of the info packet', () => {
    const head = [0x15, 60, ...bytes('2CF7F1C0448000E6'), 0x52, 1, 8, ...u32(3600), ...u32(1795564800)];
    const info = new Uint8Array([...head, ...u16(15), ...u32(12345)]);
    expect(info.length + 4).toBeLessThanOrEqual(31);
    expect(decodeInfoPacket(info)).toMatchObject({ rainRate: 1.5, rainTotal: 12.345, unixTime: 1795564800 });
    expect(decodeInfoPacket(new Uint8Array([...head, ...u16(0xffff), ...u32(0x7fffffff)]))).toMatchObject({ rainRate: null, rainTotal: null });
  });

  it('tells the packet types apart and ignores other formats', () => {
    expect(decodeManufacturerData(bytes(`10010a${OPEN_FRAME}`))?.packet).toBe('frame');
    expect(decodeManufacturerData(new Uint8Array([0x14, 60, ...bytes('2CF7F1C0448000E6'), 0x52, 1, 0, ...u32(1), ...u32(0)]))?.packet).toBe('info');
    expect(decodeManufacturerData(bytes(`20010a${OPEN_FRAME}`))).toBeNull(); // another format version
    expect(decodeFramePacket(bytes('10010a0102'))).toBeNull(); // too short
    expect(decodeManufacturerData(new Uint8Array())).toBeNull();
  });
});

describe('WS2001 beacon: long-range packet', () => {
  const infoBody = [60, ...bytes('2CF7F1C0448000E6'), 0x52, 1, 8, ...u32(3600), ...u32(1795564800), ...u16(15), ...u32(12345)];

  it('splits into the info and frame packets it stands for', () => {
    const frame = Array.from(bytes(OPEN_FRAME));
    const packets = decodeCombinedPacket(new Uint8Array([0x19, ...infoBody, 7, frame.length, ...frame]))!;
    expect(packets.map((p) => p.packet)).toEqual(['info', 'frame']);
    expect(packets[0]).toMatchObject({ nameSuffix: '8000E6', utcAligned: true, periodS: 60, unixTime: 1795564800, txPowerDbm: 8, rainRate: 1.5, rainTotal: 12.345 });
    expect(packets[1]).toMatchObject({ frameCounter: 7, stale: false, periodS: 60, frameHex: OPEN_FRAME });
  });

  it('carries the stale flag and works before the first frame exists', () => {
    const frame = Array.from(bytes(OPEN_FRAME));
    expect(decodeCombinedPacket(new Uint8Array([0x1a, ...infoBody, 9, frame.length, ...frame]))![1]).toMatchObject({ stale: true, utcAligned: false });
    expect(decodeCombinedPacket(new Uint8Array([0x18, ...infoBody, 0, 0]))!.map((p) => p.packet)).toEqual(['info']);
    expect(decodeCombinedPacket(bytes(`10010a${OPEN_FRAME}`))).toBeNull();
    expect(decodeManufacturerData(new Uint8Array([0x18, ...infoBody, 0, 0]))).toBeNull();
  });

  it('is unpacked by decodeAdvertisement', () => {
    const b = new Uint8Array([0x18, ...infoBody, 0, 0]);
    const adv = decodeAdvertisement({ device: { id: 'lr' }, manufacturerData: new Map([[BEACON_COMPANY_ID, new DataView(b.buffer)]]) })!;
    expect(adv.packets.map((p) => p.packet)).toEqual(['info']);
  });
});

describe('WS2001 beacon: BTHome v2', () => {
  it('decodes packet 0 (two speeds: wind, then gust)', () => {
    const sd = new Uint8Array([0x40, 0x00, 4, 0x02, ...u16(0x10000 - 350), 0x04, 0xc8, 0x8b, 0x01, 0x2e, 87, 0x44, ...u16(420), 0x44, ...u16(790), 0x5e, ...u16(25300)]);
    expect(decodeBthome(sd)).toEqual({ packet: 'bthome', packetId: 4, temperature: -3.5, pressure: 1013.2, humidity: 87, wind_speed: 4.2, wind_gust: 7.9, wind_direction: 253 });
  });

  it('decodes packet 1 with the timestamp', () => {
    const sd = new Uint8Array([0x40, 0x00, 5, 0x05, 0x24, 0xe3, 0x52, 0x15, 1, 0x46, 35, 0x50, ...u32(1795564800), 0x5f, ...u16(58), 0xf2, 0, 2, 5]);
    expect(sd.length + 4 + 3).toBeLessThanOrEqual(31);
    expect(decodeBthome(sd)).toEqual({ packet: 'bthome', packetId: 5, illuminance: 54321, battery_low: true, uv_index: 3.5, timestamp: 1795564800, rain_accumulated: 5.8, firmware_version: '5.2.0' });
  });

  it('decodes what a station with a partial sensor sends', () => {
    expect(decodeBthome(new Uint8Array([0x40, 0x00, 8, 0x44, 0, 0, 0x44, 0, 0, 0x5e, ...u16(25300)]))).toEqual({ packet: 'bthome', packetId: 8, wind_speed: 0, wind_gust: 0, wind_direction: 253 });
  });

  it('ignores encrypted or non-v2 BTHome and stops at unknown objects', () => {
    expect(decodeBthome(new Uint8Array([0x41, 0x00, 1]))).toBeNull();
    expect(decodeBthome(new Uint8Array([0x20, 0x00, 1]))).toBeNull();
    expect(decodeBthome(new Uint8Array([0x40, 0x00, 1, 0x99, 1, 2]))).toEqual({ packet: 'bthome', packetId: 1 });
  });

  it('decodes the merged object list of the long-range packet', () => {
    const sd = new Uint8Array([0x40, 0x00, 6, 0x02, ...u16(2150), 0x04, 0xc8, 0x8b, 0x01, 0x05, 0x24, 0xe3, 0x52, 0x15, 0, 0x2e, 55, 0x44, ...u16(420), 0x44, ...u16(790), 0x46, 35, 0x50, ...u32(1795564800), 0x5e, ...u16(27000), 0x5f, ...u16(58), 0xf2, 0, 2, 5]);
    expect(decodeBthome(sd)).toEqual({ packet: 'bthome', packetId: 6, temperature: 21.5, pressure: 1013.2, illuminance: 54321, battery_low: false, humidity: 55, wind_speed: 4.2, wind_gust: 7.9, uv_index: 3.5, timestamp: 1795564800, wind_direction: 270, rain_accumulated: 5.8, firmware_version: '5.2.0' });
  });
});

describe('WS2001 beacon: advertisement events', () => {
  const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  it('decodes manufacturer and service data of one event', () => {
    const adv = decodeAdvertisement({
      device: { id: 'abc', name: 'WeatherXM WS2001 500131' },
      rssi: -70,
      manufacturerData: new Map([[BEACON_COMPANY_ID, view(bytes(`10010a${OPEN_FRAME}`))]]),
      serviceData: new Map([[BTHOME_SERVICE_UUID, view(new Uint8Array([0x40, 0x00, 2, 0x2e, 40]))]]),
    })!;
    expect(adv).toMatchObject({ deviceId: 'abc', name: 'WeatherXM WS2001 500131', rssi: -70 });
    expect(adv.packets.map((p) => p.packet)).toEqual(['frame', 'bthome']);
  });

  it('returns null for other devices', () => {
    expect(decodeAdvertisement({ device: { id: 'x' }, manufacturerData: new Map([[0x004c, view(bytes('0215'))]]) })).toBeNull();
    expect(decodeAdvertisement({ device: { id: 'x' } })).toBeNull();
  });
});

describe('WS2001 beacon: timing and settings', () => {
  it('plans the next burst', () => {
    expect(secondsToNextBurst(60, true, 0, (1000 * 60 + 12.5) * 1000)).toBeCloseTo(47.5);
    expect(secondsToNextBurst(60, false, 100_000, 250_000)).toBeCloseTo(30);
  });

  it('parses AT+BEACON=?', () => {
    expect(parseBeaconSettings('{mode: 3, period: 60, repeat: 3, tx: 8, utc: 1, frame_age: 42}\r\nOK\r\n')).toEqual({ mode: 3, periodS: 60, repeat: 3, txPowerDbm: 8, utc: true, frameAgeS: 42 });
    expect(parseBeaconSettings('{mode: 0, period: 60, repeat: 3, tx: -8, utc: 0, frame_age: -1}')).toMatchObject({ mode: 0, txPowerDbm: -8, utc: false, frameAgeS: null });
    expect(parseBeaconSettings('\r\nAT_ERROR\r\n')).toBeNull();
  });

  it('validates periods like the firmware and builds commands within the 60-byte limit', () => {
    expect([5, 60, 127, 180, 3600].every(isValidBeaconPeriod)).toBe(true);
    expect([4, 128, 200, 3660, 10.5].some(isValidBeaconPeriod)).toBe(false);
    expect(beaconCommand(3, 60, 3, 8)).toBe('AT+BEACON=3,60,3,8');
    expect(beaconTimeCommand(1795564800250)).toBe('AT+BEACONTIME=1795564800,250');
    expect(beaconCommand(3, 3600, 10, -40).length + 2).toBeLessThanOrEqual(60);
  });
});
