export type DeviceType = 'wg1200' | 'ws1300' | 'ws2001';
export type TelemetryAction = 'connected' | 'flash_started' | 'flash_completed' | 'flash_failed';
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

/**
 * Tracks device operations by:
 * 1. Storing the detailed audit record (including hardware serial / DevEUI / MAC)
 *    in the same-origin Cloudflare D1 database via POST /api/telemetry.
 * 2. Sending privacy-safe, aggregate tags to Google Analytics 4 (GA4) WITHOUT
 *    any serial numbers or PII.
 */
export function trackTelemetry(payload: TelemetryPayload): void {
  // 1. Same-origin Cloudflare D1 audit log (includes serial number)
  try {
    fetch('/api/telemetry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
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
