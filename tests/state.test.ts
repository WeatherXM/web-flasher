import { describe, it, expect } from 'vitest';
import { FlasherStateMachine } from '../src/lib/flasher/state';

describe('state machine', () => {
  it('starts in idle state by default', () => {
    const sm = new FlasherStateMachine();
    expect(sm.state).toBe('idle');
    expect(sm.context.progressPercent).toBe(0);
  });

  it('allows valid sequential flashing transitions', () => {
    const sm = new FlasherStateMachine();
    expect(sm.canTransitionTo('connecting')).toBe(true);
    sm.transition('connecting');

    expect(sm.canTransitionTo('inspecting')).toBe(true);
    sm.transition('inspecting');

    expect(sm.canTransitionTo('ready')).toBe(true);
    sm.transition('ready');

    expect(sm.canTransitionTo('downloading')).toBe(true);
    sm.transition('downloading');

    expect(sm.canTransitionTo('flashing')).toBe(true);
    sm.transition('flashing');

    expect(sm.canTransitionTo('verifying-flash')).toBe(true);
    sm.transition('verifying-flash');

    expect(sm.canTransitionTo('verifying-protected-data')).toBe(true);
    sm.transition('verifying-protected-data');

    expect(sm.canTransitionTo('rebooting')).toBe(true);
    sm.transition('rebooting');

    expect(sm.canTransitionTo('success')).toBe(true);
    sm.transition('success');
  });

  it('disallows jumping directly to flashing from idle', () => {
    const sm = new FlasherStateMachine();
    expect(sm.canTransitionTo('flashing')).toBe(false);
    expect(() => sm.transition('flashing')).toThrow(/Illegal state transition/);
  });

  it('supports error transition and recovery', () => {
    const sm = new FlasherStateMachine();
    sm.transition('connecting');
    sm.setError('Port busy', false);
    expect(sm.state).toBe('error');
    expect(sm.context.errorMessage).toBe('Port busy');

    // Can transition back to connecting or idle from error
    expect(sm.canTransitionTo('connecting')).toBe(true);
    sm.transition('connecting');
    expect(sm.state).toBe('connecting');
  });

  it('notifies subscribers on state updates', () => {
    const sm = new FlasherStateMachine();
    let updates = 0;
    const unsub = sm.subscribe(() => {
      updates++;
    });

    // Initial subscriber call
    expect(updates).toBe(1);

    sm.transition('connecting');
    expect(updates).toBe(2);

    sm.setProgress(50, 'Halfway there');
    expect(updates).toBe(3);
    expect(sm.context.progressPercent).toBe(50);

    unsub();
    sm.transition('inspecting');
    expect(updates).toBe(3); // No more updates after unsub
  });
});
