import { ESPLoader, Transport } from 'esptool-js';
import { parseAppDescriptor, type AppDescriptor } from './appDescriptor';
import { WG1200_CONSTANTS } from './constants';
import { compareHexHashes, sha256Hex } from './hashing';
import { verifySecureCertIdentity, type SecureCertVerificationResult } from './identity';
import { determineActiveBootSlot, type OtadataStatus } from './otadata';
import { parsePartitionTable, verifyWg1200PartitionTable, type PartitionRecord } from './partitions';
import { assertAllowedWrite } from './writeGuard';

export interface ProtectedRegionSnapshot {
  name: string;
  offset: number;
  size: number;
  sha256: string;
}

export interface Wg1200Inspection {
  chipName: string;
  flashSizeBytes: number;
  flashSizeMb: number;
  isEsp32S3: boolean;
  is16Mb: boolean;
  partitions: Record<string, PartitionRecord>;
  partitionErrors: string[];
  isPartitionLayoutValid: boolean;
  secureCert: SecureCertVerificationResult;
  otadata: OtadataStatus;
  currentFirmware: AppDescriptor | null;
  isValidWg1200: boolean;
}

export interface TerminalLogger {
  log: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

export class Wg1200Transport {
  private loader: ESPLoader | null = null;
  private transport: Transport | null = null;
  private port: any = null;
  private logger: TerminalLogger;

  constructor(logger?: TerminalLogger) {
    this.logger = logger ?? {
      log: (m) => console.log('[WG1200]', m),
      error: (m) => console.error('[WG1200]', m),
    };
  }

  public get isConnected(): boolean {
    return this.loader !== null && this.transport !== null;
  }

  /**
   * Connects to the device over Web Serial and boots the ESP stub.
   */
  public async connect(serialPort: any, baudrate = 921600): Promise<Wg1200Inspection> {
    this.port = serialPort;
    this.transport = new Transport(serialPort);

    const terminalWrapper = {
      clean: () => {},
      writeLine: (data: string) => this.logger.log(data),
      write: (data: string) => this.logger.log(data),
    };

    this.loader = new ESPLoader({
      transport: this.transport,
      baudrate,
      romBaudrate: 115200,
      terminal: terminalWrapper,
    });

    try {
      this.logger.log('Connecting to ESP32 ROM bootloader…');
      await this.loader.main();
      this.logger.log('Stub running. Inspecting hardware…');
      return await this.inspect();
    } catch (err: any) {
      await this.disconnect();
      throw new Error(`Failed to initialize WG1200 serial connection: ${err.message ?? err}`);
    }
  }

  /**
   * Inspects hardware, flash size, partition table, secure cert, otadata, and current app.
   */
  public async inspect(): Promise<Wg1200Inspection> {
    if (!this.loader) {
      throw new Error('Not connected to device');
    }

    // 1. Identify chip
    const chipName: string = (this.loader as any).chip?.CHIP_NAME ?? 'Unknown';
    const isEsp32S3 =
      chipName.toLowerCase().includes('esp32-s3') || chipName.toLowerCase().includes('esp32s3');

    // 2. Identify flash size
    let flashSizeBytes = 0;
    try {
      flashSizeBytes = await this.loader.getFlashSize();
    } catch (e: any) {
      this.logger.error(`Flash size detection failed: ${e.message}`);
    }
    const is16Mb = flashSizeBytes === WG1200_CONSTANTS.FLASH_SIZE_BYTES;
    const flashSizeMb = Math.round(flashSizeBytes / (1024 * 1024));

    // 3. Read & Verify Partition Table (0xC000, 4KB)
    this.logger.log('Reading partition table from 0xC000…');
    const ptBytes = await this.readRegion(
      WG1200_CONSTANTS.PARTITION_TABLE.offset,
      WG1200_CONSTANTS.PARTITION_TABLE.size
    );
    const partitions = parsePartitionTable(ptBytes);
    const ptResult = verifyWg1200PartitionTable(partitions, chipName, flashSizeBytes);

    // 4. Read & Verify esp_secure_cert (0xD000, 8KB)
    this.logger.log('Reading esp_secure_cert from 0xD000…');
    const certBytes = await this.readRegion(
      WG1200_CONSTANTS.SECURE_CERT.offset,
      WG1200_CONSTANTS.SECURE_CERT.size
    );
    const secureCert = await verifySecureCertIdentity(certBytes);

    // 5. Read & Parse otadata (0x13000, 8KB)
    this.logger.log('Reading otadata from 0x13000…');
    const otaBytes = await this.readRegion(
      WG1200_CONSTANTS.OTADATA.offset,
      WG1200_CONSTANTS.OTADATA.size
    );
    const otadata = determineActiveBootSlot(otaBytes);

    // 6. Detect currently installed application
    let currentFirmware: AppDescriptor | null = null;
    let activeAppOffset: number = WG1200_CONSTANTS.APP_FACTORY.offset;
    if (otadata.activeSlot === 'ota_0') {
      activeAppOffset = WG1200_CONSTANTS.APP_OTA_0.offset;
    } else if (otadata.activeSlot === 'ota_1') {
      activeAppOffset = WG1200_CONSTANTS.APP_OTA_1.offset;
    }

    try {
      const headerBytes = await this.readRegion(activeAppOffset, 512);
      currentFirmware = parseAppDescriptor(headerBytes);
    } catch (e) {
      this.logger.log(`Could not read application descriptor from offset 0x${activeAppOffset.toString(16)}`);
    }

    const isValidWg1200 =
      isEsp32S3 && is16Mb && ptResult.valid && secureCert.valid;

    return {
      chipName,
      flashSizeBytes,
      flashSizeMb,
      isEsp32S3,
      is16Mb,
      partitions,
      partitionErrors: ptResult.errors,
      isPartitionLayoutValid: ptResult.valid,
      secureCert,
      otadata,
      currentFirmware,
      isValidWg1200,
    };
  }

  /**
   * Safely reads a flash memory region.
   */
  public async readRegion(offset: number, size: number): Promise<Uint8Array> {
    if (!this.loader) throw new Error('Not connected');
    return await this.loader.readFlash(offset, size);
  }

  /**
   * Snapshots SHA-256 hashes of all protected regions before flashing.
   */
  public async snapshotProtectedRegions(): Promise<ProtectedRegionSnapshot[]> {
    const targets = [
      { name: 'partition_table', ...WG1200_CONSTANTS.PARTITION_TABLE },
      { name: 'esp_secure_cert', ...WG1200_CONSTANTS.SECURE_CERT },
      { name: 'nvs', ...WG1200_CONSTANTS.NVS },
      { name: 'nvs_key', ...WG1200_CONSTANTS.NVS_KEY },
    ];

    const snapshots: ProtectedRegionSnapshot[] = [];
    for (const target of targets) {
      const bytes = await this.readRegion(target.offset, target.size);
      const hash = await sha256Hex(bytes);
      snapshots.push({
        name: target.name,
        offset: target.offset,
        size: target.size,
        sha256: hash,
      });
    }

    return snapshots;
  }

  /**
   * Re-reads protected regions and verifies hashes match the pre-flash snapshot.
   */
  public async verifyProtectedRegions(
    beforeSnapshots: ProtectedRegionSnapshot[]
  ): Promise<{ valid: boolean; mismatches: string[] }> {
    const mismatches: string[] = [];

    for (const snap of beforeSnapshots) {
      const currentBytes = await this.readRegion(snap.offset, snap.size);
      const currentHash = await sha256Hex(currentBytes);
      if (!compareHexHashes(snap.sha256, currentHash)) {
        mismatches.push(
          `Protected partition '${snap.name}' was modified! Expected SHA ${snap.sha256}, got ${currentHash}`
        );
      }
    }

    return {
      valid: mismatches.length === 0,
      mismatches,
    };
  }

  /**
   * Writes application firmware to a permitted slot with absolute write guard.
   * Hardcodes eraseAll: false.
   */
  public async installApplication(
    slotOffset: number,
    firmwareBytes: Uint8Array,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    if (!this.loader) throw new Error('Not connected');

    // 1. Guard check: allow only ota_0 or ota_1 by default (preserves factory safe haven)
    assertAllowedWrite(slotOffset, firmwareBytes.byteLength, false);

    // 2. Convert bytes to binary string for esptool-js
    const bstr = this.ui8ToBstr(firmwareBytes);

    // 3. Perform guarded flash write
    this.logger.log(
      `Writing ${firmwareBytes.byteLength} bytes to slot offset 0x${slotOffset.toString(16)} (eraseAll: false)…`
    );

    await this.loader.writeFlash({
      fileArray: [
        {
          data: bstr,
          address: slotOffset,
        },
      ],
      flashSize: '16MB',
      flashMode: 'dio',
      flashFreq: '80m',
      eraseAll: false, // Invariant: NEVER erase entire flash
      compress: true,
      reportProgress: (_fileIndex: number, written: number, total: number) => {
        if (onProgress && total > 0) {
          const pct = Math.round((written / total) * 100);
          onProgress(pct);
        }
      },
    });
  }

  /**
   * Computes the flash MD5 directly on the ESP32-S3 and compares it to expected MD5.
   */
  public async verifyApplicationFlash(
    slotOffset: number,
    expectedMd5: string,
    length: number
  ): Promise<boolean> {
    if (!this.loader) throw new Error('Not connected');
    this.logger.log(`Verifying flash MD5 @ 0x${slotOffset.toString(16)} (${length} bytes)…`);
    const chipMd5 = await this.loader.flashMd5sum(slotOffset, length);
    return compareHexHashes(chipMd5, expectedMd5);
  }

  /**
   * Writes a repaired or updated otadata image to 0x13000.
   */
  public async writeOtadata(otadataBytes: Uint8Array): Promise<void> {
    if (!this.loader) throw new Error('Not connected');
    if (otadataBytes.byteLength !== WG1200_CONSTANTS.OTADATA.size) {
      throw new Error(`Invalid otadata size: expected 8192 bytes, got ${otadataBytes.byteLength}`);
    }

    const bstr = this.ui8ToBstr(otadataBytes);
    this.logger.log('Updating otadata boot pointer @ 0x13000…');

    await this.loader.writeFlash({
      fileArray: [
        {
          data: bstr,
          address: WG1200_CONSTANTS.OTADATA.offset,
        },
      ],
      flashSize: '16MB',
      flashMode: 'dio',
      flashFreq: '80m',
      eraseAll: false,
      compress: false,
    });
  }

  /**
   * Hard-resets the ESP32-S3 chip via RTS line.
   */
  public async hardReset(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.setRTS(true);
        await new Promise((r) => setTimeout(r, 100));
        await this.transport.setRTS(false);
      } catch (e) {
        this.logger.error(`Hard reset error: ${e}`);
      }
    }
  }

  /**
   * Closes loader and disconnects serial port.
   */
  public async disconnect(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.disconnect();
      } catch (e) {
        // ignore
      }
      this.transport = null;
    }
    this.loader = null;
    this.port = null;
  }

  private ui8ToBstr(bytes: Uint8Array): string {
    const CHUNK_SZ = 0x8000;
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK_SZ) {
      chunks.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK_SZ))));
    }
    return chunks.join('');
  }
}
