/**
 * WS1300 over-the-air update: upload every image of a package over SMP, mark the
 * new images for test and reset. MCUboot swaps on the next boot, and the WS1300
 * application confirms itself early in main() (imgswap_confirm), so an image that
 * boots stays and one that crashes before that point is reverted.
 */

import type { DfuImage } from './dfuPackage';
import type { ImageSlotState, LogFn, SMPClient } from './smp';

export type DfuStage = 'upload' | 'mark' | 'reset' | 'done';

export interface DfuProgress {
  stage: DfuStage;
  /** Index into the images array of the image being uploaded */
  imageIdx: number;
  imageCount: number;
  bytesDone: number;
  bytesTotal: number;
  percentage: number;
  speedKbps: number;
  etaSeconds: number;
}

export interface DfuCallbacks {
  log: LogFn;
  onProgress: (p: DfuProgress) => void;
  /** Called right before the reset command, so the caller can expect the link drop */
  beforeReset?: () => void;
}

/** Secondary-slot images that were just uploaded and still need a test mark. */
export function imagesToMarkForTest(states: ImageSlotState[]): ImageSlotState[] {
  return states.filter((s) => s.slot === 1 && !s.active && s.hashBytes.length > 0 && !s.pending);
}

export async function runDfu(smp: SMPClient, images: DfuImage[], cb: DfuCallbacks): Promise<void> {
  const bytesTotal = images.reduce((n, i) => n + i.size, 0);
  const start = performance.now();
  let done = 0;

  const report = (stage: DfuStage, imageIdx: number, bytesDone: number) => {
    const elapsed = Math.max(0.1, (performance.now() - start) / 1000);
    const speedKbps = bytesDone / 1024 / elapsed;
    cb.onProgress({
      stage,
      imageIdx,
      imageCount: images.length,
      bytesDone,
      bytesTotal,
      percentage: Math.min(100, (bytesDone / bytesTotal) * 100),
      speedKbps,
      etaSeconds: speedKbps > 0 ? (bytesTotal - bytesDone) / (speedKbps * 1024) : 0,
    });
  };

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    cb.log(`Uploading ${img.core === 'app' ? 'application' : 'network'} core image ${img.name} (${(img.size / 1024).toFixed(1)} KB)`, 'DFU');
    report('upload', i, done);
    await smp.uploadImage(img.data, img.imageIndex, (p) => report('upload', i, done + p.offset));
    done += img.size;
  }

  report('mark', images.length - 1, done);
  const states = await smp.readImageStates();
  const toMark = imagesToMarkForTest(states);
  if (toMark.length === 0) {
    throw new Error('The station did not report the uploaded image in its update slot. Nothing was installed.');
  }
  let marked = 0;
  for (const s of toMark) {
    try {
      const rsp = await smp.markImageForTest(s.hashBytes);
      if (typeof rsp.rc === 'number' && rsp.rc !== 0) throw new Error(`rc ${rsp.rc}`);
      marked++;
      cb.log(`Image ${s.image} v${s.version} marked to install on next boot.`, 'DFU');
    } catch (err) {
      cb.log(`Could not mark image ${s.image} v${s.version}: ${err instanceof Error ? err.message : String(err)}`, 'WARN');
    }
  }
  if (marked === 0) {
    throw new Error('The station refused to schedule the update. Nothing was installed; the current firmware keeps running.');
  }

  report('reset', images.length - 1, done);
  cb.beforeReset?.();
  cb.log('Restarting the station to install the update.', 'DFU');
  await smp.reset();
  report('done', images.length - 1, done);
}

/** The running application-core version, from an SMP image state list. */
export function runningAppVersion(states: ImageSlotState[]): string | null {
  const s = states.find((x) => x.image === 0 && x.slot === 0) ?? states.find((x) => x.slot === 0 && x.active);
  return s?.version ?? null;
}
