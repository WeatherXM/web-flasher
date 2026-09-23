import { WG1200_CONSTANTS } from './constants';
import { md5Hex } from './hashing';
import {
  fetchAndVerifyFirmware,
  loadManifest,
  type FirmwareEntry,
  type FirmwareManifest,
} from './manifest';
import { buildTransactionalOtadataSector, buildUpdatedOtadata } from './otadata';
import { captureBootLogs, downloadLogFile } from './serialLog';
import { FlasherStateMachine, type FlasherState, type StateContext } from './state';
import { Wg1200Transport, type ProtectedRegionSnapshot, type Wg1200Inspection } from './transport';

export interface FlasherUICallbacks {
  onStateChange: (context: StateContext) => void;
  onLog: (line: string) => void;
  onInspection: (data: Wg1200Inspection | null) => void;
  onManifest: (manifest: FirmwareManifest | null) => void;
}

export class FlasherController {
  private stateMachine = new FlasherStateMachine('idle');
  private transport: Wg1200Transport;
  private manifest: FirmwareManifest | null = null;
  private inspection: Wg1200Inspection | null = null;
  private serialPort: any = null;
  private logLines: string[] = [];
  private callbacks: FlasherUICallbacks;

  constructor(callbacks: FlasherUICallbacks) {
    this.callbacks = callbacks;

    this.transport = new Wg1200Transport({
      log: (msg) => this.addLog(`[INFO] ${msg}`),
      error: (msg) => this.addLog(`[ERROR] ${msg}`),
    });

    this.stateMachine.subscribe((ctx) => {
      this.callbacks.onStateChange(ctx);
    });
  }

  public get state(): FlasherState {
    return this.stateMachine.state;
  }

  public get context(): Readonly<StateContext> {
    return this.stateMachine.context;
  }

  public get inspectionData(): Wg1200Inspection | null {
    return this.inspection;
  }

  public get manifestData(): FirmwareManifest | null {
    return this.manifest;
  }

  public get logs(): readonly string[] {
    return this.logLines;
  }

  public addLog(msg: string): void {
    const time = new Date().toISOString().substring(11, 19);
    const line = `[${time}] ${msg}`;
    this.logLines.push(line);
    this.callbacks.onLog(line);
  }

  public async initialize(): Promise<void> {
    this.addLog('Initializing WG1200 Firmware Switcher…');

    // 1. Check Web Serial support
    if (typeof navigator === 'undefined' || !('serial' in navigator)) {
      this.addLog('[ERROR] Web Serial API is not supported in this browser.');
      this.stateMachine.transition(
        'unsupported',
        'Web Serial is not supported in your browser. Please use Chrome, Edge, Brave, or Opera on desktop.'
      );
      return;
    }

    // 2. Load manifest
    try {
      this.addLog('Loading firmware manifest from /firmware/manifest.json…');
      this.manifest = await loadManifest('/firmware/manifest.json');
      this.callbacks.onManifest(this.manifest);
      this.addLog(
        `Loaded manifest: WeatherXM v${this.manifest.firmwares.weatherxm.version}, Meshtastic v${this.manifest.firmwares.meshtastic.version}`
      );
    } catch (e: any) {
      this.addLog(`[ERROR] Manifest load failed: ${e.message}`);
      this.stateMachine.setError(`Failed to load firmware manifest: ${e.message}`);
    }
  }

  /**
   * Prompts user for serial port and runs WG1200 inspection.
   */
  public async connectDevice(filtered = true): Promise<void> {
    if (!('serial' in navigator)) return;

    try {
      this.addLog(filtered ? 'Requesting port with WG1200 CH340 filter…' : 'Requesting all serial ports…');
      const requestOptions = filtered
        ? { filters: WG1200_CONSTANTS.USB_FILTERS }
        : {};

      this.serialPort = await (navigator as any).serial.requestPort(requestOptions);
      this.stateMachine.transition('connecting', 'Connecting to WG1200…');

      this.addLog('Serial port selected. Initializing ESP32 bootloader stub…');
      this.inspection = await this.transport.connect(this.serialPort);

      this.stateMachine.transition('inspecting', 'Inspecting hardware partitions and device credentials…');
      this.addLog(`Detected chip: ${this.inspection.chipName}`);
      this.addLog(`Detected flash size: ${this.inspection.flashSizeMb} MB`);

      if (!this.inspection.isEsp32S3) {
        throw new Error(
          `Connected device is ${this.inspection.chipName}, not a WeatherXM WG1200 (ESP32-S3 required).`
        );
      }

      if (!this.inspection.is16Mb) {
        throw new Error(
          `Detected flash size is ${this.inspection.flashSizeMb}MB. WG1200 hardware requires 16MB flash.`
        );
      }

      if (!this.inspection.isPartitionLayoutValid) {
        throw new Error(
          `WG1200 partition layout mismatch: ${this.inspection.partitionErrors.join('; ')}`
        );
      }

      if (!this.inspection.secureCert.valid) {
        throw new Error(
          `WeatherXM device identity invalid: ${this.inspection.secureCert.errors.join('; ')}`
        );
      }

      this.addLog(
        `WeatherXM Identity verified! Fingerprint: ${this.inspection.secureCert.fingerprint}`
      );
      this.addLog(`Active boot slot: ${this.inspection.otadata.activeSlot}`);
      this.callbacks.onInspection(this.inspection);

      if (this.inspection.otadata.isAmbiguous) {
        this.addLog('[WARNING] Boot state is ambiguous or otadata has invalid/aborted states.');
        this.stateMachine.transition('recovery', 'Ambiguous boot state detected. Recovery mode active.');
      } else {
        this.stateMachine.transition('ready', 'WG1200 verified. Ready to choose firmware.');
      }
    } catch (err: any) {
      this.addLog(`[ERROR] Connection failed: ${err.message ?? err}`);
      await this.disconnect();
      this.stateMachine.setError(err.message ?? 'Failed to connect to WG1200', false);
    }
  }

  /**
   * Executes the full staged flashing pipeline.
   */
  public async flashFirmware(targetFirmwareKey: 'weatherxm' | 'meshtastic'): Promise<void> {
    if (!this.manifest || !this.inspection || !this.transport.isConnected) {
      throw new Error('Device is not ready for flashing.');
    }

    const fwEntry: FirmwareEntry = this.manifest.firmwares[targetFirmwareKey];
    if (!fwEntry) {
      throw new Error(`Firmware key '${targetFirmwareKey}' not found in manifest`);
    }

    const targetSlot = this.inspection.otadata.targetSlot;
    const targetOffset = this.inspection.otadata.targetOffset;

    this.addLog(`\n========================================`);
    this.addLog(`STARTING INSTALLATION: ${fwEntry.name} v${fwEntry.version}`);
    this.addLog(`Target slot: ${targetSlot} (0x${targetOffset.toString(16)})`);
    this.addLog(`Protected partitions will remain completely untouched.`);
    this.addLog(`========================================\n`);

    try {
      // Step 1: Download & verify firmware
      this.stateMachine.transition('downloading', `Downloading ${fwEntry.name} v${fwEntry.version}…`);
      this.stateMachine.setProgress(10, 'Downloading signed firmware…');
      this.addLog(`Downloading binary from ${fwEntry.file} (${fwEntry.bytes} bytes)…`);

      const verifiedFw = await fetchAndVerifyFirmware(fwEntry);
      this.addLog(`Cryptographic SHA-256 verified: ${verifiedFw.sha256}`);
      this.stateMachine.setProgress(20, 'Binary verified');

      // Step 2: Pre-flash snapshot of protected regions
      this.addLog('Taking cryptographic snapshot of protected partitions before write…');
      const preSnapshots: ProtectedRegionSnapshot[] = await this.transport.snapshotProtectedRegions();
      for (const snap of preSnapshots) {
        this.addLog(`Protected [${snap.name} @ 0x${snap.offset.toString(16)}]: SHA ${snap.sha256.substring(0, 16)}…`);
      }

      // Step 3: Write application firmware
      this.stateMachine.transition('flashing', `Writing ${fwEntry.name} to ${targetSlot}…`);
      this.addLog(`Writing ${verifiedFw.data.byteLength} bytes to offset 0x${targetOffset.toString(16)}…`);

      await this.transport.installApplication(targetOffset, verifiedFw.data, (pct) => {
        const scaledProgress = 25 + Math.round((pct / 100) * 50);
        this.stateMachine.setProgress(scaledProgress, `Writing firmware: ${pct}%`);
      });

      this.addLog('Flash write completed successfully.');
      this.stateMachine.setProgress(75, 'Firmware written');

      // Step 4: Verify flash MD5
      this.stateMachine.transition('verifying-flash', 'Verifying flash integrity via chip MD5…');
      const expectedMd5 = md5Hex(verifiedFw.data);
      this.addLog(`Expected binary MD5: ${expectedMd5}`);
      this.addLog('Requesting on-chip MD5 calculation from ESP32 stub…');

      const md5Matches = await this.transport.verifyApplicationFlash(
        targetOffset,
        expectedMd5,
        verifiedFw.data.byteLength
      );

      if (!md5Matches) {
        throw new Error(
          'Hardware flash MD5 verification failed! The written flash contents do not match the firmware image.'
        );
      }
      this.addLog('On-chip flash MD5 check PASSED!');
      this.stateMachine.setProgress(85, 'MD5 verified');

      // Step 5: Transactional update of otadata boot pointer
      this.addLog(
        `Transactionally updating boot pointer to ${targetSlot} (seq ${this.inspection.otadata.nextSeq})…`
      );
      const { targetAddress, sectorData } = buildTransactionalOtadataSector(
        this.inspection.otadata.nextSeq,
        this.inspection.otadata.targetSector
      );
      await this.transport.writeOtaSelectSector(
        targetAddress,
        sectorData,
        this.inspection.otadata.nextSeq
      );
      this.addLog('Transactional otadata update verified: CRC32, sequence, and ESP_OTA_IMG_VALID confirmed.');
      this.stateMachine.setProgress(90, 'Boot pointer updated');

      // Step 6: Post-flash protected partitions verification
      this.stateMachine.transition(
        'verifying-protected-data',
        'Verifying protected credentials and partition table…'
      );
      this.addLog('Verifying protected partitions remained 100% byte-for-byte identical…');
      const postVerification = await this.transport.verifyProtectedRegions(preSnapshots);
      if (!postVerification.valid) {
        throw new Error(
          `Protected data integrity check failed: ${postVerification.mismatches.join('; ')}`
        );
      }
      this.addLog('Protected partition verification PASSED: zero credentials modified.');
      this.stateMachine.setProgress(95, 'Protected data verified');

      // Step 7: Reboot and capture boot log
      this.stateMachine.transition('rebooting', 'Resetting WG1200 and verifying boot sequence…');
      this.addLog('Toggling RTS to hard reset ESP32-S3…');
      await this.transport.hardReset();
      await this.transport.disconnect();

      this.addLog('Listening for post-flash boot logs for 12 seconds…');
      const bootAnalysis = await captureBootLogs(this.serialPort, 12000, (line) => {
        this.addLog(`[BOOT] ${line}`);
      });

      this.addLog(`Boot signature detected: ${bootAnalysis.detectedSign}`);
      this.stateMachine.setProgress(100, 'Complete');
      this.stateMachine.transition(
        'success',
        `Successfully switched to ${fwEntry.name} v${fwEntry.version}!`
      );
    } catch (err: any) {
      this.addLog(`\n[FATAL ERROR] Installation aborted: ${err.message ?? err}`);
      await this.disconnect();
      this.stateMachine.setError(err.message ?? 'Flash failed', true);
    }
  }

  /**
   * Safe recovery for ambiguous otadata state.
   */
  public async executeRecovery(choice: 'weatherxm' | 'meshtastic' | 'rollback_factory'): Promise<void> {
    if (choice === 'rollback_factory') {
      await this.executeFactoryRollback();
      return;
    }
    // Transition recovery to downloading
    this.stateMachine.transition('ready', 'Starting targeted recovery flash…');
    await this.flashFirmware(choice);
  }

  /**
   * Rolls back gateway to factory stock firmware by clearing otadata to 0xFF.
   */
  public async executeFactoryRollback(): Promise<void> {
    if (!this.transport.isConnected) throw new Error('Not connected');
    this.addLog('\n========================================');
    this.addLog('EXECUTING FACTORY ROLLBACK (WeatherXM Stock)');
    this.addLog('Clearing otadata to 0xFF (pointing bootloader to 0x20000 factory partition)…');
    this.addLog('========================================\n');
    await this.transport.rollbackToFactory();
    this.addLog('Hard resetting device into Factory firmware…');
    await this.transport.hardReset();
    await this.disconnect();
    this.addLog('Factory rollback complete! Gateway will reboot into stock WeatherXM firmware.');
  }

  /**
   * Backs up full 16 MB flash and triggers browser download.
   */
  public async executeFullFlashBackup(onProgress?: (pct: number) => void): Promise<void> {
    if (!this.transport.isConnected) throw new Error('Not connected');
    this.addLog('\nStarting full 16 MB flash backup. This may take 1-2 minutes over Web Serial…');
    const fullData = await this.transport.readFullFlashWithValidation((pct, current, total) => {
      this.addLog(`Backup progress: ${pct}% (${Math.round(current / 1024)} KB / ${Math.round(total / 1024)} KB)`);
      if (onProgress) onProgress(pct);
    });

    const blob = new Blob([fullData.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wg1200_16mb_backup_${Date.now()}.bin`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.addLog('Full 16 MB backup downloaded successfully.');
  }

  public downloadLog(): void {
    downloadLogFile(this.logLines, `wg1200_flasher_${Date.now()}.txt`);
  }

  public async disconnect(): Promise<void> {
    try {
      await this.transport.disconnect();
    } catch (e) {
      // ignore
    }
    this.inspection = null;
    this.serialPort = null;
    this.callbacks.onInspection(null);
    this.stateMachine.reset();
  }
}
