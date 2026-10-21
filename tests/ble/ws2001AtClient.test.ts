import { describe, it, expect } from 'vitest';
import { formatHexWithColons, hasAtTerminator, parseAtConfig, parseLoRaWanStatus, parseMeasurements, redactAtLog, REGION_NAMES, Ws2001AtClient } from '../../src/lib/ble/ws2001AtClient';

describe('Ws2001AtClient helpers', () => {
  it('formats hex strings with colons correctly for 8-byte DevEUI/JoinEUI', () => {
    const raw = '0123456789abcdef';
    const formatted = formatHexWithColons(raw, 8);
    expect(formatted).toBe('01:23:45:67:89:AB:CD:EF');
  });

  it('formats hex strings with colons correctly for 16-byte AppKey', () => {
    const raw = '00112233445566778899aabbccddeeff';
    const formatted = formatHexWithColons(raw, 16);
    expect(formatted).toBe('00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF');
  });

  it('ignores existing colons, spaces, and dashes during formatting', () => {
    const raw = '00-11-22:33 44 55 66 77';
    const formatted = formatHexWithColons(raw, 8);
    expect(formatted).toBe('00:11:22:33:44:55:66:77');
  });

  it('throws when hex character length does not match expected byte count', () => {
    expect(() => formatHexWithColons('1234', 8)).toThrow(/Invalid length/);
    expect(() => formatHexWithColons('001122334455667788', 8)).toThrow(/Invalid length/);
  });

  it('correctly parses AT+CONFIG=? JSON response', () => {
    const sampleConfig = `{deviceModel: "WS2001",deviceEui: "24:E1:24:12:8A:00:11:22",appEui: "70:B3:D5:7E:D0:00:12:34",version: "v1.2.0",classType: "A",electricity: "3.1V",collectInterval: 3,gpsUplinkInterval: 1440,frequency: 8,subBand: 1,'3c': 0,joinType: 1,nwkSkey: "...",appSkey: "...",devAddr: "...",devCode: "...",platform: 0,devKey: "..."}`;

    const parsed = parseAtConfig(sampleConfig);
    expect(parsed.deviceModel).toBe('WS2001');
    expect(parsed.deviceEui).toBe('24E124128A001122');
    expect(parsed.formattedDevEui).toBe('24:E1:24:12:8A:00:11:22');
    expect(parsed.appEui).toBe('70B3D57ED0001234');
    expect(parsed.version).toBe('v1.2.0');
    expect(parsed.uploadInterval).toBe(3);
    expect(parsed.frequencyBand).toBe(8);
    expect(parsed.frequencyName).toBe('US915');
    expect(parsed.subBand).toBe(1);
    expect(parsed.battery).toBe('3.1V');
  });

  it('correctly parses real station AT+CONFIG=? response with nested version and battery', () => {
    const realStationConfig = `{deviceModel: 'WXM WS2001',deviceEui: 24:e1:24:12:8a:00:11:22,defEui: 24:e1:24:12:8a:00:11:22,appEui: 70:b3:d5:7e:d0:00:12:34,version: {Software: 'V3.13', Hardware: 'V2.0', LoRaWAN: 'V1.0.3',},classType: 0,electricity: 100,collectInterval: 3,gpsUplinkInterval: 1440,frequency: 8,subBand: 1,'3c': 0,joinType: 1,nwkSkey: 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00,appSkey: 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00,devAddr: 00:00:00:00,devCode: 00:00:00:00:00:00:00:00,platform: 0,devKey: 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00}`;

    const parsed = parseAtConfig(realStationConfig);
    expect(parsed.deviceModel).toBe('WXM WS2001');
    expect(parsed.deviceEui).toBe('24E124128A001122');
    expect(parsed.formattedDevEui).toBe('24:E1:24:12:8A:00:11:22');
    expect(parsed.appEui).toBe('70B3D57ED0001234');
    expect(parsed.version).toBe('V3.13');
    expect(parsed.battery).toBe('100%');
    expect(parsed.defEui).toBe('24E124128A001122');
    expect(parsed.formattedDefEui).toBe('24:E1:24:12:8A:00:11:22');
    expect(parsed.devCode).toBe('00:00:00:00:00:00:00:00');
    expect(parsed.devAddr).toBe('00:00:00:00');
    expect(parsed.hardwareVersion).toBe('V2.0');
    expect(parsed.lorawanVersion).toBe('V1.0.3');
    expect(parsed.classType).toBe('0');
    expect(parsed.joinType).toBe('1');
    expect(parsed.uploadInterval).toBe(3);
    expect(parsed.frequencyBand).toBe(8);
    expect(parsed.frequencyName).toBe('US915');
    expect(parsed.subBand).toBe(1);
  });

  it('handles EU868 region mapping correctly', () => {
    expect(REGION_NAMES[5]).toBe('EU868');
    expect(REGION_NAMES[8]).toBe('US915');
    expect(REGION_NAMES[1]).toBe('AU915');
    expect(REGION_NAMES[15]).toBe('AS923-1 (Standard TTN/ChirpStack)');
  });
});

function makeMockClient() {
  const client = new Ws2001AtClient() as any;
  client.server = { connected: true };
  client.rxChar = {
    properties: { writeWithoutResponse: true },
    writeValueWithoutResponse: async () => {},
  };
  client.txChar = {};
  return client as Ws2001AtClient;
}

function notifyClient(client: any, text: string) {
  const bytes = new TextEncoder().encode(text);
  client.handleNotification({ target: { value: new DataView(bytes.buffer) } });
}

describe('Ws2001AtClient framing, serialization, and verification', () => {
  it('requires complete CRLF-terminated status lines in hasAtTerminator', () => {
    expect(hasAtTerminator('\r\nAT_')).toBe(false);
    expect(hasAtTerminator('OK')).toBe(false);
    expect(hasAtTerminator('\r\nOK\r\n')).toBe(true);
    expect(hasAtTerminator('1\r\nOK\r\n')).toBe(true);
    expect(hasAtTerminator('\r\nAT_PARAM_ERROR\r\n')).toBe(true);
    // firmware status codes that do not end in ERROR (at_command.c ATError_description[])
    expect(hasAtTerminator('\r\nAT_SAVE_FAILED\r\n')).toBe(true);
    expect(hasAtTerminator('\r\nAT_NO_NETWORK_JOINED\r\n')).toBe(true);
    expect(hasAtTerminator('\r\nAT_SAVE_')).toBe(false);
  });

  it('treats AT_SAVE_FAILED as a failed setter without waiting for the timeout', async () => {
    const client = makeMockClient() as any;
    client.rxChar.writeValueWithoutResponse = async () => {
      setTimeout(() => notifyClient(client, '\r\nAT_SAVE_FAILED\r\n'), 5);
    };
    client.rebootConfirmTimeoutMs = 100;
    const started = Date.now();
    await expect(
      client.configureOpenLoRaWan({ band: 5, joinEui: '0000000000000001', appKey: '11'.repeat(16), intervalMinutes: 5, gnss: false })
    ).rejects.toThrow(/AT_SAVE_FAILED/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('waits for complete error line across BLE fragments', async () => {
    const client = makeMockClient();
    const pending = client.sendCommand('AT+NETPROFILE=1', 200);
    notifyClient(client, '\r\nAT_');
    setTimeout(() => notifyClient(client, 'PARAM_ERROR\r\n'), 10);
    expect(await pending).toBe('\r\nAT_PARAM_ERROR\r\n');
  });

  it('rejects incomplete responses on timeout and redacts AppKey in error message', async () => {
    const client = makeMockClient();
    const fakeKey = Array(16).fill('11').join(':');
    const pending = client.sendCommand(`AT+APPKEY=${fakeKey}`, 30);
    notifyClient(client, 'OK'); // missing CRLF
    await expect(pending).rejects.toThrow(/AT\+APPKEY=<hidden>/);
  });

  it('serializes overlapping sendCommand calls in order', async () => {
    const client = makeMockClient() as any;
    const written: string[] = [];
    client.rxChar.writeValueWithoutResponse = async (bytes: Uint8Array) => {
      const cmd = new TextDecoder().decode(bytes).trim();
      written.push(cmd);
      setTimeout(() => {
        if (cmd === 'AT+NETPROFILE=?') notifyClient(client, '1\r\nOK\r\n');
        else if (cmd === 'AT+GPSSWITCH=?') notifyClient(client, '0\r\nOK\r\n');
      }, 10);
    };

    const [first, second] = await Promise.all([
      client.sendCommand('AT+NETPROFILE=?', 200),
      client.sendCommand('AT+GPSSWITCH=?', 200),
    ]);
    expect(written).toEqual(['AT+NETPROFILE=?', 'AT+GPSSWITCH=?']);
    expect(first).toBe('1\r\nOK\r\n');
    expect(second).toBe('0\r\nOK\r\n');
  });

  function makeConfigureClient(server: { connected: boolean }) {
    const client = new Ws2001AtClient() as any;
    client.server = server;
    client.rebootConfirmTimeoutMs = 300;
    const commands: string[] = [];
    client.sendCommand = async (command: string) => {
      commands.push(command.split('=')[0]);
      if (command === 'AT+TESTMODE_TYPE=?') return '0\r\nOK\r\n';
      if (command === 'AT+NETPROFILE=?') return "{active: 1, weatherxm: 'stored', custom: 'stored'}\r\nOK\r\n";
      if (command === 'ATZ') throw new Error('Command timed out after 2000ms: "ATZ"');
      return '\r\nOK\r\n';
    };
    return { client: client as Ws2001AtClient, commands };
  }
  const configureParams = { band: 5, joinEui: '0000000000000001', appKey: '11'.repeat(16), intervalMinutes: 5, gnss: false };

  it('verifies AT+NETPROFILE=? readback and fails when the station stays connected after an unanswered ATZ', async () => {
    const { client, commands } = makeConfigureClient({ connected: true });
    await expect(client.configureOpenLoRaWan(configureParams)).rejects.toThrow(/did not reboot after ATZ/);
    expect(commands.filter((c) => c === 'AT+NETPROFILE')).toEqual(['AT+NETPROFILE', 'AT+NETPROFILE']);
  });

  it('accepts an unanswered ATZ when the Bluetooth link drops (the OK is often lost in the reset)', async () => {
    const server = { connected: true };
    const { client, commands } = makeConfigureClient(server);
    setTimeout(() => { server.connected = false; }, 50);
    await expect(client.configureOpenLoRaWan(configureParams)).resolves.toBeUndefined();
    expect(commands.at(-1)).toBe('ATZ');
  });

  it('switchToStoredOpenLoRaWan reactivates profile 1 without writing keys', async () => {
    const server = { connected: true };
    const { client, commands } = makeConfigureClient(server);
    setTimeout(() => { server.connected = false; }, 50);
    await expect(client.switchToStoredOpenLoRaWan()).resolves.toBeUndefined();
    expect(commands).toEqual([
      'AT+NETPROFILE',
      'AT+TESTMODE_TYPE',
      'AT+TESTMODE_TYPE',
      'AT+NETPROFILE',
      'ATZ',
    ]);
  });

  it('switchBackToWeatherXm reactivates profile 0 without writing keys', async () => {
    const server = { connected: true };
    const client = new Ws2001AtClient() as any;
    client.server = server;
    client.rebootConfirmTimeoutMs = 300;
    const commands: string[] = [];
    client.sendCommand = async (command: string) => {
      commands.push(command);
      if (command === 'AT+TESTMODE_TYPE=?') return '0\r\nOK\r\n';
      if (command === 'AT+NETPROFILE=?') return "{active: 0, weatherxm: 'stored', custom: 'stored'}\r\nOK\r\n";
      return '\r\nOK\r\n';
    };
    await expect((client as Ws2001AtClient).switchBackToWeatherXm()).resolves.toBeUndefined();
    expect(commands).toEqual([
      'AT+NETPROFILE=0',
      'AT+TESTMODE_TYPE=0',
      'AT+TESTMODE_TYPE=?',
      'AT+NETPROFILE=?',
      'ATZ',
    ]);
  });
});

describe('Join tracker reads', () => {
  it('parses AT+LW_MODEM_STATUS=? into joined / joining / idle / unknown', () => {
    expect(parseLoRaWanStatus('JOINED \r\n\r\nOK\r\n')).toEqual({ state: 'joined', flags: ['JOINED'] });
    expect(parseLoRaWanStatus('JOINING \r\n\r\nOK\r\n').state).toBe('joining');
    expect(parseLoRaWanStatus('MUTE \r\nJOINING \r\n\r\nOK\r\n')).toEqual({ state: 'joining', flags: ['MUTE', 'JOINING'] });
    expect(parseLoRaWanStatus('\r\nOK\r\n').state).toBe('idle');
    expect(parseLoRaWanStatus('\r\nAT_ERROR\r\n').state).toBe('unknown');
  });

  it('decodes AT+MEA=? like the dev TUI, with sensor error codes as null', () => {
    const raw = '{4097:23500,4098:56000,4105:3100,4104:270000,4191:5200,4099:12345000,4113:12,4101:101320000,4190:300}\r\n\r\nOK\r\n';
    expect(parseMeasurements(raw)).toEqual({
      temperature: 23.5, humidity: 56, windSpeed: 3.1, windDirection: 270, windGust: 5.2,
      light: 12345, rainRate: 0.012, pressure: 1013.2, uvIndex: 0.3,
    });
    expect(parseMeasurements(`{4097:${0x7fff * 100},4098:56000}\r\nOK\r\n`)).toEqual({ temperature: null, humidity: 56 });
    expect(parseMeasurements('\r\nAT_ERROR\r\n')).toBeNull();
  });

  it('reconnects to the same station after it restarted, without the chooser', async () => {
    const tx = Object.assign(new EventTarget(), {
      uuid: '49535354-1e4d-4bd9-ba61-23c647249616', properties: { notify: true, write: false, writeWithoutResponse: false },
      startNotifications: async () => tx, stopNotifications: async () => tx,
    });
    const rx = { uuid: '49535354-8841-43f4-a8d4-ecbe34729bb3', properties: { notify: false, write: true, writeWithoutResponse: true } };
    const service = { uuid: '49535354-fe7d-4ae5-8fa9-9fafd205e455', getCharacteristics: async () => [tx, rx] };
    let attempts = 0;
    const server = { connected: false, getPrimaryService: async () => service, getPrimaryServices: async () => [service], disconnect: () => { server.connected = false; } };
    const device = Object.assign(new EventTarget(), {
      name: 'WeatherXM WS2001 50000C',
      gatt: {
        // The station is still booting for the first two attempts
        connect: async () => {
          attempts++;
          if (attempts < 3) throw new Error('Connection attempt failed.');
          server.connected = true;
          return server;
        },
        disconnect: () => { server.connected = false; },
      },
    });
    const client = new Ws2001AtClient() as any;
    client.lastDevice = device;
    const seen: number[] = [];
    await client.reconnect({ timeoutMs: 5000, retryDelayMs: 10, onAttempt: (n: number) => seen.push(n) });
    expect(attempts).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
    expect(client.isConnected).toBe(true);
    expect(client.deviceName).toBe('WeatherXM WS2001 50000C');
  });

  it('gives up reconnecting after the timeout', async () => {
    const device = Object.assign(new EventTarget(), {
      gatt: { connect: async () => { throw new Error('Connection attempt failed.'); }, disconnect: () => {} },
    });
    const client = new Ws2001AtClient() as any;
    client.lastDevice = device;
    await expect(client.reconnect({ timeoutMs: 50, retryDelayMs: 10 })).rejects.toThrow(/Could not reconnect/);
  });

  it('forgets the station on an explicit disconnect', async () => {
    const client = new Ws2001AtClient() as any;
    client.lastDevice = { gatt: {} };
    await client.disconnect();
    await expect(client.reconnect({ timeoutMs: 10 })).rejects.toThrow(/No station to reconnect to/);
  });
});

describe('TTN import file from the station', () => {
  const key = '2B:7E:15:16:28:AE:D2:A6:AB:F7:15:88:09:CF:4F:3C';

  it('reads the active JoinEUI back from the station (the AppKey is never readable)', async () => {
    const client = new Ws2001AtClient();
    const sent: string[] = [];
    client.sendCommand = async (cmd: string) => {
      sent.push(cmd);
      if (cmd === 'AT+APPEUI=?') return "'70:B3:D5:7E:D0:00:00:01'\r\nOK\r\n";
      return '\r\nAT_ERROR\r\n';
    };
    await expect(client.readActiveJoinEui()).resolves.toBe('70B3D57ED0000001');
    expect(sent).toEqual(['AT+APPEUI=?']);
  });

  it('fails clearly when the station does not return the JoinEUI', async () => {
    const client = new Ws2001AtClient();
    client.sendCommand = async () => '\r\nAT_ERROR\r\n';
    await expect(client.readActiveJoinEui()).rejects.toThrow(/Could not read the JoinEUI/);
  });

  it('hides a bare AppKey reply in the AT log but keeps the 8-byte DevEUI', () => {
    expect(redactAtLog(`'${key}' OK`)).toBe("'<hidden>' OK");
    expect(redactAtLog("'2C:F7:F1:C0:61:50:00:0C' OK")).toBe("'2C:F7:F1:C0:61:50:00:0C' OK");
  });
});

describe('Service discovery while pairing stalls', () => {
  function stationWith(getPrimaryService: (uuid: string) => Promise<unknown>) {
    const calls: string[] = [];
    const server = {
      connected: true,
      getPrimaryService: (uuid: string) => { calls.push(uuid); return getPrimaryService(uuid); },
      getPrimaryServices: async () => [],
      disconnect: () => { server.connected = false; },
    };
    const device = Object.assign(new EventTarget(), {
      name: 'WeatherXM WS2001 50000C',
      gatt: { connect: async () => server, disconnect: () => { server.connected = false; } },
    });
    return { device, calls };
  }

  it('shows a hint, waits once and fails clearly instead of trying every candidate', async () => {
    const st = stationWith(() => new Promise(() => {})); // the OS never answers (stuck pairing)
    const client = new Ws2001AtClient() as any;
    client.discoveryHintMs = 20;
    client.discoveryTimeoutMs = 80;
    const hints: Array<string | null> = [];
    client.onHint = (t: string | null) => hints.push(t);
    client.device = st.device;
    await expect(client.attachGatt()).rejects.toThrow(/did not answer within 35 seconds/);
    expect(st.calls).toHaveLength(1);
    expect(hints[0]).toMatch(/pairing request/);
    expect(hints.at(-1)).toBeNull();
  });

  it('still tries the next candidate when a service is simply missing', async () => {
    const tx = Object.assign(new EventTarget(), {
      uuid: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', properties: { notify: true, write: false, writeWithoutResponse: false },
      startNotifications: async () => tx,
    });
    const rx = { uuid: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', properties: { notify: false, write: true, writeWithoutResponse: true } };
    let n = 0;
    const st = stationWith(async () => {
      n++;
      if (n < 3) throw Object.assign(new Error('No Services matching UUID found in Device.'), { name: 'NotFoundError' });
      return { uuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', getCharacteristics: async () => [tx, rx] };
    });
    const client = new Ws2001AtClient() as any;
    const hints: Array<string | null> = [];
    client.onHint = (t: string | null) => hints.push(t);
    client.device = st.device;
    await client.attachGatt();
    expect(st.calls).toHaveLength(3);
    expect(client.isConnected).toBe(true);
    expect(hints).toEqual([null]); // no hint for a fast discovery, only the final clear
  });
});

describe('Restart before a reconnect', () => {
  it('waits for the link to drop even when the station answers OK to ATZ', async () => {
    const server = { connected: true, disconnect: () => { server.connected = false; } };
    const client = new Ws2001AtClient() as any;
    client.server = server;
    client.sendCommand = async () => '\r\nOK\r\n';
    setTimeout(() => { server.connected = false; }, 1800); // the browser notices the reset later
    const t0 = Date.now();
    await client.restartStation();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1800);
    expect(server.connected).toBe(false);
  });

  it('releases the stale link itself when the station confirmed the reset but the link stays up', async () => {
    let released = false;
    const server = { connected: true, disconnect: () => { released = true; server.connected = false; } };
    const client = new Ws2001AtClient() as any;
    client.server = server;
    client.rebootConfirmTimeoutMs = 300;
    client.sendCommand = async () => '\r\nOK\r\n';
    await expect(client.restartStation()).resolves.toBeUndefined();
    expect(released).toBe(true);
    expect(client.server).toBeNull();
  });

  it('does not hang disconnecting when the dying link never confirms stopNotifications', async () => {
    const tx = Object.assign(new EventTarget(), { stopNotifications: () => new Promise(() => {}) });
    const server = { connected: true, disconnect: () => { server.connected = false; } };
    const client = new Ws2001AtClient() as any;
    client.server = server;
    client.txChar = tx;
    const t0 = Date.now();
    await client.disconnect();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(server.connected).toBe(false);
  });
});
