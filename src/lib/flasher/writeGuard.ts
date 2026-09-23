import { APP_PARTITIONS, PROTECTED_REGIONS, WG1200_CONSTANTS } from './constants';

export interface WriteValidationResult {
  valid: boolean;
  partitionName?: 'factory' | 'ota_0' | 'ota_1';
  error?: string;
}

/**
 * Validates that a requested flash write is strictly and entirely contained
 * within a single valid application partition (factory, ota_0, or ota_1),
 * does not exceed the maximum app size (4 MB), does not overlap any protected
 * partition, and does not exhibit integer overflow or negative indices.
 */
export function validateAllowedWrite(
  address: number,
  length: number,
  allowFactory: boolean = true
): WriteValidationResult {
  // Check for non-numbers or invalid types
  if (typeof address !== 'number' || typeof length !== 'number') {
    return { valid: false, error: 'Flash address and length must be numbers' };
  }

  // Reject NaN or non-finite numbers
  if (!Number.isFinite(address) || !Number.isFinite(length)) {
    return { valid: false, error: 'Flash address and length must be finite numbers' };
  }

  // Reject non-integers
  if (!Number.isInteger(address) || !Number.isInteger(length)) {
    return { valid: false, error: 'Flash address and length must be integers' };
  }

  // Reject negative addresses or non-positive lengths
  if (address < 0) {
    return { valid: false, error: `Invalid negative flash address: 0x${address.toString(16)}` };
  }

  if (length <= 0) {
    return { valid: false, error: `Invalid flash write length: ${length} bytes` };
  }

  // Max app size check (4 MB)
  if (length > WG1200_CONSTANTS.MAX_APP_SIZE_BYTES) {
    return {
      valid: false,
      error: `Application size (${length} bytes) exceeds maximum partition size (${WG1200_CONSTANTS.MAX_APP_SIZE_BYTES} bytes)`,
    };
  }

  // Safe integer range check
  const end = address + length;
  if (!Number.isSafeInteger(end) || end < address) {
    return { valid: false, error: 'Integer overflow detected in flash address calculation' };
  }

  // Flash boundary check (cannot exceed 16 MB)
  if (end > WG1200_CONSTANTS.FLASH_SIZE_BYTES) {
    return {
      valid: false,
      error: `Flash write range [0x${address.toString(16)} - 0x${end.toString(16)}] exceeds 16MB flash capacity`,
    };
  }

  // Verify write does not intersect any protected region
  for (const reg of PROTECTED_REGIONS) {
    const regEnd = reg.offset + reg.size;
    // Overlap condition: max(start1, start2) < min(end1, end2)
    if (Math.max(address, reg.offset) < Math.min(end, regEnd)) {
      return {
        valid: false,
        error: `Attempted write touches protected partition '${reg.name}' [0x${reg.offset.toString(16)} - 0x${regEnd.toString(16)}]`,
      };
    }
  }

  // Find the containing application partition
  const candidatePartitions = APP_PARTITIONS.filter((p) => {
    if (!allowFactory && p.name === 'factory') {
      return false;
    }
    return address >= p.offset && end <= p.offset + p.size;
  });

  if (candidatePartitions.length === 0) {
    return {
      valid: false,
      error: `Write [0x${address.toString(16)} - 0x${end.toString(16)}] is not fully contained within any permitted WG1200 application partition`,
    };
  }

  return {
    valid: true,
    partitionName: candidatePartitions[0].name,
  };
}

/**
 * Strictly verifies that an application binary write is entirely confined to
 * ota_0 (0x420000) or ota_1 (0x820000). The factory partition is strictly forbidden
 * during normal switching to preserve the immutable safe-haven rollback.
 */
export function assertAllowedApplicationWrite(
  address: number,
  length: number
): 'ota_0' | 'ota_1' {
  const result = validateAllowedWrite(address, length, false);
  if (!result.valid || !result.partitionName) {
    throw new Error(result.error ?? 'Application write rejected by WG1200 write guard');
  }
  if (result.partitionName === 'factory') {
    throw new Error('Overwriting the factory partition is strictly prohibited by WG1200 security policy');
  }
  return result.partitionName;
}

/**
 * Strictly verifies that an otadata update targets exactly one 4 KB sector:
 * - Sector 0: 0x13000 (length 4096)
 * - Sector 1: 0x14000 (length 4096)
 * No other address or length is permitted under any circumstances.
 */
export function assertAllowedOtaSelectWrite(
  address: number,
  length: number
): { sector: 0 | 1; address: number } {
  if (length !== 4096) {
    throw new Error(`OTA select write rejected: length must be exactly 4096 bytes (received ${length})`);
  }

  if (address === WG1200_CONSTANTS.OTADATA.offset) {
    return { sector: 0, address: 0x13000 };
  }

  if (address === WG1200_CONSTANTS.OTADATA.offset + 4096) {
    return { sector: 1, address: 0x14000 };
  }

  throw new Error(
    `OTA select write rejected: address 0x${address.toString(16)} is not an authorized otadata sector (expected 0x13000 or 0x14000)`
  );
}

/**
 * Throws an Error if the requested write is not strictly permitted.
 * Delegates to validateAllowedWrite.
 */
export function assertAllowedWrite(
  address: number,
  length: number,
  allowFactory: boolean = true
): 'factory' | 'ota_0' | 'ota_1' {
  const result = validateAllowedWrite(address, length, allowFactory);
  if (!result.valid || !result.partitionName) {
    throw new Error(result.error ?? 'Flash write rejected by WG1200 write guard');
  }
  return result.partitionName;
}

