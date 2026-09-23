import SparkMD5 from 'spark-md5';

/**
 * Computes SHA-256 hex string using standard Web Crypto API.
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data as ArrayBufferView<ArrayBuffer>);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Computes MD5 hex string using SparkMD5 for flash MD5 verification.
 */
export function md5Hex(data: Uint8Array): string {
  const spark = new SparkMD5.ArrayBuffer();
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  spark.append(copy.buffer as ArrayBuffer);
  return spark.end();
}

/**
 * Safe case-insensitive comparison of hex hashes.
 */
export function compareHexHashes(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
