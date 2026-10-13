#!/usr/bin/env node

/**
 * Refresh the firmware manifests of all devices (WG1200, WS1300, WS2001).
 *
 * Usage:
 *   npm run manifest                                   # rescan all firmware folders
 *   npm run manifest -- path/to/fw-signed.bin          # add a WG1200 image, then refresh both
 *   npm run manifest -- path/to/ws1300_vX-dfu.zip      # add a WS1300 package, then refresh all
 *   npm run manifest -- path/to/ws2001-application-vNN-ble-dfu.zip   # add a WS2001 package
 *
 * Files are routed by name: ws2001*-ble-dfu.zip goes to WS2001, other *-dfu.zip to WS1300, *.bin to WG1200.
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WG1200 = path.join(SCRIPTS_DIR, 'update-manifest.mjs');
const WS1300 = path.join(SCRIPTS_DIR, 'update-ws1300-manifest.mjs');
const WS2001 = path.join(SCRIPTS_DIR, 'update-ws2001-manifest.mjs');

const wg1200Files = [];
const ws1300Files = [];
const ws2001Files = [];
for (const arg of process.argv.slice(2)) {
  if (/ws2001.*-ble-dfu\.zip$/i.test(path.basename(arg))) ws2001Files.push(arg);
  else if (arg.endsWith('-dfu.zip')) ws1300Files.push(arg);
  else if (arg.endsWith('.bin')) wg1200Files.push(arg);
  else {
    console.error(`Error: don't know which device ${arg} is for (expected a WG1200 .bin, a WS1300 -dfu.zip or a WS2001 ws2001-*-ble-dfu.zip)`);
    process.exit(1);
  }
}

function run(label, script, args) {
  console.log(`\n=== ${label} ===`);
  const res = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`\n${label} manifest update failed.`);
    process.exit(res.status ?? 1);
  }
}

// Each script copies at most one file per run and then rescans its folder
for (const f of wg1200Files) run('WG1200', WG1200, [f]);
if (wg1200Files.length === 0) run('WG1200', WG1200, []);
for (const f of ws1300Files) run('WS1300', WS1300, [f]);
if (ws1300Files.length === 0) run('WS1300', WS1300, []);
for (const f of ws2001Files) run('WS2001', WS2001, [f]);
if (ws2001Files.length === 0) run('WS2001', WS2001, []);
