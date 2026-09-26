#!/usr/bin/env node

/**
 * Refresh the firmware manifests of both devices.
 *
 * Usage:
 *   npm run manifest                                   # rescan WG1200 and WS1300 firmware folders
 *   npm run manifest -- path/to/fw-signed.bin          # add a WG1200 image, then refresh both
 *   npm run manifest -- path/to/ws1300_vX-dfu.zip      # add a WS1300 package, then refresh both
 *
 * Files are routed by name: *-dfu.zip goes to WS1300, *.bin to WG1200.
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WG1200 = path.join(SCRIPTS_DIR, 'update-manifest.mjs');
const WS1300 = path.join(SCRIPTS_DIR, 'update-ws1300-manifest.mjs');

const wg1200Files = [];
const ws1300Files = [];
for (const arg of process.argv.slice(2)) {
  if (arg.endsWith('-dfu.zip')) ws1300Files.push(arg);
  else if (arg.endsWith('.bin')) wg1200Files.push(arg);
  else {
    console.error(`Error: don't know which device ${arg} is for (expected a WG1200 .bin or a WS1300 -dfu.zip)`);
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
