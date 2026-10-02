import type { Badge } from '@uptime/contracts';
import type { CSSProperties } from 'react';

export function MonitorBadge({ badge }: { badge: Badge | null | undefined }) {
  return badge ? (
    <span className="monitor-badge" style={{ '--badge-color': badge.color } as CSSProperties}>
      {badge.name}
    </span>
  ) : null;
}
