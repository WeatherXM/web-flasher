/**
 * The full WS1300 update as the pages run it: optional download, upload, schedule,
 * restart, then reconnect and check which version came up.
 */

import { runDfu, runningAppVersion } from './dfu';
import type { DfuImage } from './dfuPackage';
import { compareVersions, downloadRelease, type Ws1300Release } from './ws1300Manifest';
import { errMsg, isChooserCancelled, sleep, type Ws1300Session } from './ws1300Session';
import { openEventLog, type ProgressView, UpdateGuard } from './ui';
import type { ImageSlotState, LogFn } from './smp';
import { trackTelemetry } from '../telemetry';

/** MCUboot needs roughly this long to swap both cores before the app advertises again. */
const SWAP_WAIT_SECONDS = 45;

export type UpdateSource = { kind: 'release'; release: Ws1300Release } | { kind: 'file'; images: DfuImage[]; name: string };

export interface UpdateFlowDeps {
  session: Ws1300Session;
  progress: ProgressView;
  log: LogFn;
  /** Called with fresh slot states whenever the flow reads them */
  onStates?: (states: ImageSlotState[]) => void;
  /** Called when the flow ends, whatever the outcome */
  onFinished?: () => void;
}

export async function runUpdateFlow(source: UpdateSource, deps: UpdateFlowDeps): Promise<void> {
  const { session, progress, log } = deps;
  const guard = new UpdateGuard();
  let images: DfuImage[] = [];
  let restarted = false;

  await guard.start();
  session.setUpdating(true);
  progress.show();

  const fwLabel = source.kind === 'release' ? source.release.label : source.name;
  trackTelemetry({
    device_type: 'ws1300',
    serial_number: session.deviceName,
    action: 'flash_started',
    firmware_target: fwLabel,
    status: 'in_progress',
  });

  try {
    if (source.kind === 'release') {
      progress.status('Downloading firmware', `${source.release.label} from flash.weatherxm.com`);
      progress.step('download', 'active');
      images = await downloadRelease(source.release);
      progress.step('download', 'done', `${source.release.label} · checksum OK`);
      log(`Downloaded ${source.release.file} and verified its SHA-256.`, 'DFU');
    } else {
      progress.step('download', 'skipped', source.name);
      images = source.images;
    }
    progress.planImages(images);

    const smp = session.smp;
    if (!smp || !session.connected) throw new Error('The station is not connected.');

    await runDfu(smp, images, {
      log,
      onProgress: (p) => progress.update(p, images),
      beforeReset: () => {
        restarted = true;
        session.expectDisconnect();
      },
    });
    progress.step('restart', 'done');
  } catch (err) {
    progress.failActive();
    log(`Update failed: ${errMsg(err)}`, 'ERROR');
    openEventLog();
    trackTelemetry({
      device_type: 'ws1300',
      serial_number: session.deviceName,
      action: 'flash_failed',
      firmware_target: fwLabel,
      status: 'failed',
      details: { error: errMsg(err) },
    });
    progress.result(
      'error',
      'The update did not finish',
      restarted
        ? `${errMsg(err)} The station was already told to restart; reconnect to check which version it runs.`
        : `${errMsg(err)} Nothing was installed, so your station keeps running its current firmware. Move closer to the station and try again.`,
      [{ label: 'Close', onClick: () => progress.hide() }],
    );
    guard.stop();
    session.setUpdating(false);
    deps.onFinished?.();
    return;
  }

  guard.stop();
  const expected = images.find((i) => i.imageIndex === 0)?.version ?? images[0].version;
  await verifyAfterRestart(expected, deps, true);
}

/**
 * Wait for the swap, then reconnect and compare versions. The silent reconnect often
 * fails after a restart, and the browser only opens its device chooser from a click,
 * so on failure we ask the user to press "Reconnect to station".
 */
export async function verifyAfterRestart(expected: string, deps: UpdateFlowDeps, wait: boolean): Promise<void> {
  const { session, progress, log } = deps;
  progress.step('verify', 'active');

  if (wait) {
    for (let s = SWAP_WAIT_SECONDS; s > 0; s--) {
      progress.status('Installing on the station', `The station is installing the update. Reconnecting in ${s} s…`);
      await sleep(1000);
    }
  }

  try {
    progress.status('Reconnecting', 'Trying to reach the station again…');
    await session.reconnect();
    await checkRunningVersion(expected, deps);
  } catch (err) {
    log(`Automatic reconnect failed: ${errMsg(err)}`, 'WARN');
    askToReconnect(expected, deps);
  } finally {
    session.setUpdating(false);
    deps.onFinished?.();
  }
}

/** Show a button that opens the device chooser; it has to come from a user click. */
function askToReconnect(expected: string, deps: UpdateFlowDeps): void {
  const { session, progress, log } = deps;
  progress.status('Reconnect to check the update', 'Pick your station again so we can check the installed version.');
  progress.result(
    'warning',
    'Reconnect to check the update',
    'The station has restarted. Your browser needs you to pick it again: click Reconnect and choose "WeatherXM WS1300". If it is not listed yet, wait a few seconds and try again.',
    [
      {
        label: 'Reconnect to station',
        primary: true,
        onClick: async () => {
          try {
            await session.connect();
          } catch (err) {
            if (!isChooserCancelled(err)) log(`Reconnect failed: ${errMsg(err)}`, 'WARN');
            askToReconnect(expected, deps);
            return;
          }
          progress.step('verify', 'active');
          progress.status('Checking', 'Reading the installed version…');
          try {
            await checkRunningVersion(expected, deps);
          } catch (err) {
            log(`Version check failed: ${errMsg(err)}`, 'WARN');
            askToReconnect(expected, deps);
          }
        },
      },
      { label: 'Skip the check', onClick: () => progress.hide() },
    ],
  );
}

async function checkRunningVersion(expected: string, deps: UpdateFlowDeps): Promise<void> {
  const { session, progress, log } = deps;
  const states = await session.smp!.readImageStates();
  deps.onStates?.(states);
  const running = runningAppVersion(states) ?? 'unknown';
  log(`Station is running v${running} (expected v${expected}).`, 'DFU');

  if (compareVersions(running, expected) === 0) {
    progress.step('verify', 'done', `v${running}`);
    progress.status('Update complete', `Your station is running v${running}.`);
    const confirmed = states.some((s) => s.image === 0 && s.slot === 0 && s.confirmed);
    log(confirmed ? 'New image is confirmed.' : 'New image is not confirmed yet.', 'DFU');
    trackTelemetry({
      device_type: 'ws1300',
      serial_number: session.deviceName,
      action: 'flash_completed',
      firmware_target: `v${running}`,
      status: 'success',
    });
    progress.result('success', `Your station is running v${running}`, `The update is installed${confirmed ? ' and the station has confirmed it' : ''}. You can disconnect now; the station goes back to normal operation on its own.`, [
      { label: 'Disconnect', primary: true, onClick: () => session.disconnect() },
    ]);
  } else {
    progress.step('verify', 'error', `v${running}`);
    openEventLog();
    trackTelemetry({
      device_type: 'ws1300',
      serial_number: session.deviceName,
      action: 'flash_failed',
      firmware_target: `v${expected}`,
      status: 'failed',
      details: { running: `v${running}` },
    });
    progress.result(
      'warning',
      `The station is still on v${running}`,
      'The new firmware did not take over, so the station kept or went back to its previous version. It is working normally. Download the technical log and send it to WeatherXM support.',
      [{ label: 'Close', onClick: () => progress.hide() }],
    );
  }
}
