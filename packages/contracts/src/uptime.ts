import type { MonitorUptimeData, UptimeDay } from './report-types.js';

export function uptimeWindow(currentTime: Date): {
  today: Date;
  since: Date;
  dayKeys: string[];
} {
  const today = new Date(currentTime);
  today.setUTCHours(0, 0, 0, 0);
  const since = new Date(today);
  since.setUTCDate(since.getUTCDate() - 89);
  const dayKeys = Array.from({ length: 90 }, (_, index) => {
    const day = new Date(since);
    day.setUTCDate(day.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
  return { today, since, dayKeys };
}

/** Aggregate source-specific daily measurements without changing their fallback rules. */
export function summarizeUptimeDays(
  dayKeys: readonly string[],
  measurement: (date: string) => Omit<UptimeDay, 'date'> & { weight: number },
): Omit<MonitorUptimeData, 'recoveryStatus'> {
  let totalWeight = 0;
  let weightedUptime = 0;
  const days = dayKeys.map((date) => {
    const { weight, ...day } = measurement(date);
    if (day.uptimePercentage !== null) {
      totalWeight += weight;
      weightedUptime += day.uptimePercentage * weight;
    }
    return { date, ...day };
  });
  const measured = days.filter((day) => day.uptimePercentage !== null);
  return {
    uptimePercentage: totalWeight === 0 ? null : weightedUptime / totalWeight,
    status:
      measured.length === 0
        ? 'unknown'
        : (measured.at(-1)?.uptimePercentage ?? 0) === 100
          ? 'up'
          : 'down',
    days,
  };
}
