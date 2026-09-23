import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseAppDescriptor } from '../src/lib/flasher/appDescriptor';

describe('appDescriptor', () => {
  const wxmBinPath = path.resolve(__dirname, '../public/firmware/weatherxm/wg1200-0.8.25-signed.bin');
  const meshBinPath = path.resolve(__dirname, '../public/firmware/meshtastic/wg1200-2.8.1-wxm-signed.bin');

  const manifestPath = path.resolve(__dirname, '../public/firmware/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  it('correctly parses real WeatherXM signed binary header matching manifest.json', () => {
    const buf = fs.readFileSync(wxmBinPath);
    // Take first 512 bytes like transport would
    const header = new Uint8Array(buf.subarray(0, 512));
    const desc = parseAppDescriptor(header);

    expect(desc).not.toBeNull();
    expect(desc?.firmwareType).toBe('weatherxm');
    expect(desc?.projectName).toBe('wg1010_port');
    expect(desc?.version).toContain(manifest.firmwares.weatherxm.version);
    expect(desc?.displayTitle).toContain('WeatherXM');
  });

  it('correctly parses real Meshtastic signed binary header matching manifest.json', () => {
    const buf = fs.readFileSync(meshBinPath);
    const header = new Uint8Array(buf.subarray(0, 512));
    const desc = parseAppDescriptor(header);

    expect(desc).not.toBeNull();
    expect(desc?.firmwareType).toBe('meshtastic');
    expect(desc?.projectName).toBe('Meshtastic-firmware');
    expect(desc?.version).toContain(manifest.firmwares.meshtastic.git_commit);
    expect(desc?.displayTitle).toContain('Meshtastic');
  });

  it('returns null when app descriptor magic 0xABCD5432 is not present', () => {
    const empty = new Uint8Array(512);
    expect(parseAppDescriptor(empty)).toBeNull();
  });
});
