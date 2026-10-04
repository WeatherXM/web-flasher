export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
}

export interface TelemetryEvent {
  device_type: string;
  serial_number?: string;
  action: string;
  firmware_target?: string;
  firmware_source?: string;
  status: string;
  details?: Record<string, any> | string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // Aggregated stats endpoint (no serial numbers or PII exposed)
    if (url.pathname === '/api/telemetry/stats' && request.method === 'GET') {
      try {
        if (!env.DB) {
          return jsonResponse({ error: 'Database not bound' }, 503);
        }
        const total = await env.DB.prepare('SELECT count(*) as count FROM flasher_events').first<{ count: number }>();
        const breakdown = await env.DB.prepare(
          'SELECT device_type, action, status, count(*) as count FROM flasher_events GROUP BY device_type, action, status'
        ).all();
        const recent = await env.DB.prepare(
          'SELECT id, created_at, device_type, action, firmware_target, status, country FROM flasher_events ORDER BY id DESC LIMIT 20'
        ).all();

        return jsonResponse({
          total_events: total?.count ?? 0,
          breakdown: breakdown.results,
          recent_activity: recent.results,
        });
      } catch (err: any) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // Telemetry event ingestion
    if (url.pathname === '/api/telemetry' && request.method === 'POST') {
      try {
        const body = (await request.json()) as TelemetryEvent;

        if (!body.device_type || !body.action || !body.status) {
          return jsonResponse({ error: 'Missing required fields: device_type, action, status' }, 400);
        }

        const country = (request as any).cf?.country || request.headers.get('cf-ipcountry') || null;
        const userAgent = request.headers.get('user-agent') || null;
        const detailsStr =
          typeof body.details === 'object' ? JSON.stringify(body.details) : body.details || null;

        if (env.DB) {
          await env.DB.prepare(
            `INSERT INTO flasher_events 
              (device_type, serial_number, action, firmware_target, firmware_source, status, details, user_agent, country)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              body.device_type,
              body.serial_number || null,
              body.action,
              body.firmware_target || null,
              body.firmware_source || null,
              body.status,
              detailsStr,
              userAgent,
              country
            )
            .run();
        }

        return jsonResponse({ ok: true });
      } catch (err: any) {
        console.error('Failed to log telemetry event:', err);
        return jsonResponse({ ok: false, error: err.message }, 500);
      }
    }

    // Fallback to static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
