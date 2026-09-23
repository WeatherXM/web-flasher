import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  parsePartitionTable,
  verifyWg1200PartitionTable,
} from '../src/lib/flasher/partitions';
import { WG1200_CONSTANTS } from '../src/lib/flasher/constants';

describe('partitions', () => {
  const fixturePath = path.resolve(__dirname, 'fixtures/test_pt.bin');
  const fixtureBytes = new Uint8Array(fs.readFileSync(fixturePath));

  it('correctly parses real hardware partition table fixture', () => {
    const partitions = parsePartitionTable(fixtureBytes);
    expect(Object.keys(partitions).length).toBe(9);
    expect(partitions['esp_secure_cert']).toBeDefined();
    expect(partitions['nvs']).toBeDefined();
    expect(partitions['otadata']).toBeDefined();
    expect(partitions['phy_init']).toBeDefined();
    expect(partitions['factory']).toBeDefined();
    expect(partitions['ota_0']).toBeDefined();
    expect(partitions['ota_1']).toBeDefined();
    expect(partitions['nvs_key']).toBeDefined();
    expect(partitions['spiffs']).toBeDefined();
  });

  it('validates authentic WG1200 hardware partition layout successfully', () => {
    const partitions = parsePartitionTable(fixtureBytes);
    const result = verifyWg1200PartitionTable(
      partitions,
      'ESP32-S3',
      WG1200_CONSTANTS.FLASH_SIZE_BYTES
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects partition table with non-ESP32-S3 chip', () => {
    const partitions = parsePartitionTable(fixtureBytes);
    const result = verifyWg1200PartitionTable(
      partitions,
      'ESP32-C3',
      WG1200_CONSTANTS.FLASH_SIZE_BYTES
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('ESP32-S3'))).toBe(true);
  });

  it('rejects partition table with wrong flash size (e.g. 4MB or 8MB)', () => {
    const partitions = parsePartitionTable(fixtureBytes);
    const result = verifyWg1200PartitionTable(
      partitions,
      'ESP32-S3',
      8 * 1024 * 1024
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('16 MB flash size'))).toBe(true);
  });

  it('rejects partition table missing critical partition', () => {
    const partitions = parsePartitionTable(fixtureBytes);
    delete partitions['esp_secure_cert'];
    const result = verifyWg1200PartitionTable(
      partitions,
      'ESP32-S3',
      WG1200_CONSTANTS.FLASH_SIZE_BYTES
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Missing mandatory WG1200 partition: 'esp_secure_cert'"))).toBe(true);
  });

  it('rejects partition table with tampered offset or size', () => {
    const partitions = parsePartitionTable(fixtureBytes);
    partitions['nvs'] = {
      ...partitions['nvs'],
      offset: 0x010000, // Expected 0x00F000
    };
    const result = verifyWg1200PartitionTable(
      partitions,
      'ESP32-S3',
      WG1200_CONSTANTS.FLASH_SIZE_BYTES
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("'nvs' offset mismatch"))).toBe(true);
  });
});
