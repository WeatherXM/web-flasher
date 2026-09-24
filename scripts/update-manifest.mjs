#!/usr/bin/env node

/**
 * Manifest Generator & Firmware Updater for WeatherXM WG1200 Web Flasher.
 *
 * Usage:
 *   node scripts/update-manifest.mjs
 *   node scripts/update-manifest.mjs path/to/new_firmware-signed.bin
 *   npm run manifest
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const PUBLIC_FW_DIR = path.join(ROOT_DIR, 'public', 'firmware');
const DIST_FW_DIR = path.join(ROOT_DIR, 'dist', 'firmware');
const MANIFEST_PATH = path.join(PUBLIC_FW_DIR, 'manifest.json');

const MAX_APP_SIZE_BYTES = 4 * 1024 * 1024; // 4MB
const FLASH_SIZE_BYTES = 16 * 1024 * 1024; // 16MB
const SECURE_BOOT_MAGIC_BYTE = 0xe7;
const ESP_IMAGE_MAGIC = 0xe9;
const ESP_APP_DESC_MAGIC = 0xabcd5432;

const KNOWN_METADATA = {
  // WeatherXM v0.8.27
  '7a394f858ab9c4a04ed653d20ca1337be9eb4112d741b21c4eacad3e0fc953a6': {
    git_commit: 'ceee14f',
    source_repo: 'WeatherXM/wg1200-firmware',
  },
  // WeatherXM v0.8.25
  'cd2a7df91dc71992d0ba0f311de5b69a65c3db902ae2c4044c1d15dfd4bd26f6': {
    git_commit: '0c2c072',
    source_repo: 'WeatherXM/wg1200-firmware',
  },
  // WeatherXM v0.8.23
  '13715499870a49ebdc90440ae22bc653b62f32ed3f8084253c96c6062c86a3ed': {
    git_commit: 'dc3b79e',
    source_repo: 'WeatherXM/wg1200-firmware',
  },
  // Meshtastic TFT v2.8.1
  'ca56cecdb93f917368741e59410101ec72d7efee465e1cc83723b09fac8ffb62': {
    git_commit: 'caa2e99',
    source_repo: 'WeatherXM/Meshtastic-firmware',
  },
  // Meshtastic Standard v2.8.1
  '5be9785196bd19f27f463cb4bd47179085854660771879587e9ae916c34b91ee': {
    git_commit: '6201f02',
    source_repo: 'WeatherXM/Meshtastic-firmware',
  },
};

/**
 * Parse ESP-IDF app descriptor from binary buffer
 */
function parseAppDesc(buf) {
  for (let i = 0x20; i < Math.min(buf.length - 256, 0x1000); i += 4) {
    if (buf.readUInt32LE(i) === ESP_APP_DESC_MAGIC) {
      const version = buf
        .subarray(i + 16, i + 48)
        .toString('utf8')
        .replace(/\0.*$/g, '');
      const project_name = buf
        .subarray(i + 48, i + 80)
        .toString('utf8')
        .replace(/\0.*$/g, '');
      const time = buf
        .subarray(i + 80, i + 96)
        .toString('utf8')
        .replace(/\0.*$/g, '');
      const date = buf
        .subarray(i + 96, i + 112)
        .toString('utf8')
        .replace(/\0.*$/g, '');
      const idf_ver = buf
        .subarray(i + 112, i + 144)
        .toString('utf8')
        .replace(/\0.*$/g, '');

      return { version, project_name, time, date, idf_ver };
    }
  }
  return null;
}

/**
 * Check if binary has Secure Boot V2 signature block
 */
function hasSecureBootV2(buf) {
  return buf.length >= 4096 && buf[buf.length - 4096] === SECURE_BOOT_MAGIC_BYTE;
}

/**
 * Extract semantic version numbers from a string for sorting
 */
function parseSemVer(v) {
  const match = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match) {
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
  }
  return [0, 0, 0];
}

function compareVersionsDesc(a, b) {
  const [a1, a2, a3] = parseSemVer(a);
  const [b1, b2, b3] = parseSemVer(b);
  if (a1 !== b1) return b1 - a1;
  if (a2 !== b2) return b2 - a2;
  return b3 - a3;
}

/**
 * If an argument is provided, copy it to public/firmware
 */
function handleCliFileArg() {
  const fileArg = process.argv[2];
  if (!fileArg) return;

  const resolved = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(resolved)) {
    console.error(`[ERROR] File not found: ${resolved}`);
    process.exit(1);
  }

  const buf = fs.readFileSync(resolved);
  const appDesc = parseAppDesc(buf);
  const isSecure = hasSecureBootV2(buf);

  console.log(`[INFO] Analyzing input file: ${path.basename(resolved)}`);
  console.log(`       Size: ${buf.length} bytes`);
  console.log(`       Secure Boot V2: ${isSecure ? 'VALID (0xE7 magic found)' : 'NOT FOUND'}`);
  if (appDesc) {
    console.log(`       Project: ${appDesc.project_name}, Version: ${appDesc.version}`);
  }

  let targetSubdir = 'weatherxm';
  const basename = path.basename(resolved).toLowerCase();
  if (basename.includes('mesh') || (appDesc && appDesc.project_name.toLowerCase().includes('mesh'))) {
    targetSubdir = 'meshtastic';
  }

  const targetDir = path.join(PUBLIC_FW_DIR, targetSubdir);
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, path.basename(resolved));

  if (path.resolve(resolved) !== path.resolve(targetPath)) {
    fs.copyFileSync(resolved, targetPath);
    console.log(`[OK] Copied firmware to ${path.relative(ROOT_DIR, targetPath)}`);
  }
}

/**
 * Prune any files from dist/firmware that no longer exist in public/firmware
 */
function pruneOrphanedDistFiles() {
  if (!fs.existsSync(DIST_FW_DIR)) return;

  for (const sub of ['weatherxm', 'meshtastic']) {
    const distSub = path.join(DIST_FW_DIR, sub);
    const pubSub = path.join(PUBLIC_FW_DIR, sub);
    if (!fs.existsSync(distSub)) continue;

    for (const f of fs.readdirSync(distSub)) {
      if (f.endsWith('.bin')) {
        const pubFile = path.join(pubSub, f);
        if (!fs.existsSync(pubFile)) {
          const distFile = path.join(distSub, f);
          try {
            fs.unlinkSync(distFile);
            console.log(`[INFO] Pruned deleted file from dist: ${sub}/${f}`);
          } catch (e) {
            console.warn(`[WARN] Could not remove orphaned dist file ${distFile}:`, e.message);
          }
        }
      }
    }
  }
}

/**
 * Main manifest regeneration routine
 */
export function generateManifest() {
  handleCliFileArg();
  pruneOrphanedDistFiles();

  // Load existing manifest to preserve known commits, source repos, and custom labels
  let existingManifest = null;
  if (fs.existsSync(MANIFEST_PATH)) {
    try {
      existingManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    } catch {
      // Ignore parse error on existing file
    }
  }

  const existingEntriesBySha = new Map();
  const existingEntriesByFile = new Map();
  if (existingManifest && existingManifest.firmwares) {
    for (const [, fw] of Object.entries(existingManifest.firmwares)) {
      if (fw.sha256) existingEntriesBySha.set(fw.sha256, fw);
      if (fw.file) existingEntriesByFile.set(fw.file, fw);
    }
  }

  const manifest = {
    schema: 1,
    hardware: 'WG1200',
    chip: 'ESP32-S3',
    flash_bytes: FLASH_SIZE_BYTES,
    app_partition_bytes: MAX_APP_SIZE_BYTES,
    firmwares: {},
  };

  // 1. Scan WeatherXM firmwares
  const wxmDir = path.join(PUBLIC_FW_DIR, 'weatherxm');
  const wxmEntries = [];

  if (fs.existsSync(wxmDir)) {
    const seenHashes = new Set();
    const files = fs.readdirSync(wxmDir).filter((f) => f.endsWith('.bin')).sort();

    for (const f of files) {
      const filePath = path.join(wxmDir, f);
      const buf = fs.readFileSync(filePath);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

      if (seenHashes.has(sha256)) {
        continue;
      }
      seenHashes.add(sha256);

      const isSecure = hasSecureBootV2(buf);
      const appDesc = parseAppDesc(buf);

      // Version detection: filename or appDesc
      const verMatch = f.match(/(\d+\.\d+\.\d+)/);
      let version = verMatch ? verMatch[1] : (appDesc?.version ?? 'unknown');

      // Check existing or known metadata
      const known = KNOWN_METADATA[sha256];
      const existing = existingEntriesBySha.get(sha256) || existingEntriesByFile.get(`/firmware/weatherxm/${f}`);

      // Git commit detection: filename or known or existing metadata
      const commitMatch = f.match(/-g?([0-9a-f]{7,8})/i);
      const git_commit = commitMatch ? commitMatch[1] : (known?.git_commit ?? existing?.git_commit ?? undefined);
      const source_repo = known?.source_repo || existing?.source_repo || 'WeatherXM/wg1200-firmware';

      wxmEntries.push({
        file: `/firmware/weatherxm/${f}`,
        filename: f,
        bytes: buf.length,
        sha256,
        version,
        git_commit,
        secure_boot_v2: isSecure,
        date: appDesc?.date,
        source_repo,
      });
    }
  }

  // Sort WeatherXM firmwares by semantic version descending
  wxmEntries.sort((a, b) => compareVersionsDesc(a.version, b.version));

  // Assign keys for WeatherXM
  wxmEntries.forEach((entry, idx) => {
    const isLatest = idx === 0;
    const key = isLatest ? 'weatherxm' : `weatherxm_${entry.version.replace(/\./g, '_')}`;
    const label = isLatest
      ? `WeatherXM v${entry.version} (Latest Release)`
      : `WeatherXM v${entry.version} (Stable Release)`;

    manifest.firmwares[key] = {
      name: 'WeatherXM',
      version: entry.version,
      label,
      category: 'weatherxm',
      file: entry.file,
      bytes: entry.bytes,
      sha256: entry.sha256,
      source_repo: entry.source_repo,
      ...(entry.git_commit ? { git_commit: entry.git_commit } : {}),
      secure_boot_v2: entry.secure_boot_v2,
    };
  });

  // 2. Scan Meshtastic firmwares
  const meshDir = path.join(PUBLIC_FW_DIR, 'meshtastic');
  if (fs.existsSync(meshDir)) {
    const meshFiles = fs.readdirSync(meshDir).filter((f) => f.endsWith('.bin')).sort((a, b) => {
      const aTft = a.includes('tft');
      const bTft = b.includes('tft');
      if (aTft && !bTft) return -1;
      if (!aTft && bTft) return 1;
      return a.localeCompare(b);
    });
    const seenHashes = new Set();

    for (const f of meshFiles) {
      const filePath = path.join(meshDir, f);
      const buf = fs.readFileSync(filePath);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

      if (seenHashes.has(sha256)) {
        continue;
      }
      seenHashes.add(sha256);

      const isSecure = hasSecureBootV2(buf);
      const known = KNOWN_METADATA[sha256];
      const existing = existingEntriesBySha.get(sha256) || existingEntriesByFile.get(`/firmware/meshtastic/${f}`);

      const isTft = f.includes('tft') || buf.length > 3_000_000;
      const verMatch = f.match(/(\d+\.\d+\.\d+)/);
      const baseVer = verMatch ? verMatch[1] : '2.8.1';
      const version = isTft ? `${baseVer}-wxm` : `${baseVer}-standard`;
      const key = isTft ? 'meshtastic' : 'meshtastic_standard';
      const label = isTft
        ? `Meshtastic v${baseVer} (TFT Touchscreen — Default)`
        : `Meshtastic v${baseVer} (Standard / Single Button Navigation)`;

      const git_commit = known?.git_commit || existing?.git_commit || (isTft ? 'caa2e99' : '6201f02');
      const source_repo = known?.source_repo || existing?.source_repo || 'WeatherXM/Meshtastic-firmware';

      manifest.firmwares[key] = {
        name: 'Meshtastic',
        version,
        label,
        category: 'meshtastic',
        file: `/firmware/meshtastic/${f}`,
        bytes: buf.length,
        sha256,
        source_repo,
        git_commit,
        secure_boot_v2: isSecure,
      };
    }
  }

  // Ensure mandatory firmwares exist
  if (!manifest.firmwares.weatherxm || !manifest.firmwares.meshtastic) {
    console.error('[ERROR] Manifest is missing mandatory weatherxm or meshtastic entries!');
    process.exit(1);
  }

  // Write manifest to public/firmware/manifest.json
  const jsonContent = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(MANIFEST_PATH, jsonContent, 'utf8');
  console.log(`\n[OK] Updated ${path.relative(ROOT_DIR, MANIFEST_PATH)} successfully!`);

  // Also sync to dist/firmware/manifest.json if dist directory exists
  if (fs.existsSync(DIST_FW_DIR)) {
    fs.writeFileSync(path.join(DIST_FW_DIR, 'manifest.json'), jsonContent, 'utf8');
    console.log(`[OK] Synced to ${path.relative(ROOT_DIR, path.join(DIST_FW_DIR, 'manifest.json'))}`);
  }

  // Display summary table
  console.log('\n--- Firmware Manifest Entries ---');
  for (const [key, fw] of Object.entries(manifest.firmwares)) {
    const mb = (fw.bytes / (1024 * 1024)).toFixed(2);
    console.log(` • [${key}] ${fw.name} v${fw.version} (${mb} MB)`);
    console.log(`   File: ${fw.file}`);
    console.log(`   SHA256: ${fw.sha256}`);
    console.log(`   Commit: ${fw.git_commit ?? 'n/a'}`);
    console.log(`   Secure Boot V2: ${fw.secure_boot_v2 ? 'YES' : 'NO'}`);
    console.log(`   Repo: ${fw.source_repo}\n`);
  }

  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateManifest();
}
