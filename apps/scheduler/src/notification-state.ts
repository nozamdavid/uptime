export interface OutageState {
  status: 'healthy' | 'down';
  failureStreak: number;
  successStreak: number;
  outageStartedAt: string | null;
  lastReminderAt: string | null;
}
export interface OutageRules {
  outageThreshold: number;
  recoveryThreshold: number;
  repeatNotificationMinutes: number | null;
}
export type RoundOutcome = 'failure' | 'healthy' | 'unknown';
export type OutageEvent = 'outage' | 'recovery' | 'reminder';
export const initialOutageState = (): OutageState => ({
  status: 'healthy',
  failureStreak: 0,
  successStreak: 0,
  outageStartedAt: null,
  lastReminderAt: null,
});

export function classifyRound(expected: number, received: number, failures: number): RoundOutcome {
  if (failures > 0) return 'failure';
  return expected > 0 && received === expected ? 'healthy' : 'unknown';
}

export function advanceOutage(
  state: OutageState,
  outcome: RoundOutcome,
  rules: OutageRules,
  at: string,
): { state: OutageState; event: OutageEvent | null } {
  const next = { ...state };
  if (outcome === 'unknown') {
    next.failureStreak = 0;
    next.successStreak = 0;
    if (next.status === 'healthy') next.outageStartedAt = null;
    return { state: next, event: null };
  }
  if (outcome === 'failure') {
    next.failureStreak = Math.min(rules.outageThreshold, next.failureStreak + 1);
    next.successStreak = 0;
    next.outageStartedAt ??= at;
    if (next.status === 'healthy' && next.failureStreak >= rules.outageThreshold) {
      next.status = 'down';
      next.lastReminderAt = at;
      return { state: next, event: 'outage' };
    }
  } else {
    next.failureStreak = 0;
    next.successStreak = Math.min(rules.recoveryThreshold, next.successStreak + 1);
    if (next.status === 'healthy') next.outageStartedAt = null;
    if (next.status === 'down' && next.successStreak >= rules.recoveryThreshold) {
      next.status = 'healthy';
      next.outageStartedAt = null;
      next.lastReminderAt = null;
      return { state: next, event: 'recovery' };
    }
  }
  return { state: next, event: null };
}

export function reminderDue(state: OutageState, rules: OutageRules, now: string): boolean {
  return (
    state.status === 'down' &&
    rules.repeatNotificationMinutes !== null &&
    state.lastReminderAt !== null &&
    Date.parse(now) - Date.parse(state.lastReminderAt) >= rules.repeatNotificationMinutes * 60_000
  );
}
