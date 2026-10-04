import { WG1200_CONSTANTS } from './constants';
import { sha256Hex } from './hashing';

export interface SecureCertVerificationResult {
  valid: boolean;
  fingerprint: string;     // Truncated for UI (e.g., "A91C...72E4")
  sha256: string;          // Full 64-char hex hash stored in memory for pre/post-flash verification
  publicKey?: string;      // Extracted public key in hex (if DEV_CERT_TLV present)
  publicKeyHash?: string;  // SHA-256 of extracted public key
  commonName?: string;     // Subject Common Name from X.509 cert (e.g., WeatherXM device identity)
  errors: string[];
}

/**
 * Searches for a DER-encoded X.509 certificate inside esp_secure_cert partition.
 * esp_secure_cert stores entries as TLVs starting with magic 0xBA5EBA11 (LE: 0x11, 0xBA, 0x5E, 0xBA).
 * Entry type 1 (DEV_CERT_TLV) is the device certificate.
 */
export function extractDeviceCertBytes(certBytes: Uint8Array): Uint8Array | null {
  for (let i = 0; i <= certBytes.length - 12; i++) {
    if (
      certBytes[i] === 0x11 &&
      certBytes[i + 1] === 0xba &&
      certBytes[i + 2] === 0x5e &&
      certBytes[i + 3] === 0xba
    ) {
      const type = certBytes[i + 8] | (certBytes[i + 9] << 8);
      const length = certBytes[i + 10] | (certBytes[i + 11] << 8);
      if (type === 1 && length > 0 && i + 12 + length <= certBytes.length) {
        return certBytes.slice(i + 12, i + 12 + length);
      }
    }
  }
  return null;
}

/**
 * Parses ASN.1 length at offset. Returns [length, bytesConsumed] or null if invalid.
 */
function parseAsn1Length(bytes: Uint8Array, offset: number): [number, number] | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if ((first & 0x80) === 0) {
    return [first, 1];
  }
  const numBytes = first & 0x7f;
  if (numBytes === 0 || numBytes > 4 || offset + 1 + numBytes > bytes.length) {
    return null;
  }
  let len = 0;
  for (let i = 0; i < numBytes; i++) {
    len = (len << 8) | bytes[offset + 1 + i];
  }
  return [len, 1 + numBytes];
}

/**
 * Extracts Common Name (OID 2.5.4.3: [0x55, 0x04, 0x03]) from a DER X.509 certificate.
 */
export function extractCommonNameFromDer(der: Uint8Array): string | null {
  for (let i = 0; i <= der.length - 5; i++) {
    if (der[i] === 0x55 && der[i + 1] === 0x04 && der[i + 2] === 0x03) {
      const tag = der[i + 3];
      // UTF8String (0x0C), PrintableString (0x13), IA5String (0x16), TeletexString (0x14)
      if (tag === 0x0c || tag === 0x13 || tag === 0x16 || tag === 0x14) {
        const parsed = parseAsn1Length(der, i + 4);
        if (parsed) {
          const [len, consumed] = parsed;
          const start = i + 4 + consumed;
          if (start + len <= der.length) {
            return new TextDecoder().decode(der.slice(start, start + len));
          }
        }
      }
    }
  }
  return null;
}

/**
 * Extracts Subject Public Key from a DER X.509 certificate.
 */
export async function extractPublicKeyFromDer(
  der: Uint8Array
): Promise<{ hex: string; hash: string } | null> {
  const ecOid = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]; // id-ecPublicKey
  const rsaOid = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]; // rsaEncryption

  let foundIdx = -1;
  for (let i = 0; i <= der.length - 10; i++) {
    const isEc = ecOid.every((b, idx) => der[i + idx] === b);
    const isRsa = rsaOid.every((b, idx) => der[i + idx] === b);
    if (isEc || isRsa) {
      foundIdx = i;
      break;
    }
  }

  // Fallback: search for uncompressed EC public key (0x04 point) inside a BIT STRING
  if (foundIdx === -1) {
    for (let i = 0; i <= der.length - 68; i++) {
      if (der[i] === 0x03 && der[i + 1] === 0x42 && der[i + 2] === 0x00 && der[i + 3] === 0x04) {
        const keyBytes = der.slice(i + 3, i + 3 + 65);
        const hex = Array.from(keyBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
        const hash = await sha256Hex(keyBytes);
        return { hex, hash };
      }
    }
    return null;
  }

  // Look for BIT STRING (0x03) after algorithm OID
  for (let j = foundIdx + 7; j <= Math.min(foundIdx + 64, der.length - 4); j++) {
    if (der[j] === 0x03) {
      const parsed = parseAsn1Length(der, j + 1);
      if (parsed) {
        const [len, consumed] = parsed;
        const bitStart = j + 1 + consumed;
        if (bitStart + len <= der.length && len > 1) {
          // Skip first byte (unused bits counter, usually 0x00)
          const keyBytes = der.slice(bitStart + 1, bitStart + len);
          const hex = Array.from(keyBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
          const hash = await sha256Hex(keyBytes);
          return { hex, hash };
        }
      }
    }
  }

  return null;
}

/**
 * Returns the WeatherXM gateway name for WG1200 (e.g. "WeatherXM WG1200 5B2C").
 * Formats according to official firmware pattern `WeatherXM WG1200 %04X`.
 */
export function formatWg1200DeviceName(macAddress?: string, commonName?: string): string {
  if (commonName && commonName.trim().length > 0) {
    return commonName.trim();
  }
  if (macAddress) {
    const clean = macAddress.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (clean.length >= 4) {
      const suffix = clean.slice(-4);
      return `WeatherXM WG1200 ${suffix}`;
    }
  }
  return 'WeatherXM WG1200';
}

/**
 * Validates the raw 8192-byte esp_secure_cert partition dump and computes its cryptographic fingerprint
 * and extracts public key / common name metadata if present.
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

  // Try extracting device certificate TLV (type 1) and its metadata
  let commonName: string | undefined;
  let publicKey: string | undefined;
  let publicKeyHash: string | undefined;

  const devCertBytes = extractDeviceCertBytes(certBytes);
  if (devCertBytes) {
    const cn = extractCommonNameFromDer(devCertBytes);
    if (cn) commonName = cn;

    const pk = await extractPublicKeyFromDer(devCertBytes);
    if (pk) {
      publicKey = pk.hex;
      publicKeyHash = pk.hash;
    }
  }

  return {
    valid: errors.length === 0,
    fingerprint: truncatedFingerprint,
    sha256: hash,
    publicKey,
    publicKeyHash,
    commonName,
    errors,
  };
}
