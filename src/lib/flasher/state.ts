export type FlasherState =
  | 'unsupported'
  | 'idle'
  | 'connecting'
  | 'inspecting'
  | 'ready'
  | 'downloading'
  | 'flashing'
  | 'verifying-flash'
  | 'verifying-protected-data'
  | 'rebooting'
  | 'success'
  | 'error';

export interface StateContext {
  state: FlasherState;
  statusMessage: string;
  errorMessage?: string;
  progressPercent: number;
  writtenToFlash: boolean;
  canRetry: boolean;
}

const VALID_TRANSITIONS: Record<FlasherState, readonly FlasherState[]> = {
  unsupported: [],
  idle: ['connecting', 'unsupported', 'error'],
  connecting: ['inspecting', 'idle', 'error'],
  inspecting: ['ready', 'idle', 'error'],
  ready: ['downloading', 'connecting', 'idle', 'error'],
  downloading: ['flashing', 'error'],
  flashing: ['verifying-flash', 'error'],
  'verifying-flash': ['verifying-protected-data', 'error'],
  'verifying-protected-data': ['rebooting', 'error'],
  rebooting: ['success', 'error'],
  success: ['idle', 'ready'],
  error: ['idle', 'connecting', 'ready'],
};

export class FlasherStateMachine {
  private currentContext: StateContext;
  private listeners: Array<(context: StateContext) => void> = [];

  constructor(initialState: FlasherState = 'idle') {
    this.currentContext = {
      state: initialState,
      statusMessage: 'Ready to connect',
      progressPercent: 0,
      writtenToFlash: false,
      canRetry: true,
    };
  }

  public get context(): Readonly<StateContext> {
    return this.currentContext;
  }

  public get state(): FlasherState {
    return this.currentContext.state;
  }

  public canTransitionTo(targetState: FlasherState): boolean {
    const allowed = VALID_TRANSITIONS[this.currentContext.state];
    return allowed ? allowed.includes(targetState) : false;
  }

  public transition(
    targetState: FlasherState,
    statusMessage?: string,
    options?: Partial<Omit<StateContext, 'state' | 'statusMessage'>>
  ): void {
    if (!this.canTransitionTo(targetState)) {
      throw new Error(
        `Illegal state transition: cannot move from '${this.currentContext.state}' to '${targetState}'`
      );
    }

    this.currentContext = {
      ...this.currentContext,
      state: targetState,
      statusMessage: statusMessage ?? this.getDefaultStatus(targetState),
      ...options,
    };

    this.notify();
  }

  public setError(errorMessage: string, writtenToFlash = false): void {
    this.currentContext = {
      ...this.currentContext,
      state: 'error',
      statusMessage: 'Operation failed',
      errorMessage,
      writtenToFlash,
      canRetry: true,
    };
    this.notify();
  }

  public setProgress(percent: number, message?: string): void {
    this.currentContext = {
      ...this.currentContext,
      progressPercent: Math.min(100, Math.max(0, percent)),
      statusMessage: message ?? this.currentContext.statusMessage,
    };
    this.notify();
  }

  public subscribe(listener: (context: StateContext) => void): () => void {
    this.listeners.push(listener);
    listener(this.currentContext);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.currentContext);
      } catch (e) {
        console.error('Error in state machine listener:', e);
      }
    }
  }

  private getDefaultStatus(state: FlasherState): string {
    switch (state) {
      case 'unsupported':
        return 'Web Serial is not supported in this browser';
      case 'idle':
        return 'Ready to connect';
      case 'connecting':
        return 'Connecting to WG1200…';
      case 'inspecting':
        return 'Verifying hardware and partition layout…';
      case 'ready':
        return 'WG1200 verified. Ready to choose firmware.';
      case 'downloading':
        return 'Downloading signed firmware…';
      case 'flashing':
        return 'Writing application firmware…';
      case 'verifying-flash':
        return 'Verifying flash integrity (MD5)…';
      case 'verifying-protected-data':
        return 'Checking protected partitions…';
      case 'rebooting':
        return 'Restarting device…';
      case 'success':
        return 'Installation completed successfully';
      case 'error':
        return 'An error occurred';
    }
  }
}
