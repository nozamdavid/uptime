import type { IntervalSeconds } from '@uptime/contracts';
import { intervalSecondsValues } from '@uptime/contracts';
export * from '@uptime/regions';

export const checkIntervalPresets: readonly IntervalSeconds[] = intervalSecondsValues;
export const timeoutConstraints = Object.freeze({ minimumMs: 1_000, maximumMs: 30_000 });
export const probeConstraints = Object.freeze({
  method: 'GET' as const,
  successStatusMinimum: 200,
  successStatusMaximum: 399,
  maxRedirects: 5,
  maxBodyBytes: 65_536,
});
export const rawObservationRetentionDays = 90;
