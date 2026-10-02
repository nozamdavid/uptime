import { describe, expect, it } from 'vitest';
import {
  advanceOutage,
  classifyRound,
  initialOutageState,
  reminderDue,
  type RoundOutcome,
} from './notification-state.js';
const rules = { outageThreshold: 3, recoveryThreshold: 2, repeatNotificationMinutes: 5 };
const at = (minute: number) => new Date(Date.UTC(2026, 8, 16, 12, minute)).toISOString();

describe('outage notification decisions', () => {
  it('counts scheduled rounds rather than individual regional failures', () => {
    expect(classifyRound(3, 3, 3)).toBe('failure');
    expect(classifyRound(3, 1, 1)).toBe('failure');
    expect(classifyRound(3, 1, 0)).toBe('unknown');
    expect(classifyRound(3, 0, 0)).toBe('unknown');
    expect(classifyRound(3, 3, 0)).toBe('healthy');
  });
  it('opens once at threshold, recovers once at threshold, and keeps the start time', () => {
    let state = initialOutageState();
    const events = [];
    for (const [index, outcome] of (
      [
        'failure',
        'failure',
        'failure',
        'failure',
        'healthy',
        'healthy',
        'healthy',
      ] as RoundOutcome[]
    ).entries()) {
      const result = advanceOutage(state, outcome, rules, at(index));
      state = result.state;
      events.push(result.event);
      if (index === 2) expect(state.outageStartedAt).toBe(at(0));
    }
    expect(events).toEqual([null, null, 'outage', null, null, 'recovery', null]);
    expect(state.status).toBe('healthy');
  });
  it('breaks failure and recovery streaks on unknown evidence', () => {
    let state = initialOutageState();
    for (const outcome of ['failure', 'failure', 'unknown', 'failure'] as const)
      state = advanceOutage(state, outcome, rules, at(0)).state;
    expect(state.status).toBe('healthy');
    expect(state.failureStreak).toBe(1);
    state = { ...state, status: 'down', successStreak: 1 };
    state = advanceOutage(state, 'unknown', rules, at(1)).state;
    expect(advanceOutage(state, 'healthy', rules, at(2)).event).toBeNull();
  });
  it('only repeats after the configured interval while still down', () => {
    const state = { ...initialOutageState(), status: 'down' as const, lastReminderAt: at(0) };
    expect(reminderDue(state, rules, at(4))).toBe(false);
    expect(reminderDue(state, rules, at(5))).toBe(true);
    expect(reminderDue(state, { ...rules, repeatNotificationMinutes: null }, at(20))).toBe(false);
    expect(reminderDue({ ...state, status: 'healthy' }, rules, at(20))).toBe(false);
  });
});
