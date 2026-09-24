import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseAppDescriptor } from '../src/lib/flasher/appDescriptor';

describe('appDescriptor', () => {
  const manifestPath = path.resolve(__dirname, '../public/firmware/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  it('correctly parses real WeatherXM signed binary header matching manifest.json', () => {
    const targetFw = manifest.firmwares.weatherxm;
    const binPath = path.resolve(__dirname, '../public', targetFw.file.replace(/^\//, ''));
    const buf = fs.readFileSync(binPath);
    // Take first 512 bytes like transport would
    const header = new Uint8Array(buf.subarray(0, 512));
    const desc = parseAppDescriptor(header);

    expect(desc).not.toBeNull();
    expect(desc?.firmwareType).toBe('weatherxm');
    expect(desc?.projectName).toBe('wg1010_port');
    expect(desc?.version).toBeTruthy();
    expect(desc?.displayTitle).toContain('WeatherXM');
  });

  it('correctly parses latest WeatherXM signed binary header', () => {
    const latestFw = manifest.firmwares.weatherxm;
    const binPath = path.resolve(__dirname, '../public', latestFw.file.replace(/^\//, ''));
    const buf = fs.readFileSync(binPath);
    const header = new Uint8Array(buf.subarray(0, 512));
    const desc = parseAppDescriptor(header);

    expect(desc).not.toBeNull();
    expect(desc?.firmwareType).toBe('weatherxm');
    expect(desc?.projectName).toBe('wg1010_port');
    expect(desc?.displayTitle).toContain('WeatherXM');
  });

  it('correctly parses real Meshtastic signed binary header matching manifest.json', () => {
    const meshBinPath = path.resolve(__dirname, '../public', manifest.firmwares.meshtastic.file.replace(/^\//, ''));
    const buf = fs.readFileSync(meshBinPath);
    const header = new Uint8Array(buf.subarray(0, 512));
    const desc = parseAppDescriptor(header);

    expect(desc).not.toBeNull();
    expect(desc?.firmwareType).toBe('meshtastic');
    expect(desc?.projectName).toBe('Meshtastic-firmware');
    // Mutually verify advertised version, source git commit, and embedded build descriptor
    expect(manifest.firmwares.meshtastic.version).toBe('2.8.1-wxm');
    expect(manifest.firmwares.meshtastic.git_commit).toBe('caa2e99');
    expect(desc?.version).toBe('b07788e2c-dirty');
    expect(desc?.displayTitle).toContain('Meshtastic');
  });

  it('returns null when app descriptor magic 0xABCD5432 is not present', () => {
    const empty = new Uint8Array(512);
    expect(parseAppDescriptor(empty)).toBeNull();
  });
});
