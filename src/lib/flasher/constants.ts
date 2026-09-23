export const WG1200_CONSTANTS = {
  HARDWARE: 'WG1200',
  CHIP: 'ESP32-S3',
  FLASH_SIZE_BYTES: 16 * 1024 * 1024, // 16 MB (16,777,216)
  MAX_APP_SIZE_BYTES: 4 * 1024 * 1024, // 4 MB (4,194,304)

  // USB Serial identification
  USB_FILTERS: [
    { usbVendorId: 0x1a86 }, // WCH CH340 / CH341 / CH343 USB-UART Bridge
    { usbVendorId: 0x303a }, // Espressif ESP32-S3 Native USB-JTAG/Serial & CDC
    { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
    { usbVendorId: 0x0403 }, // FTDI
  ],

  // Baud rates
  BAUDRATE_ROM: 115200,
  BAUDRATE_FLASH: 460800,

  // Magic values
  PARTITION_TABLE_MAGIC: 0x50aa,
  SECURE_CERT_TLV_MAGIC: 0xba5eba11,
  APP_DESC_MAGIC: 0xabcd5432,
  ERASED_32: 0xffffffff,

  // Offsets and Sizes
  PARTITION_TABLE: { offset: 0x00c000, size: 0x001000 }, // 4 KB
  SECURE_CERT: { offset: 0x00d000, size: 0x002000 },     // 8 KB
  NVS: { offset: 0x00f000, size: 0x004000 },             // 16 KB
  OTADATA: { offset: 0x013000, size: 0x002000 },         // 8 KB
  PHY_INIT: { offset: 0x015000, size: 0x001000 },        // 4 KB

  APP_FACTORY: { offset: 0x020000, size: 0x400000, name: 'factory' as const }, // 4 MB
  APP_OTA_0: { offset: 0x420000, size: 0x400000, name: 'ota_0' as const },     // 4 MB
  APP_OTA_1: { offset: 0x820000, size: 0x400000, name: 'ota_1' as const },     // 4 MB

  NVS_KEY: { offset: 0xc20000, size: 0x001000 },         // 4 KB
  SPIFFS: { offset: 0xc21000, size: 0x300000 },          // 3 MB
} as const;

export interface AppPartitionDef {
  name: 'factory' | 'ota_0' | 'ota_1';
  offset: number;
  size: number;
}

export const APP_PARTITIONS: readonly AppPartitionDef[] = [
  WG1200_CONSTANTS.APP_FACTORY,
  WG1200_CONSTANTS.APP_OTA_0,
  WG1200_CONSTANTS.APP_OTA_1,
];

export interface ProtectedRegionDef {
  name: string;
  offset: number;
  size: number;
}

export const PROTECTED_REGIONS: readonly ProtectedRegionDef[] = [
  { name: 'partition_table', ...WG1200_CONSTANTS.PARTITION_TABLE },
  { name: 'esp_secure_cert', ...WG1200_CONSTANTS.SECURE_CERT },
  { name: 'nvs', ...WG1200_CONSTANTS.NVS },
  { name: 'otadata', ...WG1200_CONSTANTS.OTADATA },
  { name: 'phy_init', ...WG1200_CONSTANTS.PHY_INIT },
  { name: 'nvs_key', ...WG1200_CONSTANTS.NVS_KEY },
  { name: 'spiffs', ...WG1200_CONSTANTS.SPIFFS },
];
