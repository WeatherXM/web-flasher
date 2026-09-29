/**
 * Web Bluetooth AT Command client for WeatherXM WS2001 weather stations.
 * Communicates over the SenseCAP / ISSC Transparent UART or Nordic UART Service (NUS).
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
  appEui: string;
  version: string;
  battery: string;
  uploadInterval: number;
  frequencyBand: number;
  frequencyName: string;
  subBand: number;
  testModeType: number; // 0 = WeatherXM, 1 = Open LoRaWAN
  rawConfig: string;
}

export type H2DeviceConfig = Ws2001DeviceConfig;

export interface ConfigureOpenLoRaWanParams {
  band: number;
  subBand?: number; // 0..7 for US915/AU915 FSB (FSB 2 = channel group 1)
  joinEui: string;  // 16 hex chars (with or without colons)
  appKey: string;   // 32 hex chars (with or without colons)
  intervalMinutes: number; // 1..1440
}

export type Ws2001LogFn = (message: string, level?: 'INFO' | 'CMD' | 'RESP' | 'WARN' | 'ERROR') => void;

/**
 * Format raw hex into colon-separated uppercase hex bytes expected by ws2001 AT console.
 * Example: "0102030405060708" -> "01:02:03:04:05:06:07:08"
 */
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

  const model = extractField('deviceModel');
  if (model) result.deviceModel = model;

  const appEui = extractField('appEui');
  if (appEui) result.appEui = appEui.replace(/[^0-9a-fA-F]/g, '').toUpperCase();

  // Extract software/firmware version cleanly:
  // Station firmware returns nested version object: version: {Software: 'V3.13', Hardware: 'V2.0', LoRaWAN: 'V1.0.3',}
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

export class Ws2001AtClient {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private rxChar: BluetoothRemoteGATTCharacteristic | null = null;
  private txChar: BluetoothRemoteGATTCharacteristic | null = null;

  private rxBuffer = '';
  private pendingResolver: ((text: string) => void) | null = null;
  private pendingRejecter: ((err: Error) => void) | null = null;

  private readonly onNotificationBound = (ev: Event) => this.handleNotification(ev);

  constructor(private readonly log: Ws2001LogFn = () => {}) {}

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

    this.device.addEventListener('gattserverdisconnected', () => {
      this.log('Bluetooth device disconnected.', 'WARN');
      this.cleanup();
    });

    this.log(`Connecting to ${this.device.name || 'Station'}...`, 'INFO');
    this.server = await this.device.gatt!.connect();

    this.log('Discovering UART Service...', 'INFO');
    let service: BluetoothRemoteGATTService | null = null;

    for (const serviceUuid of CANDIDATE_UART_SERVICES) {
      try {
        service = await this.server.getPrimaryService(serviceUuid);
        if (service) {
          this.log(`Found UART Service: ${service.uuid}`, 'INFO');
          break;
        }
      } catch {
        // try next candidate
      }
    }

    if (!service) {
      try {
        const services = await this.server.getPrimaryServices();
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
        this.log(`Could not inspect all primary services: ${(e as Error).message}`, 'WARN');
      }
    }

    if (!service) {
      throw new Error(
        `No supported UART Service found on device. Probed candidate UUIDs: ${CANDIDATE_UART_SERVICES.join(', ')}`,
      );
    }

    this.log('Discovering characteristics...', 'INFO');
    const chars = await service.getCharacteristics();
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
    await this.txChar.startNotifications();

    this.log('Connected and subscribed to notifications.', 'INFO');
  }

  /**
   * Disconnect and release Bluetooth resources.
   */
  async disconnect(): Promise<void> {
    if (this.txChar) {
      try {
        this.txChar.removeEventListener('characteristicvaluechanged', this.onNotificationBound);
        await this.txChar.stopNotifications();
      } catch {
        // ignore
      }
    }
    if (this.server?.connected) {
      this.server.disconnect();
    }
    this.cleanup();
    this.log('Disconnected.', 'INFO');
  }

  private cleanup(): void {
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

    // Check for AT termination markers: "\r\nOK\r\n" or "\r\nAT_..._ERROR\r\n"
    if (
      this.rxBuffer.includes('OK\r\n') ||
      this.rxBuffer.includes('ERROR\r\n') ||
      this.rxBuffer.includes('AT_')
    ) {
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
   */
  async sendCommand(cmd: string, timeoutMs = 4000): Promise<string> {
    if (!this.isConnected || !this.rxChar) {
      throw new Error('Station is not connected over Bluetooth.');
    }

    const rxChar = this.rxChar;
    const trimmed = cmd.trim();
    const commandPayload = trimmed + '\r\n';
    this.log(`> ${trimmed}`, 'CMD');

    this.rxBuffer = '';

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const partial = this.rxBuffer;
        this.rxBuffer = '';
        this.pendingResolver = null;
        this.pendingRejecter = null;
        if (partial.trim().length > 0) {
          resolve(partial);
        } else {
          reject(new Error(`Command timed out after ${timeoutMs}ms: "${trimmed}"`));
        }
      }, timeoutMs);

      this.pendingResolver = (res: string) => {
        clearTimeout(timer);
        this.log(`< ${res.trim().replace(/\r?\n/g, ' ')}`, 'RESP');
        resolve(res);
      };

      this.pendingRejecter = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };

      const bytes = new TextEncoder().encode(commandPayload);
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

    this.log('Reading testmode status (AT+TESTMODE_TYPE=?)...', 'INFO');
    let testMode = 0;
    try {
      const modeResp = await this.sendCommand('AT+TESTMODE_TYPE=?');
      const match = modeResp.match(/(\d+)/);
      if (match) {
        testMode = parseInt(match[1], 10);
      }
    } catch (e) {
      this.log(`Could not read testmode type: ${(e as Error).message}`, 'WARN');
    }

    return {
      deviceModel: parsed.deviceModel || 'WS2001',
      deviceEui: parsed.deviceEui || 'UNKNOWN',
      formattedDevEui: parsed.formattedDevEui || parsed.deviceEui || 'UNKNOWN',
      appEui: parsed.appEui || '',
      version: parsed.version || '1.0.0',
      battery: parsed.battery || 'OK',
      uploadInterval: parsed.uploadInterval ?? 3,
      frequencyBand: parsed.frequencyBand ?? 5,
      frequencyName: parsed.frequencyName ?? 'EU868',
      subBand: parsed.subBand ?? 0,
      testModeType: testMode,
      rawConfig: configResp,
    };
  }

  /**
   * Execute sequence to configure Open LoRaWAN parameters.
   */
  async configureOpenLoRaWan(
    params: ConfigureOpenLoRaWanParams,
    onProgress?: (step: string, current: number, total: number) => void,
  ): Promise<void> {
    const totalSteps = 6;
    let step = 1;

    // Step 1: Set Frequency Band
    onProgress?.(`Setting frequency band to ${REGION_NAMES[params.band] || params.band}...`, step++, totalSteps);
    const bandResp = await this.sendCommand(`AT+BAND=${params.band}`);
    if (bandResp.includes('ERROR')) {
      throw new Error(`Failed to set frequency band: ${bandResp}`);
    }

    // Step 2: Set SubBand / Channel Group if applicable (e.g. US915 / AU915)
    if (params.band === 8 || params.band === 1) {
      const sub = params.subBand ?? 1; // default to FSB 2 (ChannelGroup = 1)
      onProgress?.(`Setting sub-band / channel group to ${sub}...`, step++, totalSteps);
      const chanResp = await this.sendCommand(`AT+CHANNEL=${sub}`);
      if (chanResp.includes('ERROR')) {
        throw new Error(`Failed to set channel subband: ${chanResp}`);
      }
    } else {
      step++;
    }

    // Step 3: Set JoinEUI / AppEUI
    const formattedJoinEui = formatHexWithColons(params.joinEui, 8);
    onProgress?.(`Setting JoinEUI (${formattedJoinEui})...`, step++, totalSteps);
    const joinResp = await this.sendCommand(`AT+APPEUI=${formattedJoinEui}`);
    if (joinResp.includes('ERROR')) {
      throw new Error(`Failed to set JoinEUI: ${joinResp}`);
    }

    // Step 4: Set AppKey
    const formattedAppKey = formatHexWithColons(params.appKey, 16);
    onProgress?.(`Setting AppKey (${formattedAppKey})...`, step++, totalSteps);
    const keyResp = await this.sendCommand(`AT+APPKEY=${formattedAppKey}`);
    if (keyResp.includes('ERROR')) {
      throw new Error(`Failed to set AppKey: ${keyResp}`);
    }

    // Step 5: Set Upload Interval
    const interval = Math.max(1, Math.min(params.intervalMinutes, 1440));
    onProgress?.(`Setting upload interval to ${interval} minutes...`, step++, totalSteps);
    const intResp = await this.sendCommand(`AT+INTERVAL=${interval}`);
    if (intResp.includes('ERROR')) {
      throw new Error(`Failed to set upload interval: ${intResp}`);
    }

    // Step 6: Enable Open LoRaWAN Mode (TestMode 1 -> discrete SenseCAP 8-in-1 frames on Port 3)
    onProgress?.('Enabling Open LoRaWAN mode (AT+TESTMODE_TYPE=1)...', step++, totalSteps);
    const modeResp = await this.sendCommand('AT+TESTMODE_TYPE=1');
    if (modeResp.includes('ERROR')) {
      throw new Error(`Failed to set testmode type: ${modeResp}`);
    }

    // Reboot MCU to commit and start LoRaWAN join
    this.log('Rebooting MCU to apply settings and trigger LoRaWAN join (ATZ)...', 'INFO');
    try {
      await this.sendCommand('ATZ', 2000);
    } catch {
      // Station reboots immediately and cuts BLE connection, which is normal and expected
    }

    this.log('Configuration completed successfully! Device is rebooting to join your LNS.', 'INFO');
  }
}

export const H2AtClient = Ws2001AtClient;
