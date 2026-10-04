import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trackTelemetry, type TelemetryPayload } from '../src/lib/telemetry';
import worker from '../src/worker/index';

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
      action: 'flash_completed',
      firmware_target: 'open_lorawan',
      status: 'success',
    });

    expect(gtagSpy).toHaveBeenCalledWith('event', 'switched_to_open', {
      device_type: 'ws2001',
      model: 'H2',
      target: 'open_lorawan',
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

  it('inserts telemetry into DB on POST /api/telemetry', async () => {
    const runMock = vi.fn().mockResolvedValue({ success: true });
    const bindMock = vi.fn().mockReturnValue({ run: runMock });
    const prepareMock = vi.fn().mockReturnValue({ bind: bindMock });

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
        action: 'flash_completed',
        firmware_target: 'open_lorawan',
        status: 'success',
        details: { band: 0 },
      }),
    });

    const res = await worker.fetch(req, { DB: mockDb });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO flasher_events'));
    expect(bindMock).toHaveBeenCalledWith(
      'ws2001',
      '2C:F7:F1:11:22:33:44:55',
      'flash_completed',
      'open_lorawan',
      null,
      'success',
      '{"band":0}',
      'Vitest-Test-Agent',
      'GR'
    );
    expect(runMock).toHaveBeenCalled();
  });
});
