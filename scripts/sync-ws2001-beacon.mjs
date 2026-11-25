#!/usr/bin/env node
/**
 * Sync the WS2001 beacon decoders from the firmware repository.
 *
 *   node scripts/sync-ws2001-beacon.mjs path/to/ws2001-firmware
 *
 * Copies tools/decoders/ws2001_beacon_decoder.js and tools/ws2001_beacon.py to public/decoders/, where
 * /ws2001/beacon/reference offers them for download. tests/ble/ws2001BeaconDecoderJs.test.ts checks the
 * JavaScript decoder against src/lib/ble/ws2001Beacon.ts.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const firmware = process.argv[2] && path.resolve(process.argv[2]);
if (!firmware || !existsSync(path.join(firmware, 'tools', 'ws2001_beacon.py'))) {
  console.error('Usage: node scripts/sync-ws2001-beacon.mjs path/to/ws2001-firmware');
  process.exit(1);
}
for (const rel of ['tools/decoders/ws2001_beacon_decoder.js', 'tools/ws2001_beacon.py']) {
  const dest = path.join(root, 'public', 'decoders', path.basename(rel));
  copyFileSync(path.join(firmware, rel), dest);
  console.log(`Copied ${rel} -> ${path.relative(root, dest)}`);
}
