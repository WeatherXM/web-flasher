import { ESPLoader, Transport } from 'esptool-js';
import { parseAppDescriptor, type AppDescriptor } from './appDescriptor';
import { WG1200_CONSTANTS } from './constants';
import { compareHexHashes, sha256Hex } from './hashing';
import { verifySecureCertIdentity, type SecureCertVerificationResult } from './identity';
import { determineActiveBootSlot, parseOtadataSector, type OtadataStatus } from './otadata';
import { parsePartitionTableWithMetadata, verifyWg1200PartitionTable, type PartitionRecord } from './partitions';
import { assertAllowedApplicationWrite, assertAllowedFactoryRollbackWrite, assertAllowedOtaSelectWrite } from './writeGuard';

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

  public get currentPort(): any {
    return this.port;
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

    // 2. Identify flash size (normalize KB from esptool-js 0.5.4)
    let flashSizeBytes = 0;
    try {
      const rawFlashSize = await this.loader.getFlashSize();
      flashSizeBytes = rawFlashSize <= 65536 ? rawFlashSize * 1024 : rawFlashSize;
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
    const parsedPt = parsePartitionTableWithMetadata(ptBytes);
    const ptResult = verifyWg1200PartitionTable(
      parsedPt.partitions,
      chipName,
      flashSizeBytes,
      { duplicateLabels: parsedPt.duplicateLabels, md5Valid: parsedPt.md5Valid }
    );

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
      partitions: parsedPt.partitions,
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

    // 1. Guard check: strictly allow only ota_0 or ota_1 (never factory)
    assertAllowedApplicationWrite(slotOffset, firmwareBytes.byteLength);

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
   * Transactionally updates a single 4 KB otadata sector.
   * - Uses assertAllowedOtaSelectWrite to enforce that the target is strictly 0x13000 or 0x14000.
   * - Leaves the previous active sector untouched.
   * - Reads back the written 4 KB sector and validates sequence, CRC, and state.
   */
  public async writeOtaSelectSector(
    targetAddress: number,
    sectorBytes: Uint8Array,
    expectedSeq: number
  ): Promise<void> {
    if (!this.loader) throw new Error('Not connected');
    const { sector, address } = assertAllowedOtaSelectWrite(targetAddress, sectorBytes.byteLength);

    this.logger.log(`Transactionally writing otadata sector ${sector} @ 0x${address.toString(16)}…`);
    const bstr = this.ui8ToBstr(sectorBytes);

    await this.loader.writeFlash({
      fileArray: [
        {
          data: bstr,
          address,
        },
      ],
      flashSize: '16MB',
      flashMode: 'dio',
      flashFreq: '80m',
      eraseAll: false,
      compress: false,
    });

    // Read back and verify the sector
    this.logger.log(`Verifying written otadata sector ${sector} @ 0x${address.toString(16)}…`);
    const readBack = await this.readRegion(address, 4096);
    const parsed = parseOtadataSector(readBack);

    if (!parsed.valid || parsed.seq !== expectedSeq) {
      throw new Error(
        `Otadata write verification failed! Expected seq ${expectedSeq}, got seq ${parsed.seq} (valid: ${parsed.valid}). ` +
        `The previous active sector remains untouched.`
      );
    }

    this.logger.log(`Otadata sector ${sector} successfully verified with sequence ${parsed.seq}.`);
  }

  /**
   * Resets both otadata sectors (0x13000 - 0x14FFF) to 0xFF.
   * Directs ESP32-S3 ROM bootloader to rollback and boot the immutable factory partition (0x020000).
   */
  /**
   * Verifies that the preserved factory recovery image (0x020000) exists,
   * is genuine WeatherXM firmware, and has a valid Secure Boot V2 signature block.
   */
  public async verifyPreservedFactoryImage(): Promise<{ valid: boolean; descriptor: AppDescriptor }> {
    if (!this.loader) throw new Error('Not connected');
    this.logger.log('Verifying preserved factory recovery image @ 0x020000…');

    // 1. Read first 4 KB
    const headerBytes = await this.readRegion(WG1200_CONSTANTS.APP_FACTORY.offset, 4096);
    if (headerBytes[0] !== 0xe9) {
      throw new Error(
        `Factory recovery image corrupted: expected ESP image magic 0xE9, got 0x${headerBytes[0].toString(16)}`
      );
    }

    // 2. Parse app descriptor
    const desc = parseAppDescriptor(headerBytes);
    if (!desc) {
      throw new Error('Factory recovery image corrupted: missing or invalid esp_app_desc_t descriptor.');
    }

    // 3. Verify it is genuine WeatherXM firmware
    if (desc.firmwareType !== 'weatherxm') {
      throw new Error(
        `Factory partition does not contain WeatherXM recovery firmware (detected: '${desc.displayTitle}'). Rollback aborted.`
      );
    }

    // 4. Trace segments to verify Secure Boot V2 signature block presence
    const segmentCount = headerBytes[1];
    let cur = 24;
    for (let s = 0; s < segmentCount; s++) {
      const segHdr = await this.readRegion(WG1200_CONSTANTS.APP_FACTORY.offset + cur, 8);
      const view = new DataView(segHdr.buffer, segHdr.byteOffset, segHdr.byteLength);
      const dataLen = view.getUint32(4, true);
      cur += 8 + dataLen;
    }
    cur += 1; // Checksum byte
    cur += (16 - (cur % 16)) % 16;
    cur += (4096 - (cur % 4096)) % 4096;

    const sigBlock = await this.readRegion(WG1200_CONSTANTS.APP_FACTORY.offset + cur, 4096);
    if (sigBlock[0] !== 0xe7) {
      throw new Error(
        `Factory recovery image missing Secure Boot V2 signature block at offset 0x${(WG1200_CONSTANTS.APP_FACTORY.offset + cur).toString(16)}`
      );
    }

    this.logger.log(`Preserved factory recovery image verified: ${desc.displayTitle} (Secure Boot V2 signature block present)`);
    return { valid: true, descriptor: desc };
  }

  /**
   * Resets both otadata sectors (0x13000 - 0x14FFF) to 0xFF.
   * Directs ESP32-S3 ROM bootloader to rollback and boot the preserved factory recovery partition (0x020000).
   * Verifies factory partition integrity before writing and enforces assertAllowedFactoryRollbackWrite.
   */
  public async rollbackToFactory(): Promise<void> {
    if (!this.loader) throw new Error('Not connected');

    // 1. Verify preserved factory image integrity
    await this.verifyPreservedFactoryImage();

    // 2. Enforce factory rollback write guard
    assertAllowedFactoryRollbackWrite(WG1200_CONSTANTS.OTADATA.offset, WG1200_CONSTANTS.OTADATA.size);

    this.logger.log('Writing 0xFF to otadata partition (0x13000, 8KB) to trigger factory rollback…');
    const blank = new Uint8Array(WG1200_CONSTANTS.OTADATA.size);
    blank.fill(0xff);
    const bstr = this.ui8ToBstr(blank);

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

    const readBack = await this.readRegion(WG1200_CONSTANTS.OTADATA.offset, WG1200_CONSTANTS.OTADATA.size);
    const allErased = readBack.every((b) => b === 0xff);
    if (!allErased) {
      throw new Error('Factory rollback failed: otadata was not completely cleared to 0xFF.');
    }
    this.logger.log('Factory rollback verified: otadata is 0xFF. Device will boot preserved factory partition.');
  }

  /**
   * Reads full 16 MB flash in 64KB blocks and validates bootloader & partition table magics.
   */
  public async readFullFlashWithValidation(
    onProgress?: (percent: number, offset: number, total: number) => void
  ): Promise<Uint8Array> {
    if (!this.loader) throw new Error('Not connected');
    const totalBytes = WG1200_CONSTANTS.FLASH_SIZE_BYTES; // 16777216
    const chunkSize = 65536;
    const fullData = new Uint8Array(totalBytes);

    this.logger.log(`Starting full 16 MB backup in ${chunkSize / 1024}KB chunks…`);
    for (let offset = 0; offset < totalBytes; offset += chunkSize) {
      const chunk = await this.loader.readFlash(offset, chunkSize);
      fullData.set(chunk, offset);
      if (onProgress) {
        onProgress(Math.round(((offset + chunkSize) / totalBytes) * 100), offset + chunkSize, totalBytes);
      }
    }

    // Header validations
    if (fullData[0] !== 0xe9) {
      this.logger.error(`Warning: Bootloader magic at 0x0000 is 0x${fullData[0].toString(16)}, expected 0xE9`);
    }
    const ptMagic = fullData[0xc000] | (fullData[0xc001] << 8);
    if (ptMagic !== WG1200_CONSTANTS.PARTITION_TABLE_MAGIC) {
      this.logger.error(`Warning: Partition table magic at 0xC000 is 0x${ptMagic.toString(16)}, expected 0x50AA`);
    }

    return fullData;
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
