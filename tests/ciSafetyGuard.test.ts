import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('CI safety guard - absolute invariant check', () => {
  const srcDir = path.resolve(__dirname, '../src');

  function getAllFiles(dir: string): string[] {
    let results: string[] = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        results = results.concat(getAllFiles(fullPath));
      } else if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.astro')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const files = getAllFiles(srcDir);

  it('scans all src files and strictly forbids `eraseAll: true`', () => {
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const hasEraseAllTrue = /eraseAll\s*:\s*true/i.test(content);
      expect(
        hasEraseAllTrue,
        `FATAL SAFETY VIOLATION: 'eraseAll: true' found in file: ${file}`
      ).toBe(false);
    }
  });

  it('scans all src files and strictly forbids calls to `eraseFlash()`', () => {
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const hasEraseFlashCall = /\.eraseFlash\s*\(/i.test(content);
      expect(
        hasEraseFlashCall,
        `FATAL SAFETY VIOLATION: 'eraseFlash()' call found in file: ${file}`
      ).toBe(false);
    }
  });

  it('scans all src files and forbids dangerous generic flasher flags', () => {
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const hasArbitraryUpload = /allowArbitraryUpload|arbitraryBin|eraseChip/i.test(content);
      expect(
        hasArbitraryUpload,
        `FATAL SAFETY VIOLATION: dangerous debug flag found in file: ${file}`
      ).toBe(false);
    }
  });

  it('verifies Footer.astro renders deployed commit reference instead of flasher.weatherxm.com', () => {
    const footerPath = path.resolve(srcDir, 'components/Footer.astro');
    const content = fs.readFileSync(footerPath, 'utf8');
    expect(content).not.toContain('flasher.weatherxm.com');
    expect(content).toContain('commit:');
    expect(content).toContain('commitHash');
  });
});
