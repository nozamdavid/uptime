import { first, nowIso, run, type D1Database } from '@uptime/cloudflare';

export interface RetentionCheckpoint {
  observationsBefore?: string;
  checkRunsBefore?: string;
  networkDiagnosticsBefore?: string;
  complete?: boolean;
}

export interface CoordinatorMetrics {
  updatedAt: string;
  lastTickAt: string;
  dueMonitors: number;
  roundsClaimed: number;
  roundsFinalized: number;
  observationsInserted: number;
  roundsPartial: number;
  unknownRounds: number;
  reportsPublished: number;
  reportsFailed: number;
  staleRounds: number;
  staleDiagnostics: number;
  retention: {
    observationsDeleted: number;
    checkRunsDeleted: number;
    networkDiagnosticsDeleted: number;
    sessionsDeleted: number;
    deliveriesDeleted: number;
    notificationHistoryDeleted: number;
  };
  lastError: string | null;
  queryWork: Record<
    string,
    { statements: number; rowsRead: number; rowsWritten: number; unmeasured: number }
  >;
}

export function emptyMetrics(now: Date): CoordinatorMetrics {
  return {
    updatedAt: nowIso(now),
    lastTickAt: nowIso(now),
    dueMonitors: 0,
    roundsClaimed: 0,
    roundsFinalized: 0,
    observationsInserted: 0,
    roundsPartial: 0,
    unknownRounds: 0,
    reportsPublished: 0,
    reportsFailed: 0,
    staleRounds: 0,
    staleDiagnostics: 0,
    retention: {
      observationsDeleted: 0,
      checkRunsDeleted: 0,
      networkDiagnosticsDeleted: 0,
      sessionsDeleted: 0,
      deliveriesDeleted: 0,
      notificationHistoryDeleted: 0,
    },
    lastError: null,
    queryWork: {},
  };
}

export function parseCheckpoint(raw: string | null): RetentionCheckpoint {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as RetentionCheckpoint;
  } catch {
    return {};
  }
}

export interface RetentionConfig {
  readonly detailedResultsRetentionDays: number;
  readonly dnsDiagnosticsRetentionDays: number;
  readonly retentionBatchSize: number;
  readonly historyRetentionPreserveBefore?: string;
}

export interface RetentionResult {
  observationsDeleted: number;
  checkRunsDeleted: number;
  networkDiagnosticsDeleted: number;
  sessionsDeleted: number;
  deliveriesDeleted: number;
  notificationHistoryDeleted: number;
  complete: boolean;
  checkpoint: RetentionCheckpoint;
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/**
 * Delete expired detailed data in small batches, advancing a persisted
 * checkpoint so repeated invocations make bounded progress. Exact daily
 * aggregates are maintained by triggers before deletion and are deliberately
 * not decremented, preserving long-term history.
 *
 * Only finalized rounds (`status <> 'pending' AND finalized_at IS NOT NULL`)
 * are eligible. Pending/unprocessed rounds and their observations are always
 * preserved so a late finalization can never lose uptime that has not yet been
 * aggregated. `check_runs` are deleted only once they have no remaining
 * observations, so the `observations` ON DELETE CASCADE never removes an
 * unaggregated row and never silently exceeds the batch bound. Pending
 * diagnostics are likewise preserved until the coordinator finalizes them.
 *
 * The cutoff is frozen on the first pass (`checkpoint.*Before`) so a long
 * cleanup does not chase the moving wall clock between invocations. The
 * completeness probe uses `EXISTS` short-circuits rather than counting the
 * entire eligible history on every invocation.
 */
export async function runRetention(
  db: D1Database,
  now: Date,
  config: RetentionConfig,
  checkpoint: RetentionCheckpoint,
): Promise<RetentionResult> {
  const batch = config.retentionBatchSize;
  const observationsBefore =
    checkpoint.observationsBefore ?? isoDaysAgo(now, config.detailedResultsRetentionDays);
  const checkRunsBefore =
    checkpoint.checkRunsBefore ?? isoDaysAgo(now, config.detailedResultsRetentionDays);
  const networkDiagnosticsBefore =
    checkpoint.networkDiagnosticsBefore ?? isoDaysAgo(now, config.dnsDiagnosticsRetentionDays);
  const preserveBefore = config.historyRetentionPreserveBefore ?? '0000-01-01T00:00:00.000Z';

  const observations = await run(
    db,
    `DELETE FROM observations WHERE id IN (
       SELECT o.id FROM observations o INDEXED BY observations_created_at_idx
       CROSS JOIN check_runs cr ON cr.id = o.check_run_id
       WHERE o.created_at > ? AND o.created_at < ?
         AND cr.status IN ('complete', 'partial')
         AND cr.finalized_at IS NOT NULL
       ORDER BY o.created_at ASC LIMIT ?
     )`,
    [preserveBefore, observationsBefore, batch],
  );
  const checkRuns = await run(
    db,
    `DELETE FROM check_runs WHERE id IN (
       SELECT cr.id FROM check_runs cr INDEXED BY check_runs_retention_idx
       WHERE cr.created_at > ? AND cr.created_at < ?
         AND cr.status IN ('complete', 'partial')
         AND cr.finalized_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.check_run_id = cr.id)
       ORDER BY cr.created_at ASC LIMIT ?
     )`,
    [preserveBefore, checkRunsBefore, batch],
  );
  // Pending diagnostics are unresolved reservations; deleting them could race
  // a late `persistDiagnostic` and silently drop evidence. They are finalized
  // as stale by the coordinator within a minute, so excluding them only delays
  // cleanup by one batch at most.
  const diagnostics = await run(
    db,
    `DELETE FROM network_diagnostics WHERE id IN (
       SELECT id FROM network_diagnostics INDEXED BY network_diagnostics_retention_idx
       WHERE created_at > ? AND created_at < ? AND lifecycle <> 'pending'
       ORDER BY created_at ASC LIMIT ?
     )`,
    [preserveBefore, networkDiagnosticsBefore, batch],
  );
  const sessions = await run(
    db,
    `DELETE FROM sessions WHERE id IN (
       SELECT id FROM sessions WHERE expires_at < ? ORDER BY expires_at ASC LIMIT ?
     )`,
    [nowIso(now), batch],
  );
  const deliveries = await run(
    db,
    `DELETE FROM notification_deliveries WHERE id IN (
       SELECT id FROM notification_deliveries INDEXED BY notification_deliveries_retention_idx
       WHERE created_at > ? AND created_at < ? AND status IN ('sent', 'cancelled', 'failed')
       ORDER BY created_at ASC LIMIT ?
     )`,
    [preserveBefore, isoDaysAgo(now, 90), batch],
  );
  const notificationHistory = await run(
    db,
    `DELETE FROM notification_history WHERE id IN (
       SELECT id FROM notification_history INDEXED BY notification_history_retention_idx
       WHERE created_at > ? AND created_at < ?
       ORDER BY created_at ASC, id ASC LIMIT ?
     )`,
    [preserveBefore, isoDaysAgo(now, 90), batch],
  );

  const remaining = await first<{ c: number }>(
    db,
    `SELECT (
       EXISTS (
         SELECT 1 FROM observations o INDEXED BY observations_created_at_idx
         CROSS JOIN check_runs cr ON cr.id = o.check_run_id
         WHERE o.created_at > ? AND o.created_at < ?
           AND cr.status IN ('complete', 'partial')
           AND cr.finalized_at IS NOT NULL
       )
       OR EXISTS (
         SELECT 1 FROM check_runs cr INDEXED BY check_runs_retention_idx
         WHERE cr.created_at > ? AND cr.created_at < ?
           AND cr.status IN ('complete', 'partial')
           AND cr.finalized_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.check_run_id = cr.id)
       )
       OR EXISTS (
         SELECT 1 FROM network_diagnostics INDEXED BY network_diagnostics_retention_idx
         WHERE created_at > ? AND created_at < ? AND lifecycle <> 'pending'
       )
     ) AS c`,
    [
      preserveBefore,
      observationsBefore,
      preserveBefore,
      checkRunsBefore,
      preserveBefore,
      networkDiagnosticsBefore,
    ],
  );
  const complete = (remaining?.c ?? 0) === 0;
  return {
    observationsDeleted: observations.meta.changes,
    checkRunsDeleted: checkRuns.meta.changes,
    networkDiagnosticsDeleted: diagnostics.meta.changes,
    sessionsDeleted: sessions.meta.changes,
    deliveriesDeleted: deliveries.meta.changes,
    notificationHistoryDeleted: notificationHistory.meta.changes,
    complete,
    // Persist fresh cutoffs only when starting a new pass.
    checkpoint: complete
      ? {}
      : {
          observationsBefore,
          checkRunsBefore,
          networkDiagnosticsBefore,
        },
  };
}

export async function countStaleRounds(
  db: D1Database,
  now: Date,
  staleSeconds: number,
): Promise<number> {
  const row = await first<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM check_runs WHERE status = 'pending' AND deadline_at <= ?`,
    [nowIso(new Date(now.getTime() - staleSeconds * 1_000))],
  );
  return row?.c ?? 0;
}
