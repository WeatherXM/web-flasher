/**
 * Web Bluetooth AT Command client for WeatherXM WS2001 weather stations.
 * Communicates over the station's ISSC-style Transparent UART service (or Nordic UART Service (NUS)).
 */

// SenseCAP custom UART UUIDs (found in ws2001 firmware app_ble_nus.c with BLE_UUID_NUS_BASE 0x5354)
export const SENSECAP_UART_SERVICE_UUID = '49535354-fe7d-4ae5-8fa9-9fafd205e455';
export const SENSECAP_UART_RX_CHAR_UUID = '49535354-8841-43f4-a8d4-ecbe34729bb3'; // Central -> Station write
export const SENSECAP_UART_TX_CHAR_UUID = '49535354-1e4d-4bd9-ba61-23c647249616'; // Station -> Central notify

// Standard ISSC Transparent UART UUIDs (Microchip / ISSC base 0x5343)
export const ISSC_UART_SERVICE_UUID = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
export const ISSC_UART_RX_CHAR_UUID = '49535343-8841-43f4-a8d4-ecbe34729bb3';
export const ISSC_UART_TX_CHAR_UUID = '49535343-1e4d-4bd9-ba61-23c647249616';

// Standard Nordic UART Service (NUS)
export const NORDIC_NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NORDIC_NUS_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const NORDIC_NUS_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// Backwards-compatible aliases
export const NUS_SERVICE_UUID = SENSECAP_UART_SERVICE_UUID;
export const NUS_RX_CHAR_UUID = SENSECAP_UART_RX_CHAR_UUID;
export const NUS_TX_CHAR_UUID = SENSECAP_UART_TX_CHAR_UUID;

/**
 * List of candidate UART services to probe in priority order.
 */
export const CANDIDATE_UART_SERVICES = [
  SENSECAP_UART_SERVICE_UUID,
  ISSC_UART_SERVICE_UUID,
  NORDIC_NUS_SERVICE_UUID,
  '00005354-0000-1000-8000-00805f9b34fb',
  '00002886-0000-1000-8000-00805f9b34fb',
  '0000a886-0000-1000-8000-00805f9b34fb',
];

/**
 * Full list of optional services passed to navigator.bluetooth.requestDevice().
 * Web Bluetooth strictly requires any accessed GATT service to be declared in advance.
 */
export const ALL_OPTIONAL_SERVICES = [
  SENSECAP_UART_SERVICE_UUID,
  ISSC_UART_SERVICE_UUID,
  NORDIC_NUS_SERVICE_UUID,
  '00005354-0000-1000-8000-00805f9b34fb',
  '00002886-0000-1000-8000-00805f9b34fb',
  '0000a886-0000-1000-8000-00805f9b34fb',
  0x2886,
  0xa886,
  0x5354,
  '8ec90003-f315-4f60-9fb8-838830daea50', // Nordic Buttonless DFU
  '8ec90001-f315-4f60-9fb8-838830daea50', // Nordic Legacy DFU
  0xfe59,
];

/**
 * Filter list for WS2001 station discovery.
 * Matches standard production names ('WeatherXM WS2001 ...'), variants, and Seeed 16-bit UUIDs.
 */
export const WS2001_DEVICE_FILTERS: BluetoothLEScanFilter[] = [
  { namePrefix: 'WeatherXM' },
  { namePrefix: 'WS2001' },
  { namePrefix: 'WXM' },
  { services: [0x2886] },
  { services: [0xa886] },
];

const KNOWN_RX_UUIDS = [
  SENSECAP_UART_RX_CHAR_UUID.toLowerCase(),
  ISSC_UART_RX_CHAR_UUID.toLowerCase(),
  NORDIC_NUS_RX_CHAR_UUID.toLowerCase(),
];

const KNOWN_TX_UUIDS = [
  SENSECAP_UART_TX_CHAR_UUID.toLowerCase(),
  ISSC_UART_TX_CHAR_UUID.toLowerCase(),
  NORDIC_NUS_TX_CHAR_UUID.toLowerCase(),
];

export const REGION_NAMES: Record<number, string> = {
  1: 'AU915',
  5: 'EU868',
  6: 'KR920',
  7: 'IN865',
  8: 'US915',
  9: 'RU864',
  10: 'AS923 (Helium 1)',
  11: 'AS923 (Helium 2)',
  12: 'AS923 (Helium 3)',
  13: 'AS923 (Helium 4)',
  15: 'AS923-1 (Standard TTN/ChirpStack)',
};

export interface Ws2001DeviceConfig {
  deviceModel: string;
  deviceEui: string;
  formattedDevEui: string;
  defEui?: string;           // Factory immutable Default EUI
  formattedDefEui?: string;
  appEui: string;
  devCode?: string;          // Factory device code / serial
  devAddr?: string;          // LoRaWAN DevAddr
  version: string;           // Software firmware version
  hardwareVersion?: string;  // e.g. 'V2.0'
  lorawanVersion?: string;   // e.g. 'V1.0.3'
  classType?: string;        // e.g. 'A' or '0'
  joinType?: string;         // e.g. '1' (OTAA)
  battery: string;
  uploadInterval: number | null;
  frequencyBand: number | null;
  frequencyName: string;
  subBand: number | null;
  testModeType: number | null; // payload format: 0 = WeatherXM frames on FPort 99 (Open Edition frame on profile 1 from V4.9), 1 = legacy TLV (FPort 3)
  netProfile: NetProfileState | null; // null = firmware without network profiles (< V4.5)
  lorawanStatus: string | null; // AT+LW_MODEM_STATUS=?: JOINED, JOINING, MUTE, ...
  gnssSwitch: boolean | null; // AT+GPSSWITCH=?: GNSS scans on the customer network (V4.7+)
  rawConfig: string;
  bleName?: string;
  bleId?: string;
}

export type H2DeviceConfig = Ws2001DeviceConfig;

/** AT+NETPROFILE=? (firmware V4.5+): profile 0 = WeatherXM keys, profile 1 = customer network keys. */
export interface NetProfileState {
  active: number;
  weatherxmStored: boolean;
  customStored: boolean;
}

export const NET_PROFILE_WEATHERXM = 0;
export const NET_PROFILE_CUSTOM = 1;
export const DEFAULT_UPLOAD_INTERVAL_MIN = 5; // custom networks: keeps an SF7 uplink (20-byte Open Edition frame ~72 ms) within TTN's 30 s/day fair use
// The WeatherXM profile keeps its own 3-minute interval (per-profile in firmware V4.5+).
export const MAX_AT_COMMAND_BYTES = 60; // firmware BLE UART rx buffer limit including CRLF

/**
 * True only when the buffer contains a complete AT status line: `OK\r\n`, `ERROR\r\n` or `AT_<CODE>\r\n`.
 * The firmware's codes do not all end in ERROR (AT_SAVE_FAILED, AT_READ_FAILED, AT_NO_NETWORK_JOINED,
 * AT_DUTYCYCLE_RESTRICTED, AT_TEST_PARAM_OVERFLOW, AT_NO_CLASS_B_ENABLE), so any AT_ code terminates.
 */
export const AT_STATUS_LINE_RE = /(?:^|\r?\n)(?:OK|AT_[A-Z0-9_]+|ERROR)\r?\n/;
export const AT_ERROR_LINE_RE = /(?:^|\r?\n)(?:AT_[A-Z0-9_]+|ERROR)\r?\n/;
export function hasAtTerminator(buf: string): boolean {
  return /(?:^|\r\n)(?:OK|AT_[A-Z0-9_]+|ERROR)\r\n/.test(buf);
}

/** Parse `{active: 1, weatherxm: 'stored', custom: 'empty'}`; null if the command is unsupported. */
export function parseNetProfile(raw: string): NetProfileState | null {
  const m = raw.match(/active\s*:\s*([01])\b/i);
  if (!m || /AT_ERROR|AT_PARAM_ERROR/.test(raw)) return null;
  return {
    active: parseInt(m[1], 10),
    weatherxmStored: /weatherxm\s*:\s*'?stored/i.test(raw),
    customStored: /custom\s*:\s*'?stored/i.test(raw),
  };
}

export interface ConfigureOpenLoRaWanParams {
  band: number;
  subBand?: number; // 0..7 for US915/AU915 FSB (FSB 2 = channel group 1)
  joinEui: string;  // 16 hex chars (with or without colons)
  appKey: string;   // 32 hex chars (with or without colons)
  intervalMinutes: number; // 1..1440
  // Raw GNSS scans (0xF3 frames) on the customer network; firmware V4.7+ only, off by default
  gnss?: boolean;
}

export type Ws2001LogFn = (message: string, level?: 'INFO' | 'CMD' | 'RESP' | 'WARN' | 'ERROR') => void;

/**
 * Format raw hex into colon-separated uppercase hex bytes expected by ws2001 AT console.
 * Example: "0102030405060708" -> "01:02:03:04:05:06:07:08"
 */
/**
 * Mask LoRaWAN key material before it reaches the on-page log (key writes, AT+CONFIG key fields).
 * The station still receives the real values.
 */
export function redactAtLog(text: string): string {
  return text
    .replace(/(AT\+(?:APPKEY|NWKKEY|NWKSKEY|APPSKEY|DKEY)=)[0-9A-Fa-f:]+/g, '$1<hidden>')
    .replace(/((?:nwkSkey|appSkey|devKey|appKey|nwkKey)\s*:\s*)'?[0-9A-Fa-f:]+'?/g, "$1'<hidden>'")
    // Bare 16-byte keys, e.g. the reply to AT+APPKEY=? ('2B:7E:...:3C')
    .replace(/\b(?:[0-9A-Fa-f]{2}:){15}[0-9A-Fa-f]{2}\b/g, '<hidden>');
}

export function formatHexWithColons(hexStr: string, expectedBytes: number): string {
  const clean = hexStr.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (clean.length !== expectedBytes * 2) {
    throw new Error(
      `Invalid length for hex input. Expected ${expectedBytes * 2} hex characters (${expectedBytes} bytes), got ${clean.length}.`,
    );
  }
  const parts: string[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    parts.push(clean.slice(i, i + 2));
  }
  return parts.join(':');
}

/** AT+LW_MODEM_STATUS=? flags (LoRa Basics Modem status bits), one per line. */
export type LoRaWanState = 'joined' | 'joining' | 'idle' | 'unknown';
export interface LoRaWanStatus {
  state: LoRaWanState;
  flags: string[];
}

/** Parse AT+LW_MODEM_STATUS=?: JOINED / JOINING / MUTE / SUSPEND / ... ; no flag with OK = not joining. */
export function parseLoRaWanStatus(raw: string): LoRaWanStatus {
  const flags = Array.from(new Set(raw.match(/\b(BROWNOUT|CRASH|MUTE|JOINED|SUSPEND|UPLOAD|JOINING|STREAM)\b/g) ?? []));
  if (flags.includes('JOINED')) return { state: 'joined', flags };
  if (flags.includes('JOINING')) return { state: 'joining', flags };
  if (/(?:^|\r?\n)OK\r?\n/.test(raw) && !AT_ERROR_LINE_RE.test(raw)) return { state: 'idle', flags };
  return { state: 'unknown', flags };
}

/** Live sensor values from AT+MEA=? (null = sensor reported an error code). */
export interface StationMeasurements {
  temperature?: number | null;    // °C
  humidity?: number | null;       // %RH
  windSpeed?: number | null;      // m/s, 12 s average
  windDirection?: number | null;  // degrees
  windGust?: number | null;       // m/s
  light?: number | null;          // lux
  rainRate?: number | null;       // mm/h
  pressure?: number | null;       // hPa
  uvIndex?: number | null;
}

// AT+MEA=? keys follow the SenseCAP measurement-ID convention: value / 1000 = unit value
// (pressure: / 100000 for hPa). `mult` is what the firmware multiplied the raw sensor field by.
const MEA_FIELDS: Record<number, [keyof StationMeasurements, number]> = {
  4097: ['temperature', 100],
  4098: ['humidity', 1000],
  4105: ['windSpeed', 100],
  4104: ['windDirection', 1000],
  4191: ['windGust', 100],
  4099: ['light', 1000],
  4113: ['rainRate', 1],
  4101: ['pressure', 10000],
  4190: ['uvIndex', 100],
};
const MEA_SENTINELS = new Set([0x7ffd, 0x7ffe, 0x7fff, 0xffff, 0x7ffffffd, 0x7ffffffe, 0x7fffffff]);

/** Decode an AT+MEA=? response (same rules as tools/ws2001_dev_tui.py decode_mea); null if it holds no values. */
export function parseMeasurements(raw: string): StationMeasurements | null {
  const out: StationMeasurements = {};
  let found = false;
  for (const m of raw.matchAll(/(\d{4}):(-?\d+)/g)) {
    const key = parseInt(m[1], 10);
    const field = MEA_FIELDS[key];
    if (!field) continue;
    const [name, mult] = field;
    const v = parseInt(m[2], 10);
    const rawValue = Math.trunc(v / mult);
    found = true;
    if (
      MEA_SENTINELS.has(rawValue) ||
      [0xff0d, 0xff0e, 0xff0f].includes(rawValue & 0xffff) ||
      (key === 4101 && rawValue <= 0)
    ) {
      out[name] = null;
      continue;
    }
    const value = key === 4101 ? v / 100000 : v / 1000;
    out[name] = Math.round(value * 1000) / 1000;
  }
  return found ? out : null;
}

/**
 * Parse the JSON-like payload returned by AT+CONFIG=?
 */
export function parseAtConfig(raw: string): Partial<Ws2001DeviceConfig> {
  const result: Partial<Ws2001DeviceConfig> = { rawConfig: raw };

  // Match: {deviceModel: ..., deviceEui: ..., ...}
  const extractField = (key: string): string | null => {
    // Looks for "key: value," or "key: value}"
    const regex = new RegExp(`['"]?${key}['"]?\\s*:\\s*([^,}]+)`, 'i');
    const match = raw.match(regex);
    if (!match) return null;
    return match[1].replace(/['"]/g, '').trim();
  };

  const devEui = extractField('deviceEui');
  if (devEui) {
    result.formattedDevEui = devEui.toUpperCase();
    result.deviceEui = devEui.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  }

  const defEui = extractField('defEui');
  if (defEui) {
    result.formattedDefEui = defEui.toUpperCase();
    result.defEui = defEui.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  }

  const devCode = extractField('devCode');
  if (devCode) result.devCode = devCode;

  const devAddr = extractField('devAddr');
  if (devAddr) result.devAddr = devAddr;

  const classType = extractField('classType');
  if (classType) result.classType = classType;

  const joinType = extractField('joinType');
  if (joinType) result.joinType = joinType;

  const model = extractField('deviceModel');
  if (model) result.deviceModel = model;

  const appEui = extractField('appEui');
  if (appEui) result.appEui = appEui.replace(/[^0-9a-fA-F]/g, '').toUpperCase();

  // Extract software/firmware version cleanly:
  // Station firmware returns nested version object: version: {Software: 'V3.13', Hardware: 'V2.0', LoRaWAN: 'V1.0.3',}
  const hwMatch = raw.match(/Hardware\s*:\s*['"]?([^,'"}]+)['"]?/i);
  if (hwMatch) {
    result.hardwareVersion = hwMatch[1].trim();
  }

  const loraMatch = raw.match(/LoRaWAN\s*:\s*['"]?([^,'"}]+)['"]?/i);
  if (loraMatch) {
    result.lorawanVersion = loraMatch[1].trim();
  }

  const swMatch = raw.match(/Software\s*:\s*['"]?([^,'"}]+)['"]?/i);
  if (swMatch) {
    result.version = swMatch[1].trim();
  } else {
    const rawVer = extractField('version');
    if (rawVer) {
      result.version = rawVer.replace(/[{}]/g, '').replace(/^Software\s*:\s*/i, '').trim();
    }
  }

  const bat = extractField('electricity');
  if (bat) {
    const num = parseInt(bat, 10);
    if (!isNaN(num) && !bat.includes('V') && !bat.includes('%')) {
      result.battery = `${num}%`;
    } else {
      result.battery = bat;
    }
  }

  const interval = extractField('collectInterval');
  if (interval) result.uploadInterval = parseInt(interval, 10);

  const freq = extractField('frequency');
  if (freq) {
    const bandNum = parseInt(freq, 10);
    result.frequencyBand = bandNum;
    result.frequencyName = REGION_NAMES[bandNum] || `Region #${bandNum}`;
  }

  const subBand = extractField('subBand');
  if (subBand) result.subBand = parseInt(subBand, 10);

  return result;
}

// A host without a bond pairs on its first encrypted access (the station also sends a Security
// Request right after connecting). While the OS pairs, GATT calls stall; the SMP pairing timeout
// is 30 s. Giving up sooner disconnects mid-pairing, which is why the first attempt used to fail
// and only the second one worked. Wait just past that timeout.
const GATT_STEP_TIMEOUT_MS = 35000;
const PAIRING_WAIT_MS = 35000;

/**
 * Web Bluetooth GATT calls can wait forever when the OS is stuck mid-pairing (seen on Windows);
 * bound every step so the page reports an error instead of hanging on "Discovering...".
 */
class GattTimeoutError extends Error {
  name = 'GattTimeoutError';
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new GattTimeoutError(`${what} timed out after ${ms / 1000}s. Disconnect, wait a few seconds and connect again ` +
        '(if Windows shows a pairing prompt, accept it).')),
      ms,
    );
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Shown when the station's services do not arrive quickly: the computer is usually pairing. */
export const DISCOVERY_SLOW_HINT =
  'Still waiting for the station. If your computer shows a pairing request, accept it. ' +
  'Otherwise click Cancel, press the station\'s RESET button once (do not hold it), wait 10 seconds and connect again.';

/** Thrown when service discovery stalls for the whole wait (pairing stuck or an old pairing on the computer). */
export const DISCOVERY_STALLED_MESSAGE =
  'The station did not answer within 35 seconds. The computer is probably still pairing or holds an old pairing. ' +
  'Press the station\'s RESET button once (do not hold it), wait 10 seconds and connect again within 5 minutes. ' +
  'If it keeps happening, remove the station from your computer\'s Bluetooth settings and connect again.';

export class Ws2001AtClient {
  private device: BluetoothDevice | null = null;
  /** The station picked in the chooser; kept across its restarts so reconnect() needs no new chooser. */
  private lastDevice: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private rxChar: BluetoothRemoteGATTCharacteristic | null = null;
  private txChar: BluetoothRemoteGATTCharacteristic | null = null;

  private rxBuffer = '';
  private pendingResolver: ((text: string) => void) | null = null;
  private pendingRejecter: ((err: Error) => void) | null = null;
  private commandChain: Promise<unknown> = Promise.resolve();
  private commandInFlight = false;

  private readonly onNotificationBound = (ev: Event) => this.handleNotification(ev);
  private readonly onDisconnectedBound = () => {
    this.log('Bluetooth disconnected. Station reboots automatically and will send a fresh LoRaWAN Join-Request.', 'INFO');
    this.cleanup();
  };

  /** Called with a hint while service discovery is slow, and with null once it ends. */
  onHint: ((text: string | null) => void) | null = null;
  /** Service discovery: hint after this many ms, give up after one wait of this many ms. */
  discoveryHintMs = 8000;
  discoveryTimeoutMs = GATT_STEP_TIMEOUT_MS;

  constructor(private readonly log: Ws2001LogFn = () => {}) {}

  /** The bonded GATT link (used for buttonless DFU entry, which must run on the same encrypted connection). */
  get gattServer(): BluetoothRemoteGATTServer | null {
    return this.server?.connected ? this.server : null;
  }

  get isConnected(): boolean {
    return Boolean(this.server?.connected && this.rxChar && this.txChar);
  }

  get deviceName(): string {
    return this.device?.name || 'WeatherXM WS2001 Station';
  }

  /**
   * Request Bluetooth device and establish UART/NUS connection.
   */
  async connect(): Promise<void> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not supported in this browser. Please use Google Chrome or Microsoft Edge.');
    }

    this.log('Requesting Bluetooth device (WeatherXM WS2001)...', 'INFO');

    this.device = await navigator.bluetooth.requestDevice({
      filters: WS2001_DEVICE_FILTERS,
      optionalServices: ALL_OPTIONAL_SERVICES,
    });
    this.lastDevice = this.device;
    await this.attachGatt();
  }

  /**
   * Reconnect to the same station after it restarted (e.g. after ATZ), without the Bluetooth chooser:
   * the browser already has permission for this device and the link is bonded. Retries until the
   * station advertises again or `timeoutMs` passes.
   */
  async reconnect(opts: { timeoutMs?: number; retryDelayMs?: number; onAttempt?: (attempt: number) => void } = {}): Promise<void> {
    const device = this.lastDevice;
    if (!device?.gatt) throw new Error('No station to reconnect to. Connect to it again.');
    const deadline = Date.now() + (opts.timeoutMs ?? 60000);
    for (let attempt = 1; ; attempt++) {
      opts.onAttempt?.(attempt);
      try {
        this.device = device;
        await this.attachGatt();
        return;
      } catch (e) {
        try { device.gatt.disconnect(); } catch { /* ignore */ }
        this.cleanup();
        if (Date.now() >= deadline) {
          throw new Error(`Could not reconnect to the station: ${(e as Error).message}`);
        }
        await new Promise((res) => setTimeout(res, opts.retryDelayMs ?? 2000));
      }
    }
  }

  /** Open the GATT link to `this.device`, find the UART service and subscribe to its notifications. */
  private async attachGatt(): Promise<void> {
    const device = this.device;
    if (!device?.gatt) throw new Error('No Bluetooth device selected.');
    this.rxChar = null;
    this.txChar = null;
    device.addEventListener('gattserverdisconnected', this.onDisconnectedBound);

    this.log(`Connecting to ${device.name || 'Station'}...`, 'INFO');
    this.server = await withTimeout(device.gatt.connect(), 20000, 'Bluetooth connection');

    this.log('Discovering UART Service...', 'INFO');
    let service: BluetoothRemoteGATTService | null = null;
    const server = this.server;
    const hintTimer = setTimeout(() => {
      this.log(DISCOVERY_SLOW_HINT, 'WARN');
      this.onHint?.(DISCOVERY_SLOW_HINT);
    }, this.discoveryHintMs);
    try {
      // A missing service is rejected at once; a stall means pairing is stuck, and waiting again for
      // every other candidate would only multiply the wait. So one stalled wait ends the attempt.
      for (const serviceUuid of CANDIDATE_UART_SERVICES) {
        try {
          service = await withTimeout(server.getPrimaryService(serviceUuid), this.discoveryTimeoutMs, 'UART service discovery');
          if (service) {
            this.log(`Found UART Service: ${service.uuid}`, 'INFO');
            break;
          }
        } catch (e) {
          if (e instanceof GattTimeoutError) throw new Error(DISCOVERY_STALLED_MESSAGE);
          // not present on this station: try the next candidate
        }
      }

      if (!service) {
        try {
          const services = await withTimeout(server.getPrimaryServices(), this.discoveryTimeoutMs, 'GATT service discovery');
          const availableUuids = services.map((s) => s.uuid);
          this.log(`Available GATT services: [${availableUuids.join(', ')}]`, 'INFO');

          for (const s of services) {
            if (CANDIDATE_UART_SERVICES.some((c) => c.toLowerCase() === s.uuid.toLowerCase())) {
              service = s;
              this.log(`Selected service from available list: ${s.uuid}`, 'INFO');
              break;
            }
          }

          if (!service && services.length > 0) {
            const customService = services.find((s) => s.uuid.length > 8 && !s.uuid.startsWith('000018'));
            if (customService) {
              service = customService;
              this.log(`Probing custom vendor service: ${service.uuid}`, 'WARN');
            }
          }
        } catch (e) {
          if (e instanceof GattTimeoutError) throw new Error(DISCOVERY_STALLED_MESSAGE);
          this.log(`Could not inspect all primary services: ${(e as Error).message}`, 'WARN');
        }
      }
    } finally {
      clearTimeout(hintTimer);
      this.onHint?.(null);
    }

    if (!service) {
      throw new Error(
        `No supported UART Service found on device. Probed candidate UUIDs: ${CANDIDATE_UART_SERVICES.join(', ')}`,
      );
    }

    this.log('Discovering characteristics...', 'INFO');
    const chars = await withTimeout(service.getCharacteristics(), GATT_STEP_TIMEOUT_MS, 'characteristic discovery');
    this.log(`Discovered ${chars.length} characteristic(s) in service.`, 'INFO');

    for (const c of chars) {
      const uuid = c.uuid.toLowerCase();
      const isNotify = Boolean(c.properties.notify);
      const isWrite = Boolean(c.properties.write || c.properties.writeWithoutResponse);
      this.log(` - Characteristic ${c.uuid} (notify=${isNotify}, write=${isWrite})`, 'INFO');

      // Identify TX (station notify -> browser)
      if (
        KNOWN_TX_UUIDS.includes(uuid) ||
        (isNotify && !this.txChar)
      ) {
        this.txChar = c;
      }

      // Identify RX (browser write -> station)
      if (
        KNOWN_RX_UUIDS.includes(uuid) ||
        (isWrite && !this.rxChar)
      ) {
        this.rxChar = c;
      }
    }

    if (!this.rxChar || !this.txChar) {
      throw new Error(
        `Failed to locate both RX and TX characteristics on service ${service.uuid}. ` +
        `Found RX (write): ${Boolean(this.rxChar)}, TX (notify): ${Boolean(this.txChar)}`,
      );
    }

    this.txChar.addEventListener('characteristicvaluechanged', this.onNotificationBound);
    await this.startNotificationsWhenPaired(this.txChar);

    this.log('Connected and subscribed to notifications.', 'INFO');
  }

  /**
   * Enable TX notifications. The CCCD needs an encrypted link, so on a host that is not bonded
   * yet this is the step that pairs; the first write can fail while the OS is still pairing (or
   * waiting for the user to accept a pairing prompt). Retry on the same connection until the
   * link is encrypted instead of disconnecting, which would abort the pairing.
   */
  private async startNotificationsWhenPaired(char: BluetoothRemoteGATTCharacteristic): Promise<void> {
    const deadline = Date.now() + PAIRING_WAIT_MS;
    let hinted = false;
    for (;;) {
      try {
        await withTimeout(char.startNotifications(), PAIRING_WAIT_MS, 'Bluetooth pairing');
        if (hinted) this.log('Bluetooth pairing complete.', 'INFO');
        return;
      } catch (e) {
        if (!this.server?.connected || Date.now() >= deadline) throw e;
        if (!hinted) {
          this.log('Waiting for Bluetooth pairing... If your computer shows a pairing prompt, accept it. ' +
            'Keep this page open.', 'WARN');
          hinted = true;
        }
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
  }

  /**
   * Disconnect and release Bluetooth resources.
   */
  async disconnect(): Promise<void> {
    if (this.txChar) {
      try {
        this.txChar.removeEventListener('characteristicvaluechanged', this.onNotificationBound);
        // On a link that is already dying this can wait forever; the disconnect below releases it anyway
        if (this.server?.connected) await withTimeout(this.txChar.stopNotifications(), 2000, 'Stopping notifications');
      } catch {
        // ignore
      }
    }
    if (this.server?.connected) {
      this.server.disconnect();
    } else {
      // Also drops a link that is still being set up (connect cancelled mid-way)
      try { this.device?.gatt?.disconnect(); } catch { /* ignore */ }
    }
    this.cleanup();
    this.lastDevice = null;
    this.log('Disconnected.', 'INFO');
  }

  /**
   * Detach UART listeners before handing the GATT link over to buttonless DFU entry, so the expected
   * reboot into the bootloader does not log a spurious application disconnect message.
   */
  detachForBootloader(): void {
    try {
      this.txChar?.removeEventListener('characteristicvaluechanged', this.onNotificationBound);
    } catch {
      // ignore
    }
    try {
      this.device?.removeEventListener('gattserverdisconnected', this.onDisconnectedBound);
    } catch {
      // ignore
    }
  }

  private cleanup(): void {
    try {
      this.device?.removeEventListener('gattserverdisconnected', this.onDisconnectedBound);
    } catch {
      // ignore
    }
    if (this.pendingRejecter) {
      this.pendingRejecter(new Error('Device disconnected during command execution'));
    }
    this.pendingResolver = null;
    this.pendingRejecter = null;
    this.rxBuffer = '';
    this.server = null;
    this.rxChar = null;
    this.txChar = null;
    this.device = null;
  }

  private handleNotification(ev: Event): void {
    const char = ev.target as BluetoothRemoteGATTCharacteristic;
    if (!char.value) return;

    const chunk = new TextDecoder().decode(char.value);
    this.rxBuffer += chunk;

    // Check for complete AT termination line: "\r\nOK\r\n" or "\r\nAT_..._ERROR\r\n"
    if (hasAtTerminator(this.rxBuffer)) {
      if (this.pendingResolver) {
        const full = this.rxBuffer;
        this.rxBuffer = '';
        const resolve = this.pendingResolver;
        this.pendingResolver = null;
        this.pendingRejecter = null;
        resolve(full);
      }
    }
  }

  /**
   * Send an AT command and await response from station.
   * Commands are serialized over the single BLE UART characteristic and bounded to 60 bytes including CRLF.
   */
  async sendCommand(cmd: string, timeoutMs = 5000): Promise<string> {
    if (!this.commandInFlight) {
      this.commandInFlight = true;
      const p = this.sendCommandInternal(cmd, timeoutMs).finally(() => {
        this.commandInFlight = false;
      });
      this.commandChain = p.then(() => undefined, () => undefined);
      return p;
    }
    const next = this.commandChain.then(
      () => {
        this.commandInFlight = true;
        return this.sendCommandInternal(cmd, timeoutMs).finally(() => {
          this.commandInFlight = false;
        });
      },
      () => {
        this.commandInFlight = true;
        return this.sendCommandInternal(cmd, timeoutMs).finally(() => {
          this.commandInFlight = false;
        });
      },
    );
    this.commandChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async sendCommandInternal(cmd: string, timeoutMs = 5000): Promise<string> {
    if (!this.isConnected || !this.rxChar) {
      throw new Error('Station is not connected over Bluetooth.');
    }

    const rxChar = this.rxChar;
    const trimmed = cmd.trim();
    const commandPayload = trimmed + '\r\n';
    const bytes = new TextEncoder().encode(commandPayload);
    if (bytes.length > MAX_AT_COMMAND_BYTES) {
      throw new Error(`AT command is ${bytes.length} bytes; station buffer allows at most ${MAX_AT_COMMAND_BYTES} bytes.`);
    }
    this.log(`> ${redactAtLog(trimmed)}`, 'CMD');

    this.rxBuffer = '';

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const hadPartial = this.rxBuffer.trim().length > 0;
        this.rxBuffer = '';
        this.pendingResolver = null;
        this.pendingRejecter = null;
        reject(
          new Error(
            hadPartial
              ? `Incomplete response before ${timeoutMs}ms timeout: "${redactAtLog(trimmed)}"`
              : `Command timed out after ${timeoutMs}ms: "${redactAtLog(trimmed)}"`
          )
        );
      }, timeoutMs);

      this.pendingResolver = (res: string) => {
        clearTimeout(timer);
        this.log(`< ${redactAtLog(res.trim().replace(/\r?\n/g, ' '))}`, 'RESP');
        resolve(res);
      };

      this.pendingRejecter = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };

      const writePromise = rxChar.properties.writeWithoutResponse
        ? rxChar.writeValueWithoutResponse(bytes)
        : rxChar.writeValueWithResponse(bytes);

      writePromise.catch((err) => {
        clearTimeout(timer);
        this.pendingResolver = null;
        this.pendingRejecter = null;
        reject(err);
      });
    });
  }

  /**
   * Read device full configuration and current mode.
   */
  async readFullConfig(): Promise<Ws2001DeviceConfig> {
    this.log('Reading device configuration (AT+CONFIG=?)...', 'INFO');
    const configResp = await this.sendCommand('AT+CONFIG=?');
    const parsed = parseAtConfig(configResp);

    // Allow Nordic BLE buffer to settle after large AT+CONFIG=? JSON response
    await new Promise((resolve) => setTimeout(resolve, 300));

    this.log('Reading testmode status (AT+TESTMODE_TYPE=?)...', 'INFO');
    let testMode: number | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const modeResp = await this.sendCommand('AT+TESTMODE_TYPE=?', 3000);
        const match = modeResp.match(/^\s*([01])\s*(?:\r?\n|$)/m);
        if (match) {
          testMode = parseInt(match[1], 10);
          break;
        }
      } catch (e) {
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        } else {
          this.log(`Could not read testmode type: ${(e as Error).message}`, 'WARN');
        }
      }
    }

    let netProfile: NetProfileState | null = null;
    let netProfileExplicitUnsupported = false;
    this.log('Reading network profile (AT+NETPROFILE=?)...', 'INFO');
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const rawProfile = await this.sendCommand('AT+NETPROFILE=?', 3000);
        if (/AT_ERROR|AT_PARAM_ERROR/.test(rawProfile)) {
          netProfileExplicitUnsupported = true;
          this.log('Firmware has no network profiles (< V4.5): switching would overwrite the WeatherXM keys.', 'WARN');
          break;
        }
        netProfile = parseNetProfile(rawProfile);
        if (netProfile) break;
      } catch (e) {
        if (attempt >= 2) {
          this.log(`Could not read network profile: ${(e as Error).message}`, 'WARN');
        }
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    const verMatch = (parsed.version ?? '').match(/(\d+)\.(\d+)/);
    const supportsProfilesByVersion = verMatch
      ? parseInt(verMatch[1], 10) > 4 || (parseInt(verMatch[1], 10) === 4 && parseInt(verMatch[2], 10) >= 5)
      : false;
    if (!netProfile && !netProfileExplicitUnsupported && supportsProfilesByVersion) {
      throw new Error('Could not read network profile state from station (AT+NETPROFILE=?); please reconnect and try again.');
    }

    let lorawanStatus: string | null = null;
    try {
      const st = await this.sendCommand('AT+LW_MODEM_STATUS=?', 3000);
      lorawanStatus = (st.match(/\b(JOINED|JOINING|MUTE|SUSPEND|STREAM|UPLOAD|ALC_SYNC|FILE)\b/) ?? [null])[0];
    } catch {
      // optional
    }

    let gnssSwitch: boolean | null = null;
    try {
      const g = await this.sendCommand('AT+GPSSWITCH=?', 3000);
      const m = g.match(/^\s*([01])\b/m);
      if (m) gnssSwitch = m[1] === '1';
    } catch {
      // optional
    }

    return {
      deviceModel: parsed.deviceModel || 'Unknown',
      deviceEui: parsed.deviceEui || 'Unknown',
      formattedDevEui: parsed.formattedDevEui || parsed.deviceEui || 'Unknown',
      defEui: parsed.defEui,
      formattedDefEui: parsed.formattedDefEui,
      appEui: parsed.appEui || '',
      devCode: parsed.devCode,
      devAddr: parsed.devAddr,
      version: parsed.version || 'Unknown',
      hardwareVersion: parsed.hardwareVersion,
      lorawanVersion: parsed.lorawanVersion,
      classType: parsed.classType,
      joinType: parsed.joinType,
      battery: parsed.battery || 'Unknown',
      uploadInterval: parsed.uploadInterval ?? null,
      frequencyBand: parsed.frequencyBand ?? null,
      frequencyName: parsed.frequencyName ?? 'Unknown',
      subBand: parsed.subBand ?? null,
      testModeType: testMode,
      netProfile,
      lorawanStatus,
      gnssSwitch,
      rawConfig: configResp,
      bleName: this.deviceName,
      bleId: this.device?.id,
    };
  }

  /** LoRaWAN join state (AT+LW_MODEM_STATUS=?). Cheap; also keeps the Bluetooth session alive. */
  async readLoRaWanStatus(): Promise<LoRaWanStatus> {
    return parseLoRaWanStatus(await this.sendCommand('AT+LW_MODEM_STATUS=?', 3000));
  }

  /** Live sensor readings (AT+MEA=?, a fresh sensor read on the station: poll it sparingly). */
  async readMeasurements(): Promise<StationMeasurements | null> {
    return parseMeasurements(await this.sendCommand('AT+MEA=?', 5000));
  }

  /**
   * JoinEUI of the active network profile (AT+APPEUI=?). The station never reveals its AppKey:
   * AT+APPKEY=? is disabled in the firmware's command table, and AT+CONFIG=? leaves it out.
   */
  async readActiveJoinEui(): Promise<string> {
    const resp = await this.sendCommand('AT+APPEUI=?', 3000);
    const joinEui = (resp.match(/(?:[0-9A-Fa-f]{2}:){7}[0-9A-Fa-f]{2}/) ?? [''])[0].replace(/:/g, '').toUpperCase();
    if (joinEui.length !== 16) throw new Error('Could not read the JoinEUI from the station.');
    return joinEui;
  }

  /** Restart the station (ATZ) so it sends a fresh Join-Request; resolves once the link dropped. */
  async restartStation(): Promise<void> {
    await this.rebootToJoin();
  }

  private async expectOk(cmd: string, what: string, timeoutMs?: number): Promise<string> {
    const resp = await this.sendCommand(cmd, timeoutMs);
    if (AT_ERROR_LINE_RE.test(resp) || !/(?:^|\r?\n)OK\r?\n/.test(resp)) {
      throw new Error(`Failed to ${what}: ${redactAtLog(resp.trim())}`);
    }
    return resp;
  }

  private async setPayloadFormatWeatherXm(): Promise<void> {
    // FPort 99 weather frames: the 24-byte WeatherXM frame (signed, 1 Helium DC per uplink) on profile 0, the
    // Open Edition frame on profile 1 (V4.9+: 16 bytes, 20 bytes from V5.1); both with gust and rain total
    await this.expectOk('AT+TESTMODE_TYPE=0', 'select the WeatherXM payload format');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const verify = await this.sendCommand('AT+TESTMODE_TYPE=?');
    const m = verify.match(/^\s*([01])\s*(?:\r?\n|$)/m);
    if (!m || m[1] !== '0') {
      throw new Error(`Station did not keep the WeatherXM payload format (status: ${redactAtLog(verify.trim())})`);
    }
  }

  /** How long to wait for the Bluetooth link to drop after an unanswered ATZ (BLE supervision timeout is 4 s). */
  rebootConfirmTimeoutMs = 6000;

  private async rebootToJoin(): Promise<void> {
    // Allow Nordic FDS flash operations to finalize before rebooting
    await new Promise((resolve) => setTimeout(resolve, 1500));
    this.log('Rebooting station to apply settings and send a LoRaWAN Join-Request (ATZ)...', 'INFO');
    let answeredOk = false;
    try {
      const resp = await this.sendCommand('ATZ', 2000);
      if (AT_ERROR_LINE_RE.test(resp)) {
        throw new Error(`Station rejected reboot command (ATZ): ${redactAtLog(resp.trim())}`);
      }
      answeredOk = true;
    } catch (err) {
      const msg = (err as Error).message || '';
      if (/rejected reboot command/.test(msg)) throw err;
      if (/disconnected|GATT Server is disconnected/i.test(msg)) return; // link already dropped: it reset
      // The firmware prints OK and resets 100 ms later; with a 100-200 ms connection interval the OK is
      // often never transmitted, so a timeout here is the normal outcome, not a failure.
    }
    // Either way the station is resetting, but the browser keeps the link until the 4 s supervision
    // timeout. Wait for the drop so a reconnect never reuses the dying link.
    const deadline = Date.now() + this.rebootConfirmTimeoutMs;
    while (this.server?.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (this.server?.connected) {
      if (!answeredOk) {
        throw new Error('Station did not reboot after ATZ (Bluetooth link still up). Settings were saved; reconnect and retry the reboot.');
      }
      // It confirmed the reset; release the stale link (a disconnect restarts the station anyway).
      try { this.server.disconnect(); } catch { /* ignore */ }
      this.cleanup();
    }
    this.log('Station reset confirmed: Bluetooth link dropped after ATZ.', 'INFO');
  }

  /**
   * Point the station at the customer's network server.
   * Firmware V4.5+: keys go into network profile 1; the WeatherXM keys (profile 0) are kept.
   * Older firmware: the single key set is overwritten (allowOverwrite must be true).
   * The payload stays on FPort 99 (AT+TESTMODE_TYPE=0): the Open Edition frame on V4.9+, the 24-byte frame before.
   */
  async configureOpenLoRaWan(
    params: ConfigureOpenLoRaWanParams,
    onProgress?: (step: string, current: number, total: number) => void,
    options: { useProfiles: boolean; allowOverwrite?: boolean } = { useProfiles: true },
  ): Promise<void> {
    if (!options.useProfiles && !options.allowOverwrite) {
      throw new Error('This firmware cannot keep the WeatherXM keys; update the station to V4.5 or confirm overwriting.');
    }
    const totalSteps = 9;
    let step = 1;

    if (options.useProfiles) {
      onProgress?.('Selecting the custom network profile (WeatherXM keys are kept)...', step++, totalSteps);
      await this.expectOk(`AT+NETPROFILE=${NET_PROFILE_CUSTOM}`, 'select the custom network profile');
    } else {
      step++;
    }

    onProgress?.(`Setting frequency band to ${REGION_NAMES[params.band] || params.band}...`, step++, totalSteps);
    await this.expectOk(`AT+BAND=${params.band}`, 'set the frequency band');

    if (params.band === 8 || params.band === 1) {
      const sub = params.subBand ?? 1; // FSB 2 (ChannelGroup = 1)
      onProgress?.(`Setting sub-band / channel group to ${sub}...`, step++, totalSteps);
      await this.expectOk(`AT+CHANNEL=${sub}`, 'set the channel sub-band');
    } else {
      step++;
    }

    const formattedJoinEui = formatHexWithColons(params.joinEui, 8);
    onProgress?.(`Setting JoinEUI (${formattedJoinEui})...`, step++, totalSteps);
    await this.expectOk(`AT+APPEUI=${formattedJoinEui}`, 'set the JoinEUI');

    const formattedAppKey = formatHexWithColons(params.appKey, 16);
    onProgress?.('Setting AppKey...', step++, totalSteps);
    await this.expectOk(`AT+APPKEY=${formattedAppKey}`, 'set the AppKey');

    if (!Number.isFinite(params.intervalMinutes)) {
      throw new Error('Upload interval must be a number between 1 and 1440 minutes.');
    }
    const interval = Math.max(1, Math.min(Math.round(params.intervalMinutes), 1440));
    onProgress?.(`Setting upload interval to ${interval} minutes...`, step++, totalSteps);
    await this.expectOk(`AT+INTERVAL=${interval}`, 'set the upload interval');

    // Before V4.7 this switch also turned on the LoRa Cloud services on FPort 199, so only V4.7+
    // stations get gnss = true from the page; everything else is switched off.
    onProgress?.(params.gnss ? 'Enabling GNSS location scans...' : 'GNSS location scans off...', step++, totalSteps);
    if (params.gnss) {
      await this.expectOk('AT+GPSSWITCH=1', 'set the GNSS switch');
    } else {
      const gpsResp = await this.sendCommand('AT+GPSSWITCH=0');
      if (!gpsResp.includes('OK') && !/AT_ERROR|AT_PARAM_ERROR/.test(gpsResp)) {
        throw new Error(`Failed to set the GNSS switch: ${gpsResp.trim()}`);
      }
    }

    onProgress?.('Keeping the FPort 99 weather payload...', step++, totalSteps);
    await this.setPayloadFormatWeatherXm();

    if (options.useProfiles) {
      const verified = parseNetProfile(await this.sendCommand('AT+NETPROFILE=?'));
      if (!verified || verified.active !== NET_PROFILE_CUSTOM || !verified.customStored) {
        throw new Error('Station did not confirm custom network profile activation; aborting before reboot.');
      }
    }

    onProgress?.('Committing settings and rebooting...', step, totalSteps);
    await this.rebootToJoin();
    this.log('Configuration completed. The station is rebooting to join your network server.', 'INFO');
  }

  /**
   * Firmware V4.5+: reactivate the WeatherXM keys (profile 0). The customer profile stays stored.
   * Each profile keeps its own upload interval, so the WeatherXM 3-minute rate comes back with it.
   */
  async switchBackToWeatherXm(onProgress?: (step: string, current: number, total: number) => void): Promise<void> {
    onProgress?.('Selecting the WeatherXM (Helium) network profile...', 1, 3);
    await this.expectOk(`AT+NETPROFILE=${NET_PROFILE_WEATHERXM}`, 'select the WeatherXM network profile');
    onProgress?.('Selecting the WeatherXM payload format...', 2, 3);
    await this.setPayloadFormatWeatherXm();
    const verified = parseNetProfile(await this.sendCommand('AT+NETPROFILE=?'));
    if (!verified || verified.active !== NET_PROFILE_WEATHERXM || !verified.weatherxmStored) {
      throw new Error('Station did not confirm WeatherXM network profile activation; aborting before reboot.');
    }
    onProgress?.('Rebooting to rejoin the WeatherXM (Helium) network...', 3, 3);
    await this.rebootToJoin();
    this.log('Switched back to WeatherXM (Helium). The station is rebooting to rejoin.', 'INFO');
  }

  /**
   * Firmware V4.5+: reactivate a previously stored Open LoRaWAN profile (profile 1) without
   * re-entering JoinEUI / AppKey / interval. WeatherXM (Helium) keys stay stored in profile 0.
   */
  async switchToStoredOpenLoRaWan(onProgress?: (step: string, current: number, total: number) => void): Promise<void> {
    onProgress?.('Selecting the stored Open LoRaWAN network profile...', 1, 3);
    await this.expectOk(`AT+NETPROFILE=${NET_PROFILE_CUSTOM}`, 'select the custom network profile');
    onProgress?.('Selecting the FPort 99 weather payload...', 2, 3);
    await this.setPayloadFormatWeatherXm();
    const verified = parseNetProfile(await this.sendCommand('AT+NETPROFILE=?'));
    if (!verified || verified.active !== NET_PROFILE_CUSTOM || !verified.customStored) {
      throw new Error('Station did not confirm custom network profile activation; aborting before reboot.');
    }
    onProgress?.('Rebooting to join your Open LoRaWAN network...', 3, 3);
    await this.rebootToJoin();
    this.log('Switched to stored Open LoRaWAN profile. The station is rebooting to join.', 'INFO');
  }
}

export const H2AtClient = Ws2001AtClient;
