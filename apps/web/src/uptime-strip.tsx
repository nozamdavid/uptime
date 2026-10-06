import { defaultUptimeThresholds, type UptimeThresholds } from '@uptime/contracts';
import type { UptimeDay } from './api.js';
import { formatLatency, formatPercentage } from './status-page-format.js';
import './monitor-design.css';

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
  compact = false,
  thresholds = defaultUptimeThresholds,
}: {
  days: UptimeDay[];
  label: string;
  compact?: boolean;
  thresholds?: UptimeThresholds | undefined;
}) {
  return (
    <span
      className={`uptime-days ut-strip__days ${compact ? 'ut-strip--compact' : ''}`.trim()}
      aria-label={label}
    >
      {days.map((day) => {
        const severity = uptimeSeverity(day.uptimePercentage, thresholds);
        let tokenClass = 'ut-day';
        if (severity === 'light-green') tokenClass = 'ut-day ut-day--soft';
        else if (severity === 'orange') tokenClass = 'ut-day ut-day--degraded';
        else if (severity === 'red') tokenClass = 'ut-day ut-day--down';
        else if (severity === 'unknown') tokenClass = 'ut-day ut-day--none';

        const downtimeMinutes =
          day.uptimePercentage !== null
            ? Math.round(((100 - day.uptimePercentage) / 100) * 1440)
            : null;

        return (
          <span
            className={`uptime-day uptime-day--${severity} ${tokenClass}`}
            key={day.date}
            tabIndex={0}
            role="img"
            aria-label={`${day.date}: ${formatPercentage(day.uptimePercentage)} uptime${downtimeMinutes !== null ? `, ${downtimeMinutes}m downtime` : ''}, ${formatLatency(day.averageResponseMs)} average response`}
          >
            <span className="uptime-day__tooltip" role="tooltip">
              <strong>
                {new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, {
                  timeZone: 'UTC',
                })}
              </strong>
              <span>{formatPercentage(day.uptimePercentage)} uptime</span>
              {downtimeMinutes !== null && <span>{downtimeMinutes}m downtime</span>}
              <span>{formatLatency(day.averageResponseMs)} average response</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}
