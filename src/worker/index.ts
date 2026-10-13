// Minimal shapes of the Cloudflare bindings used here (the project does not ship @cloudflare/workers-types).
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}
interface D1Database {
  prepare(sql: string): D1Statement;
}
interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  // Bearer token for GET /api/telemetry/stats (set with `wrangler secret put STATS_TOKEN`).
  // Without it the endpoint stays closed.
  STATS_TOKEN?: string;
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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Events are written to flasher_events_v2. The original flasher_events table stays as a legacy log
// (early test events) and is no longer written.
// For WS2001 network switches the fields the WeatherXM backend needs to unprovision / provision the
// station on its LNS (Helium ChirpStack / LoneStar) are real columns: serial_number (DevEUI), network,
// keys_kept, wxm_join_eui. See scripts/sql/ws2001-network-state.sql and migrations/0001_flasher_events_v2.sql.
export const EVENTS_TABLE = 'flasher_events_v2';
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    device_type TEXT NOT NULL,
    serial_number TEXT,
    action TEXT NOT NULL,
    target TEXT,
    source TEXT,
    status TEXT NOT NULL,
    network TEXT,
    from_network TEXT,
    keys_kept INTEGER,
    wxm_join_eui TEXT,
    firmware_version TEXT,
    details TEXT,
    user_agent TEXT,
    country TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_${EVENTS_TABLE}_device ON ${EVENTS_TABLE} (device_type, serial_number, id)`,
  `CREATE INDEX IF NOT EXISTS idx_${EVENTS_TABLE}_action ON ${EVENTS_TABLE} (action, status)`,
];

let schemaReady: Promise<void> | null = null;

/** Create the events table on first use (once per worker isolate); a failure is retried next time. */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of SCHEMA_STATEMENTS) {
        await db.prepare(sql).run();
      }
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/** Test hook: forget that the schema was created. */
export function resetSchemaCache(): void {
  schemaReady = null;
}

// WS2001 serial numbers are DevEUIs; store one canonical form (16 uppercase hex chars, no separators)
// so events from different pages and firmware versions group by device.
export function normalizeSerial(deviceType: string, serial?: string | null): string | null {
  if (!serial) return null;
  if (deviceType === 'ws2001') {
    const hex = serial.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    return hex.length === 16 ? hex : serial;
  }
  return serial;
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function statsAuthorized(request: Request, env: Env): boolean {
  if (!env.STATS_TOKEN) return false;
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return token.length > 0 && sameSecret(token, env.STATS_TOKEN);
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

    // Aggregated stats (no serial numbers). Needs Authorization: Bearer <STATS_TOKEN>.
    if (url.pathname === '/api/telemetry/stats' && request.method === 'GET') {
      if (!statsAuthorized(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      try {
        if (!env.DB) {
          return jsonResponse({ error: 'Database not bound' }, 503);
        }
        await ensureSchema(env.DB);
        const total = await env.DB.prepare(`SELECT count(*) as count FROM ${EVENTS_TABLE}`).first<{ count: number }>();
        // Network switches only (firmware updates are flash_* events and must not count here)
        const switchedOpen = await env.DB.prepare(
          `SELECT count(*) as count, count(DISTINCT serial_number) as unique_devices FROM ${EVENTS_TABLE} WHERE action = 'network_switch_completed' AND network = 'open_lorawan' AND status = 'success'`
        ).first<{ count: number; unique_devices: number }>();
        const switchedBack = await env.DB.prepare(
          `SELECT count(*) as count, count(DISTINCT serial_number) as unique_devices FROM ${EVENTS_TABLE} WHERE action = 'network_switch_completed' AND network = 'weatherxm' AND status = 'success'`
        ).first<{ count: number; unique_devices: number }>();
        const flashedTotal = await env.DB.prepare(
          `SELECT count(*) as count, count(DISTINCT serial_number) as unique_devices FROM ${EVENTS_TABLE} WHERE action = 'flash_completed' AND status = 'success'`
        ).first<{ count: number; unique_devices: number }>();
        const breakdown = await env.DB.prepare(
          `SELECT device_type, action, status, count(*) as count FROM ${EVENTS_TABLE} GROUP BY device_type, action, status`
        ).all();
        const recent = await env.DB.prepare(
          `SELECT id, created_at, device_type, action, target, status, country FROM ${EVENTS_TABLE} ORDER BY id DESC LIMIT 20`
        ).all();

        return jsonResponse({
          total_events: total?.count ?? 0,
          devices_switched_to_open: {
            total_operations: switchedOpen?.count ?? 0,
            unique_devices: switchedOpen?.unique_devices ?? 0,
          },
          devices_switched_back_to_weatherxm: {
            total_operations: switchedBack?.count ?? 0,
            unique_devices: switchedBack?.unique_devices ?? 0,
          },
          devices_flashed: {
            total_operations: flashedTotal?.count ?? 0,
            unique_devices: flashedTotal?.unique_devices ?? 0,
          },
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
        const details: Record<string, any> =
          body.details && typeof body.details === 'object' ? body.details : {};
        const detailsStr =
          typeof body.details === 'object' ? JSON.stringify(body.details) : body.details || null;
        const isNetworkSwitch = body.action.startsWith('network_switch_');
        const keysKept = typeof details.keysKept === 'boolean' ? (details.keysKept ? 1 : 0) : null;

        if (env.DB) {
          await ensureSchema(env.DB);
          await env.DB.prepare(
            `INSERT INTO ${EVENTS_TABLE}
              (device_type, serial_number, action, target, source, status, network, from_network,
               keys_kept, wxm_join_eui, firmware_version, details, user_agent, country)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              body.device_type,
              normalizeSerial(body.device_type, body.serial_number),
              body.action,
              body.firmware_target || null,
              body.firmware_source || null,
              body.status,
              isNetworkSwitch ? body.firmware_target || null : null,
              typeof details.fromNetwork === 'string' ? details.fromNetwork : null,
              keysKept,
              typeof details.wxmJoinEui === 'string' ? details.wxmJoinEui : null,
              typeof details.firmwareVersion === 'string' ? details.firmwareVersion : body.firmware_source || null,
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
