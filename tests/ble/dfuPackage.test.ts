import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { zipSync, strToU8 } from 'fflate';
import { parseDfuPackage, parseMcubootHeader, MCUBOOT_IMAGE_MAGIC } from '../../src/lib/ble/dfuPackage';
import { compareVersions, downloadRelease, validateWs1300Manifest } from '../../src/lib/ble/ws1300Manifest';
import { cleanShellReply, NUSClient } from '../../src/lib/ble/nus';

function fakeMcuboot(major: number, minor: number, rev: number, body = 64): Uint8Array {
  const buf = new Uint8Array(32 + body + 16);
  const v = new DataView(buf.buffer);
  v.setUint32(0, MCUBOOT_IMAGE_MAGIC, true);
  v.setUint16(8, 32, true);
  v.setUint32(12, body, true);
  v.setUint8(20, major);
  v.setUint8(21, minor);
  v.setUint16(22, rev, true);
  return buf;
}

const pkgManifest = (files: object[]) => strToU8(JSON.stringify({ 'format-version': 0, files }));

describe('MCUboot header', () => {
  it('reads the version the way the station reports it', () => {
    expect(parseMcubootHeader(fakeMcuboot(22, 4, 0))?.version).toBe('22.4.0');
  });
  it('rejects non-MCUboot data', () => {
    expect(parseMcubootHeader(new Uint8Array(64))).toBeNull();
  });
});

describe('DFU package', () => {
  it('reads app and net core images from an nRF Connect SDK -dfu.zip', async () => {
    const zip = zipSync({
      'manifest.json': pkgManifest([
        { file: 'net_core_app_update.bin', image_index: '1', board: 'ws1300_nrf5340_cpunet' },
        { file: 'app_update.bin', image_index: '0', board: 'ws1300_nrf5340_cpuapp' },
      ]),
      'app_update.bin': fakeMcuboot(22, 4, 0),
      'net_core_app_update.bin': fakeMcuboot(22, 4, 0, 32),
    });
    const images = await parseDfuPackage(zip, 'x-dfu.zip');
    expect(images.map((i) => [i.imageIndex, i.core, i.version])).toEqual([
      [0, 'app', '22.4.0'],
      [1, 'net', '22.4.0'],
    ]);
    expect(images[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses images without an MCUboot header', async () => {
    const zip = zipSync({
      'manifest.json': pkgManifest([{ file: 'app_update.bin', image_index: '0' }]),
      'app_update.bin': new Uint8Array(100),
    });
    await expect(parseDfuPackage(zip, 'bad.zip')).rejects.toThrow(/not an MCUboot image/);
  });

  it('refuses truncated images', async () => {
    const full = fakeMcuboot(1, 0, 0, 200);
    await expect(parseDfuPackage(full.subarray(0, 100), 'cut.bin')).rejects.toThrow(/truncated/);
  });

  it('refuses a manifest that points at a missing file', async () => {
    const zip = zipSync({ 'manifest.json': pkgManifest([{ file: 'app_update.bin', image_index: '0' }]) });
    await expect(parseDfuPackage(zip, 'empty.zip')).rejects.toThrow(/missing/);
  });

  it('accepts a single signed .bin as an application core image', async () => {
    const images = await parseDfuPackage(fakeMcuboot(9, 1, 2), 'app.bin');
    expect(images).toHaveLength(1);
    expect(images[0].imageIndex).toBe(0);
  });
});

describe('published WS1300 releases', () => {
  const root = path.resolve(__dirname, '../../public');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'firmware/ws1300/manifest.json'), 'utf8'));

  it('has a valid manifest', () => {
    const m = validateWs1300Manifest(manifest);
    expect(m.hardware).toBe('WS1300');
  });

  it('matches the packages on disk and their contents', async () => {
    for (const r of manifest.releases) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(root, r.file)));
      expect(bytes.length).toBe(r.bytes);
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(r.sha256);

      const fakeFetch = (async () => new Response(bytes)) as unknown as typeof fetch;
      const images = await downloadRelease(r, fakeFetch);
      expect(images[0].version).toBe(r.version);
      expect(images.map((i) => i.imageIndex)).toEqual(r.images.map((i: { image_index: number }) => i.image_index));
    }
  });

  it('rejects a package whose checksum does not match', async () => {
    const r = manifest.releases[0];
    const bytes = new Uint8Array(fs.readFileSync(path.join(root, r.file)));
    bytes[bytes.length - 1] ^= 0xff;
    const fakeFetch = (async () => new Response(bytes)) as unknown as typeof fetch;
    await expect(downloadRelease(r, fakeFetch)).rejects.toThrow(/checksum/);
  });
});

describe('versions', () => {
  it('orders dotted versions numerically', () => {
    expect(compareVersions('22.4.0', '22.3.0')).toBe(1);
    expect(compareVersions('22.10.0', '22.9.0')).toBe(1);
    expect(compareVersions('22.4.0', '22.4')).toBe(0);
    expect(compareVersions('9.0.0', '22.4.0')).toBe(-1);
  });
});

describe('NUS shell', () => {
  it('collects output until the prompt and strips echo and prompt', async () => {
    const written: string[] = [];
    const rx = { writeValueWithoutResponse: async (v: BufferSource) => void written.push(new TextDecoder().decode(v)) };
    const tx = { addEventListener() {}, removeEventListener() {}, startNotifications: async () => {}, stopNotifications: async () => {} };
    const streamed: string[] = [];
    const nus = new NUSClient(rx, tx, () => {}, (t) => streamed.push(t));

    const p = nus.sendCommand('fw_version', 1000);
    nus.handleText('fw_version\r\nWeatherXM WS1300 MC: v22.4');
    nus.handleText('.0\r\nbt_nus:~$ ');
    const reply = await p;

    expect(written.join('')).toBe('fw_version\r\n');
    expect(cleanShellReply(reply, 'fw_version')).toBe('WeatherXM WS1300 MC: v22.4.0');
    expect(streamed).toEqual([]);

    nus.handleText('<inf> unsolicited log\r\n');
    expect(streamed).toEqual(['<inf> unsolicited log\r\n']);
  });
});
