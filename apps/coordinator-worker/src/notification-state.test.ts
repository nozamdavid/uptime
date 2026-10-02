import { describe, expect, it } from 'vitest';

import {
  advanceOutage,
  classifyRound,
  initialOutageState,
  reminderDue,
  type OutageState,
} from './notification-state.js';

const rules = { outageThreshold: 3, recoveryThreshold: 2, repeatNotificationMinutes: 30 };

describe('outage semantics', () => {
  it('treats missing regions as unknown, never healthy', () => {
    expect(classifyRound(3, 3, 0)).toBe('healthy');
    expect(classifyRound(3, 2, 0)).toBe('unknown');
    expect(classifyRound(3, 0, 0)).toBe('unknown');
    // A missing region plus a real failure is still a failure.
    expect(classifyRound(3, 2, 1)).toBe('failure');
  });

  it('raises an outage only once the consecutive failure threshold is reached', () => {
    let state: OutageState = initialOutageState();
    const first = advanceOutage(state, 'failure', rules, '2026-09-20T10:00:00.000Z');
    state = first.state;
    expect(first.event).toBeNull();
    expect(state.failureStreak).toBe(1);
    expect(state.outageStartedAt).toBe('2026-09-20T10:00:00.000Z');

    const second = advanceOutage(state, 'failure', rules, '2026-09-20T10:01:00.000Z');
    state = second.state;
    expect(second.event).toBeNull();

    const third = advanceOutage(state, 'failure', rules, '2026-09-20T10:02:00.000Z');
    expect(third.event).toBe('outage');
    expect(third.state.status).toBe('down');
    expect(third.state.lastReminderAt).toBe('2026-09-20T10:02:00.000Z');
  });

  it('recovers only after the consecutive success threshold', () => {
    let state: OutageState = {
      ...initialOutageState(),
      status: 'down',
      outageStartedAt: '2026-09-20T10:00:00.000Z',
    };
    const first = advanceOutage(state, 'healthy', rules, '2026-09-20T10:05:00.000Z');
    expect(first.event).toBeNull();
    expect(first.state.successStreak).toBe(1);

    const second = advanceOutage(first.state, 'healthy', rules, '2026-09-20T10:06:00.000Z');
    expect(second.event).toBe('recovery');
    expect(second.state.status).toBe('healthy');
    expect(second.state.outageStartedAt).toBeNull();
  });

  it('resets streaks on unknown without clearing a real outage', () => {
    const down = { ...initialOutageState(), status: 'down' as const, failureStreak: 3 };
    const result = advanceOutage(down, 'unknown', rules, '2026-09-20T10:10:00.000Z');
    expect(result.event).toBeNull();
    expect(result.state.failureStreak).toBe(0);
    expect(result.state.status).toBe('down');
  });

  it('schedules reminders from the last reminder time', () => {
    const state = {
      ...initialOutageState(),
      status: 'down' as const,
      lastReminderAt: '2026-09-20T10:00:00.000Z',
    };
    expect(reminderDue(state, rules, '2026-09-20T10:29:59.000Z')).toBe(false);
    expect(reminderDue(state, rules, '2026-09-20T10:30:00.000Z')).toBe(true);
    expect(
      reminderDue(state, { ...rules, repeatNotificationMinutes: null }, '2026-09-21T00:00:00.000Z'),
    ).toBe(false);
  });
});
