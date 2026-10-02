import type { IntervalSeconds, RegionId } from '@uptime/contracts';
import { checkIntervalPresets } from '@uptime/contracts';

export function checkFrequencySliderIndex(intervalSeconds: IntervalSeconds): number {
  return Math.max(0, checkIntervalPresets.indexOf(intervalSeconds));
}

export function intervalSecondsForSliderIndex(index: number): IntervalSeconds {
  const boundedIndex = Math.max(0, Math.min(checkIntervalPresets.length - 1, Math.round(index)));
  return checkIntervalPresets[boundedIndex]!;
}

export function expectedChecksPerDay(
  regionIds: readonly RegionId[],
  intervalSeconds: IntervalSeconds,
): number {
  return regionIds.length * (86_400 / intervalSeconds);
}

export function expectedDnsSnapshotsPerDay(
  regionIds: readonly RegionId[],
  enabled: boolean,
): number {
  return enabled ? regionIds.length : 0;
}

export function isValidTimeout(timeoutMs: number, intervalSeconds: IntervalSeconds): boolean {
  return timeoutMs >= 1_000 && timeoutMs <= 30_000 && timeoutMs < intervalSeconds * 1_000;
}
