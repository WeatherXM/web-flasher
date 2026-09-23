import { WG1200_CONSTANTS } from './constants';

export type DetectedFirmwareType = 'weatherxm' | 'meshtastic' | 'unknown';

export interface AppDescriptor {
  magic: number;
  secureVersion: number;
  version: string;
  projectName: string;
  compileTime: string;
  compileDate: string;
  idfVersion: string;
  firmwareType: DetectedFirmwareType;
  displayTitle: string;
}

/**
 * Searches for and parses the ESP-IDF esp_app_desc_t structure from the beginning of an application partition.
 */
export function parseAppDescriptor(bytes: Uint8Array): AppDescriptor | null {
  const maxSearch = Math.min(bytes.byteLength - 144, 2048);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i <= maxSearch; i += 4) {
    if (view.getUint32(i, true) === WG1200_CONSTANTS.APP_DESC_MAGIC) {
      const magic = WG1200_CONSTANTS.APP_DESC_MAGIC;
      const secureVersion = view.getUint32(i + 4, true);

      // Version: 32 bytes ASCII
      const version = readString(bytes, i + 16, 32);

      // Project Name: 32 bytes ASCII
      const projectName = readString(bytes, i + 48, 32);

      // Compile Time: 16 bytes ASCII
      const compileTime = readString(bytes, i + 80, 16);

      // Compile Date: 16 bytes ASCII
      const compileDate = readString(bytes, i + 96, 16);

      // IDF Version: 32 bytes ASCII
      const idfVersion = readString(bytes, i + 112, 32);

      const firmwareType = classifyFirmware(projectName, version);
      const displayTitle = formatDisplayTitle(firmwareType, projectName, version);

      return {
        magic,
        secureVersion,
        version,
        projectName,
        compileTime,
        compileDate,
        idfVersion,
        firmwareType,
        displayTitle,
      };
    }
  }

  return null;
}

function readString(bytes: Uint8Array, offset: number, maxLength: number): string {
  let str = '';
  for (let i = 0; i < maxLength; i++) {
    const code = bytes[offset + i];
    if (code === 0) break;
    str += String.fromCharCode(code);
  }
  return str.trim();
}

function classifyFirmware(projectName: string, version: string): DetectedFirmwareType {
  const p = projectName.toLowerCase();
  const v = version.toLowerCase();

  if (p.includes('wg1') || p.includes('weatherxm') || p.includes('station') || v.includes('wxm')) {
    return 'weatherxm';
  }

  if (p.includes('meshtastic') || v.includes('meshtastic')) {
    return 'meshtastic';
  }

  return 'unknown';
}

function formatDisplayTitle(
  type: DetectedFirmwareType,
  projectName: string,
  version: string
): string {
  switch (type) {
    case 'weatherxm':
      return `WeatherXM ${version || projectName}`;
    case 'meshtastic':
      return `Meshtastic (${version || 'WG1200'})`;
    case 'unknown':
      return projectName ? `${projectName} (${version})` : 'Unknown compatible firmware';
  }
}
