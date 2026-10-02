import { useEffect, useMemo, useState } from 'react';

import { assessFreshness, type FreshnessAssessment, type SnapshotFreshness } from './reports.js';

const freshnessTickMs = 1_000;

/** Keep a loaded report's age current even when no network refresh is running. */
export function useSnapshotFreshness(
  snapshot: Pick<
    SnapshotFreshness,
    'generatedAt' | 'latestObservationAt' | 'staleAfterSeconds'
  > | null,
): FreshnessAssessment | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!snapshot) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), freshnessTickMs);
    return () => window.clearInterval(timer);
  }, [snapshot]);

  return useMemo(
    () => (snapshot ? assessFreshness(snapshot, new Date(now)) : null),
    [now, snapshot],
  );
}
