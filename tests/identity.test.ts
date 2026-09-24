import { describe, it, expect } from 'vitest';
import { verifySecureCertIdentity } from '../src/lib/flasher/identity';
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
});
