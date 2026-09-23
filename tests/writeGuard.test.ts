import { describe, it, expect } from 'vitest';
import {
  assertAllowedFactoryRollbackWrite,
  assertAllowedFullBackupRestore,
  assertAllowedWrite,
  checkImageSignature,
  validateAllowedWrite,
  validateFullBackupImage,
} from '../src/lib/flasher/writeGuard';
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

  it('assertAllowedFactoryRollbackWrite allows strictly 0x13000 with 8192 bytes and rejects others', () => {
    expect(() => assertAllowedFactoryRollbackWrite(0x13000, 8192)).not.toThrow();
    expect(() => assertAllowedFactoryRollbackWrite(0x13000, 4096)).toThrow(/Factory rollback write rejected/);
    expect(() => assertAllowedFactoryRollbackWrite(0x14000, 8192)).toThrow(/Factory rollback write rejected/);
    expect(() => assertAllowedFactoryRollbackWrite(0x20000, 8192)).toThrow(/Factory rollback write rejected/);
  });

  describe('full backup restore validation', () => {
    it('assertAllowedFullBackupRestore allows strictly address 0 with 16MB and rejects others', () => {
      expect(() => assertAllowedFullBackupRestore(0, WG1200_CONSTANTS.FLASH_SIZE_BYTES)).not.toThrow();
      expect(() => assertAllowedFullBackupRestore(0x1000, WG1200_CONSTANTS.FLASH_SIZE_BYTES)).toThrow(
        /Full backup restore write rejected/
      );
      expect(() => assertAllowedFullBackupRestore(0, 1024)).toThrow(
        /Full backup restore write rejected/
      );
    });

    it('validateFullBackupImage rejects incorrect size or invalid magic', () => {
      const small = new Uint8Array(1024);
      expect(validateFullBackupImage(small).valid).toBe(false);
      expect(validateFullBackupImage(small).error).toMatch(/Invalid backup file size/);

      const fake16mb = new Uint8Array(WG1200_CONSTANTS.FLASH_SIZE_BYTES);
      fake16mb[0] = 0x00; // Not 0xE9
      const resMagic = validateFullBackupImage(fake16mb);
      expect(resMagic.valid).toBe(false);
      expect(resMagic.error).toMatch(/missing ESP bootloader header magic/);
    });

    it('validateFullBackupImage detects unsigned backup and reports warnings', () => {
      const unsigned16mb = new Uint8Array(WG1200_CONSTANTS.FLASH_SIZE_BYTES);
      unsigned16mb[0] = 0xe9; // ESP magic
      unsigned16mb[1] = 0x01; // 1 segment
      unsigned16mb[0xc000] = 0xaa;
      unsigned16mb[0xc001] = 0x50; // 0x50AA partition table magic

      const res = validateFullBackupImage(unsigned16mb);
      expect(res.valid).toBe(true);
      expect(res.isSigned).toBe(false);
      expect(res.bootloaderSigned).toBe(false);
      expect(res.warnings.some((w) => w.includes('missing an authentic Secure Boot V2 signature'))).toBe(true);
    });

    it('validateFullBackupImage and checkImageSignature detect valid Secure Boot V2 signature', () => {
      const signed16mb = new Uint8Array(WG1200_CONSTANTS.FLASH_SIZE_BYTES);
      signed16mb[0] = 0xe9; // ESP magic
      signed16mb[1] = 0x01; // 1 segment

      // Segment 0 header at offset 24
      const segLen = 16;
      signed16mb[24 + 4] = segLen & 0xff; // 16 bytes len
      // cur = 24 + 8 + 16 = 48
      // cur += 1 (checksum) = 49
      // cur += (16 - (49 % 16)) % 16 = 49 + 15 = 64
      // cur += (4096 - (64 % 4096)) % 4096 = 4096
      signed16mb[4096] = 0xe7; // Secure Boot V2 signature block magic!

      // Partition table magic at 0xC000
      signed16mb[0xc000] = 0xaa;
      signed16mb[0xc001] = 0x50;

      expect(checkImageSignature(signed16mb, 0)).toBe(true);

      const res = validateFullBackupImage(signed16mb);
      expect(res.valid).toBe(true);
      expect(res.isSigned).toBe(true);
      expect(res.bootloaderSigned).toBe(true);
      expect(res.detectedSign).toMatch(/ESP32-S3 Secure Boot V2 signature block/);
    });
  });
});
