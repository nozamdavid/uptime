import { defaultUptimeThresholds, type UptimeThresholds } from '@uptime/contracts';
import type { UptimeDay } from './api.js';
import { formatLatency, formatPercentage } from './status-page-format.js';

export function uptimeSeverity(
  uptimePercentage: number | null,
  thresholds: UptimeThresholds = defaultUptimeThresholds,
) {
  if (uptimePercentage === null) return 'unknown';
  if (uptimePercentage > thresholds.green) return 'green';
  if (uptimePercentage > thresholds.lightGreen) return 'light-green';
  if (uptimePercentage >= thresholds.orange) return 'orange';
  return 'red';
}

export function UptimeStrip({
  days,
  label,
  thresholds = defaultUptimeThresholds,
}: {
  days: UptimeDay[];
  label: string;
  thresholds?: UptimeThresholds | undefined;
}) {
  return (
    <span className="uptime-days" aria-label={label}>
      {days.map((day) => {
        const severity = uptimeSeverity(day.uptimePercentage, thresholds);
        return (
          <span
            className={`uptime-day uptime-day--${severity}`}
            key={day.date}
            role="img"
            aria-label={`${day.date}: ${formatPercentage(day.uptimePercentage)} uptime, ${formatLatency(day.averageResponseMs)} average response`}
          >
            <span className="uptime-day__tooltip">
              <strong>
                {new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, {
                  timeZone: 'UTC',
                })}
              </strong>
              <span>{formatPercentage(day.uptimePercentage)} uptime</span>
              <span>{formatLatency(day.averageResponseMs)} average response</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}
