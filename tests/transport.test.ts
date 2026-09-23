import { describe, it, expect, vi } from 'vitest';
import { Wg1200Transport } from '../src/lib/flasher/transport';
import { LogSanitizer } from '../src/lib/flasher/serialLog';

describe('transport & serialLog', () => {
  it('correctly normalizes 16MB string returned by esptool-js 0.7.0 detectFlashSize to 16,777,216 bytes', async () => {
    const transport = new Wg1200Transport({
      log: () => {},
      error: () => {},
    });

    // Mock loader with detectFlashSize returning '16MB'
    const mockLoader = {
      chip: { CHIP_NAME: 'ESP32-S3' },
      detectFlashSize: vi.fn().mockResolvedValue('16MB'),
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

  it('passes Uint8Array directly to loader.writeFlash for esptool-js 0.7.0', async () => {
    const transport = new Wg1200Transport({
      log: () => {},
      error: () => {},
    });

    let capturedOptions: any = null;
    (transport as any).loader = {
      writeFlash: vi.fn().mockImplementation((opts: any) => {
        capturedOptions = opts;
        return Promise.resolve();
      }),
    };

    const firmwareData = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    // slot ota_0 (0x420000)
    await transport.installApplication(0x420000, firmwareData);

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions.fileArray[0].address).toBe(0x420000);
    expect(capturedOptions.fileArray[0].data).toBeInstanceOf(Uint8Array);
    expect(capturedOptions.fileArray[0].data).toBe(firmwareData);
    expect(capturedOptions.eraseAll).toBe(false);
  });

  it('chunks readRegion into 4096-byte slices for large reads', async () => {
    const transport = new Wg1200Transport({
      log: () => {},
      error: () => {},
    });

    const calls: { offset: number; size: number }[] = [];
    (transport as any).loader = {
      readFlash: vi.fn().mockImplementation((offset: number, size: number) => {
        calls.push({ offset, size });
        return Promise.resolve(new Uint8Array(size).fill(0x55));
      }),
    };

    // 8192 bytes (e.g. esp_secure_cert)
    const result = await transport.readRegion(0xd000, 8192);
    expect(result.length).toBe(8192);
    expect(calls).toEqual([
      { offset: 0xd000, size: 4096 },
      { offset: 0xe000, size: 4096 },
    ]);
  });

  it('hardReset cleanly coordinates DTR and RTS signals to boot application', async () => {
    const transport = new Wg1200Transport({
      log: () => {},
      error: () => {},
    });

    const signalCalls: { dtr: boolean; rts: boolean }[] = [];
    (transport as any).transport = {
      _DTR_state: true,
      setSignals: vi.fn().mockImplementation((dtr: boolean, rts: boolean) => {
        signalCalls.push({ dtr, rts });
        return Promise.resolve();
      }),
    };

    await transport.hardReset();
    expect((transport as any).transport._DTR_state).toBe(false);
    expect(signalCalls).toEqual([
      { dtr: false, rts: true },  // EN low (reset)
      { dtr: false, rts: false }, // EN high (run app)
    ]);
  });

  it('patchTransportRead ignores leading noise bytes before 0xC0 (SLIP_END)', async () => {
    const { Transport } = await import('esptool-js');
    const mockDevice = {
      setSignals: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
    };
    const t = new Transport(mockDevice as any);

    // Provide buffer containing leading UART pin glitches (0xfc, 0x00) followed by valid SLIP packet [0xc0, 0x01, 0x02, 0xc0]
    (t as any).buffer = new Uint8Array([0xfc, 0x00, 0xc0, 0x01, 0x02, 0xc0]);

    const packet = await (t as any).read(1000);
    expect(Array.from(packet)).toEqual([0x01, 0x02]);
  });
});

