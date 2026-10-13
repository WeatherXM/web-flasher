import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { parseWs2001DfuPackage, SecureDfuTransfer, crc32, DfuError } from '../../src/lib/ble/ws2001Dfu';
import { isOutdated, parseStationVersion, validateWs2001Manifest } from '../../src/lib/ble/ws2001Firmware';

const FW_DIR = path.join(__dirname, '../../public/firmware/ws2001');
const manifest = JSON.parse(readFileSync(path.join(FW_DIR, 'manifest.json'), 'utf8'));
const latestFile = manifest.releases.find((r: { version: string }) => r.version === manifest.latest).file;
const zip = new Uint8Array(readFileSync(path.join(__dirname, '../../public', latestFile)));

describe('WS2001 firmware manifest', () => {
  it('lists a valid latest release', () => {
    const m = validateWs2001Manifest(manifest);
    expect(m.latest).toBe('4.5');
    expect(m.releases[0].fw_version).toBe(45);
  });

  it('compares station versions', () => {
    expect(parseStationVersion('V4.5')).toEqual([4, 5]);
    expect(isOutdated('V3.7', '4.5')).toBe(true);
    expect(isOutdated('V4.4', '4.5')).toBe(true);
    expect(isOutdated('V4.5', '4.5')).toBe(false);
    expect(isOutdated('V4.10', '4.5')).toBe(false);
    expect(isOutdated('Unknown', '4.5')).toBe(true);
  });
});

describe('WS2001 DFU package', () => {
  it('accepts the published, signed V4.5 package', async () => {
    const pkg = await parseWs2001DfuPackage(zip);
    expect(pkg.initPacket.fwVersion).toBe(45);
    expect(pkg.initPacket.hwVersion).toBe(52);
    expect(pkg.initPacket.sdReq).toContain(0x0100);
    expect(pkg.firmware.length).toBe(manifest.releases[0].image_bytes);
  });

  it('rejects a package whose image was modified', async () => {
    const entries = unzipSync(zip);
    const bin = Object.keys(entries).find((n) => n.endsWith('.bin'))!;
    entries[bin] = entries[bin].slice();
    entries[bin][1000] ^= 0xff;
    await expect(parseWs2001DfuPackage(zipSync(entries))).rejects.toThrow(/hash/);
  });

  it('rejects a package with a forged signature', async () => {
    const entries = unzipSync(zip);
    const dat = Object.keys(entries).find((n) => n.endsWith('.dat'))!;
    entries[dat] = entries[dat].slice();
    entries[dat][entries[dat].length - 1] ^= 0x01; // last byte is inside the signature
    await expect(parseWs2001DfuPackage(zipSync(entries))).rejects.toThrow(/signed/);
  });
});

/** Fake GATT characteristics modelling nrf_dfu_req_handler (command/data objects, CRC, execute). */
function fakeBootloader(opts: { corruptAt?: number; rejectInit?: number } = {}) {
  let cmd = new Uint8Array(0);
  let committed = new Uint8Array(0);
  let current = new Uint8Array(0);
  let objType = 0;
  let listener: ((ev: { target: { value: DataView } }) => void) | null = null;
  const concat = (a: Uint8Array, b: Uint8Array) => { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; };
  const notify = (bytes: number[]) => setTimeout(() => listener?.({ target: { value: new DataView(new Uint8Array(bytes).buffer) } }), 1);
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  let corruptAt = opts.corruptAt;
  const ctrl = {
    addEventListener: (_: string, l: typeof listener) => { listener = l; },
    startNotifications: async () => ctrl,
    writeValueWithResponse: async (d: Uint8Array) => {
      const op = d[0];
      if (op === 0x02) notify([0x60, op, 1]);
      else if (op === 0x06) {
        const buf = d[1] === 1 ? cmd : committed;
        notify([0x60, op, 1, ...u32(d[1] === 1 ? 256 : 4096), ...u32(buf.length), ...u32(crc32(buf))]);
      } else if (op === 0x01) {
        objType = d[1];
        if (objType === 1) cmd = new Uint8Array(0); else current = new Uint8Array(0);
        notify([0x60, op, 1]);
      } else if (op === 0x03) {
        const buf = objType === 1 ? cmd : concat(committed, current);
        notify([0x60, op, 1, ...u32(buf.length), ...u32(crc32(buf))]);
      } else if (op === 0x04) {
        if (objType === 1 && opts.rejectInit !== undefined) { notify([0x60, op, 0x0b, opts.rejectInit]); return; }
        if (objType === 2) { committed = concat(committed, current); current = new Uint8Array(0); }
        notify([0x60, op, 1]);
      }
    },
  };
  const pkt = {
    writeValueWithoutResponse: async (d: Uint8Array) => {
      let data = d;
      const pos = committed.length + current.length;
      if (objType === 2 && corruptAt !== undefined && pos <= corruptAt && corruptAt < pos + d.length) {
        data = d.slice(); data[0] ^= 0xff; corruptAt = undefined;
      }
      if (objType === 1) cmd = concat(cmd, data); else current = concat(current, data);
    },
  };
  return { ctrl, pkt, state: () => ({ cmd, committed }) };
}

describe('Secure DFU transfer (Web Bluetooth)', () => {
  const pkgPromise = parseWs2001DfuPackage(zip);

  it('transfers the init packet and the image', async () => {
    const pkg = await pkgPromise;
    const bl = fakeBootloader();
    const t = new SecureDfuTransfer(bl.ctrl as never, bl.pkt as never, () => {});
    await t.start();
    await t.sendInit(pkg.init);
    await t.sendFirmware(pkg.firmware);
    expect(bl.state().cmd).toEqual(pkg.init);
    expect(bl.state().committed).toEqual(pkg.firmware);
  }, 30000);

  it('resends an object after a checksum mismatch', async () => {
    const pkg = await pkgPromise;
    const bl = fakeBootloader({ corruptAt: 9000 });
    const logs: string[] = [];
    const t = new SecureDfuTransfer(bl.ctrl as never, bl.pkt as never, (m) => logs.push(m));
    await t.start();
    await t.sendInit(pkg.init);
    await t.sendFirmware(pkg.firmware);
    expect(bl.state().committed).toEqual(pkg.firmware);
    expect(logs.some((l) => l.includes('Checksum mismatch'))).toBe(true);
  }, 30000);

  it('explains a version rejection', async () => {
    const pkg = await pkgPromise;
    const bl = fakeBootloader({ rejectInit: 0x05 });
    const t = new SecureDfuTransfer(bl.ctrl as never, bl.pkt as never, () => {});
    await t.start();
    await expect(t.sendInit(pkg.init)).rejects.toThrow(DfuError);
    await expect(t.sendInit(pkg.init)).rejects.toThrow(/newer firmware/);
  });
});
