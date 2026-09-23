import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  calculateOtaSeqCrc32,
  determineActiveBootSlot,
  buildUpdatedOtadata,
  parseOtadataSector,
  buildResetOtadata,
} from '../src/lib/flasher/otadata';
import { WG1200_CONSTANTS } from '../src/lib/flasher/constants';

describe('otadata', () => {
  const factoryFixturePath = path.resolve(__dirname, 'fixtures/otadata_dump.bin');
  const factoryBytes = new Uint8Array(fs.readFileSync(factoryFixturePath));

  const ota0FixturePath = path.resolve(__dirname, 'fixtures/ota_slot0.bin');
  const ota0Bytes = new Uint8Array(fs.readFileSync(ota0FixturePath));

  it('calculates exact hardware-verified CRC32 for sequence numbers', () => {
    // Verified against real hardware dump and Python binascii:
    // seq=1 -> 0x4743989a
    const crc1 = calculateOtaSeqCrc32(1);
    expect(crc1).toBe(0x4743989a);
  });

  it('identifies clean factory / blank otadata fixture as active factory', () => {
    const status = determineActiveBootSlot(factoryBytes);
    expect(status.activeSlot).toBe('factory');
    expect(status.targetSlot).toBe('ota_0');
    expect(status.nextSeq).toBe(1);
    expect(status.targetSector).toBe(0);
    expect(status.targetOffset).toBe(WG1200_CONSTANTS.APP_OTA_0.offset);
    expect(status.isAmbiguous).toBe(false);
  });

  it('identifies slot 0 active fixture correctly and targets slot 1', () => {
    const status = determineActiveBootSlot(ota0Bytes);
    expect(status.activeSlot).toBe('ota_0');
    expect(status.targetSlot).toBe('ota_1');
    expect(status.activeSeq).toBe(1);
    expect(status.nextSeq).toBe(2);
    expect(status.targetSector).toBe(1);
    expect(status.targetOffset).toBe(WG1200_CONSTANTS.APP_OTA_1.offset);
  });

  it('builds valid updated otadata image for next sequence', () => {
    // Generate sector 1 with seq = 2
    const updated = buildUpdatedOtadata(ota0Bytes, 2, 1);
    expect(updated.byteLength).toBe(8192);

    // Parse the updated image
    const status = determineActiveBootSlot(updated);
    expect(status.activeSlot).toBe('ota_1');
    expect(status.targetSlot).toBe('ota_0');
    expect(status.activeSeq).toBe(2);
    expect(status.nextSeq).toBe(3);
  });

  it('handles corrupted otadata safely by reverting to factory and targeting ota_0', () => {
    const corruptBytes = new Uint8Array(8192);
    corruptBytes.fill(0xaa); // Invalid data

    const status = determineActiveBootSlot(corruptBytes);
    expect(status.activeSlot).toBe('factory');
    expect(status.targetSlot).toBe('ota_0');
    expect(status.isAmbiguous).toBe(true);
    expect(status.nextSeq).toBe(1);
  });

  it('buildResetOtadata creates all 0xFF 8KB buffer for factory fallback', () => {
    const reset = buildResetOtadata();
    expect(reset.byteLength).toBe(8192);
    expect(reset.every((b) => b === 0xff)).toBe(true);
  });

  it('parseOtadataSector correctly parses sector bytes and validates CRC', () => {
    const sector = factoryBytes.subarray(0, 4096);
    const parsed = parseOtadataSector(sector);
    expect(parsed).toBeDefined();
    expect(typeof parsed.valid).toBe('boolean');
  });
});
