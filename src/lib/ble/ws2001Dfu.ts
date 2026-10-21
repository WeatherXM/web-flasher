/**
 * WS2001 firmware update over Web Bluetooth: Nordic nRF5 SDK legacy Secure DFU (service 0xFE59).
 *
 * TypeScript port of ws2001-firmware/tools/ws2001_dfu.py (same algorithm: buttonless entry,
 * command + data objects, CRC32 check per 4 KB object with retry, resume, adaptive pacing).
 *
 * Flow (browsers require a user click to connect to a new device):
 *   1. On the bonded application link: enterBootloader() sets a unique advertising name and
 *      reboots the station into its bootloader.
 *   2. The user picks that name in the Bluetooth chooser (requestBootloaderDevice()).
 *   3. SecureDfuTransfer sends the signed init packet and the image; the bootloader validates
 *      the signature and boots the new application.
 */

import { unzipSync, strFromU8 } from 'fflate';

export const DFU_SERVICE = 0xfe59;
export const DFU_CTRL_UUID = '8ec90001-f315-4f60-9fb8-838830daea50';
export const DFU_PKT_UUID = '8ec90002-f315-4f60-9fb8-838830daea50';
export const DFU_BUTTONLESS_UUID = '8ec90003-f315-4f60-9fb8-838830daea50';

/** Public key compiled into the WS2001 bootloader (bootloader/dfu/dfu_public_key.c), little-endian X||Y. */
export const WS2001_DFU_PUBLIC_KEY_LE =
  '61f1308c12c4bebb3f7221fd93f6b62c8f10975738787dc0fe3a005fa0ff26e4' +
  '9e9d1f889cf2b6b9161f45566758ecd19e0b5f91b9f9b618928494f849b206f7';

const OP_CREATE = 0x01;
const OP_SET_PRN = 0x02;
const OP_CALC_CRC = 0x03;
const OP_EXECUTE = 0x04;
const OP_SELECT = 0x06;
const OP_RESPONSE = 0x60;
const OBJ_COMMAND = 0x01;
const OBJ_DATA = 0x02;

const RESULT: Record<number, string> = {
  0x02: 'OPCODE_NOT_SUPPORTED', 0x03: 'INVALID_PARAMETER', 0x04: 'INSUFFICIENT_RESOURCES',
  0x05: 'INVALID_OBJECT', 0x07: 'UNSUPPORTED_TYPE', 0x08: 'OPERATION_NOT_PERMITTED', 0x0a: 'OPERATION_FAILED',
};
const EXT_ERROR: Record<number, string> = {
  0x02: 'wrong command format', 0x03: 'unknown command', 0x04: 'invalid init command',
  0x05: 'firmware version too low (the station already runs a newer firmware)',
  0x06: 'hardware version mismatch', 0x07: 'SoftDevice version mismatch', 0x08: 'signature missing',
  0x09: 'wrong hash type', 0x0a: 'hash failed', 0x0b: 'wrong signature type',
  0x0c: 'signature verification failed (package not signed for this station)', 0x0d: 'insufficient space',
};

export class DfuError extends Error {}

// ---------------------------------------------------------------------------------------------
// Package + init packet (dfu-cc.proto)
// ---------------------------------------------------------------------------------------------

export interface Ws2001InitPacket {
  initBytes: Uint8Array; // serialized InitCommand: what nrfutil signs
  signed: boolean;
  signature: Uint8Array;
  fwVersion: number | null;
  hwVersion: number | null;
  sdReq: number[];
  fwType: number;
  appSize: number;
  hashType: number;
  hash: Uint8Array; // little-endian SHA-256 of the image
}

export interface Ws2001DfuPackage {
  firmware: Uint8Array;
  init: Uint8Array;
  initPacket: Ws2001InitPacket;
}

function readVarint(b: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= b.length) throw new DfuError('Truncated init packet');
    if (shift > 63) throw new DfuError('Malformed varint in init packet');
    const byte = b[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [result, pos];
    shift += 7;
  }
}

function parseFields(b: Uint8Array): Map<number, Array<number | Uint8Array>> {
  const fields = new Map<number, Array<number | Uint8Array>>();
  let pos = 0;
  while (pos < b.length) {
    let key: number;
    [key, pos] = readVarint(b, pos);
    const num = Math.floor(key / 8);
    const wtype = key & 7;
    if (num <= 0) throw new DfuError('Invalid protobuf field number in init packet');
    let val: number | Uint8Array;
    if (wtype === 0) {
      [val, pos] = readVarint(b, pos);
    } else if (wtype === 2) {
      let len: number;
      [len, pos] = readVarint(b, pos);
      if (len < 0 || pos + len > b.length) throw new DfuError('Truncated length-delimited field in init packet');
      val = b.subarray(pos, pos + len);
      pos += len;
    } else if (wtype === 5) {
      if (pos + 4 > b.length) throw new DfuError('Truncated 32-bit field in init packet');
      val = new DataView(b.buffer, b.byteOffset + pos, 4).getUint32(0, true);
      pos += 4;
    } else {
      throw new DfuError(`Unsupported protobuf wire type ${wtype}`);
    }
    if (!fields.has(num)) fields.set(num, []);
    fields.get(num)!.push(val);
  }
  return fields;
}

const firstNum = (f: Map<number, Array<number | Uint8Array>>, n: number): number | null => {
  const v = f.get(n)?.[0];
  return typeof v === 'number' ? v : null;
};
const firstBytes = (f: Map<number, Array<number | Uint8Array>>, n: number): Uint8Array =>
  (f.get(n)?.[0] as Uint8Array | undefined) ?? new Uint8Array(0);

export function decodeInitPacket(raw: Uint8Array): Ws2001InitPacket {
  const top = parseFields(raw);
  let commandBytes: Uint8Array = new Uint8Array(0);
  let signed = false;
  let signature: Uint8Array = new Uint8Array(0);
  if (top.has(2)) {
    signed = true;
    const sc = parseFields(firstBytes(top, 2));
    commandBytes = firstBytes(sc, 1);
    signature = firstBytes(sc, 3);
  } else {
    commandBytes = firstBytes(top, 1);
  }
  const cmd = parseFields(commandBytes);
  const initBytes = firstBytes(cmd, 2);
  const init = parseFields(initBytes);
  const sdReq: number[] = [];
  for (const v of init.get(3) ?? []) {
    if (typeof v === 'number') sdReq.push(v);
    else for (let p = 0; p < v.length; ) { let n: number; [n, p] = readVarint(v, p); sdReq.push(n); }
  }
  const hashFields = init.has(8) ? parseFields(firstBytes(init, 8)) : new Map();
  return {
    initBytes, signed, signature,
    fwVersion: firstNum(init, 1),
    hwVersion: firstNum(init, 2),
    sdReq,
    fwType: firstNum(init, 4) ?? 0,
    appSize: firstNum(init, 7) ?? 0,
    hashType: firstNum(hashFields, 1) ?? 0,
    hash: firstBytes(hashFields, 2),
  };
}

/** Web Bluetooth / WebCrypto take ArrayBuffer-backed views (TS 5.7 typing); our buffers always are. */
const bs = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

const hexToBytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));

/** Verify the init packet's ECDSA P-256 signature (nRF5 stores key and signature halves little-endian). */
export async function verifyInitSignature(pkt: Ws2001InitPacket, publicKeyLeHex = WS2001_DFU_PUBLIC_KEY_LE): Promise<boolean> {
  if (!pkt.signed || pkt.signature.length !== 64) return false;
  const le = hexToBytes(publicKeyLeHex);
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(le.subarray(0, 32).slice().reverse(), 1);
  raw.set(le.subarray(32, 64).slice().reverse(), 33);
  const sig = new Uint8Array(64);
  sig.set(pkt.signature.subarray(0, 32).slice().reverse(), 0);
  sig.set(pkt.signature.subarray(32, 64).slice().reverse(), 32);
  const key = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, bs(pkt.initBytes));
}

/** Parse an nrfutil application DFU zip and check it is a valid, signed WS2001 application. */
export async function parseWs2001DfuPackage(zip: Uint8Array): Promise<Ws2001DfuPackage> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    throw new DfuError('Firmware package is not a valid ZIP file');
  }
  if (!entries['manifest.json']) throw new DfuError('Firmware package has no manifest.json');
  let parsedManifest: { manifest?: Record<string, { bin_file?: unknown; dat_file?: unknown }> };
  try {
    parsedManifest = JSON.parse(strFromU8(entries['manifest.json']));
  } catch {
    throw new DfuError('Firmware package manifest.json is not valid JSON');
  }
  const manifest = parsedManifest?.manifest ?? {};
  const app = manifest.application;
  if (!app || Object.keys(manifest).length !== 1 || typeof app.bin_file !== 'string' || typeof app.dat_file !== 'string') {
    throw new DfuError('Only application-only packages can be installed over Bluetooth');
  }
  const firmware = entries[app.bin_file];
  const init = entries[app.dat_file];
  if (!firmware || !init || firmware.length === 0) throw new DfuError('Firmware package is missing its image or init packet');
  const initPacket = decodeInitPacket(init);
  if (initPacket.fwType !== 0) {
    throw new DfuError(`Package firmware type is ${initPacket.fwType}, not APPLICATION (0)`);
  }
  if (initPacket.hwVersion !== 52) throw new DfuError(`Package is for hardware ${initPacket.hwVersion}, not the WS2001 (52)`);
  if (!initPacket.sdReq.includes(0x0100)) throw new DfuError('Package does not target the WS2001 SoftDevice (S140 7.2.0)');
  if (initPacket.appSize !== firmware.length) throw new DfuError('Package image size mismatch');
  if (initPacket.hashType !== 3 || initPacket.hash.length !== 32) {
    throw new DfuError('Package init packet is missing a valid SHA-256 image hash');
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bs(firmware))).reverse();
  if (!initPacket.hash.every((b, i) => b === digest[i])) {
    throw new DfuError('Package image hash does not match its init packet');
  }
  if (!(await verifyInitSignature(initPacket))) {
    throw new DfuError('Package is not signed with the WS2001 bootloader key');
  }
  return { firmware, init, initPacket };
}

// ---------------------------------------------------------------------------------------------
// Bluetooth
// ---------------------------------------------------------------------------------------------

type Log = (msg: string, level?: 'INFO' | 'WARN' | 'ERROR') => void;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Random bootloader name so the right station is easy to pick in the chooser (max 20 chars). */
export function makeBootloaderName(): string {
  const r = new Uint8Array(3);
  crypto.getRandomValues(r);
  return 'DfuWX' + Array.from(r, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * Ask the running application (on its bonded link) to reboot into the bootloader under `advName`.
 * Resolves once the request was accepted or the link dropped because the station rebooted.
 */
export async function enterBootloader(server: BluetoothRemoteGATTServer, advName: string, log: Log): Promise<void> {
  const svc = await server.getPrimaryService(DFU_SERVICE);
  const ch = await svc.getCharacteristic(DFU_BUTTONLESS_UUID);
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  ch.addEventListener('characteristicvaluechanged', (ev) => {
    const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (v) queue.push(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    wake?.();
  });
  await ch.startNotifications();

  const request = async (payload: Uint8Array, timeoutMs = 5000): Promise<Uint8Array | null> => {
    queue.length = 0;
    await ch.writeValueWithResponse(bs(payload));
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = queue.shift();
      if (r && r.length >= 3 && r[0] === 0x20 && r[1] === payload[0]) return r;
      await new Promise<void>((res) => { wake = res; setTimeout(res, 200); });
    }
    return null;
  };

  const name = new TextEncoder().encode(advName).slice(0, 20);
  const nameResp = await request(new Uint8Array([0x02, name.length, ...name]));
  if (nameResp && nameResp[2] === 0x01) log(`The station's bootloader will appear as "${advName}".`);
  else log('Could not set a custom bootloader name; look for "DfuTarg".', 'WARN');

  try {
    const resp = await request(new Uint8Array([0x01]));
    if (resp && resp[2] !== 0x01) throw new DfuError(`The station refused to enter update mode (code 0x${resp[2].toString(16)})`);
  } catch (e) {
    if (e instanceof DfuError) throw e;
    // The link dropping during the write means the station already rebooted.
  }
}

/** Chooser for the bootloader (must be called from a user click). */
export async function requestBootloaderDevice(advName: string): Promise<BluetoothDevice> {
  return navigator.bluetooth.requestDevice({
    filters: [{ name: advName }, { namePrefix: 'DfuWX' }, { name: 'DfuTarg' }],
    optionalServices: [DFU_SERVICE],
  });
}

export interface DfuProgress {
  stage: 'init' | 'firmware' | 'activating';
  sent: number;
  total: number;
  kbPerSec: number;
}

/** The Secure DFU object protocol on a connected bootloader. Works on any BluetoothRemoteGATTCharacteristic pair. */
export class SecureDfuTransfer {
  private queue: Uint8Array[] = [];
  private wake: (() => void) | null = null;
  private disconnected = false;
  chunk = 244;
  pace = 0; // ms between packets; raised after CRC failures (host dropped packets)

  constructor(
    private readonly ctrl: BluetoothRemoteGATTCharacteristic,
    private readonly pkt: BluetoothRemoteGATTCharacteristic,
    private readonly log: Log,
    private readonly onProgress?: (p: DfuProgress) => void,
  ) {}

  static async open(server: BluetoothRemoteGATTServer, log: Log, onProgress?: (p: DfuProgress) => void): Promise<SecureDfuTransfer> {
    const svc = await server.getPrimaryService(DFU_SERVICE);
    const t = new SecureDfuTransfer(
      await svc.getCharacteristic(DFU_CTRL_UUID), await svc.getCharacteristic(DFU_PKT_UUID), log, onProgress);
    await t.start();
    return t;
  }

  async start(): Promise<void> {
    this.ctrl.service?.device?.addEventListener('gattserverdisconnected', () => {
      this.disconnected = true;
      this.wake?.();
    });
    this.ctrl.addEventListener('characteristicvaluechanged', (ev) => {
      const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (v) this.queue.push(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
      this.wake?.();
    });
    await this.ctrl.startNotifications();
    await this.request(new Uint8Array([OP_SET_PRN, 0, 0]));
  }

  private async request(payload: Uint8Array, timeoutMs = 10000): Promise<DataView> {
    if (this.disconnected) throw new DfuError('Bootloader disconnected during update');
    this.queue.length = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.ctrl.writeValueWithResponse(bs(payload));
        break;
      } catch (e) {
        if (this.disconnected || attempt >= 3) throw e;
        this.log(`Control write 0x${payload[0].toString(16)} failed (${(e as Error).message}); retrying`, 'WARN');
        await sleep(300 * attempt);
      }
    }
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = this.queue.shift();
      if (r) {
        if (r.length < 3 || r[0] !== OP_RESPONSE || r[1] !== payload[0]) continue;
        if (r[2] === 0x01) return new DataView(r.buffer, r.byteOffset + 3, r.length - 3);
        let msg = RESULT[r[2]] ?? `0x${r[2].toString(16)}`;
        if (r[2] === 0x0b && r.length > 3) msg = EXT_ERROR[r[3]] ?? `extended error 0x${r[3].toString(16)}`;
        throw new DfuError(`Update rejected: ${msg}`);
      }
      if (this.disconnected) throw new DfuError('Bootloader disconnected during update');
      await new Promise<void>((res) => { this.wake = res; setTimeout(res, 200); });
    }
    throw new DfuError(`No response from the bootloader (opcode 0x${payload[0].toString(16)})`);
  }

  private async select(obj: number) {
    const v = await this.request(new Uint8Array([OP_SELECT, obj]));
    return { maxSize: v.getUint32(0, true), offset: v.getUint32(4, true), crc: v.getUint32(8, true) };
  }

  private async create(obj: number, size: number) {
    const b = new Uint8Array(6);
    b[0] = OP_CREATE; b[1] = obj;
    new DataView(b.buffer).setUint32(2, size, true);
    await this.request(b);
  }

  private async crc() {
    const v = await this.request(new Uint8Array([OP_CALC_CRC]));
    return { offset: v.getUint32(0, true), crc: v.getUint32(4, true) };
  }

  private async stream(data: Uint8Array, base: number, total: number, t0: number, stage: DfuProgress['stage']) {
    for (let i = 0; i < data.length; ) {
      const part = data.subarray(i, i + this.chunk);
      try {
        await this.pkt.writeValueWithoutResponse(bs(part));
      } catch (e) {
        if (this.chunk > 20) { // larger than the negotiated MTU allows: fall back to the minimum
          this.chunk = 20;
          this.log('Using 20-byte packets for this connection.', 'WARN');
          continue;
        }
        throw e;
      }
      i += part.length;
      if (this.pace) await sleep(this.pace);
      const sent = base + i;
      this.onProgress?.({ stage, sent, total, kbPerSec: sent / 1024 / Math.max(0.1, (performance.now() - t0) / 1000) });
    }
  }

  async sendInit(init: Uint8Array): Promise<void> {
    const sel = await this.select(OBJ_COMMAND);
    if (sel.offset === init.length && sel.crc === crc32(init)) {
      try { await this.request(new Uint8Array([OP_EXECUTE])); return; } catch { /* resend below */ }
    }
    await this.create(OBJ_COMMAND, init.length);
    await this.stream(init, 0, 0, performance.now(), 'init');
    const c = await this.crc();
    if (c.offset !== init.length || c.crc !== crc32(init)) throw new DfuError('Init packet CRC mismatch');
    await this.request(new Uint8Array([OP_EXECUTE]), 20000); // signature + version checks happen here
  }

  async sendFirmware(fw: Uint8Array): Promise<void> {
    const sel = await this.select(OBJ_DATA);
    if (!sel.maxSize || sel.maxSize <= 0) throw new DfuError('Bootloader reported an invalid object size (0)');
    let start = 0;
    if (sel.offset > 0 && sel.offset <= fw.length && sel.crc === crc32(fw.subarray(0, sel.offset))) {
      start = sel.offset - (sel.offset % sel.maxSize);
      if (sel.offset % sel.maxSize === 0) {
        try { await this.request(new Uint8Array([OP_EXECUTE])); } catch { /* already executed */ }
        start = sel.offset;
      }
      if (start) this.log(`Resuming an interrupted update at ${start} of ${fw.length} bytes.`);
    }
    const t0 = performance.now() - 1;
    for (let objStart = start; objStart < fw.length; objStart += sel.maxSize) {
      const obj = fw.subarray(objStart, objStart + sel.maxSize);
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        await this.create(OBJ_DATA, obj.length);
        await this.stream(obj, objStart, fw.length, t0, 'firmware');
        await sleep(50); // let queued packets drain before asking for the CRC
        const c = await this.crc();
        ok = c.offset === objStart + obj.length && c.crc === crc32(fw.subarray(0, c.offset));
        if (!ok) {
          this.pace = Math.min(50, this.pace ? this.pace * 2 : 5);
          this.log(`Checksum mismatch at ${objStart} (attempt ${attempt}/3); resending with ${this.pace} ms pacing`, 'WARN');
        }
      }
      if (!ok) throw new DfuError(`Data at offset ${objStart} failed its checksum 3 times`);
      const last = objStart + obj.length >= fw.length;
      try {
        await this.request(new Uint8Array([OP_EXECUTE]), 20000);
      } catch (e) {
        if (e instanceof DfuError || !last) throw e; // the bootloader may reset before answering the last one
      }
    }
    this.onProgress?.({ stage: 'activating', sent: fw.length, total: fw.length, kbPerSec: 0 });
  }
}

let crcTable: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
