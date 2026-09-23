import { describe, it, expect, vi } from 'vitest';
import { Wg1200Transport } from '../src/lib/flasher/transport';
import { LogSanitizer } from '../src/lib/flasher/serialLog';

describe('transport & serialLog', () => {
  it('correctly normalizes 16384 KB returned by esptool-js 0.5.4 to 16,777,216 bytes', async () => {
    const transport = new Wg1200Transport({
      log: () => {},
      error: () => {},
    });

    // Mock loader with getFlashSize returning 16384 (KB)
    const mockLoader = {
      chip: { CHIP_NAME: 'ESP32-S3' },
      getFlashSize: vi.fn().mockResolvedValue(16384),
      readFlash: vi.fn().mockImplementation((offset: number, size: number) => {
        const buf = new Uint8Array(size);
        if (offset === 0xc000) {
          // Partition table magic
          buf[0] = 0xaa;
          buf[1] = 0x50;
        }
        return Promise.resolve(buf);
      }),
    };

    (transport as any).loader = mockLoader;

    const inspection = await transport.inspect();
    expect(inspection.flashSizeBytes).toBe(16777216);
    expect(inspection.flashSizeMb).toBe(16);
    expect(inspection.is16Mb).toBe(true);
    expect(inspection.isEsp32S3).toBe(true);
  });

  it('rejects an application write targeting factory partition (0x20000)', async () => {
    const transport = new Wg1200Transport({
      log: () => {},
      error: () => {},
    });
    (transport as any).loader = {
      writeFlash: vi.fn(),
    };

    const dummyData = new Uint8Array(1024);
    await expect(transport.installApplication(0x020000, dummyData)).rejects.toThrow(
      /permitted WG1200 application partition/
    );
  });

  it('LogSanitizer statefully strips multiline certificate blocks', () => {
    const sanitizer = new LogSanitizer();
    const rawLog = [
      'Normal log line 1',
      '-----BEGIN CERTIFICATE-----',
      'MIIBkTCB+wIJAKH...',
      'AnotherCertLine==',
      '-----END CERTIFICATE-----',
      'Normal log line 2',
    ].join('\n');

    const clean = sanitizer.sanitizeText(rawLog);
    expect(clean).toContain('Normal log line 1');
    expect(clean).toContain('Normal log line 2');
    expect(clean).not.toContain('MIIBkTCB+wIJAKH');
    expect(clean).not.toContain('AnotherCertLine==');
    expect(clean).toContain('[REDACTED_SENSITIVE_BLOCK_START]');
    expect(clean).toContain('[REDACTED_SENSITIVE_BLOCK_END]');
  });

  it('LogSanitizer statefully strips multiline private key blocks', () => {
    const sanitizer = new LogSanitizer();
    const rawLog = [
      'Booting up...',
      '-----BEGIN EC PRIVATE KEY-----',
      'MHcCAQEEIPX...',
      'SecretKeyMaterial==',
      '-----END EC PRIVATE KEY-----',
      'WiFi connecting...',
    ].join('\n');

    const clean = sanitizer.sanitizeText(rawLog);
    expect(clean).toContain('Booting up...');
    expect(clean).toContain('WiFi connecting...');
    expect(clean).not.toContain('SecretKeyMaterial==');
    expect(clean).toContain('[REDACTED_SENSITIVE_BLOCK_START]');
  });

  it('LogSanitizer statefully strips sequential lines via sanitizeLine() across separate calls', () => {
    const sanitizer = new LogSanitizer();
    expect(sanitizer.sanitizeLine('I (123) main: system init')).toBe('I (123) main: system init');
    expect(sanitizer.sanitizeLine('-----BEGIN CERTIFICATE-----')).toBe('[REDACTED_SENSITIVE_BLOCK_START]');
    expect(sanitizer.sanitizeLine('MIIBkTCB+wIJAKH...')).toBeNull();
    expect(sanitizer.sanitizeLine('AnotherCertLine==')).toBeNull();
    expect(sanitizer.sanitizeLine('-----END CERTIFICATE-----')).toBe('[REDACTED_SENSITIVE_BLOCK_END]');
    expect(sanitizer.sanitizeLine('I (456) wifi: connected')).toBe('I (456) wifi: connected');
  });
});
