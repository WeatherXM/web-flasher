/**
 * Web Bluetooth connection to a WS1300 station: device chooser, GATT setup,
 * SMP (firmware update) and optionally NUS (shell).
 */

import { NUSClient, NUS_RX_CHAR_UUID, NUS_SERVICE_UUID, NUS_TX_CHAR_UUID } from './nus';
import { SMPClient, SMP_CHAR_UUID, SMP_SERVICE_UUID, type LogFn } from './smp';

export type SessionState = 'disconnected' | 'connecting' | 'connected' | 'updating';

export const WS1300_NAME_PREFIXES = ['WeatherXM', 'WS1300', 'WXM'];

/** A drop this soon after connecting, unprompted, points at a stale bond. */
const STALE_BOND_WINDOW_MS = 6000;
/** macOS keeps a connect to a silent device pending forever; give up after this. */
const GATT_CONNECT_TIMEOUT_MS = 20000;

export interface SessionOptions {
  log: LogFn;
  onState?: (state: SessionState) => void;
  /** Unsolicited shell output; enabling it also subscribes to the shell service */
  onShellOutput?: (text: string) => void;
  /** Called when the link drops in a way that has a known fix */
  onHint?: (hint: 'stale-bond') => void;
}

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator && !!navigator.bluetooth;
}

export class Ws1300Session {
  device: BluetoothDevice | null = null;
  smp: SMPClient | null = null;
  nus: NUSClient | null = null;
  shellReady = false;
  state: SessionState = 'disconnected';

  private connectedAt = 0;
  private expectingDrop = false;
  private readonly onGattDisconnected = () => this.handleDisconnected();

  constructor(private readonly opts: SessionOptions) {}

  get deviceName(): string {
    return this.device?.name || 'WS1300';
  }

  get connected(): boolean {
    return !!this.device?.gatt?.connected;
  }

  private setState(s: SessionState): void {
    this.state = s;
    this.opts.onState?.(s);
  }

  /** Show the browser's device chooser and connect. Must run from a user gesture. */
  async connect(): Promise<void> {
    if (!isWebBluetoothAvailable()) throw new Error('This browser does not support Web Bluetooth.');
    const log = this.opts.log;

    this.setState('connecting');
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: WS1300_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
        optionalServices: [SMP_SERVICE_UUID, NUS_SERVICE_UUID],
      });
      if (this.device && this.device !== device) {
        this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
      }
      this.device = device;
      device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
      log(`Selected "${device.name ?? 'unnamed'}"`, 'BLE');
      await this.openGatt();
    } catch (err) {
      this.setState('disconnected');
      throw err;
    }
  }

  /**
   * Try to reconnect to the station picked earlier without the chooser (e.g. after a reboot).
   * Often fails after a restart: Chrome is not scanning in the background and may not
   * recognise the restarted station, so callers need a chooser fallback on a user click.
   */
  async reconnect(attempts = 2, delayMs = 3000, timeoutMs = 8000): Promise<void> {
    if (!this.device) throw new Error('No station selected yet');
    this.setState('connecting');
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.openGatt(timeoutMs);
        return;
      } catch (err) {
        lastErr = err;
        this.opts.log(`Reconnect attempt ${i + 1}/${attempts} failed: ${errMsg(err)}`, 'WARN');
        await sleep(delayMs);
      }
    }
    this.setState('disconnected');
    throw lastErr instanceof Error ? lastErr : new Error('Could not reconnect to the station');
  }

  private async openGatt(timeoutMs = GATT_CONNECT_TIMEOUT_MS): Promise<void> {
    const log = this.opts.log;
    const gatt = this.device?.gatt;
    if (!gatt) throw new Error('Selected device has no GATT server');

    let timer: ReturnType<typeof setTimeout> | undefined;
    const server = await Promise.race([
      gatt.connect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          gatt.disconnect();
          reject(new Error('The station did not answer. Is it nearby and awake?'));
        }, timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    this.connectedAt = performance.now();
    this.shellReady = false;
    this.expectingDrop = false;
    log('Connected. Resolving services...', 'BLE');

    const smpService = await server.getPrimaryService(SMP_SERVICE_UUID).catch(() => null);
    if (!smpService) {
      server.disconnect();
      throw new Error('This device does not offer the firmware update service. Is it a WS1300?');
    }
    this.smp = new SMPClient(await smpService.getCharacteristic(SMP_CHAR_UUID), log);
    await this.smp.start();

    if (this.opts.onShellOutput) {
      try {
        const nusService = await server.getPrimaryService(NUS_SERVICE_UUID);
        const rx = await nusService.getCharacteristic(NUS_RX_CHAR_UUID);
        const tx = await nusService.getCharacteristic(NUS_TX_CHAR_UUID);
        this.nus = new NUSClient(rx, tx, log, this.opts.onShellOutput);
        await this.nus.start();
      } catch (err) {
        log(`Shell service unavailable: ${errMsg(err)}`, 'WARN');
        this.nus = null;
      }
    }

    this.setState('connected');
  }

  /**
   * The station enables its shell only after the link is encrypted (security level 2)
   * and ignores input until then. Probe until it answers, keeping the link up for the
   * whole pairing window: disconnecting mid-pairing makes the station drop the bond.
   */
  async waitForShell(maxWaitMs = 32000, onWaiting?: () => void): Promise<boolean> {
    const deadline = performance.now() + maxWaitMs;
    let hinted = false;
    while (performance.now() < deadline) {
      if (!this.nus || !this.connected) return false;
      const reply = await this.nus.sendCommand('fw_version', 2500).catch(() => '');
      if (reply.trim()) {
        this.shellReady = true;
        this.opts.log('Station shell ready.', 'NUS');
        return true;
      }
      if (!this.connected) return false;
      if (!hinted) {
        hinted = true;
        onWaiting?.();
      }
    }
    return false;
  }

  setUpdating(on: boolean): void {
    this.setState(on ? 'updating' : this.connected ? 'connected' : 'disconnected');
  }

  /** The next disconnect is intentional (reset after update), not a fault. */
  expectDisconnect(): void {
    this.expectingDrop = true;
  }

  disconnect(): void {
    this.expectingDrop = true;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.handleDisconnected();
  }

  private handleDisconnected(): void {
    const quickDrop =
      !this.expectingDrop &&
      this.connectedAt > 0 &&
      !this.shellReady &&
      performance.now() - this.connectedAt < STALE_BOND_WINDOW_MS;

    this.opts.log('Station disconnected.', 'BLE');
    if (quickDrop) this.opts.onHint?.('stale-bond');
    this.smp?.abort(new Error('The Bluetooth connection to the station was lost.'));

    this.connectedAt = 0;
    this.expectingDrop = false;
    this.smp = null;
    this.nus = null;
    this.shellReady = false;
    this.setState('disconnected');
  }
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The user closed the browser's device chooser. Not an error worth showing. */
export function isChooserCancelled(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotFoundError';
}
