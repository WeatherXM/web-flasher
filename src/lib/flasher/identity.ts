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
 * Converts a PEM-formatted certificate string into DER bytes.
 */
export function pemToDer(pem: string): Uint8Array | null {
  try {
    const base64 = pem
      .replace(/-----BEGIN [^-]+-----/g, '')
      .replace(/-----END [^-]+-----/g, '')
      .replace(/\s+/g, '');
    if (!base64 || base64.length === 0) return null;
    if (typeof atob === 'function') {
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      return bytes;
    } else if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(base64, 'base64'));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Normalizes a certificate payload (which may be ASCII PEM or raw DER binary) into DER bytes.
 */
export function normalizeCertPayloadToDer(payload: Uint8Array): Uint8Array | null {
  if (!payload || payload.length === 0) return null;

  // Trim trailing null characters or 0xFF padding
  let len = payload.length;
  while (len > 0 && (payload[len - 1] === 0x00 || payload[len - 1] === 0xff)) {
    len--;
  }
  if (len === 0) return null;
  const trimmed = payload.subarray(0, len);

  // Check if it's PEM (starts with "-----BEGIN")
  const pemHeader = '-----BEGIN';
  let isPem = true;
  if (trimmed.length >= pemHeader.length) {
    for (let i = 0; i < pemHeader.length; i++) {
      if (trimmed[i] !== pemHeader.charCodeAt(i)) {
        isPem = false;
        break;
      }
    }
  } else {
    isPem = false;
  }

  if (isPem) {
    const pemStr = new TextDecoder().decode(trimmed);
    return pemToDer(pemStr);
  }

  // Check if it's ASN.1 DER SEQUENCE (starts with 0x30)
  if (trimmed[0] === 0x30 && trimmed.length >= 4) {
    const parsed = parseAsn1Length(trimmed, 1);
    if (parsed) {
      const [seqLen, consumed] = parsed;
      const totalLen = 1 + consumed + seqLen;
      if (totalLen <= trimmed.length) {
        return trimmed.subarray(0, totalLen);
      }
    }
    return trimmed;
  }

  return null;
}

/**
 * Extracts a device certificate (as DER bytes) from an esp_secure_cert partition.
 * Supports:
 * 1. Direct ASCII PEM strings ("-----BEGIN CERTIFICATE-----") anywhere in the partition.
 * 2. Modern TLV format (Magic 0xBA5EBA11, TLV type 1 = DEV_CERT_TLV).
 * 3. Legacy cust_flash format (device cert located at offset 64, length at offset 4).
 * 4. Raw ASN.1 DER certificate sequences (0x30, 0x82...) anywhere in the partition.
 */
export function extractDeviceCertBytes(certBytes: Uint8Array): Uint8Array | null {
  if (!certBytes || certBytes.length < 64) return null;

  // 1. Check for PEM "-----BEGIN CERTIFICATE-----" anywhere in partition
  const pemMarker = new TextEncoder().encode('-----BEGIN CERTIFICATE-----');
  const pemEndMarker = new TextEncoder().encode('-----END CERTIFICATE-----');

  for (let i = 0; i <= certBytes.length - pemMarker.length; i++) {
    let match = true;
    for (let m = 0; m < pemMarker.length; m++) {
      if (certBytes[i + m] !== pemMarker[m]) {
        match = false;
        break;
      }
    }
    if (match) {
      for (
        let j = i + pemMarker.length;
        j <= certBytes.length - pemEndMarker.length;
        j++
      ) {
        let endMatch = true;
        for (let em = 0; em < pemEndMarker.length; em++) {
          if (certBytes[j + em] !== pemEndMarker[em]) {
            endMatch = false;
            break;
          }
        }
        if (endMatch) {
          const pemSlice = certBytes.subarray(i, j + pemEndMarker.length);
          const pemStr = new TextDecoder().decode(pemSlice);
          const der = pemToDer(pemStr);
          if (der) return der;
        }
      }
    }
  }

  // 2. Check for Modern TLV format (Magic 0xBA5EBA11, entry type 1 = DEV_CERT_TLV)
  for (let i = 0; i <= certBytes.length - 12; i++) {
    const isTlv =
      (certBytes[i] === 0x11 &&
        certBytes[i + 1] === 0xba &&
        certBytes[i + 2] === 0x5e &&
        certBytes[i + 3] === 0xba) ||
      (certBytes[i] === 0xba &&
        certBytes[i + 1] === 0x5e &&
        certBytes[i + 2] === 0xba &&
        certBytes[i + 3] === 0x11);

    if (isTlv) {
      const type = certBytes[i + 8] | (certBytes[i + 9] << 8);
      const length = certBytes[i + 10] | (certBytes[i + 11] << 8);
      if (type === 1 && length > 0 && i + 12 + length <= certBytes.length) {
        const payload = certBytes.subarray(i + 12, i + 12 + length);
        const der = normalizeCertPayloadToDer(payload);
        if (der) return der;
      }
    }
  }

  // 3. Check for Legacy cust_flash format (DEV_CERT at offset 64)
  const legacyLen = certBytes[4] | (certBytes[5] << 8);
  if (legacyLen > 0 && legacyLen < 4096 && 64 + legacyLen <= certBytes.length) {
    const payload = certBytes.subarray(64, 64 + legacyLen);
    const der = normalizeCertPayloadToDer(payload);
    if (der) return der;
  }

  // Check offset 64 directly
  if (certBytes.length >= 128) {
    const payload = certBytes.subarray(64, Math.min(certBytes.length, 64 + 2048));
    const der = normalizeCertPayloadToDer(payload);
    if (der) return der;
  }

  // 4. Scan for ASN.1 DER SEQUENCE (0x30, 0x82) anywhere in the partition
  for (let i = 0; i <= certBytes.length - 8; i++) {
    if (certBytes[i] === 0x30 && certBytes[i + 1] === 0x82) {
      const seqLen = (certBytes[i + 2] << 8) | certBytes[i + 3];
      const totalLen = 4 + seqLen;
      if (seqLen > 100 && i + totalLen <= certBytes.length) {
        if (certBytes[i + 4] === 0x30) {
          return certBytes.subarray(i, i + totalLen);
        }
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
 * Extracts Subject Common Name (OID 2.5.4.3: [0x55, 0x04, 0x03]) from a DER X.509 certificate.
 * Returns the last matching Common Name in the certificate (which corresponds to Subject CN,
 * rather than Issuer/CA CN).
 */
export function extractCommonNameFromDer(der: Uint8Array): string | null {
  let lastCn: string | null = null;
  for (let i = 0; i <= der.length - 5; i++) {
    if (der[i] === 0x55 && der[i + 1] === 0x04 && der[i + 2] === 0x03) {
      const tag = der[i + 3];
      // UTF8String (0x0C), PrintableString (0x13), IA5String (0x16), TeletexString (0x14)
      if (tag === 0x0c || tag === 0x13 || tag === 0x16 || tag === 0x14) {
        const parsed = parseAsn1Length(der, i + 4);
        if (parsed) {
          const [len, consumed] = parsed;
          const start = i + 4 + consumed;
          if (start + len <= der.length && len > 0) {
            lastCn = new TextDecoder().decode(der.subarray(start, start + len));
          }
        }
      }
    }
  }
  return lastCn;
}

/**
 * Extracts Subject Public Key from a DER X.509 certificate.
 * Handles EC (id-ecPublicKey / secp256r1) and RSA keys.
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
        const keyBytes = der.subarray(i + 3, i + 3 + 65);
        const hex = Array.from(keyBytes)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
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
          const keyBytes = der.subarray(bitStart + 1, bitStart + len);
          const hex = Array.from(keyBytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
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
 * Validates the raw 8192-byte esp_secure_cert partition dump, verifies its format and cryptographic integrity,
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

  // Check 2: Recognized partition format or valid X.509 certificate
  let foundRecognizedFormat = false;

  // 2a. TLV Magic 0xBA5EBA11 (LE or BE)
  for (let i = 0; i <= certBytes.length - 4; i++) {
    if (
      (certBytes[i] === 0x11 &&
        certBytes[i + 1] === 0xba &&
        certBytes[i + 2] === 0x5e &&
        certBytes[i + 3] === 0xba) ||
      (certBytes[i] === 0xba &&
        certBytes[i + 1] === 0x5e &&
        certBytes[i + 2] === 0xba &&
        certBytes[i + 3] === 0x11)
    ) {
      foundRecognizedFormat = true;
      break;
    }
  }

  // 2b. Legacy cust_flash Magic 0x12345678 in metadata (first 64 bytes)
  if (!foundRecognizedFormat) {
    for (let i = 0; i <= Math.min(60, certBytes.length - 4); i++) {
      if (
        (certBytes[i] === 0x78 &&
          certBytes[i + 1] === 0x56 &&
          certBytes[i + 2] === 0x34 &&
          certBytes[i + 3] === 0x12) ||
        (certBytes[i] === 0x12 &&
          certBytes[i + 1] === 0x34 &&
          certBytes[i + 2] === 0x56 &&
          certBytes[i + 3] === 0x78)
      ) {
        foundRecognizedFormat = true;
        break;
      }
    }
  }

  // Extract device certificate (handles PEM, DER, TLV, cust_flash)
  const devCertBytes = extractDeviceCertBytes(certBytes);
  if (devCertBytes) {
    foundRecognizedFormat = true;
  }

  if (!foundRecognizedFormat && !allFf && !allZero) {
    errors.push(
      'esp_secure_cert partition does not contain expected TLV magic (0xBA5EBA11) or legacy cust_flash credentials.'
    );
  }

  // Compute SHA-256 hash of the entire partition
  const hash = await sha256Hex(certBytes);
  const truncatedFingerprint =
    hash.length >= 8
      ? `${hash.substring(0, 4).toUpperCase()}…${hash.substring(hash.length - 4).toUpperCase()}`
      : hash.toUpperCase();

  // Extract public key and common name metadata
  let commonName: string | undefined;
  let publicKey: string | undefined;
  let publicKeyHash: string | undefined;

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
