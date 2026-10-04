import { describe, it, expect } from 'vitest';
import {
  verifySecureCertIdentity,
  formatWg1200DeviceName,
  extractDeviceCertBytes,
  extractCommonNameFromDer,
  extractPublicKeyFromDer,
} from '../src/lib/flasher/identity';
import { WG1200_CONSTANTS } from '../src/lib/flasher/constants';

describe('identity (esp_secure_cert)', () => {
  function makeMockCert(includeTlvMagic = true, fillValue = 0x5a): Uint8Array {
    const cert = new Uint8Array(WG1200_CONSTANTS.SECURE_CERT.size);
    cert.fill(fillValue);
    if (includeTlvMagic) {
      // 0xBA5EBA11 in Little Endian: 0x11, 0xBA, 0x5E, 0xBA
      cert[0] = 0x11;
      cert[1] = 0xba;
      cert[2] = 0x5e;
      cert[3] = 0xba;
    }
    return cert;
  }

  it('validates authentic cert partition containing TLV magic 0xBA5EBA11', async () => {
    const cert = makeMockCert(true);
    const result = await verifySecureCertIdentity(cert);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.sha256).toHaveLength(64);
    expect(result.fingerprint).toMatch(/^[0-9A-F]{4}…[0-9A-F]{4}$/);
  });

  it('rejects blank / erased cert partition (all 0xFF)', async () => {
    const cert = new Uint8Array(WG1200_CONSTANTS.SECURE_CERT.size);
    cert.fill(0xff);
    const result = await verifySecureCertIdentity(cert);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('blank (all 0xFF)'))).toBe(true);
  });

  it('rejects zeroed cert partition (all 0x00)', async () => {
    const cert = new Uint8Array(WG1200_CONSTANTS.SECURE_CERT.size);
    cert.fill(0x00);
    const result = await verifySecureCertIdentity(cert);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('zeroed out (all 0x00)'))).toBe(true);
  });

  it('rejects cert partition missing TLV magic', async () => {
    const cert = makeMockCert(false);
    const result = await verifySecureCertIdentity(cert);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('TLV magic'))).toBe(true);
  });

  it('rejects cert with wrong partition size', async () => {
    const cert = new Uint8Array(4096);
    const result = await verifySecureCertIdentity(cert);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('size'))).toBe(true);
  });

  describe('formatWg1200DeviceName', () => {
    it('formats name using last 4 hex characters of MAC address', () => {
      expect(formatWg1200DeviceName('24:ec:4a:00:5b:2c')).toBe('WeatherXM WG1200 5B2C');
      expect(formatWg1200DeviceName('24ec4a005b2c')).toBe('WeatherXM WG1200 5B2C');
      expect(formatWg1200DeviceName('AA:BB:CC:DD:EE:FF')).toBe('WeatherXM WG1200 EEFF');
    });

    it('prefers commonName from certificate when provided', () => {
      expect(formatWg1200DeviceName('24:ec:4a:00:5b:2c', 'WeatherXM-GW-99')).toBe(
        'WeatherXM-GW-99'
      );
    });

    it('falls back to default name when MAC and commonName are missing', () => {
      expect(formatWg1200DeviceName()).toBe('WeatherXM WG1200');
    });
  });

  describe('DER certificate and public key extraction', () => {
    it('extracts Common Name from DER bytes', () => {
      // Construct minimal DER snippet for OID 2.5.4.3 (0x55, 0x04, 0x03) + UTF8String (0x0C)
      const name = 'WeatherXM Test GW';
      const nameBytes = new TextEncoder().encode(name);
      const der = new Uint8Array([
        0x30, 0x20, // SEQUENCE
        0x55, 0x04, 0x03, // OID commonName
        0x0c, nameBytes.length, // UTF8String tag and length
        ...nameBytes,
      ]);

      const cn = extractCommonNameFromDer(der);
      expect(cn).toBe('WeatherXM Test GW');
    });

    it('extracts EC public key and calculates SHA256 hash', async () => {
      // Uncompressed 65-byte EC public key starting with 0x04
      const mockKey = new Uint8Array(65);
      mockKey[0] = 0x04;
      for (let i = 1; i < 65; i++) mockKey[i] = i;

      // BIT STRING containing 0x00 (unused bits) + 65 key bytes
      const der = new Uint8Array([
        0x30, 0x50, // SEQUENCE
        0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // id-ecPublicKey
        0x03, 0x42, 0x00, // BIT STRING length 66, 0 unused bits
        ...mockKey,
      ]);

      const pk = await extractPublicKeyFromDer(der);
      expect(pk).not.toBeNull();
      expect(pk?.hex).toHaveLength(130); // 65 bytes * 2
      expect(pk?.hex.startsWith('04')).toBe(true);
      expect(pk?.hash).toHaveLength(64);
    });

    it('extracts device cert TLV and parses metadata within full partition', async () => {
      const partition = new Uint8Array(WG1200_CONSTANTS.SECURE_CERT.size);
      partition.fill(0x00);

      // TLV magic 0xBA5EBA11 (LE)
      partition[0] = 0x11;
      partition[1] = 0xba;
      partition[2] = 0x5e;
      partition[3] = 0xba;

      // Entry type 1 (DEV_CERT_TLV) at offset 8 (uint16 LE)
      partition[8] = 0x01;
      partition[9] = 0x00;

      // Create dummy cert payload with CN
      const name = 'WeatherXM WG1200 Live';
      const nameBytes = new TextEncoder().encode(name);
      const certPayload = new Uint8Array([
        0x30, 0x30,
        0x55, 0x04, 0x03,
        0x0c, nameBytes.length,
        ...nameBytes,
      ]);

      // Length at offset 10 (uint16 LE)
      partition[10] = certPayload.length & 0xff;
      partition[11] = (certPayload.length >> 8) & 0xff;

      // Copy payload at offset 12
      partition.set(certPayload, 12);

      const result = await verifySecureCertIdentity(partition);
      expect(result.valid).toBe(true);
      expect(result.commonName).toBe('WeatherXM WG1200 Live');
    });
  });
});
