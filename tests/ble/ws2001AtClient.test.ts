import { describe, it, expect } from 'vitest';
import { formatHexWithColons, hasAtTerminator, parseAtConfig, REGION_NAMES, Ws2001AtClient } from '../../src/lib/ble/ws2001AtClient';

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
});
