import { WG1200_CONSTANTS } from './constants';
import { md5Hex, compareHexHashes } from './hashing';

export interface PartitionRecord {
  label: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
  flags: number;
}

export interface ParsedPartitionTable {
  partitions: Record<string, PartitionRecord>;
  duplicateLabels: string[];
  md5Valid: boolean | null; // null if no MD5 entry present
}

export interface PartitionVerificationResult {
  valid: boolean;
  partitions: Record<string, PartitionRecord>;
  md5Verified?: boolean | null;
  errors: string[];
}

export const EXPECTED_WG1200_PARTITIONS: Record<
  string,
  { offset: number; size: number; type?: number; subtype?: number }
> = {
  esp_secure_cert: { offset: 0x00d000, size: 0x002000, type: 0x3f, subtype: 0x06 },
  nvs: { offset: 0x00f000, size: 0x004000, type: 0x01, subtype: 0x02 },
  otadata: { offset: 0x013000, size: 0x002000, type: 0x01, subtype: 0x00 },
  phy_init: { offset: 0x015000, size: 0x001000, type: 0x01, subtype: 0x01 },
  factory: { offset: 0x020000, size: 0x400000, type: 0x00, subtype: 0x00 },
  ota_0: { offset: 0x420000, size: 0x400000, type: 0x00, subtype: 0x10 },
  ota_1: { offset: 0x820000, size: 0x400000, type: 0x00, subtype: 0x11 },
  nvs_key: { offset: 0xc20000, size: 0x001000, type: 0x01, subtype: 0x04 },
  spiffs: { offset: 0xc21000, size: 0x300000, type: 0x01, subtype: 0x82 },
};

/**
 * Parses ESP-IDF binary partition table bytes (32-byte records with 0x50AA magic).
 * Also detects duplicate partition labels and verifies ESP-IDF MD5 checksum (magic 0xEBEB).
 */
export function parsePartitionTableWithMetadata(bytes: Uint8Array): ParsedPartitionTable {
  const partitions: Record<string, PartitionRecord> = {};
  const duplicateLabels: string[] = [];
  let md5Valid: boolean | null = null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i + 32 <= bytes.byteLength; i += 32) {
    const magic = view.getUint16(i, true);

    // Check for ESP-IDF partition table MD5 record (magic 0xEBEB)
    if (magic === 0xebeb) {
      const type = view.getUint8(i + 2);
      const subtype = view.getUint8(i + 3);
      if (type === 0xff && subtype === 0xff) {
        // MD5 of all preceding partition entries
        const precedingEntries = bytes.subarray(0, i);
        const calculatedMd5 = md5Hex(precedingEntries);

        // Stored MD5 is at bytes 16..31 of this 32-byte record
        const storedMd5Bytes = bytes.subarray(i + 16, i + 32);
        let storedMd5Hex = '';
        for (let b = 0; b < 16; b++) {
          storedMd5Hex += storedMd5Bytes[b].toString(16).padStart(2, '0');
        }

        md5Valid = compareHexHashes(calculatedMd5, storedMd5Hex);
      }
      break;
    }

    if (magic !== WG1200_CONSTANTS.PARTITION_TABLE_MAGIC) {
      // End of table (e.g. 0xFFFF unprogrammed flash)
      break;
    }

    const type = view.getUint8(i + 2);
    const subtype = view.getUint8(i + 3);
    const offset = view.getUint32(i + 4, true);
    const size = view.getUint32(i + 8, true);

    // Label: 16 bytes ASCII null-terminated
    let label = '';
    for (let c = 0; c < 16; c++) {
      const charCode = bytes[i + 12 + c];
      if (charCode === 0) break;
      label += String.fromCharCode(charCode);
    }
    label = label.trim();

    const flags = view.getUint32(i + 28, true);

    if (label) {
      if (partitions[label]) {
        duplicateLabels.push(label);
      } else {
        partitions[label] = {
          label,
          type,
          subtype,
          offset,
          size,
          flags,
        };
      }
    }
  }

  return { partitions, duplicateLabels, md5Valid };
}

/**
 * Standard parse function returning Record<string, PartitionRecord> for backward compatibility.
 */
export function parsePartitionTable(bytes: Uint8Array): Record<string, PartitionRecord> {
  return parsePartitionTableWithMetadata(bytes).partitions;
}

/**
 * Validates that the parsed partition table conforms strictly to the WG1200 layout.
 */
export function verifyWg1200PartitionTable(
  partitions: Record<string, PartitionRecord>,
  chipName?: string,
  flashSizeBytes?: number,
  metadata?: { duplicateLabels?: string[]; md5Valid?: boolean | null }
): PartitionVerificationResult {
  const errors: string[] = [];

  // Chip identification check
  if (chipName && !chipName.toLowerCase().includes('esp32-s3') && !chipName.toLowerCase().includes('esp32s3')) {
    errors.push(`Expected ESP32-S3 chip, but detected '${chipName}'`);
  }

  // Flash size check (must be 16 MB)
  if (flashSizeBytes !== undefined && flashSizeBytes !== WG1200_CONSTANTS.FLASH_SIZE_BYTES) {
    const detectedMb = (flashSizeBytes / (1024 * 1024)).toFixed(0);
    errors.push(`Expected 16 MB flash size, but detected ${detectedMb} MB (${flashSizeBytes} bytes)`);
  }

  // Duplicate labels check
  if (metadata?.duplicateLabels && metadata.duplicateLabels.length > 0) {
    errors.push(`Duplicate partition labels detected: ${metadata.duplicateLabels.join(', ')}`);
  }

  // MD5 checksum verification check
  if (metadata?.md5Valid === false) {
    errors.push('Partition table MD5 checksum verification failed! Flash corruption suspected.');
  }

  // Validate every required WG1200 partition
  for (const [name, expected] of Object.entries(EXPECTED_WG1200_PARTITIONS)) {
    const found = partitions[name];
    if (!found) {
      errors.push(`Missing mandatory WG1200 partition: '${name}'`);
      continue;
    }

    if (found.offset !== expected.offset) {
      errors.push(
        `Partition '${name}' offset mismatch: found 0x${found.offset.toString(16)}, expected 0x${expected.offset.toString(16)}`
      );
    }

    if (found.size !== expected.size) {
      errors.push(
        `Partition '${name}' size mismatch: found 0x${found.size.toString(16)} (${found.size} bytes), expected 0x${expected.size.toString(16)} (${expected.size} bytes)`
      );
    }

    if (expected.type !== undefined && found.type !== expected.type) {
      errors.push(`Partition '${name}' type mismatch: found 0x${found.type.toString(16)}, expected 0x${expected.type.toString(16)}`);
    }

    if (expected.subtype !== undefined && found.subtype !== expected.subtype) {
      errors.push(
        `Partition '${name}' subtype mismatch: found 0x${found.subtype.toString(16)}, expected 0x${expected.subtype.toString(16)}`
      );
    }
  }

  return {
    valid: errors.length === 0,
    partitions,
    md5Verified: metadata?.md5Valid,
    errors,
  };
}

