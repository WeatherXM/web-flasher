/**
 * WS2001 / WS2000 BLE weather beacon (firmware V5.2+): decoders and a Web Bluetooth listener.
 *
 * The station broadcasts bursts of advertising packets; listening needs no pairing and no connection.
 * Packet layouts: ws2001-firmware/docs/BLE_BEACON.md (firmware: application/apps/common/app_ble_beacon.c,
 * reference decoder: tools/ws2001_beacon.py).
 *
 * The weather frame inside the frame packet is the LoRaWAN uplink frame. It is decoded here in TypeScript
 * because the site's Content-Security-Policy does not allow evaluating the published decoder script;
 * tests/ble/ws2001Beacon.test.ts checks this decoder against that script field by field.
 */

/** Bluetooth SIG company identifier of the manufacturer data (0xFFFF = test identifier, see BLE_BEACON.md). */
export const BEACON_COMPANY_ID = 0xffff;
export const BEACON_FORMAT_VERSION = 1;
export const BEACON_PACKET_FRAME = 0;
export const BEACON_PACKET_INFO = 1;
export const BEACON_PACKET_COMBINED = 2; // long-range mode: info + frame in one extended advertising packet
export const BEACON_MODE_FRAME = 1;
export const BEACON_MODE_BTHOME = 2;
export const BEACON_MODE_LONG_RANGE = 4;
export const BTHOME_SERVICE_UUID16 = 0xfcd2;
export const BTHOME_SERVICE_UUID = '0000fcd2-0000-1000-8000-00805f9b34fb';

/** Length of the info packet body (bytes 21-26, the rain fields, were added before the first release). */
export const BEACON_INFO_LEN = 27;

const FLAG_UTC = 0x01;
const FLAG_STALE = 0x02;

/** Firmware limits of AT+BEACON (app_ble_beacon.h). */
export const BEACON_TX_POWERS = [-40, -20, -16, -12, -8, -4, 0, 2, 3, 4, 5, 6, 7, 8];
export const BEACON_PERIOD_MIN_S = 5;
export const BEACON_PERIOD_MAX_S = 3600;

export interface BeaconWeather {
  format: 'weatherxm' | 'open';
  temperature: number | null; // °C
  humidity: number | null; // %RH
  wind_speed: number | null; // m/s
  wind_gust: number | null; // m/s
  wind_direction: number | null; // degrees
  rain_accumulated: number | null; // mm
  rain_rate: number | null; // mm/h
  lux: number | null;
  uv_index: number | null;
  pressure: number | null; // hPa
  battery_low: boolean;
  firmware_version?: string;
  upload_interval_min?: number;
  wind_direction_sigma?: number | null;
  wind_direction_range_start?: number | null;
  wind_direction_range_end?: number | null;
  wind_gust_direction?: number | null;
}

export interface BeaconFramePacket {
  packet: 'frame';
  utcAligned: boolean;
  stale: boolean;
  frameCounter: number;
  periodS: number;
  frameHex: string;
  data: BeaconWeather | null;
}

export interface BeaconInfoPacket {
  packet: 'info';
  utcAligned: boolean;
  periodS: number;
  devEui: string;
  nameSuffix: string;
  firmwareVersion: string;
  networkProfile: 'weatherxm' | 'custom';
  txPowerDbm: number;
  /** This packet was sent this many ms after its burst started (the next burst starts periodS later). */
  burstOffsetMs: number;
  /** Minutes since the station booted (saturates at 65535). */
  uptimeMin: number;
  unixTime: number | null;
  /** Rain rate of the latest 12-s reading, mm/h (null = not available, undefined = firmware without the field). */
  rainRate?: number | null;
  /** Lifetime rain total, mm. */
  rainTotal?: number | null;
}

export interface BeaconBthomePacket {
  packet: 'bthome';
  packetId?: number;
  temperature?: number; // °C
  pressure?: number; // hPa
  humidity?: number; // %RH
  wind_speed?: number; // m/s, 12-s mean
  wind_gust?: number; // m/s, 12-s peak
  wind_direction?: number; // degrees
  illuminance?: number; // lux
  battery_low?: boolean;
  uv_index?: number;
  timestamp?: number; // Unix time
  rain_accumulated?: number; // mm, rolling
  firmware_version?: string;
}

export type BeaconPacket = BeaconFramePacket | BeaconInfoPacket | BeaconBthomePacket;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const s16le = (b: Uint8Array, i: number) => {
  const v = u16le(b, i);
  return v & 0x8000 ? v - 0x10000 : v;
};
const dir2 = (b: number) => (b > 179 ? null : b * 2);

/** Burst period in seconds from the period byte: 1..127 = seconds, bit 7 set = minutes. */
export function decodePeriod(code: number): number {
  return code & 0x80 ? (code & 0x7f) * 60 : code;
}

/** The weather frame of the LoRaWAN uplink (FPort 99): 24-byte WeatherXM frame (0xF0) or untagged Open Edition frame. */
export function decodeWeatherFrame(b: Uint8Array): BeaconWeather | null {
  if (b.length >= 24 && (b[0] === 0xf0 || b[0] === 0xf1)) {
    const t = s16le(b, 5);
    const hd = (b[7] << 8) | b[8];
    const uw = (b[9] << 8) | b[10];
    const g = u16le(b, 11);
    const r = u32le(b, 13);
    const lx = b[19] | (b[20] << 8) | (b[21] << 16);
    const p = u16le(b, 22);
    return {
      format: 'weatherxm',
      firmware_version: `${b[1] >> 4}.${b[1] & 0x0f}`,
      upload_interval_min: b[3] & 0x7f,
      battery_low: (b[3] & 0x80) !== 0,
      temperature: t === 0x7fff ? null : t / 10,
      humidity: hd >> 9 === 0x7f ? null : hd >> 9,
      wind_direction: (hd & 0x1ff) === 0x1ff ? null : hd & 0x1ff,
      uv_index: uw >> 11 === 0x1f ? null : uw >> 11,
      wind_speed: (uw & 0x7ff) === 0x7ff ? null : (uw & 0x7ff) / 10,
      wind_gust: g === 0xffff ? null : g / 10,
      rain_accumulated: r === 0x7fffffff ? null : r / 1000,
      rain_rate: u16le(b, 17) / 10,
      lux: lx === 0x7fffff ? null : lx,
      pressure: p === 0xffff || p === 0 ? null : p / 10,
    };
  }
  if (b.length >= 16 && !(b[0] >= 0xf0 && b[0] <= 0xf3)) {
    const hd = (b[0] << 8) | b[1];
    const t = s16le(b, 2);
    const buw = (b[4] << 8) | b[5];
    const uv = (buw >> 11) & 0x0f;
    const g = u16le(b, 6);
    const r = u16le(b, 8);
    const rr = u16le(b, 10);
    const lx = u16le(b, 12);
    const p = u16le(b, 14);
    const out: BeaconWeather = {
      format: 'open',
      humidity: hd >> 9 === 0x7f ? null : hd >> 9,
      wind_direction: (hd & 0x1ff) === 0x1ff ? null : hd & 0x1ff,
      temperature: t === 0x7fff ? null : t / 10,
      battery_low: (buw & 0x8000) !== 0,
      uv_index: uv === 0x0f ? null : uv,
      wind_speed: (buw & 0x7ff) === 0x7ff ? null : (buw & 0x7ff) / 10,
      wind_gust: g === 0xffff ? null : g / 10,
      rain_accumulated: r === 0xffff ? null : r / 10,
      rain_rate: rr === 0xffff ? null : rr / 10,
      lux: lx === 0xffff ? null : lx * 10,
      pressure: p === 0xffff || p === 0 ? null : p / 10,
    };
    if (b.length >= 20) {
      out.wind_direction_sigma = b[16] === 0xff ? null : b[16];
      out.wind_direction_range_start = dir2(b[17]);
      out.wind_direction_range_end = dir2(b[18]);
      out.wind_gust_direction = dir2(b[19]);
    }
    return out;
  }
  return null;
}

const packetType = (b: Uint8Array) => (b[0] >> 2) & 0x03;
const isBeacon = (b: Uint8Array) => b.length > 0 && b[0] >> 4 === BEACON_FORMAT_VERSION;

/** Frame packet: the manufacturer data after the company identifier. Null if it is not one. */
export function decodeFramePacket(b: Uint8Array): BeaconFramePacket | null {
  if (!isBeacon(b) || packetType(b) !== BEACON_PACKET_FRAME || b.length < 3 + 16) return null;
  const frame = b.subarray(3);
  return {
    packet: 'frame',
    utcAligned: (b[0] & FLAG_UTC) !== 0,
    stale: (b[0] & FLAG_STALE) !== 0,
    frameCounter: b[1],
    periodS: decodePeriod(b[2]),
    frameHex: hex(frame),
    data: decodeWeatherFrame(frame),
  };
}

/** Info packet (station identity and clock). Later firmware may append bytes. */
export function decodeInfoPacket(b: Uint8Array): BeaconInfoPacket | null {
  if (!isBeacon(b) || packetType(b) !== BEACON_PACKET_INFO || b.length < 21) return null;
  const devEui = b.subarray(2, 10);
  const unixTime = u32le(b, 17);
  const rain: Pick<BeaconInfoPacket, 'rainRate' | 'rainTotal'> = {};
  if (b.length >= BEACON_INFO_LEN) {
    const rate = u16le(b, 21);
    const total = u32le(b, 23);
    rain.rainRate = rate === 0xffff ? null : rate / 10;
    rain.rainTotal = total === 0x7fffffff ? null : total / 1000;
  }
  return {
    packet: 'info',
    utcAligned: (b[0] & FLAG_UTC) !== 0,
    periodS: decodePeriod(b[1]),
    devEui: hex(devEui).toUpperCase(),
    nameSuffix: hex(devEui.subarray(5)).toUpperCase(),
    firmwareVersion: `${b[10] >> 4}.${b[10] & 0x0f}`,
    networkProfile: b[11] === 0 ? 'weatherxm' : 'custom',
    txPowerDbm: b[12] > 127 ? b[12] - 256 : b[12],
    burstOffsetMs: u16le(b, 13),
    uptimeMin: u16le(b, 15),
    unixTime: unixTime || null,
    ...rain,
  };
}

/**
 * Long-range packet (type 2): the info packet body, then frame counter, frame length and the weather frame.
 * Returned as the info and frame packets it stands for, so callers handle it like a normal burst.
 */
export function decodeCombinedPacket(b: Uint8Array): (BeaconFramePacket | BeaconInfoPacket)[] | null {
  if (!isBeacon(b) || packetType(b) !== BEACON_PACKET_COMBINED || b.length < BEACON_INFO_LEN + 2) return null;
  const infoBytes = b.slice(0, BEACON_INFO_LEN);
  infoBytes[0] = (b[0] & 0xf3) | (BEACON_PACKET_INFO << 2);
  const info = decodeInfoPacket(infoBytes);
  if (!info) return null;
  const out: (BeaconFramePacket | BeaconInfoPacket)[] = [info];
  const frameLen = b[BEACON_INFO_LEN + 1];
  const frame = b.subarray(BEACON_INFO_LEN + 2, BEACON_INFO_LEN + 2 + frameLen);
  if (frameLen > 0 && frame.length === frameLen) {
    out.push({
      packet: 'frame',
      utcAligned: info.utcAligned,
      stale: (b[0] & FLAG_STALE) !== 0,
      frameCounter: b[BEACON_INFO_LEN],
      periodS: info.periodS,
      frameHex: hex(frame),
      data: decodeWeatherFrame(frame),
    });
  }
  return out;
}

export function decodeManufacturerData(b: Uint8Array): BeaconFramePacket | BeaconInfoPacket | null {
  if (!isBeacon(b)) return null;
  if (packetType(b) === BEACON_PACKET_COMBINED) return null; // several packets: use decodeCombinedPacket
  return packetType(b) === BEACON_PACKET_INFO ? decodeInfoPacket(b) : decodeFramePacket(b);
}

// BTHome v2 objects the station sends: id -> [byte length, field, factor]
const BTHOME_OBJECTS: Record<number, [number, string, number]> = {
  0x00: [1, 'packetId', 1],
  0x02: [2, 'temperature', 0.01],
  0x04: [3, 'pressure', 0.01],
  0x05: [3, 'illuminance', 0.01],
  0x15: [1, 'battery_low', 1],
  0x2e: [1, 'humidity', 1],
  0x44: [2, 'speed', 0.01],
  0x46: [1, 'uv_index', 0.1],
  0x50: [4, 'timestamp', 1],
  0x5e: [2, 'wind_direction', 0.01],
  0x5f: [2, 'rain_accumulated', 0.1],
  0xf2: [3, 'firmware_version', 1],
};

const round2 = (v: number) => Math.round(v * 100) / 100;

/** BTHome v2 service data (the bytes after the 0xFCD2 UUID). Null unless BTHome v2, not encrypted. */
export function decodeBthome(b: Uint8Array): BeaconBthomePacket | null {
  if (b.length < 1 || b[0] >> 5 !== 2 || (b[0] & 0x01) !== 0) return null;
  const out: Record<string, unknown> = { packet: 'bthome' };
  const speeds: number[] = [];
  let i = 1;
  while (i < b.length) {
    const spec = BTHOME_OBJECTS[b[i]];
    if (!spec) break; // BTHome receivers stop at the first object they do not know
    const [size, field, factor] = spec;
    if (i + 1 + size > b.length) break;
    let raw = 0;
    for (let k = size - 1; k >= 0; k--) raw = raw * 256 + b[i + 1 + k];
    if (b[i] === 0x02 && raw & 0x8000) raw -= 0x10000;
    if (b[i] === 0x44) speeds.push(round2(raw * factor));
    else if (b[i] === 0xf2) out[field] = `${(raw >> 16) & 0xff}.${(raw >> 8) & 0xff}.${raw & 0xff}`;
    else if (b[i] === 0x15) out[field] = raw !== 0;
    else out[field] = factor === 1 ? raw : round2(raw * factor);
    i += 1 + size;
  }
  // two "speed" objects, always in this order: wind speed (12-s mean), wind gust (12-s peak)
  if (speeds.length >= 1) out.wind_speed = speeds[0];
  if (speeds.length >= 2) out.wind_gust = speeds[1];
  return out as unknown as BeaconBthomePacket;
}

/**
 * Seconds until the next burst starts, from a packet that was heard. Bursts are exactly one period apart on the
 * station's clock, and the info packet says how long after the start of its burst it was sent (burstOffsetMs),
 * so no absolute time is needed and clock drift does not add up.
 */
export function secondsToNextBurst(periodS: number, heardAtMs: number, burstOffsetMs = 0, nowMs = Date.now()): number {
  if (periodS <= 0) return 0;
  const sinceStart = (nowMs - (heardAtMs - burstOffsetMs)) / 1000;
  return periodS - (((sinceStart % periodS) + periodS) % periodS);
}

/** Seconds until the next burst of a UTC-aligned station (header bit 0), without having heard it. */
export function secondsToNextUtcBurst(periodS: number, nowMs = Date.now()): number {
  return periodS <= 0 ? 0 : periodS - ((nowMs / 1000) % periodS);
}

/** AT+BEACON=? reply: {mode: 3, period: 60, repeat: 3, tx: 0, utc: 0, frame_age: 42} */
export interface BeaconSettings {
  mode: number;
  periodS: number;
  repeat: number;
  txPowerDbm: number;
  utc: boolean;
  frameAgeS: number | null;
}

export function parseBeaconSettings(raw: string): BeaconSettings | null {
  const num = (key: string) => {
    const m = new RegExp(`\\b${key}:\\s*(-?\\d+)`).exec(raw);
    return m ? Number(m[1]) : null;
  };
  const mode = num('mode');
  const period = num('period');
  if (mode === null || period === null) return null;
  const age = num('frame_age');
  return {
    mode,
    periodS: period,
    repeat: num('repeat') ?? 3,
    txPowerDbm: num('tx') ?? 0,
    utc: num('utc') === 1,
    frameAgeS: age === null || age < 0 ? null : age,
  };
}

/** A period the firmware accepts: 5..127 s, or whole minutes up to 3600 s. */
export function isValidBeaconPeriod(periodS: number): boolean {
  if (!Number.isInteger(periodS) || periodS < BEACON_PERIOD_MIN_S || periodS > BEACON_PERIOD_MAX_S) return false;
  return periodS <= 127 || periodS % 60 === 0;
}

export function beaconCommand(mode: number, periodS: number, repeat: number, txPowerDbm: number): string {
  return `AT+BEACON=${mode},${periodS},${repeat},${txPowerDbm}`;
}

/** AT+BEACONTIME for this device's clock; build it right before sending. */
export function beaconTimeCommand(nowMs = Date.now()): string {
  return `AT+BEACONTIME=${Math.floor(nowMs / 1000)},${Math.floor(nowMs % 1000)}`;
}

// ---------------------------------------------------------------------------------------------- listener

/**
 * How this browser can read advertisements:
 *  - 'scan': navigator.bluetooth.requestLEScan - every station in range, one permission prompt
 *  - 'watch': BluetoothDevice.watchAdvertisements - one station picked in the chooser
 *  - 'none': neither (in Chrome both need chrome://flags/#enable-experimental-web-platform-features)
 */
export type BeaconScanSupport = 'scan' | 'watch' | 'none';

export function beaconScanSupport(): BeaconScanSupport {
  if (typeof navigator === 'undefined' || !navigator.bluetooth) return 'none';
  const bt = navigator.bluetooth as unknown as { requestLEScan?: unknown };
  if (typeof bt.requestLEScan === 'function') return 'scan';
  const proto = (globalThis as unknown as { BluetoothDevice?: { prototype: { watchAdvertisements?: unknown } } }).BluetoothDevice?.prototype;
  if (proto && typeof proto.watchAdvertisements === 'function') return 'watch';
  return 'none';
}

export interface BeaconAdvertisement {
  deviceId: string;
  name: string | null;
  rssi: number | null;
  packets: BeaconPacket[];
}

interface AdvEventLike {
  device?: { id?: string; name?: string | null };
  name?: string | null;
  rssi?: number | null;
  manufacturerData?: Map<number, DataView>;
  serviceData?: Map<string, DataView>;
}

const toBytes = (v: DataView) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

/** Decode one advertisementreceived event. Null if it carries no WS2001 beacon data. */
export function decodeAdvertisement(ev: AdvEventLike): BeaconAdvertisement | null {
  const packets: BeaconPacket[] = [];
  const mfg = ev.manufacturerData?.get(BEACON_COMPANY_ID);
  if (mfg) {
    const bytes = toBytes(mfg);
    const combined = decodeCombinedPacket(bytes);
    if (combined) packets.push(...combined);
    else {
      const p = decodeManufacturerData(bytes);
      if (p) packets.push(p);
    }
  }
  const sd = ev.serviceData?.get(BTHOME_SERVICE_UUID);
  if (sd) {
    const p = decodeBthome(toBytes(sd));
    if (p) packets.push(p);
  }
  if (packets.length === 0) return null;
  return {
    deviceId: ev.device?.id ?? 'unknown',
    name: ev.name ?? ev.device?.name ?? null,
    rssi: typeof ev.rssi === 'number' ? ev.rssi : null,
    packets,
  };
}

/**
 * Start listening. Must be called from a user gesture (button click). Resolves with a function that stops
 * listening. No pairing happens and nothing is written to the station.
 */
export async function startBeaconListener(onAdvertisement: (adv: BeaconAdvertisement) => void): Promise<() => void> {
  const support = beaconScanSupport();
  const handler = (ev: Event) => {
    const adv = decodeAdvertisement(ev as unknown as AdvEventLike);
    if (adv) onAdvertisement(adv);
  };

  if (support === 'scan') {
    const bt = navigator.bluetooth as unknown as {
      requestLEScan(options: object): Promise<{ stop(): void }>;
      addEventListener(type: string, cb: (ev: Event) => void): void;
      removeEventListener(type: string, cb: (ev: Event) => void): void;
    };
    // filtering happens in decodeAdvertisement: manufacturer-data scan filters are not supported everywhere
    const scan = await bt.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
    bt.addEventListener('advertisementreceived', handler);
    return () => {
      bt.removeEventListener('advertisementreceived', handler);
      scan.stop();
    };
  }

  if (support === 'watch') {
    const device = (await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'WeatherXM' }, { namePrefix: 'WS2001' }],
      optionalManufacturerData: [BEACON_COMPANY_ID],
      optionalServices: [BTHOME_SERVICE_UUID16],
    } as RequestDeviceOptions)) as BluetoothDevice & { watchAdvertisements(options?: { signal?: AbortSignal }): Promise<void> };
    const abort = new AbortController();
    device.addEventListener('advertisementreceived', handler);
    await device.watchAdvertisements({ signal: abort.signal });
    return () => {
      device.removeEventListener('advertisementreceived', handler);
      abort.abort();
    };
  }

  throw new Error('This browser cannot read Bluetooth advertisements.');
}
