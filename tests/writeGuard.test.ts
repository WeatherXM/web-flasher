import { describe, it, expect } from 'vitest';
import { assertAllowedWrite, validateAllowedWrite } from '../src/lib/flasher/writeGuard';
import { WG1200_CONSTANTS } from '../src/lib/flasher/constants';

describe('writeGuard', () => {
  it('allows valid writes within ota_0', () => {
    const res = validateAllowedWrite(WG1200_CONSTANTS.APP_OTA_0.offset, 2 * 1024 * 1024);
    expect(res.valid).toBe(true);
    expect(res.partitionName).toBe('ota_0');
  });

  it('allows valid writes within ota_1', () => {
    const res = validateAllowedWrite(WG1200_CONSTANTS.APP_OTA_1.offset, 3 * 1024 * 1024);
    expect(res.valid).toBe(true);
    expect(res.partitionName).toBe('ota_1');
  });

  it('allows write to factory partition only when explicitly permitted', () => {
    const resAllowed = validateAllowedWrite(WG1200_CONSTANTS.APP_FACTORY.offset, 1024, true);
    expect(resAllowed.valid).toBe(true);
    expect(resAllowed.partitionName).toBe('factory');

    const resForbidden = validateAllowedWrite(WG1200_CONSTANTS.APP_FACTORY.offset, 1024, false);
    expect(resForbidden.valid).toBe(false);
  });

  it('rejects image exceeding 4 MB partition limit', () => {
    const res = validateAllowedWrite(WG1200_CONSTANTS.APP_OTA_0.offset, 4 * 1024 * 1024 + 1);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('exceeds maximum partition size');
  });

  it('rejects writes overlapping partition table (0xC000)', () => {
    const res = validateAllowedWrite(0x00c000, 0x1000);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("touches protected partition 'partition_table'");
  });

  it('rejects writes overlapping esp_secure_cert (0xD000)', () => {
    const res = validateAllowedWrite(0x00d000, 0x2000);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("touches protected partition 'esp_secure_cert'");
  });

  it('rejects writes overlapping NVS (0xF000)', () => {
    const res = validateAllowedWrite(0x00f000, 0x4000);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("touches protected partition 'nvs'");
  });

  it('rejects writes overlapping otadata (0x13000)', () => {
    const res = validateAllowedWrite(0x013000, 0x2000);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("touches protected partition 'otadata'");
  });

  it('rejects writes overlapping nvs_key (0xC20000)', () => {
    const res = validateAllowedWrite(0xc20000, 0x1000);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("touches protected partition 'nvs_key'");
  });

  it('rejects negative offsets or non-positive lengths', () => {
    expect(validateAllowedWrite(-100, 1024).valid).toBe(false);
    expect(validateAllowedWrite(0x420000, 0).valid).toBe(false);
    expect(validateAllowedWrite(0x420000, -50).valid).toBe(false);
  });

  it('rejects NaN, non-finite, and non-integers', () => {
    expect(validateAllowedWrite(NaN, 1024).valid).toBe(false);
    expect(validateAllowedWrite(0x420000, Infinity).valid).toBe(false);
    expect(validateAllowedWrite(0x420000 + 0.5, 1024).valid).toBe(false);
  });

  it('assertAllowedWrite throws on invalid write', () => {
    expect(() => assertAllowedWrite(0x00d000, 0x1000)).toThrow();
  });
});
