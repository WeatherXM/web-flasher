/**
 * WS1300 DFU package parsing: nRF Connect SDK `-dfu.zip` (manifest.json +
 * app core and network core images) or a single MCUboot `.bin`.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { sha256Hex } from '../flasher/hashing';

export const MCUBOOT_IMAGE_MAGIC = 0x96f3b83d;

export interface McubootHeader {
  loadAddr: number;
  hdrSize: number;
  imgSize: number;
  flags: number;
  major: number;
  minor: number;
  revision: number;
  buildNum: number;
  /** Same format the station reports over SMP, e.g. "22.4.0" or "22.4.0.7" */
  version: string;
}

export interface DfuImage {
  /** File name inside the package */
  name: string;
  /** MCUboot image index: 0 = application core, 1 = network core */
  imageIndex: number;
  core: 'app' | 'net';
  data: Uint8Array;
  size: number;
  sha256: string;
  version: string;
  header: McubootHeader;
}

/**
 * Decode the MCUboot image header (little-endian):
 *   u32 magic, u32 load_addr, u16 hdr_size, u16 protect_tlv_size, u32 img_size,
 *   u32 flags, u8 major, u8 minor, u16 revision, u32 build_num
 */
export function parseMcubootHeader(data: Uint8Array): McubootHeader | null {
  if (data.length < 28) return null;
  const v = new DataView(data.buffer, data.byteOffset, 32 <= data.byteLength ? 32 : data.byteLength);
  if (v.getUint32(0, true) !== MCUBOOT_IMAGE_MAGIC) return null;

  const major = v.getUint8(20);
  const minor = v.getUint8(21);
  const revision = v.getUint16(22, true);
  const buildNum = v.getUint32(24, true);
  return {
    loadAddr: v.getUint32(4, true),
    hdrSize: v.getUint16(8, true),
    imgSize: v.getUint32(12, true),
    flags: v.getUint32(16, true),
    major,
    minor,
    revision,
    buildNum,
    version: `${major}.${minor}.${revision}` + (buildNum ? `.${buildNum}` : ''),
  };
}

const isZip = (u8: Uint8Array) => u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;

async function toImage(name: string, data: Uint8Array, imageIndex: number): Promise<DfuImage> {
  const header = parseMcubootHeader(data);
  if (!header) {
    throw new Error(`${name} is not an MCUboot image (magic 0x96f3b83d missing)`);
  }
  if (header.hdrSize + header.imgSize > data.length) {
    throw new Error(`${name} is truncated: header says ${header.hdrSize + header.imgSize} bytes, file has ${data.length}`);
  }
  return {
    name,
    imageIndex,
    core: imageIndex === 0 ? 'app' : 'net',
    data,
    size: data.length,
    sha256: await sha256Hex(data),
    version: header.version,
    header,
  };
}

interface ZipManifestFile {
  file?: string;
  image_index?: string | number;
  board?: string;
}

/**
 * Parse a DFU package. Images come back ordered by image index, app core first.
 * Throws with a readable message when the file is not a usable WS1300 package.
 */
export async function parseDfuPackage(bytes: Uint8Array, fileName = 'package'): Promise<DfuImage[]> {
  if (!isZip(bytes)) {
    return [await toImage(fileName, bytes, 0)];
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    throw new Error(`Could not open ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const images: DfuImage[] = [];

  if (entries['manifest.json']) {
    let manifest: { files?: ZipManifestFile[] };
    try {
      manifest = JSON.parse(strFromU8(entries['manifest.json']));
    } catch {
      throw new Error(`${fileName} has an unreadable manifest.json`);
    }
    for (const f of manifest.files ?? []) {
      if (!f.file) continue;
      const data = entries[f.file];
      if (!data) throw new Error(`${fileName}: manifest lists ${f.file} but the file is missing`);
      const idx = Number.parseInt(String(f.image_index ?? 0), 10);
      if (!Number.isInteger(idx) || idx < 0 || idx > 1) {
        throw new Error(`${fileName}: unexpected image_index ${String(f.image_index)} for ${f.file}`);
      }
      images.push(await toImage(f.file, data, idx));
    }
  } else {
    // No manifest: take every .bin, network core if the name says so
    for (const [name, data] of Object.entries(entries)) {
      if (!name.toLowerCase().endsWith('.bin')) continue;
      images.push(await toImage(name, data, /net/i.test(name) ? 1 : 0));
    }
  }

  if (images.length === 0) throw new Error(`${fileName} contains no firmware images`);
  const seen = new Set<number>();
  for (const img of images) {
    if (seen.has(img.imageIndex)) throw new Error(`${fileName} contains two images for the same core`);
    seen.add(img.imageIndex);
  }
  return images.sort((a, b) => a.imageIndex - b.imageIndex);
}
