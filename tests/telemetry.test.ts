import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trackTelemetry, type TelemetryPayload } from '../src/lib/telemetry';
import worker, { resetSchemaCache } from '../src/worker/index';

describe('telemetry client helper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).window = globalThis;
  });

  it('sends POST /api/telemetry with serial number to Cloudflare D1 endpoint', () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    globalThis.fetch = fetchSpy;

    const payload: TelemetryPayload = {
      device_type: 'ws2001',
      serial_number: '2C:F7:F1:20:30:40:50:60',
      action: 'flash_completed',
      firmware_target: 'open_lorawan',
      status: 'success',
    };

    trackTelemetry(payload);

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/telemetry',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      })
    );
  });

  it('triggers GA4 events WITHOUT passing serial numbers or PII', () => {
    const gtagSpy = vi.fn();
    (globalThis as any).gtag = gtagSpy;

    trackTelemetry({
      device_type: 'ws2001',
      serial_number: '2C:F7:F1:20:30:40:50:60',
      action: 'connected',
      status: 'success',
    });

    expect(gtagSpy).toHaveBeenCalledWith('event', 'device_connected', {
      device_type: 'ws2001',
      connection_type: 'bluetooth',
    });
    // Verify serial number was NEVER passed to GA4
    const args = gtagSpy.mock.calls[0];
    expect(JSON.stringify(args)).not.toContain('2C:F7:F1');
  });

  it('triggers GA4 flash_completed and conversion on successful flash', () => {
    const gtagSpy = vi.fn();
    (globalThis as any).gtag = gtagSpy;

    trackTelemetry({
      device_type: 'wg1200',
      serial_number: '24:DC:C3:AA:BB:CC',
      action: 'flash_completed',
      firmware_target: 'Meshtastic v2.8.1',
      status: 'success',
    });

    expect(gtagSpy).toHaveBeenCalledWith('event', 'flash_completed', {
      device_type: 'wg1200',
      firmware_target: 'Meshtastic v2.8.1',
      status: 'success',
    });
    expect(gtagSpy).toHaveBeenCalledWith('event', 'conversion', {
      device_type: 'wg1200',
      firmware_target: 'Meshtastic v2.8.1',
    });
    // Verify MAC was NEVER passed to GA4
    expect(JSON.stringify(gtagSpy.mock.calls)).not.toContain('24:DC:C3');
  });

  it('triggers GA4 switched_to_open event when H2 switches to open LoRaWAN', () => {
    const gtagSpy = vi.fn();
    (globalThis as any).gtag = gtagSpy;

    trackTelemetry({
      device_type: 'ws2001',
      serial_number: '2C:F7:F1:20:30:40:50:60',
      action: 'network_switch_completed',
      firmware_target: 'open_lorawan',
      status: 'success',
    });

    expect(gtagSpy).toHaveBeenCalledWith('event', 'switched_to_open', {
      device_type: 'ws2001',
      model: 'H2',
      target: 'open_lorawan',
    });
  });

  it('does not report a WS2001 firmware update as a switch to open LoRaWAN', () => {
    const gtagSpy = vi.fn();
    (globalThis as any).gtag = gtagSpy;

    trackTelemetry({
      device_type: 'ws2001',
      serial_number: '2C:F7:F1:20:30:40:50:60',
      action: 'flash_completed',
      firmware_target: 'V4.7',
      status: 'success',
    });

    expect(gtagSpy.mock.calls.map((c) => c[1])).not.toContain('switched_to_open');
  });

  it('reports a switch back to WeatherXM', () => {
    const gtagSpy = vi.fn();
    (globalThis as any).gtag = gtagSpy;

    trackTelemetry({
      device_type: 'ws2001',
      action: 'network_switch_completed',
      firmware_target: 'weatherxm',
      status: 'success',
    });

    expect(gtagSpy).toHaveBeenCalledWith('event', 'switched_to_weatherxm', {
      device_type: 'ws2001',
      model: 'H2',
      target: 'weatherxm',
    });
  });
});

describe('Cloudflare worker API', () => {
  it('responds to /api/health with status ok', async () => {
    const req = new Request('https://flasher.weatherxm.com/api/health');
    const res = await worker.fetch(req, { DB: {} as any });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('inserts telemetry into flasher_events_v2 on POST /api/telemetry', async () => {
    resetSchemaCache();
    const runMock = vi.fn().mockResolvedValue({ success: true });
    const bindMock = vi.fn().mockReturnValue({ run: runMock });
    const prepareMock = vi.fn().mockReturnValue({ bind: bindMock, run: runMock });

    const mockDb: any = {
      prepare: prepareMock,
    };

    const req = new Request('https://flasher.weatherxm.com/api/telemetry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-ipcountry': 'GR',
        'user-agent': 'Vitest-Test-Agent',
      },
      body: JSON.stringify({
        device_type: 'ws2001',
        serial_number: '2C:F7:F1:11:22:33:44:55',
        action: 'network_switch_completed',
        firmware_target: 'open_lorawan',
        status: 'success',
        details: { band: 0, keysKept: true, wxmJoinEui: '00:11:22:33:44:55:66:77', fromNetwork: 'weatherxm', firmwareVersion: 'V4.7' },
      }),
    });

    const res = await worker.fetch(req, { DB: mockDb });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS flasher_events_v2'));
    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO flasher_events_v2'));
    expect(bindMock).toHaveBeenCalledWith(
      'ws2001',
      '2CF7F11122334455',
      'network_switch_completed',
      'open_lorawan',
      null,
      'success',
      'open_lorawan',
      'weatherxm',
      1,
      '00:11:22:33:44:55:66:77',
      'V4.7',
      expect.stringContaining('"keysKept":true'),
      'Vitest-Test-Agent',
      'GR'
    );
    expect(runMock).toHaveBeenCalled();
  });

  it('keeps /api/telemetry/stats closed without the STATS_TOKEN bearer token', async () => {
    const url = 'https://flasher.weatherxm.com/api/telemetry/stats';
    expect((await worker.fetch(new Request(url), { DB: {} as any })).status).toBe(401);
    expect((await worker.fetch(new Request(url), { DB: {} as any, STATS_TOKEN: 's3cret' })).status).toBe(401);
    const wrong = new Request(url, { headers: { Authorization: 'Bearer nope' } });
    expect((await worker.fetch(wrong, { DB: {} as any, STATS_TOKEN: 's3cret' })).status).toBe(401);
  });

  it('redacts AT+APPKEY and strips secret key fields in client and worker telemetry', async () => {
    resetSchemaCache();
    const fakeKey = Array(16).fill('11').join(':');
    let sentBody = '';
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      sentBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ ok: true }));
    });

    trackTelemetry({
      device_type: 'ws2001',
      serial_number: '2C:F7:F1:11:22:33:44:55',
      action: 'network_switch_failed',
      status: 'failed',
      details: {
        error: `AT command timed out: AT+APPKEY=${fakeKey}`,
        appKey: fakeKey,
      },
    });

    expect(sentBody).not.toContain(fakeKey);
    expect(sentBody).toContain('AT+APPKEY=<redacted>');

    let boundArgs: unknown[] = [];
    const mockDb: any = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          if (sql.includes('INSERT INTO')) boundArgs = args;
          return { run: async () => ({ success: true }) };
        },
        run: async () => ({ success: true }),
      }),
    };

    const res = await worker.fetch(
      new Request('https://flasher.weatherxm.com/api/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_type: 'ws2001',
          serial_number: '2C:F7:F1:11:22:33:44:55',
          action: 'network_switch_failed',
          status: 'failed',
          details: {
            error: `AT command timed out: AT+APPKEY=${fakeKey}`,
            appKey: fakeKey,
          },
        }),
      }),
      { DB: mockDb }
    );
    expect(res.status).toBe(200);
    expect(JSON.stringify(boundArgs)).not.toContain(fakeKey);
    expect(JSON.stringify(boundArgs)).toContain('AT+APPKEY=<redacted>');
  });

  it('rejects oversized bodies and invalid device_type or status values', async () => {
    const mockDb: any = {
      prepare: () => ({
        bind: () => ({ run: async () => ({ success: true }) }),
        run: async () => ({ success: true }),
      }),
    };

    const oversized = await worker.fetch(
      new Request('https://flasher.weatherxm.com/api/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_type: 'ws2001',
          action: 'connected',
          details: { pad: 'x'.repeat(20000) },
        }),
      }),
      { DB: mockDb }
    );
    expect(oversized.status).toBe(413);

    const badDevice = await worker.fetch(
      new Request('https://flasher.weatherxm.com/api/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_type: 'unknown_station',
          action: 'connected',
        }),
      }),
      { DB: mockDb }
    );
    expect(badDevice.status).toBe(400);
  });
});
