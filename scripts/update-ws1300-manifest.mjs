#!/usr/bin/env node

/**
 * Manifest generator for WS1300 over-the-air (Bluetooth) firmware releases.
 *
 * Usage:
 *   node scripts/update-ws1300-manifest.mjs                                  # rescan public/firmware/ws1300
 *   node scripts/update-ws1300-manifest.mjs path/to/ws1300_release_v22.4-dfu.zip
 *   npm run manifest:ws1300 -- path/to/ws1300_release_v22.4-dfu.zip
 *
 * For every *-dfu.zip in public/firmware/ws1300/ it:
 *   1. Reads the nRF Connect SDK manifest.json and each image it lists
 *   2. Checks the MCUboot header (magic 0x96f3b83d) and that the image is complete
 *   3. Computes SHA-256 of the package and of each image
 *   4. Writes public/firmware/ws1300/manifest.json with the newest release as "latest"
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { unzipSync, strFromU8 } from 'fflate';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FW_DIR = path.join(ROOT_DIR, 'public', 'firmware', 'ws1300');
const MANIFEST_PATH = path.join(FW_DIR, 'manifest.json');

const MCUBOOT_IMAGE_MAGIC = 0x96f3b83d;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function mcubootVersion(buf, name) {
  if (buf.length < 32) throw new Error(`${name}: too small for an MCUboot header`);
  const v = new DataView(buf.buffer, buf.byteOffset, 32);
  if (v.getUint32(0, true) !== MCUBOOT_IMAGE_MAGIC) throw new Error(`${name}: MCUboot magic 0x96f3b83d missing`);
  const hdrSize = v.getUint16(8, true);
  const imgSize = v.getUint32(12, true);
  if (hdrSize + imgSize > buf.length) throw new Error(`${name}: truncated (${buf.length} < ${hdrSize + imgSize})`);
  const build = v.getUint32(24, true);
  return `${v.getUint8(20)}.${v.getUint8(21)}.${v.getUint16(22, true)}` + (build ? `.${build}` : '');
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function describePackage(fileName) {
  const full = path.join(FW_DIR, fileName);
  const zipBytes = fs.readFileSync(full);
  if (zipBytes.length > MAX_PACKAGE_BYTES) throw new Error(`${fileName}: ${zipBytes.length} bytes is larger than expected`);

  const entries = unzipSync(new Uint8Array(zipBytes));
  if (!entries['manifest.json']) throw new Error(`${fileName}: no manifest.json inside`);
  const inner = JSON.parse(strFromU8(entries['manifest.json']));

  const images = (inner.files ?? []).map((f) => {
    const data = entries[f.file];
    if (!data) throw new Error(`${fileName}: manifest lists ${f.file} but it is missing`);
    const imageIndex = Number.parseInt(String(f.image_index ?? 0), 10);
    if (imageIndex !== 0 && imageIndex !== 1) throw new Error(`${fileName}: unexpected image_index ${f.image_index}`);
    if (!/ws1300/i.test(f.board ?? '')) throw new Error(`${fileName}: ${f.file} is built for "${f.board}", not WS1300`);
    return {
      file: f.file,
      image_index: imageIndex,
      core: imageIndex === 0 ? 'app' : 'net',
      version: mcubootVersion(data, f.file),
      bytes: data.length,
      sha256: sha256(data),
    };
  });
  const app = images.find((i) => i.image_index === 0);
  if (!app) throw new Error(`${fileName}: no application core image`);

  const revision = inner.firmware?.application?.revision ?? '';
  if (revision.endsWith('-dirty')) {
    console.warn(`  ! ${fileName}: built from a working tree with uncommitted changes (${revision})`);
  }
  const labelMatch = fileName.match(/_v(\d+(?:\.\d+)*)/);

  return {
    version: app.version,
    label: `v${labelMatch ? labelMatch[1] : app.version}`,
    file: `/firmware/ws1300/${fileName}`,
    bytes: zipBytes.length,
    sha256: sha256(zipBytes),
    source_repo: 'WeatherXM/ws1300-firmware-legacy',
    git_commit: revision ? revision.replace(/-dirty$/, '').slice(0, 7) : undefined,
    built_at: inner.time ? new Date(inner.time * 1000).toISOString() : undefined,
    images: images.sort((a, b) => a.image_index - b.image_index),
  };
}

function main() {
  fs.mkdirSync(FW_DIR, { recursive: true });

  const input = process.argv[2];
  if (input) {
    const src = path.resolve(input);
    if (!src.endsWith('-dfu.zip')) throw new Error('Expected a WS1300 *-dfu.zip package');
    fs.copyFileSync(src, path.join(FW_DIR, path.basename(src)));
    console.log(`Copied ${path.basename(src)} into public/firmware/ws1300/`);
  }

  const zips = fs.readdirSync(FW_DIR).filter((f) => f.endsWith('-dfu.zip'));
  if (zips.length === 0) throw new Error('No *-dfu.zip packages in public/firmware/ws1300/');

  const releases = zips.map((z) => {
    console.log(`Checking ${z}`);
    return describePackage(z);
  });
  releases.sort((a, b) => compareVersions(b.version, a.version));

  const manifest = {
    schema: 1,
    hardware: 'WS1300',
    soc: 'nRF5340',
    latest: releases[0].version,
    releases,
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${path.relative(ROOT_DIR, MANIFEST_PATH)}: ${releases.length} release(s), latest ${releases[0].label}`);
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
