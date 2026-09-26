import { describe, it, expect } from 'vitest';
import { cborDecode, cborEncode } from '../../src/lib/ble/cbor';
import { encodeSmpFrame, SMPClient, type SmpCharacteristic, OP_READ_RSP, OP_WRITE_RSP, GROUP_IMAGE } from '../../src/lib/ble/smp';
import { imagesToMarkForTest, runDfu, runningAppVersion } from '../../src/lib/ble/dfu';
import type { DfuImage } from '../../src/lib/ble/dfuPackage';

/**
 * Fake SMP characteristic: reassembles written fragments into frames, lets the
 * test answer each request, and delivers the answer split over notifications.
 */
class FakeChar implements SmpCharacteristic {
  writes: Uint8Array[] = [];
  frames: { op: number; group: number; seq: number; cmd: number; body: Record<string, unknown> }[] = [];
  private listener: ((ev: Event) => void) | null = null;
  private pending = new Uint8Array(0);

  constructor(
    private readonly respond: (req: FakeChar['frames'][number]) => Record<string, unknown> | null,
    private readonly notifySize = 20,
  ) {}

  addEventListener(_t: string, l: (ev: Event) => void) {
    this.listener = l;
  }
  removeEventListener() {
    this.listener = null;
  }
  async startNotifications() {}
  async stopNotifications() {}

  async writeValueWithoutResponse(value: BufferSource) {
    const frag = new Uint8Array(value as ArrayBuffer);
    this.writes.push(frag);
    const merged = new Uint8Array(this.pending.length + frag.length);
    merged.set(this.pending);
    merged.set(frag, this.pending.length);
    this.pending = merged;

    const len = 8 + ((this.pending[2] << 8) | this.pending[3]);
    if (this.pending.length < len) return;
    const frame = this.pending.subarray(0, len);
    this.pending = new Uint8Array(0);

    const req = {
      op: frame[0],
      group: (frame[4] << 8) | frame[5],
      seq: frame[6],
      cmd: frame[7],
      body: cborDecode(frame.subarray(8)) as Record<string, unknown>,
    };
    this.frames.push(req);
    const answer = this.respond(req);
    if (!answer) return;
    const rsp = encodeSmpFrame(req.op + 1, req.group, req.seq, req.cmd, cborEncode(answer as never));
    setTimeout(() => {
      for (let i = 0; i < rsp.length; i += this.notifySize) {
        const part = rsp.slice(i, i + this.notifySize);
        this.listener?.({ target: { value: new DataView(part.buffer) } } as unknown as Event);
      }
    }, 0);
  }
}

const slotStates = (pendingSecondary = false) => ({
  images: [
    { image: 0, slot: 0, version: '22.3.0', hash: new Uint8Array(32).fill(1), active: true, confirmed: true },
    { image: 0, slot: 1, version: '22.4.0', hash: new Uint8Array(32).fill(2), pending: pendingSecondary },
    { image: 1, slot: 0, version: '22.3.0', hash: new Uint8Array(32).fill(3), active: true, confirmed: true },
    { image: 1, slot: 1, version: '22.4.0', hash: new Uint8Array(32).fill(4) },
  ],
});

const fakeImage = (imageIndex: number, size: number): DfuImage => ({
  name: imageIndex === 0 ? 'app_update.bin' : 'net_core_app_update.bin',
  imageIndex,
  core: imageIndex === 0 ? 'app' : 'net',
  data: new Uint8Array(size).map((_, i) => i & 0xff),
  size,
  sha256: '',
  version: '22.4.0',
  header: {} as DfuImage['header'],
});

describe('SMP client', () => {
  it('fragments writes to the ATT-safe size and reassembles split notifications', async () => {
    const chr = new FakeChar(() => slotStates(), 9);
    const smp = new SMPClient(chr);
    await smp.start();
    const states = await smp.readImageStates();

    expect(chr.writes.every((w) => w.length <= 180)).toBe(true);
    expect(states).toHaveLength(4);
    expect(states[0]).toMatchObject({ image: 0, slot: 0, version: '22.3.0', active: true, confirmed: true });
    expect(states[0].hash).toBe('01'.repeat(32));
    expect(runningAppVersion(states)).toBe('22.3.0');
  });

  it('uploads with len/sha only on the first chunk and follows the station offset', async () => {
    const chr = new FakeChar((req) => {
      if (req.group !== GROUP_IMAGE) return {};
      const off = req.body.off as number;
      const n = (req.body.data as Uint8Array).length;
      return { rc: 0, off: off + n };
    });
    const smp = new SMPClient(chr);
    await smp.start();
    const img = fakeImage(1, 1000);
    const seen: number[] = [];
    await smp.uploadImage(img.data, 1, (p) => seen.push(p.offset));

    const uploads = chr.frames.filter((f) => f.cmd === 1);
    expect(uploads[0].body.len).toBe(1000);
    expect(uploads[0].body.image).toBe(1);
    expect((uploads[0].body.sha as Uint8Array).length).toBe(32);
    expect(uploads[1].body.len).toBeUndefined();
    expect(seen[seen.length - 1]).toBe(1000);
    expect(chr.writes.every((w) => w.length <= 180)).toBe(true);
  });

  it('stops on a station error code', async () => {
    const chr = new FakeChar(() => ({ rc: 3 }));
    const smp = new SMPClient(chr);
    await smp.start();
    await expect(smp.uploadImage(new Uint8Array(10), 0)).rejects.toThrow(/code 3/);
  });

  it('times out when the station never answers', async () => {
    const chr = new FakeChar(() => null);
    const smp = new SMPClient(chr);
    await smp.start();
    await expect(smp.request(0, 1, 0, {}, 30)).rejects.toThrow(/timed out/);
  });
});

describe('DFU sequence', () => {
  it('uploads app then net core, marks both secondaries for test, then resets', async () => {
    const chr = new FakeChar((req) => {
      if (req.group === GROUP_IMAGE && req.cmd === 1) {
        return { rc: 0, off: (req.body.off as number) + (req.body.data as Uint8Array).length };
      }
      if (req.group === GROUP_IMAGE && req.cmd === 0) return req.op === 0 ? slotStates() : { rc: 0 };
      return {}; // reset
    });
    const smp = new SMPClient(chr);
    await smp.start();
    let beforeReset = false;
    const stages: string[] = [];
    await runDfu(smp, [fakeImage(0, 600), fakeImage(1, 300)], {
      log: () => {},
      onProgress: (p) => stages.push(p.stage),
      beforeReset: () => (beforeReset = true),
    });

    const ops = chr.frames.map((f) => `${f.op}:${f.group}:${f.cmd}`);
    // First chunk of each upload carries len; app core (no image field) goes first
    const starts = chr.frames.filter((f) => f.cmd === 1 && f.body.len !== undefined);
    expect(starts.map((f) => [f.body.image ?? 0, f.body.len])).toEqual([[0, 600], [1, 300]]);

    const marks = chr.frames.filter((f) => f.op === 2 && f.group === 1 && f.cmd === 0);
    expect(marks).toHaveLength(2);
    expect(marks.every((m) => m.body.confirm === false)).toBe(true);
    expect(ops[ops.length - 1]).toBe('2:0:5');
    expect(beforeReset).toBe(true);
    expect(stages).toContain('done');
  });

  it('does not reset when nothing could be scheduled', async () => {
    const chr = new FakeChar((req) => {
      if (req.cmd === 1) return { rc: 0, off: (req.body.off as number) + (req.body.data as Uint8Array).length };
      if (req.cmd === 0 && req.op === 0) return slotStates();
      if (req.cmd === 0) return { rc: 1 };
      return {};
    });
    const smp = new SMPClient(chr);
    await smp.start();
    await expect(runDfu(smp, [fakeImage(0, 100)], { log: () => {}, onProgress: () => {} })).rejects.toThrow(/refused/);
    expect(chr.frames.some((f) => f.group === 0 && f.cmd === 5)).toBe(false);
  });

  it('skips active and already-pending slots when choosing what to mark', () => {
    const states = [
      { image: 0, slot: 0, active: true, hashBytes: new Uint8Array(32), pending: false },
      { image: 0, slot: 1, active: false, hashBytes: new Uint8Array(32), pending: true },
      { image: 1, slot: 1, active: false, hashBytes: new Uint8Array(32), pending: false },
      { image: 1, slot: 1, active: false, hashBytes: new Uint8Array(0), pending: false },
    ] as never;
    expect(imagesToMarkForTest(states).map((s) => s.image)).toEqual([1]);
  });
});

// Keep the response op constants referenced so a renumbering shows up here
expect(OP_READ_RSP).toBe(1);
expect(OP_WRITE_RSP).toBe(3);
