import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { validateManifest } from '../src/lib/flasher/manifest';

describe('manifest', () => {
  const manifestPath = path.resolve(__dirname, '../public/firmware/manifest.json');
  const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  it('validates the official public/firmware/manifest.json successfully', () => {
    const validated = validateManifest(manifestJson);
    expect(validated.hardware).toBe('WG1200');
    expect(validated.chip).toBe('ESP32-S3');
    expect(validated.flash_bytes).toBe(16777216);
    expect(validated.firmwares.weatherxm).toBeDefined();
    expect(validated.firmwares.meshtastic).toBeDefined();
  });

  it('verifies that firmware binary files exist on disk with exact declared sizes and hashes', () => {
    const crypto = require('crypto');
    for (const [, fw] of Object.entries(manifestJson.firmwares as any)) {
      const diskPath = path.resolve(__dirname, '../public', (fw as any).file.replace(/^\//, ''));
      expect(fs.existsSync(diskPath)).toBe(true);

      const buf = fs.readFileSync(diskPath);
      expect(buf.length).toBe((fw as any).bytes);

      const computedSha = crypto.createHash('sha256').update(buf).digest('hex');
      expect(computedSha).toBe((fw as any).sha256);
    }
  });

  it('rejects manifest with non-WG1200 hardware', () => {
    const invalid = { ...manifestJson, hardware: 'ESP32_GENERIC' };
    expect(() => validateManifest(invalid)).toThrow(/hardware mismatch/);
  });

  it('rejects manifest with non-ESP32-S3 chip', () => {
    const invalid = { ...manifestJson, chip: 'ESP32-C3' };
    expect(() => validateManifest(invalid)).toThrow(/chip mismatch/);
  });

  it('rejects manifest with wrong flash size', () => {
    const invalid = { ...manifestJson, flash_bytes: 4194304 };
    expect(() => validateManifest(invalid)).toThrow(/flash_bytes mismatch/);
  });
});
