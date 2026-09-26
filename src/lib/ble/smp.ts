/**
 * Zephyr MCUmgr Simple Management Protocol (SMP) client over Web Bluetooth.
 *
 *   - 8-byte SMP framing and reassembly of multi-notification responses
 *   - MCUboot image state query (ImageStatesRead)
 *   - Chunked multi-image upload (ImageUploadWrite)
 *   - Mark image for test (ImageStatesWrite) and reset (OS ResetWrite)
 *
 * SMP does not need BLE pairing on the WS1300, so it works even when the
 * encrypted shell never comes up.
 */

import { cborDecode, cborEncode, type CborValue } from './cbor';

export const SMP_SERVICE_UUID = '8d53dc1d-1db7-4cd3-868b-8a527460aa84';
export const SMP_CHAR_UUID = 'da2e7828-fbce-4e01-ae9e-261174997c48';

export const OP_READ = 0;
export const OP_READ_RSP = 1;
export const OP_WRITE = 2;
export const OP_WRITE_RSP = 3;

export const GROUP_OS = 0;
export const GROUP_IMAGE = 1;

export const CMD_OS_ECHO = 0;
export const CMD_OS_RESET = 5;

export const CMD_IMG_STATE = 0;
export const CMD_IMG_UPLOAD = 1;

// 185 is the smallest ATT MTU macOS/iOS negotiate; 182 payload bytes fit in one write
export const SMP_MAX_WRITE_SIZE = 180;
// Upload data bytes per request; the frame is reassembled on the station
export const SMP_UPLOAD_CHUNK_SIZE = 244;

export type LogFn = (msg: string, tag?: string) => void;

/** The subset of BluetoothRemoteGATTCharacteristic the SMP client uses. */
export interface SmpCharacteristic {
  addEventListener(type: 'characteristicvaluechanged', listener: (ev: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (ev: Event) => void): void;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
}

export interface SmpResponse {
  op: number;
  group: number;
  seq: number;
  cmd: number;
  data: Record<string, CborValue>;
}

export interface ImageSlotState {
  image: number;
  slot: number;
  version: string;
  hash: string;
  hashBytes: Uint8Array;
  bootable: boolean;
  pending: boolean;
  confirmed: boolean;
  active: boolean;
  permanent: boolean;
}

export interface UploadProgress {
  offset: number;
  total: number;
  percentage: number;
  speedKbps: number;
  etaSeconds: number;
}

export function encodeSmpFrame(op: number, group: number, seq: number, cmd: number, payload: Uint8Array): Uint8Array {
  const packet = new Uint8Array(8 + payload.length);
  packet[0] = op & 0xff;
  packet[1] = 0; // flags
  packet[2] = (payload.length >> 8) & 0xff;
  packet[3] = payload.length & 0xff;
  packet[4] = (group >> 8) & 0xff;
  packet[5] = group & 0xff;
  packet[6] = seq & 0xff;
  packet[7] = cmd & 0xff;
  packet.set(payload, 8);
  return packet;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export class SMPClient {
  private seq = 0;
  private rxBuffer = new Uint8Array(0);
  private expectedLength = 0;
  private pendingSeq: number | null = null;
  private resolver: ((r: SmpResponse) => void) | null = null;
  private rejecter: ((e: Error) => void) | null = null;
  private readonly onNotification = (ev: Event) => this.handleNotification(ev);

  constructor(
    private readonly characteristic: SmpCharacteristic,
    private readonly log: LogFn = () => {},
    private readonly maxWriteSize = SMP_MAX_WRITE_SIZE,
  ) {}

  async start(): Promise<void> {
    this.characteristic.addEventListener('characteristicvaluechanged', this.onNotification);
    await this.characteristic.startNotifications();
    this.log('Subscribed to SMP notifications.', 'BLE');
  }

  /** Fail the request in flight, e.g. because the link dropped. */
  abort(reason: Error): void {
    this.rxBuffer = new Uint8Array(0);
    this.rejecter?.(reason);
  }

  async stop(): Promise<void> {
    try {
      this.characteristic.removeEventListener('characteristicvaluechanged', this.onNotification);
      await this.characteristic.stopNotifications();
    } catch {
      // Link already gone
    }
  }

  private handleNotification(ev: Event): void {
    const v = (ev.target as { value?: DataView } | null)?.value;
    if (!v) return;
    this.handleData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }

  /** Feed one notification payload. Public for tests. */
  handleData(data: Uint8Array): void {
    if (data.length === 0) return;

    if (this.rxBuffer.length === 0) {
      if (data.length < 8) {
        this.log(`SMP header too short (${data.length} bytes)`, 'WARN');
        return;
      }
      this.expectedLength = 8 + ((data[2] << 8) | data[3]);
      this.rxBuffer = new Uint8Array(data);
    } else {
      const merged = new Uint8Array(this.rxBuffer.length + data.length);
      merged.set(this.rxBuffer);
      merged.set(data, this.rxBuffer.length);
      this.rxBuffer = merged;
    }

    if (this.rxBuffer.length >= this.expectedLength) {
      const frame = this.rxBuffer.subarray(0, this.expectedLength);
      this.rxBuffer = new Uint8Array(0);
      this.expectedLength = 0;
      this.processResponse(frame);
    }
  }

  private processResponse(frame: Uint8Array): void {
    const op = frame[0];
    const group = (frame[4] << 8) | frame[5];
    const seq = frame[6];
    const cmd = frame[7];

    let data: Record<string, CborValue> = {};
    const payload = frame.subarray(8);
    if (payload.length > 0) {
      try {
        const decoded = cborDecode(payload);
        if (decoded && typeof decoded === 'object' && !Array.isArray(decoded) && !(decoded instanceof Uint8Array)) {
          data = decoded;
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.log(`CBOR decode error: ${e.message}`, 'ERROR');
        this.rejecter?.(e);
        return;
      }
    }

    if (this.resolver && (this.pendingSeq === null || this.pendingSeq === seq)) {
      const resolve = this.resolver;
      this.clearPending();
      resolve({ op, group, seq, cmd, data });
    }
  }

  private clearPending(): void {
    this.resolver = null;
    this.rejecter = null;
    this.pendingSeq = null;
  }

  /**
   * Write one SMP frame as ATT-sized fragments; the station reassembles them
   * (MCUMGR_TRANSPORT_BT_REASSEMBLY). Web Bluetooth does not expose the MTU, and on
   * macOS CoreBluetooth truncates write-without-response values longer than MTU-3,
   * so a whole ~270 byte upload frame never arrives intact.
   */
  private async writeFragmented(packet: Uint8Array): Promise<void> {
    for (let i = 0; i < packet.length; i += this.maxWriteSize) {
      const frag = packet.slice(i, i + this.maxWriteSize);
      for (let attempt = 0; ; attempt++) {
        try {
          await this.characteristic.writeValueWithoutResponse(frag);
          break;
        } catch (err) {
          // Chrome rejects while a previous GATT op is still queued; back off briefly
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt >= 5 || !/in progress|busy/i.test(msg)) throw err;
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
        }
      }
    }
  }

  request(
    op: number,
    group: number,
    cmd: number,
    payload: Record<string, CborValue> = {},
    timeoutMs = 12000,
  ): Promise<SmpResponse> {
    const seq = this.seq++ & 0xff;
    const packet = encodeSmpFrame(op, group, seq, cmd, cborEncode(payload));

    return new Promise<SmpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingSeq === seq) {
          this.clearPending();
          this.rxBuffer = new Uint8Array(0);
          reject(new Error(`SMP request timed out after ${timeoutMs} ms (group ${group}, cmd ${cmd})`));
        }
      }, timeoutMs);

      this.resolver = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.rejecter = (e) => {
        clearTimeout(timer);
        this.clearPending();
        reject(e);
      };
      this.pendingSeq = seq;

      this.writeFragmented(packet).catch((err) => {
        clearTimeout(timer);
        this.clearPending();
        reject(err);
      });
    });
  }

  async readImageStates(): Promise<ImageSlotState[]> {
    const res = await this.request(OP_READ, GROUP_IMAGE, CMD_IMG_STATE, {});
    const images = Array.isArray(res.data.images) ? res.data.images : [];
    return images.map((raw) => {
      const img = (raw ?? {}) as Record<string, CborValue>;
      const hashBytes = img.hash instanceof Uint8Array ? img.hash : new Uint8Array(0);
      return {
        image: typeof img.image === 'number' ? img.image : 0,
        slot: typeof img.slot === 'number' ? img.slot : 0,
        version: typeof img.version === 'string' ? img.version : 'unknown',
        hash: toHex(hashBytes),
        hashBytes,
        bootable: !!img.bootable,
        pending: !!img.pending,
        confirmed: !!img.confirmed,
        active: !!img.active,
        permanent: !!img.permanent,
      };
    });
  }

  async uploadImage(
    imageData: Uint8Array,
    imageIndex = 0,
    onProgress?: (p: UploadProgress) => void,
    chunkSize = SMP_UPLOAD_CHUNK_SIZE,
  ): Promise<void> {
    const total = imageData.length;
    const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', imageData as ArrayBufferView<ArrayBuffer>));
    const start = performance.now();
    let offset = 0;

    this.log(`Starting SMP upload: ${total} bytes (image ${imageIndex}, ${chunkSize} B chunks)`, 'DFU');

    while (offset < total) {
      const end = Math.min(offset + chunkSize, total);
      const payload: Record<string, CborValue> = { data: imageData.subarray(offset, end), off: offset };

      // First packet carries image length, SHA-256 and image (core) index
      if (offset === 0) {
        payload.len = total;
        payload.sha = sha;
        if (imageIndex !== 0) payload.image = imageIndex;
      }

      const res = await this.request(OP_WRITE, GROUP_IMAGE, CMD_IMG_UPLOAD, payload, 25000);

      if (typeof res.data.rc === 'number' && res.data.rc !== 0) {
        throw new Error(`Station rejected upload at offset ${offset} with code ${res.data.rc}`);
      }
      // SMP v2 error format
      const err = res.data.err as Record<string, CborValue> | undefined;
      if (err && typeof err === 'object') {
        throw new Error(`Station rejected upload at offset ${offset}: group ${String(err.group)}, rc ${String(err.rc)}`);
      }

      offset = typeof res.data.off === 'number' ? res.data.off : end;

      if (onProgress) {
        const elapsed = Math.max(0.05, (performance.now() - start) / 1000);
        const speedKbps = offset / 1024 / elapsed;
        onProgress({
          offset,
          total,
          percentage: Math.min(100, (offset / total) * 100),
          speedKbps,
          etaSeconds: speedKbps > 0 ? (total - offset) / (speedKbps * 1024) : 0,
        });
      }
    }

    this.log(`SMP upload complete: ${total} bytes.`, 'DFU');
  }

  async markImageForTest(hashBytes: Uint8Array): Promise<Record<string, CborValue>> {
    const res = await this.request(OP_WRITE, GROUP_IMAGE, CMD_IMG_STATE, { hash: hashBytes, confirm: false });
    return res.data;
  }

  async reset(): Promise<void> {
    try {
      await this.request(OP_WRITE, GROUP_OS, CMD_OS_RESET, {}, 5000);
    } catch {
      // The station drops the link as it reboots, which is expected
    }
  }
}
