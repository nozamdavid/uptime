import { nowIso } from '@uptime/cloudflare';
import { pgFirst as first, pgRun as run, type Database } from '@uptime/cloudflare/postgres';
import type { QueryWorkByStage } from './query-metrics.js';

export interface RetentionCheckpoint {
  observationsBefore?: string;
  checkRunsBefore?: string;
  networkDiagnosticsBefore?: string;
  complete?: boolean;
}

export interface CoordinatorMetrics {
  regionalProbes?: Record<string, { attempts: number; failures: number; missingResults: number }>;
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
  queryWork: QueryWorkByStage;
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
    regionalProbes: {},
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
  db: Database,
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
    `DELETE FROM ${db.table('observations')} WHERE id IN (
       SELECT o.id FROM ${db.table('observations')} o
       JOIN ${db.table('check_runs')} cr ON cr.id = o.check_run_id
       WHERE o.created_at > $1 AND o.created_at < $2
         AND cr.status IN ('complete', 'partial')
         AND cr.finalized_at IS NOT NULL
       ORDER BY o.created_at ASC LIMIT $3
     )`,
    [preserveBefore, observationsBefore, batch],
  );
  const checkRuns = await run(
    db,
    `DELETE FROM ${db.table('check_runs')} WHERE id IN (
       SELECT cr.id FROM ${db.table('check_runs')} cr
       WHERE cr.created_at > $1 AND cr.created_at < $2
         AND cr.status IN ('complete', 'partial')
         AND cr.finalized_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${db.table('observations')} o WHERE o.check_run_id = cr.id)
       ORDER BY cr.created_at ASC LIMIT $3
     )`,
    [preserveBefore, checkRunsBefore, batch],
  );
  // Pending diagnostics are unresolved reservations; deleting them could race
  // a late `persistDiagnostic` and silently drop evidence. They are finalized
  // as stale by the coordinator within a minute, so excluding them only delays
  // cleanup by one batch at most.
  const diagnostics = await run(
    db,
    `DELETE FROM ${db.table('network_diagnostics')} WHERE id IN (
       SELECT id FROM ${db.table('network_diagnostics')}
       WHERE created_at > $1 AND created_at < $2 AND lifecycle <> 'pending'
       ORDER BY created_at ASC LIMIT $3
     )`,
    [preserveBefore, networkDiagnosticsBefore, batch],
  );
  const sessions = await run(
    db,
    `DELETE FROM ${db.table('sessions')} WHERE id IN (
       SELECT id FROM ${db.table('sessions')} WHERE expires_at < $1 ORDER BY expires_at ASC LIMIT $2
     )`,
    [nowIso(now), batch],
  );
  const deliveries = await run(
    db,
    `DELETE FROM ${db.table('notification_deliveries')} WHERE id IN (
       SELECT id FROM ${db.table('notification_deliveries')}
       WHERE created_at > $1 AND created_at < $2 AND status IN ('sent', 'cancelled', 'failed')
       ORDER BY created_at ASC LIMIT $3
     )`,
    [preserveBefore, isoDaysAgo(now, 90), batch],
  );
  const notificationHistory = await run(
    db,
    `DELETE FROM ${db.table('notification_history')} WHERE id IN (
       SELECT id FROM ${db.table('notification_history')}
       WHERE created_at > $1 AND created_at < $2
       ORDER BY created_at ASC, id ASC LIMIT $3
     )`,
    [preserveBefore, isoDaysAgo(now, 90), batch],
  );

  const remaining = await first<{ c: number }>(
    db,
    `SELECT (
       EXISTS (
         SELECT 1 FROM ${db.table('observations')} o
         JOIN ${db.table('check_runs')} cr ON cr.id = o.check_run_id
         WHERE o.created_at > $1 AND o.created_at < $2
           AND cr.status IN ('complete', 'partial')
           AND cr.finalized_at IS NOT NULL
       )
       OR EXISTS (
         SELECT 1 FROM ${db.table('check_runs')} cr
         WHERE cr.created_at > $3 AND cr.created_at < $4
           AND cr.status IN ('complete', 'partial')
           AND cr.finalized_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${db.table('observations')} o WHERE o.check_run_id = cr.id)
       )
       OR EXISTS (
         SELECT 1 FROM ${db.table('network_diagnostics')}
         WHERE created_at > $5 AND created_at < $6 AND lifecycle <> 'pending'
       )
     )::integer AS c`,
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
    observationsDeleted: observations.rowCount ?? 0,
    checkRunsDeleted: checkRuns.rowCount ?? 0,
    networkDiagnosticsDeleted: diagnostics.rowCount ?? 0,
    sessionsDeleted: sessions.rowCount ?? 0,
    deliveriesDeleted: deliveries.rowCount ?? 0,
    notificationHistoryDeleted: notificationHistory.rowCount ?? 0,
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
  db: Database,
  now: Date,
  staleSeconds: number,
): Promise<number> {
  const row = await first<{ c: number }>(
    db,
    `SELECT COUNT(*)::integer AS c FROM ${db.table('check_runs')} WHERE status = 'pending' AND deadline_at <= $1`,
    [nowIso(new Date(now.getTime() - staleSeconds * 1_000))],
  );
  return row?.c ?? 0;
}
