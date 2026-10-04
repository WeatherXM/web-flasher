import { describe, it, expect } from 'vitest';
import {
  verifySecureCertIdentity,
  formatWg1200DeviceName,
  extractDeviceCertBytes,
  extractCommonNameFromDer,
  extractPublicKeyFromDer,
  pemToDer,
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

  it('rejects unformatted random partition lacking magic or cert', async () => {
    const cert = makeMockCert(false);
    const result = await verifySecureCertIdentity(cert);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('TLV magic') || e.includes('cust_flash'))).toBe(true);
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

  describe('DER & PEM certificate and public key extraction', () => {
    it('converts PEM certificate to DER bytes', () => {
      const mockDer = new Uint8Array([0x30, 0x82, 0x01, 0x00, 0x01, 0x02, 0x03, 0x04]);
      const base64 = btoa(String.fromCharCode(...mockDer));
      const pem = `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;

      const der = pemToDer(pem);
      expect(der).not.toBeNull();
      expect(Array.from(der!)).toEqual(Array.from(mockDer));
    });

    it('extracts Common Name from DER bytes', () => {
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

    it('extracts legacy cust_flash partition with PEM certificate at offset 64 and magic 0x12345678', async () => {
      const partition = new Uint8Array(WG1200_CONSTANTS.SECURE_CERT.size);
      partition.fill(0xff);

      // Construct a mock EC DER cert with CN and uncompressed public key
      const name = 'WeatherXM WG1200 5B2C';
      const nameBytes = new TextEncoder().encode(name);
      const mockKey = new Uint8Array(65);
      mockKey[0] = 0x04;
      for (let i = 1; i < 65; i++) mockKey[i] = i * 2;

      const derCert = new Uint8Array([
        0x30, 0x82, 0x01, 0x00,
        // Common Name
        0x55, 0x04, 0x03,
        0x0c, nameBytes.length,
        ...nameBytes,
        // Public Key
        0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
        0x03, 0x42, 0x00,
        ...mockKey,
      ]);

      // Base64 encode into PEM format
      const pemStr = `-----BEGIN CERTIFICATE-----\n${btoa(String.fromCharCode(...derCert))}\n-----END CERTIFICATE-----\0`;
      const pemBytes = new TextEncoder().encode(pemStr);

      // dev_cert at offset 64
      partition.set(pemBytes, 64);

      // Metadata at offset 0: dev_cert_len at bytes 4-5
      partition[4] = pemBytes.length & 0xff;
      partition[5] = (pemBytes.length >> 8) & 0xff;

      // Magic 0x12345678 at byte 32 (LE: 0x78, 0x56, 0x34, 0x12)
      partition[32] = 0x78;
      partition[33] = 0x56;
      partition[34] = 0x34;
      partition[35] = 0x12;

      const result = await verifySecureCertIdentity(partition);
      expect(result.valid).toBe(true);
      expect(result.commonName).toBe('WeatherXM WG1200 5B2C');
      expect(result.publicKey).not.toBeUndefined();
      expect(result.publicKey).toHaveLength(130);
      expect(result.publicKey?.startsWith('04')).toBe(true);
      expect(result.publicKeyHash).toHaveLength(64);
    });

    it('extracts standalone PEM certificate placed anywhere in partition', async () => {
      const partition = new Uint8Array(WG1200_CONSTANTS.SECURE_CERT.size);
      partition.fill(0xee);

      const name = 'WeatherXM Direct PEM';
      const nameBytes = new TextEncoder().encode(name);
      const derCert = new Uint8Array([
        0x30, 0x40,
        0x55, 0x04, 0x03,
        0x0c, nameBytes.length,
        ...nameBytes,
      ]);

      const pemStr = `-----BEGIN CERTIFICATE-----\n${btoa(String.fromCharCode(...derCert))}\n-----END CERTIFICATE-----`;
      const pemBytes = new TextEncoder().encode(pemStr);

      // Place at offset 512
      partition.set(pemBytes, 512);

      const devCert = extractDeviceCertBytes(partition);
      expect(devCert).not.toBeNull();
      const cn = extractCommonNameFromDer(devCert!);
      expect(cn).toBe('WeatherXM Direct PEM');
    });
  });
});
