/**
 * Minimal CBOR (RFC 8949) codec covering what MCUmgr/SMP uses.
 *
 * Zephyr's zcbor encodes maps and arrays with INDEFINITE length
 * (0xBF ... 0xFF / 0x9F ... 0xFF) by default, so the decoder must handle
 * additional-info 31 for strings, arrays and maps.
 */

export type CborValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | Uint8Array
  | CborValue[]
  | { [key: string]: CborValue };

export function cborEncode(value: CborValue): Uint8Array {
  const parts: Uint8Array[] = [];

  const pushHead = (major: number, n: number) => {
    if (n < 24) {
      parts.push(new Uint8Array([(major << 5) | n]));
    } else if (n < 0x100) {
      parts.push(new Uint8Array([(major << 5) | 24, n]));
    } else if (n < 0x10000) {
      parts.push(new Uint8Array([(major << 5) | 25, (n >> 8) & 0xff, n & 0xff]));
    } else if (n < 0x100000000) {
      parts.push(
        new Uint8Array([(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]),
      );
    } else {
      const b = new Uint8Array(9);
      b[0] = (major << 5) | 27;
      new DataView(b.buffer).setBigUint64(1, BigInt(n));
      parts.push(b);
    }
  };

  const encodeValue = (v: CborValue): void => {
    if (v === null || v === undefined) {
      parts.push(new Uint8Array([0xf6]));
    } else if (typeof v === 'boolean') {
      parts.push(new Uint8Array([v ? 0xf5 : 0xf4]));
    } else if (typeof v === 'number') {
      if (Number.isInteger(v)) {
        if (v >= 0) pushHead(0, v);
        else pushHead(1, -1 - v);
      } else {
        const b = new Uint8Array(9);
        b[0] = 0xfb;
        new DataView(b.buffer).setFloat64(1, v);
        parts.push(b);
      }
    } else if (typeof v === 'string') {
      const enc = new TextEncoder().encode(v);
      pushHead(3, enc.length);
      parts.push(enc);
    } else if (v instanceof Uint8Array) {
      pushHead(2, v.length);
      parts.push(v);
    } else if (Array.isArray(v)) {
      pushHead(4, v.length);
      for (const item of v) encodeValue(item);
    } else if (typeof v === 'object') {
      const keys = Object.keys(v);
      pushHead(5, keys.length);
      for (const k of keys) {
        encodeValue(k);
        encodeValue(v[k]);
      }
    } else {
      throw new Error(`Unsupported CBOR type: ${typeof v}`);
    }
  };

  encodeValue(value);

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const BREAK = Symbol('break');

export function cborDecode(u8: Uint8Array): CborValue {
  let pos = 0;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const need = (n: number) => {
    if (pos + n > u8.length) throw new Error('Unexpected end of CBOR buffer');
  };

  const readUint = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return u8[pos++];
    }
    if (info === 25) {
      need(2);
      const v = view.getUint16(pos);
      pos += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = view.getUint32(pos);
      pos += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      const v = Number(view.getBigUint64(pos));
      pos += 8;
      return v;
    }
    throw new Error(`Invalid uint additional info: ${info}`);
  };

  const decodeValue = (allowBreak = false): CborValue | typeof BREAK => {
    need(1);
    const initial = u8[pos++];
    const major = initial >> 5;
    const info = initial & 0x1f;

    if (initial === 0xff) {
      if (!allowBreak) throw new Error('Unexpected CBOR break');
      return BREAK;
    }

    switch (major) {
      case 0:
        return readUint(info);
      case 1:
        return -1 - readUint(info);
      case 2:
      case 3: {
        let bytes: Uint8Array;
        if (info === 31) {
          const chunks: Uint8Array[] = [];
          for (;;) {
            const c = decodeValue(true);
            if (c === BREAK) break;
            chunks.push(typeof c === 'string' ? new TextEncoder().encode(c) : (c as Uint8Array));
          }
          bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
          let o = 0;
          for (const c of chunks) {
            bytes.set(c, o);
            o += c.length;
          }
        } else {
          const len = readUint(info);
          if (pos + len > u8.length) throw new Error('CBOR string runs past end of buffer');
          bytes = u8.subarray(pos, pos + len);
          pos += len;
        }
        return major === 2 ? bytes : new TextDecoder().decode(bytes);
      }
      case 4: {
        const arr: CborValue[] = [];
        if (info === 31) {
          for (;;) {
            const v = decodeValue(true);
            if (v === BREAK) break;
            arr.push(v);
          }
        } else {
          const len = readUint(info);
          for (let i = 0; i < len; i++) arr.push(decodeValue() as CborValue);
        }
        return arr;
      }
      case 5: {
        const obj: { [key: string]: CborValue } = {};
        if (info === 31) {
          for (;;) {
            const k = decodeValue(true);
            if (k === BREAK) break;
            obj[String(k)] = decodeValue() as CborValue;
          }
        } else {
          const len = readUint(info);
          for (let i = 0; i < len; i++) {
            const k = decodeValue();
            obj[String(k)] = decodeValue() as CborValue;
          }
        }
        return obj;
      }
      case 6:
        // Tag: skip the tag number, return the tagged value
        readUint(info);
        return decodeValue();
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 24) {
          pos += 1;
          return undefined;
        }
        if (info === 25) {
          // Half float: not used by SMP
          pos += 2;
          return undefined;
        }
        if (info === 26) {
          need(4);
          const v = view.getFloat32(pos);
          pos += 4;
          return v;
        }
        if (info === 27) {
          need(8);
          const v = view.getFloat64(pos);
          pos += 8;
          return v;
        }
        return undefined;
      }
      default:
        throw new Error(`Unsupported CBOR major type: ${major}`);
    }
  };

  return decodeValue() as CborValue;
}
