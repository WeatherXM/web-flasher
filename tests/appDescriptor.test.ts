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
    expect(desc?.projectName?.toLowerCase()).toContain('meshtastic');
    // Mutually verify advertised version, source git commit, and embedded build descriptor
    expect(manifest.firmwares.meshtastic.version).toBe('2.8.1-wxm');
    expect(manifest.firmwares.meshtastic.git_commit).toBe('caa2e99');
    expect(desc?.version).toBeTruthy();
    expect(desc?.displayTitle).toContain('Meshtastic');
  });

  it('returns null when app descriptor magic 0xABCD5432 is not present', () => {
    const empty = new Uint8Array(512);
    expect(parseAppDescriptor(empty)).toBeNull();
  });

  it('correctly discovers app descriptor located beyond 512 bytes in a 4096-byte buffer', () => {
    const buf = new Uint8Array(4096);
    const view = new DataView(buf.buffer);
    const offset = 1024; // Beyond the old 512-byte window

    view.setUint32(offset, 0xabcd5432, true); // Magic
    view.setUint32(offset + 4, 1, true); // Secure version
    // Write version string at offset + 16 (32 bytes)
    const versionBytes = new TextEncoder().encode('2.5.0\0');
    buf.set(versionBytes, offset + 16);
    // Write project name at offset + 48 (32 bytes)
    const projectBytes = new TextEncoder().encode('Meshtastic-custom\0');
    buf.set(projectBytes, offset + 48);

    const desc = parseAppDescriptor(buf);
    expect(desc).not.toBeNull();
    expect(desc?.firmwareType).toBe('meshtastic');
    expect(desc?.projectName).toBe('Meshtastic-custom');
    expect(desc?.version).toBe('2.5.0');
    expect(desc?.displayTitle).toBe('Meshtastic (2.5.0)');
  });
});
