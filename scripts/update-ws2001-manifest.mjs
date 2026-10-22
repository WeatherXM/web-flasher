#!/usr/bin/env node

/**
 * Manifest generator for WS2001 over-the-air (Bluetooth) firmware releases.
 *
 * Usage:
 *   node scripts/update-ws2001-manifest.mjs                                    # rescan public/firmware/ws2001
 *   node scripts/update-ws2001-manifest.mjs path/to/ws2001-application-v45-ble-dfu.zip [--commit <sha>]
 *
 * Packages come from ws2001-firmware/scripts/build_ble_dfu.sh (nrfutil, signed with the bootloader key).
 * For each zip it checks that the package is application-only, targets HW 52 / S140 7.2.0 (0x0100), that
 * the image hash matches the init packet and that the ECDSA signature verifies against the WS2001
 * bootloader public key. The firmware version is the DFU fw_version (convention: major*10+minor,
 * 45 = V4.5). Packages are stored as ws2001-application-v<major>.<minor>-ble-dfu.zip.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { unzipSync, strFromU8 } from 'fflate';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FW_DIR = path.join(ROOT_DIR, 'public', 'firmware', 'ws2001');
const MANIFEST_PATH = path.join(FW_DIR, 'manifest.json');
const PUBLIC_KEY_LE =
  '61f1308c12c4bebb3f7221fd93f6b62c8f10975738787dc0fe3a005fa0ff26e4' +
  '9e9d1f889cf2b6b9161f45566758ecd19e0b5f91b9f9b618928494f849b206f7';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function varint(b, pos) {
  let r = 0, s = 0;
  for (;;) { const x = b[pos++]; r += (x & 0x7f) * 2 ** s; if (!(x & 0x80)) return [r, pos]; s += 7; }
}
function fields(b) {
  const f = new Map();
  for (let p = 0; p < b.length; ) {
    let k; [k, p] = varint(b, p);
    const n = Math.floor(k / 8), w = k & 7;
    let v;
    if (w === 0) [v, p] = varint(b, p);
    else if (w === 2) { let l; [l, p] = varint(b, p); v = b.subarray(p, p + l); p += l; }
    else if (w === 5) { v = b.readUInt32LE(p); p += 4; }
    else throw new Error(`unsupported wire type ${w}`);
    if (!f.has(n)) f.set(n, []);
    f.get(n).push(v);
  }
  return f;
}

function inspect(zipBuf, name) {
  const entries = unzipSync(new Uint8Array(zipBuf));
  const manifest = JSON.parse(strFromU8(entries['manifest.json'])).manifest;
  if (!manifest?.application || Object.keys(manifest).length !== 1) throw new Error(`${name}: not an application-only package`);
  const fw = Buffer.from(entries[manifest.application.bin_file]);
  const dat = Buffer.from(entries[manifest.application.dat_file]);
  if (!fw.length || !dat.length) throw new Error(`${name}: empty image or init packet`);
  const signed = fields(fields(dat).get(2)[0]);
  const initBytes = Buffer.from(fields(signed.get(1)[0]).get(2)[0]);
  const init = fields(initBytes);
  const fwVersion = init.get(1)?.[0];
  if ((init.get(4)?.[0] ?? 0) !== 0) throw new Error(`${name}: fw_type is not APPLICATION (0)`);
  if (init.get(2)?.[0] !== 52) throw new Error(`${name}: hw_version is not 52`);
  const sdReq = [];
  for (const v of init.get(3) ?? []) {
    if (typeof v === 'number') sdReq.push(v);
    else for (let p = 0; p < v.length; ) { let n; [n, p] = varint(v, p); sdReq.push(n); }
  }
  if (!sdReq.includes(0x0100)) throw new Error(`${name}: sd_req does not include S140 7.2.0 (0x0100)`);
  if (init.get(7)?.[0] !== fw.length) throw new Error(`${name}: app_size does not match image length`);
  const hashFields = fields(init.get(8)[0]);
  if (hashFields.get(1)?.[0] !== 3) throw new Error(`${name}: hash_type is not SHA-256 (3)`);
  const hash = Buffer.from(hashFields.get(2)[0]).reverse().toString('hex');
  if (hash.length !== 64 || hash !== sha256(fw)) throw new Error(`${name}: image hash does not match the init packet`);
  if ((signed.get(2)?.[0] ?? 0) !== 0) throw new Error(`${name}: signature_type is not ECDSA_P256_SHA256 (0)`);
  const sig = Buffer.from(signed.get(3)[0]);
  if (sig.length !== 64) throw new Error(`${name}: signature is not 64 bytes`);
  const le = Buffer.from(PUBLIC_KEY_LE, 'hex');
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: Buffer.from(le.subarray(0, 32)).reverse().toString('base64url'),
    y: Buffer.from(le.subarray(32)).reverse().toString('base64url'),
  };
  const sigBE = Buffer.concat([Buffer.from(sig.subarray(0, 32)).reverse(), Buffer.from(sig.subarray(32)).reverse()]);
  const ok = crypto.verify('sha256', initBytes, { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, sigBE);
  if (!ok) throw new Error(`${name}: signature does not verify against the WS2001 bootloader key`);
  return { fwVersion, imageBytes: fw.length, imageSha256: sha256(fw) };
}

const label = (v, file) => {
  const m = file?.match(/-v(\d+\.\d+)-ble-dfu\.zip$/);
  if (m) return m[1];
  return v >= 40 && v <= 55 ? `4.${v - 40}` : `${Math.floor(v / 10)}.${v % 10}`;
};

function main() {
  fs.mkdirSync(FW_DIR, { recursive: true });
  const args = process.argv.slice(2);
  const commitIdx = args.indexOf('--commit');
  const commit = commitIdx >= 0 ? args[commitIdx + 1] : undefined;
  const input = args.find((a, i) => !a.startsWith('--') && (commitIdx < 0 || i !== commitIdx + 1));
  const forceOverwrite = args.includes('--force');
  const previous = fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) : { releases: [] };

  if (input) {
    const buf = fs.readFileSync(input);
    const info = inspect(buf, path.basename(input));
    const verStr = label(info.fwVersion, path.basename(input));
    const dest = path.join(FW_DIR, `ws2001-application-v${verStr}-ble-dfu.zip`);
    if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) !== sha256(buf) && !forceOverwrite) {
      throw new Error(`${path.basename(dest)} already exists with different SHA-256; pass --force to overwrite`);
    }
    fs.writeFileSync(dest, buf);
    console.log(`Added ${path.relative(ROOT_DIR, dest)} (fw_version ${info.fwVersion})`);
    if (commit) previous.releases = previous.releases.filter((r) => r.fw_version !== info.fwVersion).concat([{ fw_version: info.fwVersion, git_commit: commit, sha256: sha256(buf) }]);
  }

  const releases = [];
  for (const file of fs.readdirSync(FW_DIR).filter((f) => f.endsWith('-ble-dfu.zip'))) {
    const buf = fs.readFileSync(path.join(FW_DIR, file));
    const info = inspect(buf, file);
    const prev = previous.releases.find((r) => r.fw_version === info.fwVersion) ?? {};
    const zipSha256 = sha256(buf);
    const sameBytes = !prev.sha256 || prev.sha256 === zipSha256;
    const verStr = label(info.fwVersion, file);
    releases.push({
      version: verStr,
      label: `V${verStr}`,
      fw_version: info.fwVersion,
      file: `/firmware/ws2001/${file}`,
      bytes: buf.length,
      sha256: zipSha256,
      image_bytes: info.imageBytes,
      image_sha256: info.imageSha256,
      source_repo: 'WeatherXM/ws2001-firmware',
      ...(sameBytes && prev.git_commit ? { git_commit: prev.git_commit } : {}),
      built_at: sameBytes && prev.built_at ? prev.built_at : fs.statSync(path.join(FW_DIR, file)).mtime.toISOString(),
    });
  }
  if (releases.length === 0) throw new Error('No *-ble-dfu.zip packages in public/firmware/ws2001');
  releases.sort((a, b) => b.fw_version - a.fw_version);
  const manifest = { schema: 1, hardware: 'WS2001', soc: 'nRF52840', latest: releases[0].version, releases };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${path.relative(ROOT_DIR, MANIFEST_PATH)}: latest ${manifest.latest}, ${releases.length} release(s)`);
}

main();
