import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { WS2001_CHANGELOG, ws2001ChangelogFor } from '../../src/lib/ble/ws2001Changelog';
import { stationDfuNumber } from '../../src/lib/ble/ws2001Firmware';

const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../public/firmware/ws2001/manifest.json'), 'utf8'));

describe('WS2001 firmware changelog', () => {
  it('has release notes for every published release', () => {
    for (const r of manifest.releases) {
      expect(ws2001ChangelogFor(r.version), `no changelog entry for V${r.version}`).not.toBeNull();
    }
  });

  it('lists releases newest first, by DFU number', () => {
    const dfu = WS2001_CHANGELOG.map((e) => stationDfuNumber(e.version)!);
    expect(dfu.every((n) => Number.isInteger(n))).toBe(true);
    expect([...dfu].sort((a, b) => b - a)).toEqual(dfu);
    expect(new Set(dfu).size).toBe(dfu.length);
  });

  it('gives every entry a date, a summary and at least one change', () => {
    for (const e of WS2001_CHANGELOG) {
      expect(e.version).toMatch(/^\d+\.\d+$/);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.summary.length).toBeGreaterThan(10);
      expect(e.changes.length).toBeGreaterThan(0);
    }
    expect(ws2001ChangelogFor('9.9')).toBeNull();
  });
});
