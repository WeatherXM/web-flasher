import { WG1200_CONSTANTS } from './constants';

export interface OtadataSectorStatus {
  seq: number;
  state: number;
  crc: number;
  expectedCrc: number;
  valid: boolean;
  erased: boolean;
}

export interface OtadataStatus {
  activeSlot: 'factory' | 'ota_0' | 'ota_1';
  targetSlot: 'ota_0' | 'ota_1';
  targetOffset: number;
  nextSeq: number;
  targetSector: 0 | 1;
  activeSeq: number;
  activeSector: 0 | 1 | null;
  isAmbiguous: boolean;
  sector0: OtadataSectorStatus;
  sector1: OtadataSectorStatus;
  description: string;
}

// Precomputed CRC32 table (polynomial 0xEDB88320)
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

/**
 * Computes ESP-IDF standard CRC32 for the 4-byte sequence number.
 * Mirrors esp_rom_crc32_le(UINT32_MAX, (uint8_t*)&s->ota_seq, 4).
 */
export function calculateOtaSeqCrc32(seq: number): number {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, seq >>> 0, true);

  // In ESP-IDF / zlib with initVal = 0xFFFFFFFF:
  // initial crc = (0xFFFFFFFF ^ 0xFFFFFFFF) = 0
  let crc = 0;
  for (let i = 0; i < 4; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Parses one 4 KB otadata sector.
 */
export function parseOtadataSector(bytes: Uint8Array): OtadataSectorStatus {
  if (bytes.byteLength < 32) {
    return {
      seq: 0,
      state: 0,
      crc: 0,
      expectedCrc: 0,
      valid: false,
      erased: false,
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, 32);
  const seq = view.getUint32(0, true);
  const state = view.getUint32(24, true);
  const crc = view.getUint32(28, true);

  const erased = seq === WG1200_CONSTANTS.ERASED_32;
  const expectedCrc = erased ? WG1200_CONSTANTS.ERASED_32 : calculateOtaSeqCrc32(seq);
  const valid = !erased && seq > 0 && crc === expectedCrc;

  return {
    seq,
    state,
    crc,
    expectedCrc,
    valid,
    erased,
  };
}

/**
 * Evaluates the full 8192-byte otadata partition and determines the active and next boot slots.
 */
export function determineActiveBootSlot(otadataBytes: Uint8Array): OtadataStatus {
  const s0Bytes = otadataBytes.subarray(0, 4096);
  const s1Bytes = otadataBytes.subarray(4096, 8192);

  const s0 = parseOtadataSector(s0Bytes);
  const s1 = parseOtadataSector(s1Bytes);

  // Case 1: Fresh or factory reset (both erased or invalid)
  if (!s0.valid && !s1.valid) {
    const isCleanErased = s0.erased && s1.erased;
    return {
      activeSlot: 'factory',
      targetSlot: 'ota_0',
      targetOffset: WG1200_CONSTANTS.APP_OTA_0.offset,
      nextSeq: 1,
      targetSector: 0,
      activeSeq: 0,
      activeSector: null,
      isAmbiguous: !isCleanErased,
      sector0: s0,
      sector1: s1,
      description: isCleanErased
        ? 'Factory firmware active (clean otadata). Target will be OTA_0.'
        : 'Otadata sectors invalid. Reverting to factory slot and repairing pointer to OTA_0.',
    };
  }

  // Case 2: One valid sector
  let activeSeq = 0;
  let activeSector: 0 | 1 = 0;

  if (s0.valid && !s1.valid) {
    activeSeq = s0.seq;
    activeSector = 0;
  } else if (s1.valid && !s0.valid) {
    activeSeq = s1.seq;
    activeSector = 1;
  } else {
    // Both sectors valid: select higher sequence (with rollover check if near 0xFFFFFFFF)
    if (s0.seq >= s1.seq) {
      activeSeq = s0.seq;
      activeSector = 0;
    } else {
      activeSeq = s1.seq;
      activeSector = 1;
    }
  }

  // Map active sequence to partition:
  // seq 1 -> (1-1)%2 = 0 -> ota_0
  // seq 2 -> (2-1)%2 = 1 -> ota_1
  // seq 3 -> (3-1)%2 = 0 -> ota_0
  const slotIndex = (activeSeq - 1) % 2;
  const activeSlot: 'ota_0' | 'ota_1' = slotIndex === 0 ? 'ota_0' : 'ota_1';

  // Toggle to the other OTA slot
  const targetSlot: 'ota_0' | 'ota_1' = activeSlot === 'ota_0' ? 'ota_1' : 'ota_0';
  const targetOffset =
    targetSlot === 'ota_0'
      ? WG1200_CONSTANTS.APP_OTA_0.offset
      : WG1200_CONSTANTS.APP_OTA_1.offset;
  const targetSector: 0 | 1 = activeSector === 0 ? 1 : 0;
  const nextSeq = activeSeq + 1;

  return {
    activeSlot,
    targetSlot,
    targetOffset,
    nextSeq,
    targetSector,
    activeSeq,
    activeSector,
    isAmbiguous: false,
    sector0: s0,
    sector1: s1,
    description: `Currently active slot: ${activeSlot} (sequence ${activeSeq}). Next target: ${targetSlot}.`,
  };
}

/**
 * Builds an 8192-byte otadata image with the updated target sequence and sector.
 */
export function buildUpdatedOtadata(
  existingOtadata: Uint8Array | null,
  nextSeq: number,
  targetSectorIdx: 0 | 1
): Uint8Array {
  const data = new Uint8Array(8192);
  if (existingOtadata && existingOtadata.byteLength === 8192) {
    data.set(existingOtadata);
  } else {
    data.fill(0xff);
  }

  const start = targetSectorIdx * 4096;
  const view = new DataView(data.buffer, data.byteOffset + start, 4096);

  // 1. ota_seq (uint32 LE)
  view.setUint32(0, nextSeq >>> 0, true);

  // 2. ota_label (20 bytes 0xFF)
  for (let i = 4; i < 24; i++) {
    data[start + i] = 0xff;
  }

  // 3. ota_state (uint32 LE): 0 = ESP_OTA_IMG_VALID
  view.setUint32(24, 0, true);

  // 4. crc (uint32 LE)
  const crc = calculateOtaSeqCrc32(nextSeq);
  view.setUint32(28, crc, true);

  return data;
}

/**
 * Builds an 8192-byte blank (all 0xFF) otadata image to rollback to factory firmware.
 */
export function buildResetOtadata(): Uint8Array {
  const data = new Uint8Array(8192);
  data.fill(0xff);
  return data;
}
