/**
 * The Things Stack "end device JSON" for importing a WS2001 (H2) station into TTN
 * (Console > Applications > End devices > Import end devices > "The Things Stack JSON").
 *
 * Built in the browser from the values written to the station; it contains the AppKey, so it is
 * only handed to the user as a download and never sent anywhere.
 * Format: https://www.thethingsindustries.com/docs/hardware/devices/adding-devices/adding-devices-in-bulk/device-json/
 * The WS2001 uplink decoder is attached as the device's JavaScript uplink formatter, so imported devices
 * decode the weather frames on FPort 99 without further setup: the 16-byte Open Edition frame (V4.9+) and
 * the 24-byte WeatherXM frame that earlier firmware sends on the custom profile.
 */

import { WS2001_UPLINK_DECODER } from './ws2001UplinkDecoder';

export interface TtnExportParams {
  devEui: string;   // 16 hex chars, separators allowed
  joinEui: string;  // 16 hex chars, separators allowed
  appKey: string;   // 32 hex chars, separators allowed
  band: number;     // station band code (AT+BAND), see REGION_NAMES in ws2001AtClient
  subBand?: number; // US915 / AU915 channel group 0..7 (FSB 2 = 1)
}

export interface TtnEndDevice {
  ids: { device_id: string; dev_eui: string; join_eui: string };
  name: string;
  description: string;
  lorawan_version: string;
  lorawan_phy_version: string;
  frequency_plan_id: string;
  supports_join: true;
  root_keys: { app_key: { key: string } };
  formatters: { up_formatter: 'FORMATTER_JAVASCRIPT'; up_formatter_parameter: string };
}

function hex(value: string, bytes: number, what: string): string {
  const h = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (h.length !== bytes * 2) {
    throw new Error(`${what} must be ${bytes * 2} hexadecimal characters.`);
  }
  return h;
}

/** TTN frequency plan for a station band code; null when TTN has no matching plan. */
export function ttnFrequencyPlan(band: number, subBand = 1): string | null {
  const fsb = Math.min(8, Math.max(1, subBand + 1));
  switch (band) {
    case 5: return 'EU_863_870_TTN';
    case 8: return `US_902_928_FSB_${fsb}`;
    case 1: return `AU_915_928_FSB_${fsb}`;
    case 15: return 'AS_923';
    case 7: return 'IN_865_867';
    case 6: return 'KR_920_923_TTN';
    case 9: return 'RU_864_870_TTN';
    default: return null; // Helium AS923 variants etc.
  }
}

export function buildTtnEndDevice(p: TtnExportParams): TtnEndDevice {
  const devEui = hex(p.devEui, 8, 'DevEUI');
  const plan = ttnFrequencyPlan(p.band, p.subBand ?? 1);
  if (!plan) throw new Error('The selected region has no matching The Things Network frequency plan.');
  const suffix = devEui.slice(-6);
  return {
    ids: {
      device_id: `ws2001-${suffix.toLowerCase()}`,
      dev_eui: devEui,
      join_eui: hex(p.joinEui, 8, 'JoinEUI'),
    },
    name: `WeatherXM H2 ${suffix}`,
    description: 'WeatherXM H2 Open Edition (WS2001). 16-byte weather frame on FPort 99 (firmware V4.8 and earlier: 24-byte WeatherXM frame).',
    lorawan_version: 'MAC_V1_0_4',
    lorawan_phy_version: 'RP002_V1_0_3',
    frequency_plan_id: plan,
    supports_join: true,
    root_keys: { app_key: { key: hex(p.appKey, 16, 'AppKey') } },
    formatters: { up_formatter: 'FORMATTER_JAVASCRIPT', up_formatter_parameter: WS2001_UPLINK_DECODER },
  };
}

export function ttnImportJson(p: TtnExportParams): string {
  return JSON.stringify(buildTtnEndDevice(p), null, 2) + '\n';
}

export function ttnImportFileName(p: Pick<TtnExportParams, 'devEui'>): string {
  return `ttn-import-ws2001-${hex(p.devEui, 8, 'DevEUI').slice(-6).toLowerCase()}.json`;
}
