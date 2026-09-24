import { WG1200_CONSTANTS } from './constants';
import { sha256Hex } from './hashing';

export interface SecureCertVerificationResult {
  valid: boolean;
  fingerprint: string;     // Truncated for UI (e.g., "A91C...72E4")
  sha256: string;          // Full 64-char hex hash stored in memory for pre/post-flash verification
  errors: string[];
}

/**
 * Validates the raw 8192-byte esp_secure_cert partition dump and computes its cryptographic fingerprint.
 */
export async function verifySecureCertIdentity(
  certBytes: Uint8Array
): Promise<SecureCertVerificationResult> {
  const errors: string[] = [];

  if (certBytes.byteLength !== WG1200_CONSTANTS.SECURE_CERT.size) {
    errors.push(
      `Invalid esp_secure_cert partition size: expected ${WG1200_CONSTANTS.SECURE_CERT.size} bytes, got ${certBytes.byteLength} bytes`
    );
    return {
      valid: false,
      fingerprint: '',
      sha256: '',
      errors,
    };
  }

  // Check 1: Not all 0xFF (blank / erased)
  let allFf = true;
  let allZero = true;
  for (let i = 0; i < certBytes.length; i++) {
    if (certBytes[i] !== 0xff) allFf = false;
    if (certBytes[i] !== 0x00) allZero = false;
    if (!allFf && !allZero) break;
  }

  if (allFf) {
    errors.push('esp_secure_cert partition is blank (all 0xFF). No factory credentials present.');
  }

  if (allZero) {
    errors.push('esp_secure_cert partition is zeroed out (all 0x00). Invalid credentials.');
  }

  // Check 2: TLV Magic 0xBA5EBA11 (LE: 0x11, 0xBA, 0x5E, 0xBA)
  let foundTlvMagic = false;
  for (let i = 0; i <= certBytes.length - 4; i++) {
    if (
      certBytes[i] === 0x11 &&
      certBytes[i + 1] === 0xba &&
      certBytes[i + 2] === 0x5e &&
      certBytes[i + 3] === 0xba
    ) {
      foundTlvMagic = true;
      break;
    }
  }

  if (!foundTlvMagic && !allFf && !allZero) {
    errors.push('esp_secure_cert partition does not contain expected TLV magic (0xBA5EBA11).');
  }

  // Compute SHA-256 hash of the entire partition
  const hash = await sha256Hex(certBytes);
  const truncatedFingerprint =
    hash.length >= 8
      ? `${hash.substring(0, 4).toUpperCase()}…${hash.substring(hash.length - 4).toUpperCase()}`
      : hash.toUpperCase();

  return {
    valid: errors.length === 0,
    fingerprint: truncatedFingerprint,
    sha256: hash,
    errors,
  };
}
