import { describe, it, expect } from 'vitest';
import { cborDecode, cborEncode } from '../../src/lib/ble/cbor';

describe('cbor', () => {
  it('round-trips the values SMP uses', () => {
    const value = {
      off: 0,
      len: 571779,
      image: 1,
      data: new Uint8Array([1, 2, 3, 250]),
      confirm: false,
      big: 2 ** 33,
      neg: -500,
      name: 'app_update.bin',
      list: [1, 'two', null, true],
    };
    const decoded = cborDecode(cborEncode(value)) as Record<string, unknown>;
    expect(decoded.off).toBe(0);
    expect(decoded.len).toBe(571779);
    expect(decoded.big).toBe(2 ** 33);
    expect(decoded.neg).toBe(-500);
    expect(Array.from(decoded.data as Uint8Array)).toEqual([1, 2, 3, 250]);
    expect(decoded.confirm).toBe(false);
    expect(decoded.name).toBe('app_update.bin');
    expect(decoded.list).toEqual([1, 'two', null, true]);
  });

  it('encodes integer heads with the shortest form', () => {
    expect(Array.from(cborEncode(23))).toEqual([0x17]);
    expect(Array.from(cborEncode(24))).toEqual([0x18, 24]);
    expect(Array.from(cborEncode(256))).toEqual([0x19, 1, 0]);
    expect(Array.from(cborEncode(65536))).toEqual([0x1a, 0, 1, 0, 0]);
  });

  it('decodes zcbor indefinite-length maps and arrays (image state response)', () => {
    // {"images": [{"slot": 0, "version": "22.4.0", "active": true}]} with 0xBF/0x9F ... 0xFF
    const enc = new TextEncoder();
    const str = (s: string) => [0x60 | s.length, ...enc.encode(s)];
    const bytes = new Uint8Array([
      0xbf,
      ...str('images'),
      0x9f,
      0xbf,
      ...str('slot'), 0x00,
      ...str('version'), ...str('22.4.0'),
      ...str('active'), 0xf5,
      0xff,
      0xff,
      0xff,
    ]);
    expect(cborDecode(bytes)).toEqual({ images: [{ slot: 0, version: '22.4.0', active: true }] });
  });

  it('decodes indefinite-length byte strings', () => {
    const bytes = new Uint8Array([0x5f, 0x42, 1, 2, 0x41, 3, 0xff]);
    expect(Array.from(cborDecode(bytes) as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('rejects truncated input instead of reading past the end', () => {
    expect(() => cborDecode(new Uint8Array([0x19, 0x01]))).toThrow();
    expect(() => cborDecode(new Uint8Array([0x65, 0x61]))).toThrow();
    expect(() => cborDecode(new Uint8Array([0xbf, 0x61, 0x61]))).toThrow();
  });
});
