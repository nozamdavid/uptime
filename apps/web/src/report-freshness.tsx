import { useSnapshotFreshness } from './use-snapshot-freshness.js';
import type { SnapshotFreshness } from './reports.js';

/** Render report age in an isolated component so its clock doesn't rerender charts. */
export function ReportFreshness({
  snapshot,
  monitorName,
  className = '',
  ariaLabel,
  observationDate = 'locale',
}: {
  snapshot: Pick<
    SnapshotFreshness,
    'generatedAt' | 'latestObservationAt' | 'staleAfterSeconds'
  > | null;
  monitorName?: string;
  className?: string;
  ariaLabel?: string;
  observationDate?: 'locale' | 'medium';
}) {
  const freshness = useSnapshotFreshness(snapshot);
  if (!freshness) return null;

  const label = ariaLabel ?? `${monitorName ?? 'Public'} report freshness`;
  const observationTime = freshness.latestObservationAt
    ? observationDate === 'medium'
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(
          new Date(freshness.latestObservationAt),
        )
      : new Date(freshness.latestObservationAt).toLocaleString()
    : null;

  return (
    <div
      className={`report-freshness report-freshness--${freshness.state}${
        className ? ` ${className}` : ''
      }`}
      data-state={freshness.state}
      role="status"
      aria-label={label}
    >
      <span className="report-freshness__badge">
        {freshness.state === 'fresh'
          ? 'Snapshot'
          : freshness.state === 'stale'
            ? 'Stale snapshot'
            : 'Snapshot age unknown'}
      </span>
      <span className="report-freshness__detail">{freshness.detail}</span>
      {freshness.latestObservationAt && observationTime && (
        <span className="report-freshness__observation tnum">
          Latest observation <time dateTime={freshness.latestObservationAt}>{observationTime}</time>
        </span>
      )}
    </div>
  );
}
