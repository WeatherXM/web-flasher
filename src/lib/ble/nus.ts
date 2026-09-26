/**
 * Nordic UART Service (NUS) client for the WS1300 Zephyr shell.
 * The station enables the shell only after the link is encrypted (security level 2).
 */

import type { LogFn } from './smp';

export const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // station RX (we write)
export const NUS_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // station TX (we get notified)

const SHELL_PROMPTS = ['bt_nus:~$', 'uart:~$'];
const WRITE_CHUNK = 128;

export interface NusWritable {
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
}

export interface NusNotifying {
  addEventListener(type: 'characteristicvaluechanged', listener: (ev: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (ev: Event) => void): void;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
}

export class NUSClient {
  private rxBuffer = '';
  private resolver: ((text: string) => void) | null = null;
  private readonly onNotification = (ev: Event) => this.handleNotification(ev);

  constructor(
    private readonly rxChar: NusWritable,
    private readonly txChar: NusNotifying,
    private readonly log: LogFn = () => {},
    private readonly onStream: (text: string) => void = () => {},
  ) {}

  async start(): Promise<void> {
    this.txChar.addEventListener('characteristicvaluechanged', this.onNotification);
    await this.txChar.startNotifications();
    this.log('Subscribed to shell (NUS) notifications.', 'BLE');
  }

  async stop(): Promise<void> {
    try {
      this.txChar.removeEventListener('characteristicvaluechanged', this.onNotification);
      await this.txChar.stopNotifications();
    } catch {
      // Link already gone
    }
  }

  private handleNotification(ev: Event): void {
    const v = (ev.target as { value?: DataView } | null)?.value;
    if (!v) return;
    this.handleText(new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
  }

  /** Feed received text. Public for tests. */
  handleText(text: string): void {
    this.rxBuffer += text;
    if (this.resolver && SHELL_PROMPTS.some((p) => this.rxBuffer.includes(p))) {
      const out = this.rxBuffer;
      this.rxBuffer = '';
      const resolve = this.resolver;
      this.resolver = null;
      resolve(out);
      return;
    }
    // Unsolicited output (logs, async prints) goes straight to the terminal
    if (!this.resolver) {
      this.onStream(text);
    }
  }

  /**
   * Send a command and collect output until the shell prompt returns.
   * Resolves with whatever arrived if the prompt never shows up in time.
   */
  sendCommand(cmd: string, timeoutMs = 3500): Promise<string> {
    const payload = new TextEncoder().encode(cmd.trim() + '\r\n');
    this.rxBuffer = '';

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const partial = this.rxBuffer;
        this.rxBuffer = '';
        this.resolver = null;
        resolve(partial);
      }, timeoutMs);

      this.resolver = (text) => {
        clearTimeout(timer);
        resolve(text);
      };

      (async () => {
        for (let i = 0; i < payload.length; i += WRITE_CHUNK) {
          await this.rxChar.writeValueWithoutResponse(payload.slice(i, i + WRITE_CHUNK));
        }
      })().catch((err) => {
        clearTimeout(timer);
        this.resolver = null;
        reject(err);
      });
    });
  }
}

/** Strip the echoed command and trailing prompt from a shell reply. */
export function cleanShellReply(reply: string, cmd: string): string {
  let out = reply.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  for (const p of SHELL_PROMPTS) out = out.split(p).join('');
  const lines = out.split(/\r?\n/);
  if (lines.length && lines[0].trim() === cmd.trim()) lines.shift();
  return lines.join('\n').trim();
}
