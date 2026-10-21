export type DeviceType = 'wg1200' | 'ws1300' | 'ws2001';
// flash_*: firmware written to the device (all devices).
// network_switch_*: WS2001 moved between the WeatherXM network and the customer's own LoRaWAN network
// (firmware_target = 'open_lorawan' or 'weatherxm'). These drive unprovisioning on the WeatherXM LNS.
export type TelemetryAction =
  | 'connected'
  | 'flash_started'
  | 'flash_completed'
  | 'flash_failed'
  | 'network_switch_started'
  | 'network_switch_completed'
  | 'network_switch_failed';
export type TelemetryStatus = 'success' | 'failed' | 'in_progress';

export interface TelemetryPayload {
  device_type: DeviceType;
  serial_number?: string;
  action: TelemetryAction;
  firmware_target?: string;
  firmware_source?: string;
  status: TelemetryStatus;
  details?: Record<string, any>;
}

const FORBIDDEN_DETAIL_KEYS = new Set(['appkey', 'appskey', 'nwkskey', 'devkey']);

export function redactTelemetryString(value: string): string {
  return value
    .replace(/(AT\+(?:APPKEY|APPSKEY|NWKSKEY|DEVKEY)=)[^\s"']+/gi, '$1<redacted>')
    .replace(/(?:[0-9a-fA-F]{2}:){15}[0-9a-fA-F]{2}/g, '<redacted-key>')
    .replace(/\b[0-9a-fA-F]{32}\b/g, '<redacted-key>');
}

export function sanitizeTelemetryDetails(details?: Record<string, any>): Record<string, any> | undefined {
  if (!details || typeof details !== 'object') return details;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(details)) {
    if (FORBIDDEN_DETAIL_KEYS.has(k.toLowerCase())) continue;
    if (typeof v === 'string') {
      out[k] = redactTelemetryString(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Tracks device operations by:
 * 1. Storing the detailed audit record (including hardware serial / DevEUI / MAC)
 *    in the same-origin Cloudflare D1 database via POST /api/telemetry.
 * 2. Sending privacy-safe, aggregate tags to Google Analytics 4 (GA4) WITHOUT
 *    any serial numbers or PII.
 */
export function trackTelemetry(payload: TelemetryPayload): void {
  const safePayload: TelemetryPayload = payload.details
    ? { ...payload, details: sanitizeTelemetryDetails(payload.details) }
    : payload;
  // 1. Same-origin Cloudflare D1 audit log (includes serial number)
  try {
    fetch('/api/telemetry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(safePayload),
      keepalive: true,
    }).catch(() => {
      // Fire-and-forget: network errors must never interrupt flasher UX
    });
  } catch {
    // Non-fatal
  }

  // 2. Google Analytics 4 (GA4) generic aggregate tags (NO serial numbers)
  try {
    if (typeof window !== 'undefined' && typeof (window as any).gtag === 'function') {
      const gtag = (window as any).gtag;

      switch (payload.action) {
        case 'connected':
          gtag('event', 'device_connected', {
            device_type: payload.device_type,
            connection_type: payload.device_type === 'wg1200' ? 'serial' : 'bluetooth',
          });
          break;

        case 'flash_started':
          gtag('event', 'flash_started', {
            device_type: payload.device_type,
            firmware_target: payload.firmware_target || 'unknown',
          });
          break;

        case 'flash_completed':
          gtag('event', 'flash_completed', {
            device_type: payload.device_type,
            firmware_target: payload.firmware_target || 'unknown',
            status: 'success',
          });
          // Also fire standard conversion event for GA4 conversion funnels
          gtag('event', 'conversion', {
            device_type: payload.device_type,
            firmware_target: payload.firmware_target || 'unknown',
          });
          break;

        case 'network_switch_completed':
          // H2 moved to the customer's own LoRaWAN network, or back to WeatherXM
          gtag('event', payload.firmware_target === 'weatherxm' ? 'switched_to_weatherxm' : 'switched_to_open', {
            device_type: payload.device_type,
            model: 'H2',
            target: payload.firmware_target || 'open_lorawan',
          });
          break;

        case 'network_switch_failed':
          gtag('event', 'network_switch_failed', {
            device_type: payload.device_type,
            target: payload.firmware_target || 'unknown',
          });
          break;

        case 'flash_failed':
          gtag('event', 'flash_failed', {
            device_type: payload.device_type,
            firmware_target: payload.firmware_target || 'unknown',
            status: 'failed',
          });
          break;
      }
    }
  } catch {
    // Non-fatal
  }
}
