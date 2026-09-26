/**
 * DOM helpers shared by the WS1300 pages. They bind to the markup in
 * src/components/ws1300/*.astro by element id.
 */

import type { DfuProgress } from './dfu';
import type { DfuImage } from './dfuPackage';
import type { ImageSlotState } from './smp';

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

export const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '–';
  const s = Math.ceil(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

export const coreName = (imageIndex: number) => (imageIndex === 0 ? 'Main (app core)' : 'Radio (network core)');

// ---------------------------------------------------------------------------
// Event log (EventLog.astro)

const TAG_COLOR: Record<string, string> = {
  BLE: 'text-wxm-zenith',
  NUS: 'text-violet-300',
  DFU: 'text-emerald-300',
  INFO: 'text-wxm-mist',
  WARN: 'text-amber-300',
  ERROR: 'text-red-400',
};

export interface EventLog {
  log: (msg: string, tag?: string) => void;
}

export function createEventLog(filePrefix: string): EventLog {
  const box = $('ws-log');
  const count = $('ws-log-count');
  const filter = $<HTMLSelectElement>('ws-log-filter');
  const entries: string[] = [];

  const applyFilter = (row: HTMLElement) => {
    const f = filter.value;
    row.hidden = f !== 'ALL' && row.dataset.tag !== f;
  };

  const log = (msg: string, tag = 'INFO') => {
    const now = new Date();
    const time = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    entries.push(`[${time}] [${tag}] ${msg}`);

    const row = document.createElement('div');
    row.dataset.tag = tag;
    const t = document.createElement('span');
    t.className = 'text-wxm-mist/70';
    t.textContent = `${time} `;
    const g = document.createElement('span');
    g.className = `${TAG_COLOR[tag] ?? 'text-wxm-mist'} font-semibold`;
    g.textContent = `${tag.padEnd(5)} `;
    const m = document.createElement('span');
    m.textContent = msg;
    row.append(t, g, m);
    applyFilter(row);
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
    count.textContent = String(entries.length);
  };

  filter.addEventListener('change', () => box.querySelectorAll<HTMLElement>('[data-tag]').forEach(applyFilter));
  $('ws-log-clear').addEventListener('click', () => {
    entries.length = 0;
    box.replaceChildren();
    count.textContent = '0';
  });
  $('ws-log-download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([entries.join('\n') + '\n'], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filePrefix}_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return { log };
}

/** Open the log panel, e.g. when something failed and the details matter. */
export function openEventLog(): void {
  const panel = document.getElementById('ws-log-panel') as HTMLDetailsElement | null;
  if (panel) panel.open = true;
}

// ---------------------------------------------------------------------------
// Slot table (SlotTable.astro)

export function renderSlots(states: ImageSlotState[]): void {
  const body = $('slots-body');
  body.replaceChildren();
  if (states.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="5" class="px-3 py-3 text-center text-wxm-mist font-sans">The station reported no image slots.</td>';
    body.appendChild(tr);
    return;
  }
  for (const s of [...states].sort((a, b) => a.image - b.image || a.slot - b.slot)) {
    const flags = [
      s.active && 'running',
      s.confirmed && 'confirmed',
      s.pending && 'installs on next boot',
      s.permanent && 'permanent',
      !s.active && !s.pending && s.bootable && 'ready',
    ].filter(Boolean);
    const tr = document.createElement('tr');
    const cells = [coreName(s.image), String(s.slot), `v${s.version}`, flags.join(', ') || '–', s.hash ? `${s.hash.slice(0, 12)}…` : '–'];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.className = `px-3 py-2 ${i === 0 ? 'font-sans text-white' : 'text-wxm-cloud'}`;
      td.textContent = text;
      if (i === 4) td.title = s.hash;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// Update progress (DfuProgress.astro)

type StepState = 'idle' | 'active' | 'done' | 'error' | 'skipped';

export class ProgressView {
  private readonly root = $('dfu-progress');

  show(): void {
    this.root.hidden = false;
    this.root.classList.remove('hidden');
    $('dfu-result').classList.add('hidden');
    $('dfu-spinner').classList.remove('hidden');
    $('dfu-bar').style.width = '0%';
    $('dfu-pct').textContent = '0%';
    $('dfu-bytes').textContent = '0 / 0 KB';
    $('dfu-speed').textContent = '–';
    $('dfu-eta').textContent = '–';
    this.root.querySelectorAll<HTMLElement>('.dfu-step').forEach((li) => {
      li.dataset.state = 'idle';
      li.querySelector('.step-detail')!.textContent = '';
    });
    this.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  status(title: string, detail: string): void {
    $('dfu-title').textContent = title;
    $('dfu-status').textContent = detail;
  }

  step(id: string, state: StepState, detail?: string): void {
    const li = this.root.querySelector<HTMLElement>(`.dfu-step[data-step="${id}"]`);
    if (!li) return;
    li.dataset.state = state;
    const dot = li.querySelector('.step-dot')!;
    const index = Array.from(this.root.querySelectorAll('.dfu-step')).indexOf(li) + 1;
    dot.textContent = state === 'done' ? '✓' : state === 'error' ? '!' : String(index);
    if (detail !== undefined) li.querySelector('.step-detail')!.textContent = detail;
  }

  /** Mark the step that was running as failed. */
  failActive(): void {
    const li = this.root.querySelector<HTMLElement>('.dfu-step[data-state="active"]');
    if (li?.dataset.step) this.step(li.dataset.step, 'error');
  }

  planImages(images: DfuImage[]): void {
    const app = images.find((i) => i.imageIndex === 0);
    const net = images.find((i) => i.imageIndex === 1);
    this.step('app', app ? 'idle' : 'skipped', app ? `${kb(app.size)} · v${app.version}` : 'not in this package');
    this.step('net', net ? 'idle' : 'skipped', net ? kb(net.size) : 'not in this package');
  }

  update(p: DfuProgress, images: DfuImage[]): void {
    if (p.stage === 'upload') {
      const current = images[p.imageIdx];
      for (let i = 0; i < images.length; i++) {
        const id = images[i].imageIndex === 0 ? 'app' : 'net';
        if (i < p.imageIdx) this.step(id, 'done');
        else if (i === p.imageIdx) this.step(id, 'active');
      }
      this.status('Sending firmware to the station', `${coreName(current.imageIndex)} · keep this tab open and stay close.`);
    } else {
      for (const img of images) this.step(img.imageIndex === 0 ? 'app' : 'net', 'done');
      if (p.stage === 'mark') {
        this.step('schedule', 'active');
        this.status('Scheduling the install', 'Telling the station to install the new firmware on its next start.');
      } else if (p.stage === 'reset' || p.stage === 'done') {
        this.step('schedule', 'done');
        this.step('restart', 'active');
      }
    }
    $('dfu-bar').style.width = `${p.percentage.toFixed(1)}%`;
    $('dfu-pct').textContent = `${p.percentage.toFixed(0)}%`;
    $('dfu-bytes').textContent = `${kb(p.bytesDone)} / ${kb(p.bytesTotal)}`;
    $('dfu-speed').textContent = p.speedKbps > 0 ? `${p.speedKbps.toFixed(1)} KB/s` : '–';
    $('dfu-eta').textContent = p.stage === 'upload' ? formatDuration(p.etaSeconds) : '–';
  }

  result(kind: 'success' | 'warning' | 'error', title: string, msg: string, actions: { label: string; primary?: boolean; onClick: () => void }[] = []): void {
    $('dfu-spinner').classList.add('hidden');
    const box = $('dfu-result');
    box.classList.remove('hidden', 'border-emerald-500/40', 'bg-emerald-500/10', 'border-warning/50', 'bg-warning/10', 'border-wxm-error/40', 'bg-wxm-error/10');
    const tone = {
      success: ['border-emerald-500/40', 'bg-emerald-500/10', 'text-wxm-live', 'M5 13l4 4L19 7'],
      warning: ['border-warning/50', 'bg-warning/10', 'text-warning', 'M12 9v4m0 4h.01'],
      error: ['border-wxm-error/40', 'bg-wxm-error/10', 'text-wxm-error', 'M6 18L18 6M6 6l12 12'],
    }[kind];
    box.classList.add(tone[0], tone[1]);
    $('dfu-result-icon').innerHTML = `<svg class="w-5 h-5 ${tone[2]}" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="${tone[3]}"/></svg>`;
    $('dfu-result-title').textContent = title;
    $('dfu-result-msg').textContent = msg;
    const bar = $('dfu-result-actions');
    bar.replaceChildren();
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.className = a.primary
        ? 'px-4 py-2 rounded-control text-xs font-bold btn-primary-beacon cursor-pointer'
        : 'px-4 py-2 rounded-control text-xs font-bold text-white border border-wxm-cloud/20 bg-wxm-storm/50 hover:bg-wxm-storm cursor-pointer';
      b.addEventListener('click', a.onClick);
      bar.appendChild(b);
    }
  }
}

// ---------------------------------------------------------------------------
// Keep the screen on and warn before leaving while an update runs

export class UpdateGuard {
  private wakeLock: { release(): Promise<void> } | null = null;
  private readonly onBeforeUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = '';
  };

  async start(): Promise<void> {
    window.addEventListener('beforeunload', this.onBeforeUnload);
    try {
      const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
      this.wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      // Not granted; the update still works, the screen may just dim
    }
  }

  stop(): void {
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }
}
