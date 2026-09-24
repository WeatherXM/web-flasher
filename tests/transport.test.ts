import { describe, it, expect, vi } from 'vitest';
import { Wg1200Transport } from '../src/lib/flasher/transport';
import { LogSanitizer } from '../src/lib/flasher/serialLog';
import { WG1200_CONSTANTS } from '../src/lib/flasher/constants';

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

  it('restoreFullFlash invokes loader.writeFlash for 16MB image and verifies bootloader', async () => {
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
      readFlash: vi.fn().mockImplementation((offset: number, size: number) => {
        const buf = new Uint8Array(size);
        if (offset === 0) {
          buf[0] = 0xe9;
        }
        return Promise.resolve(buf);
      }),
    };

    const fullData = new Uint8Array(WG1200_CONSTANTS.FLASH_SIZE_BYTES);
    fullData[0] = 0xe9;

    let progressReported = false;
    await transport.restoreFullFlash(fullData, (_pct) => {
      progressReported = true;
    });

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions.fileArray[0].address).toBe(0);
    expect(capturedOptions.fileArray[0].data).toBe(fullData);
    expect(capturedOptions.flashSize).toBe('16MB');
    expect(capturedOptions.compress).toBe(true);

    // Call reportProgress callback to verify progress handling
    capturedOptions.reportProgress(0, 50, 100);
    expect(progressReported).toBe(true);
  });

  it('restoreFullFlash throws if verification fails', async () => {
    const transport = new Wg1200Transport({
      log: () => {},
      error: () => {},
    });

    (transport as any).loader = {
      writeFlash: vi.fn().mockResolvedValue(undefined),
      readFlash: vi.fn().mockResolvedValue(new Uint8Array([0x00, 0x00, 0x00, 0x00])),
    };

    const fullData = new Uint8Array(WG1200_CONSTANTS.FLASH_SIZE_BYTES);
    await expect(transport.restoreFullFlash(fullData)).rejects.toThrow(
      /Flash restore verification failed/
    );
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
      { dtr: false, rts: false }, // Step 1: Idle
      { dtr: false, rts: true },  // Step 2: EN low (reset)
      { dtr: false, rts: false }, // Step 3: EN high (run app)
    ]);
  });

  it('disconnect releases reset lines and resets device by default', async () => {
    const transport = new Wg1200Transport({
      log: () => {},
      error: () => {},
    });

    let resetCalled = false;
    transport.hardReset = vi.fn().mockImplementation(() => {
      resetCalled = true;
      return Promise.resolve();
    });

    const mockTransport = {
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    (transport as any).transport = mockTransport;

    await transport.disconnect();
    expect(resetCalled).toBe(true);
    expect(mockTransport.disconnect).toHaveBeenCalled();
  });

  it('disconnect can skip reset when releaseReset is false', async () => {
    const transport = new Wg1200Transport({
      log: () => {},
      error: () => {},
    });

    let resetCalled = false;
    transport.hardReset = vi.fn().mockImplementation(() => {
      resetCalled = true;
      return Promise.resolve();
    });

    const mockTransport = {
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    (transport as any).transport = mockTransport;

    await transport.disconnect(false);
    expect(resetCalled).toBe(false);
    expect(mockTransport.disconnect).toHaveBeenCalled();
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

  it('patchEsploaderRunStub applies ROM pointer hijacking workaround when ESP32-S3 has Secure Boot enabled', async () => {
    const { ESPLoader } = await import('esptool-js');
    const calls: string[] = [];
    const regsWritten: { addr: number; val: number }[] = [];

    const mockLoader: any = Object.create(ESPLoader.prototype);
    mockLoader.chip = {
      CHIP_NAME: 'ESP32-S3',
      getChipRevision: vi.fn().mockResolvedValue(2),
    };
    mockLoader.IS_STUB = false;
    mockLoader.secureDownloadMode = false;
    mockLoader.ESP_RAM_BLOCK = 2048;
    mockLoader.DEFAULT_TIMEOUT = 1000;
    mockLoader.info = vi.fn();
    mockLoader.debug = vi.fn();
    mockLoader.applyUsbFlashWriteSize = vi.fn().mockResolvedValue(undefined);
    mockLoader.memBegin = vi.fn().mockResolvedValue(undefined);
    mockLoader.memBlock = vi.fn().mockResolvedValue(undefined);

    mockLoader.memFinish = vi.fn().mockImplementation((entry: number) => {
      calls.push(`memFinish(${entry})`);
      return Promise.resolve();
    });

    mockLoader.readReg = vi.fn().mockImplementation((addr: number) => {
      calls.push(`readReg(0x${addr.toString(16)})`);
      if (addr === 0x60007038) {
        // Secure boot bit 20 is set (0x100000)
        return Promise.resolve(0x100000);
      }
      if (addr === 0x3fcef688) {
        // Original legacy ROM read pointer
        return Promise.resolve(0x40000123);
      }
      return Promise.resolve(0);
    });

    mockLoader.writeReg = vi.fn().mockImplementation((addr: number, val: number) => {
      calls.push(`writeReg(0x${addr.toString(16)}, 0x${val.toString(16)})`);
      regsWritten.push({ addr, val });
      return Promise.resolve();
    });

    mockLoader.command = vi.fn().mockImplementation((op: number, data: Uint8Array, chk: number, waitResponse: boolean) => {
      calls.push(`command(0x${op.toString(16)}, waitResponse=${waitResponse})`);
      return Promise.resolve([0, new Uint8Array(0)]);
    });

    mockLoader.transport = {
      read: vi.fn().mockResolvedValue(new TextEncoder().encode('OHAI')),
    };

    await mockLoader.runStub();

    // Verify step sequence
    expect(calls).toContain('readReg(0x60007038)');
    expect(calls).toContain('memFinish(0)');
    expect(calls).toContain('readReg(0x3fcef688)');
    expect(calls).toContain('command(0xe, waitResponse=false)');
    expect(mockLoader.transport.read).toHaveBeenCalled();

    // Verify pointer was hijacked to stub entrypoint and then restored
    expect(regsWritten.length).toBeGreaterThanOrEqual(2);
    expect(regsWritten[0].addr).toBe(0x3fcef688);
    // Stub entrypoint for ESP32-S3 is non-zero (0x40379524 or similar)
    expect(regsWritten[0].val).toBeGreaterThan(0x40000000);
    // Pointer restored to 0x40000123
    expect(regsWritten[1].addr).toBe(0x3fcef688);
    expect(regsWritten[1].val).toBe(0x40000123);

    expect(mockLoader.IS_STUB).toBe(true);
  });

  it('patchEsploaderRunStub uses standard memFinish(entry) when ESP32-S3 Secure Boot is not enabled', async () => {
    const { ESPLoader } = await import('esptool-js');
    const calls: string[] = [];

    const mockLoader: any = Object.create(ESPLoader.prototype);
    mockLoader.chip = {
      CHIP_NAME: 'ESP32-S3',
      getChipRevision: vi.fn().mockResolvedValue(2),
    };
    mockLoader.IS_STUB = false;
    mockLoader.secureDownloadMode = false;
    mockLoader.ESP_RAM_BLOCK = 2048;
    mockLoader.DEFAULT_TIMEOUT = 1000;
    mockLoader.info = vi.fn();
    mockLoader.debug = vi.fn();
    mockLoader.applyUsbFlashWriteSize = vi.fn().mockResolvedValue(undefined);
    mockLoader.memBegin = vi.fn().mockResolvedValue(undefined);
    mockLoader.memBlock = vi.fn().mockResolvedValue(undefined);

    mockLoader.memFinish = vi.fn().mockImplementation((entry: number) => {
      calls.push(`memFinish(0x${entry.toString(16)})`);
      return Promise.resolve();
    });

    mockLoader.readReg = vi.fn().mockImplementation((addr: number) => {
      if (addr === 0x60007038) {
        // Secure boot bit 20 is NOT set
        return Promise.resolve(0);
      }
      return Promise.resolve(0);
    });

    mockLoader.writeReg = vi.fn().mockResolvedValue(undefined);
    mockLoader.command = vi.fn().mockResolvedValue([0, new Uint8Array(0)]);
    mockLoader.transport = {
      read: vi.fn().mockResolvedValue(new TextEncoder().encode('OHAI')),
    };

    await mockLoader.runStub();

    // Standard path should NOT call memFinish(0) and should NOT hijack 0x3fcef688
    expect(calls).not.toContain('memFinish(0x0)');
    expect(mockLoader.memFinish).toHaveBeenCalled();
    const entryArg = mockLoader.memFinish.mock.calls[0][0];
    expect(entryArg).toBeGreaterThan(0x40000000);
    expect(mockLoader.IS_STUB).toBe(true);
  });

  it('patchEsploaderRunStub skips stub upload when syncStubDetected is true', async () => {
    const { ESPLoader } = await import('esptool-js');
    const mockLoader: any = Object.create(ESPLoader.prototype);
    mockLoader.chip = { CHIP_NAME: 'ESP32-S3' };
    mockLoader.syncStubDetected = true;
    mockLoader.IS_STUB = false;
    mockLoader.info = vi.fn();
    mockLoader.applyUsbFlashWriteSize = vi.fn().mockResolvedValue(undefined);
    mockLoader.memBegin = vi.fn();

    const chip = await mockLoader.runStub();
    expect(chip).toBe(mockLoader.chip);
    expect(mockLoader.IS_STUB).toBe(true);
    expect(mockLoader.memBegin).not.toHaveBeenCalled();
    expect(mockLoader.applyUsbFlashWriteSize).toHaveBeenCalled();
  });
});

