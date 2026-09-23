import { WG1200_CONSTANTS } from './constants';
import { compareHexHashes, sha256Hex } from './hashing';

export interface FirmwareEntry {
  name: string;
  version: string;
  file: string;
  bytes: number;
  sha256: string;
  source_repo?: string;
  git_commit?: string;
  secure_boot_v2: boolean;
}

export interface FirmwareManifest {
  schema: number;
  hardware: string;
  chip: string;
  flash_bytes: number;
  app_partition_bytes: number;
  firmwares: {
    weatherxm: FirmwareEntry;
    meshtastic: FirmwareEntry;
    [key: string]: FirmwareEntry;
  };
}

export interface VerifiedFirmware {
  entry: FirmwareEntry;
  data: Uint8Array;
  sha256: string;
}

/**
 * Validates the schema and hardware constants of a loaded firmware manifest.
 */
export function validateManifest(manifest: any): FirmwareManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid manifest: Expected JSON object');
  }

  if (manifest.hardware !== WG1200_CONSTANTS.HARDWARE) {
    throw new Error(`Manifest hardware mismatch: expected '${WG1200_CONSTANTS.HARDWARE}', got '${manifest.hardware}'`);
  }

  if (manifest.chip !== WG1200_CONSTANTS.CHIP) {
    throw new Error(`Manifest chip mismatch: expected '${WG1200_CONSTANTS.CHIP}', got '${manifest.chip}'`);
  }

  if (manifest.flash_bytes !== WG1200_CONSTANTS.FLASH_SIZE_BYTES) {
    throw new Error(`Manifest flash_bytes mismatch: expected ${WG1200_CONSTANTS.FLASH_SIZE_BYTES}, got ${manifest.flash_bytes}`);
  }

  if (!manifest.firmwares || typeof manifest.firmwares !== 'object') {
    throw new Error('Manifest does not contain any firmware definitions');
  }

  const { weatherxm, meshtastic } = manifest.firmwares;
  if (!weatherxm || !meshtastic) {
    throw new Error("Manifest must include both 'weatherxm' and 'meshtastic' firmwares");
  }

  for (const [key, fw] of Object.entries(manifest.firmwares as Record<string, FirmwareEntry>)) {
    if (!fw.file || typeof fw.file !== 'string') {
      throw new Error(`Firmware '${key}' missing valid file path`);
    }
    if (!fw.bytes || fw.bytes <= 0 || fw.bytes > WG1200_CONSTANTS.MAX_APP_SIZE_BYTES) {
      throw new Error(
        `Firmware '${key}' size (${fw.bytes} bytes) exceeds maximum application limit (${WG1200_CONSTANTS.MAX_APP_SIZE_BYTES} bytes)`
      );
    }
    if (!fw.sha256 || typeof fw.sha256 !== 'string' || fw.sha256.length !== 64) {
      throw new Error(`Firmware '${key}' missing valid 64-character SHA-256 hash`);
    }
  }

  return manifest as FirmwareManifest;
}

/**
 * Fetches the manifest from the specified URL (defaults to /firmware/manifest.json).
 */
export async function loadManifest(manifestUrl = '/firmware/manifest.json'): Promise<FirmwareManifest> {
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Failed to load firmware manifest: HTTP ${response.status} ${response.statusText}`);
  }
  const json = await response.json();
  return validateManifest(json);
}

/**
 * Fetches and cryptographically verifies a firmware binary against the manifest.
 */
export async function fetchAndVerifyFirmware(entry: FirmwareEntry): Promise<VerifiedFirmware> {
  const response = await fetch(entry.file);
  if (!response.ok) {
    throw new Error(`Failed to download firmware binary from '${entry.file}': HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);

  // 1. Verify exact length
  if (data.byteLength !== entry.bytes) {
    throw new Error(
      `Firmware size mismatch for '${entry.name}': expected ${entry.bytes} bytes, received ${data.byteLength} bytes`
    );
  }

  // 2. Max size check
  if (data.byteLength > WG1200_CONSTANTS.MAX_APP_SIZE_BYTES) {
    throw new Error(
      `Firmware binary exceeds maximum permitted partition size of 4MB (${data.byteLength} bytes)`
    );
  }

  // 3. Verify SHA-256
  const computedSha = await sha256Hex(data);
  if (!compareHexHashes(computedSha, entry.sha256)) {
    throw new Error(
      `Firmware integrity check failed! Computed SHA-256 (${computedSha}) does not match manifest (${entry.sha256})`
    );
  }

  return {
    entry,
    data,
    sha256: computedSha,
  };
}
