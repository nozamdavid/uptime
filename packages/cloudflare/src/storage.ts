import type { RegionId } from './regions.js';
import { chunk } from './db.js';
import { pgAll as all, pgFirst as first, pgRun as run } from './postgres/query.js';
import {
  isPostgresUniqueViolation as isUniqueViolation,
  type Database,
} from './postgres/database.js';
import { nowIso, randomId } from './crypto.js';
import { toBoolean } from './env.js';
import type {
  CheckRunRow,
  DueRound,
  MonitorRow,
  ObservationRow,
  RunStatus,
  UptimeThresholdsRow,
} from './types.js';

export interface CoordinatorContext {
  db: Database;
  schedulingPolicy?: 'hosted' | 'legacy';
  now: Date;
  enabledRegionIds: readonly RegionId[];
  claimToken: string;
  leaseSeconds?: number;
  batchSize?: number;
  regionalTaskBudget?: number;
  collectionGraceMs?: number;
  probeConcurrency?: number;
  probeBatchSize?: number;
}

const defaultLeaseSeconds = 90;
const defaultBatchSize = 50;
const defaultCollectionGraceMs = 15_000;
const defaultProbeConcurrency = 32;
const defaultProbeBatchSize = 5;

/**
 * Conservative wall-clock bound for the batches a coordinator dispatches.
 * Each regional request receives the same timeout budget as executeBatch, and
 * the lane simulation accounts for requests queued behind its concurrency cap.
 */
export function probeQueueBudgetMs(
  timeoutMs: readonly number[],
  regionCount: number,
  concurrency: number = defaultProbeConcurrency,
  batchSize: number = defaultProbeBatchSize,
  graceMs: number = defaultCollectionGraceMs,
): number {
  if (timeoutMs.length === 0 || regionCount === 0) return 0;
  const regional = chunk(timeoutMs, batchSize).map(
    (timeouts) => timeouts.reduce((sum, timeout) => sum + timeout, 0) + graceMs,
  );
  const durations = Array.from({ length: regionCount }, () => regional).flat();
  const lanes = Array.from({ length: Math.min(concurrency, durations.length) }, () => 0);
  for (const duration of durations) {
    let lane = 0;
    for (let index = 1; index < lanes.length; index += 1) {
      if (lanes[index]! < lanes[lane]!) lane = index;
    }
    lanes[lane]! += duration;
  }
  return Math.max(...lanes);
}

/** Parse `uptime_thresholds` JSON with contract defaults. */
export function parseUptimeThresholds(raw: string): UptimeThresholdsRow {
  try {
    const parsed = JSON.parse(raw) as Partial<UptimeThresholdsRow>;
    return {
      green: Number(parsed.green ?? 99.5),
      lightGreen: Number(parsed.lightGreen ?? 99),
      orange: Number(parsed.orange ?? 90),
    };
  } catch {
    return { green: 99.5, lightGreen: 99, orange: 90 };
  }
}

export function parseJsonColumn<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Compute the next schedule boundary strictly after `now`, preserving the
 * existing "advance from the schedule, not completion time" semantics.
 */
export function nextCheckAt(
  observedNextCheckAt: string,
  intervalSeconds: number,
  now: Date,
): string {
  const intervalMs = intervalSeconds * 1_000;
  const observed = Date.parse(observedNextCheckAt);
  const elapsed = now.getTime() - observed;
  const steps = Math.max(1, Math.floor(elapsed / intervalMs) + 1);
  return new Date(observed + steps * intervalMs).toISOString();
}

/**
 * Atomically advance due monitor schedules, insert their check rounds, and
 * claim pending rounds.
 *
 * The compare-and-set on `next_check_at` (guarded by the value we read) makes
 * the advance safe across concurrent coordinator invocations, and the unique
 * `(monitor_id, window_started_at)` constraint makes round insertion
 * idempotent.
 */
export async function claimDueRounds(
  context: CoordinatorContext,
  dueMonitors: readonly MonitorRow[],
): Promise<DueRound[]> {
  // Only schedules at or before `now` are due. The caller normally supplies a
  // pre-filtered set, but enforcing it here keeps the compare-and-set correct
  // if a caller passes a broader list.
  const due = dueMonitors.filter(
    (monitor) =>
      toBoolean(monitor.enabled) && Date.parse(monitor.next_check_at) <= context.now.getTime(),
  );
  if (due.length === 0) return [];
  const roundDeadlineOffset = probeQueueBudgetMs(
    due.map((monitor) => monitor.timeout_ms),
    context.enabledRegionIds.length,
    context.probeConcurrency,
    context.probeBatchSize,
    context.collectionGraceMs,
  );

  for (const monitor of due.slice(0, Math.min(context.batchSize ?? defaultBatchSize, 50))) {
    const advanced = nextCheckAt(monitor.next_check_at, monitor.interval_seconds, context.now);
    const windowStartedAt = monitor.next_check_at;
    // Include time spent queued behind other regional requests. Basing this on
    // a stale scheduled window would immediately expire missed windows.
    const deadlineAt = new Date(context.now.getTime() + roundDeadlineOffset).toISOString();
    await context.db.transaction(async (db) => {
      const eligibility = db.table(
        context.schedulingPolicy === 'hosted' ? 'tier_schedulable_monitors' : 'monitors',
      );
      const locked = await first<{ id: string }>(
        db,
        `SELECT m.id FROM ${db.table('monitors')} m
         WHERE m.id = $1 AND m.next_check_at = $2 AND m.enabled = 1
           AND EXISTS (SELECT 1 FROM ${eligibility} eligible WHERE eligible.id = m.id)
         FOR UPDATE OF m SKIP LOCKED`,
        [monitor.id, monitor.next_check_at],
      );
      if (!locked) return;
      const regions = await all<{ region_id: RegionId }>(
        db,
        `SELECT region_id FROM ${db.table('monitor_regions')}
         WHERE monitor_id = $1 AND region_id = ANY($2::text[]) ORDER BY region_id`,
        [monitor.id, context.enabledRegionIds],
      );
      if (regions.length === 0) return;
      await run(db, `UPDATE ${db.table('monitors')} SET next_check_at = $1 WHERE id = $2`, [
        advanced,
        monitor.id,
      ]);
      await run(
        db,
        `INSERT INTO ${db.table('check_runs')} (
                monitor_id, window_started_at, expected_region_count, expected_regions,
                monitor_url, timeout_ms, dns_diagnostics_enabled, deadline_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (monitor_id, window_started_at) DO NOTHING`,
        [
          monitor.id,
          windowStartedAt,
          regions.length,
          JSON.stringify(regions.map((row) => row.region_id)),
          monitor.url,
          monitor.timeout_ms,
          monitor.dns_diagnostics_enabled,
          deadlineAt,
        ],
      );
    });
  }

  return claimPendingRounds(context);
}

/** Claim pending rounds whose lease is free or expired. */
export async function claimPendingRounds(context: CoordinatorContext): Promise<DueRound[]> {
  const leaseSeconds = context.leaseSeconds ?? defaultLeaseSeconds;
  const batchSize = Math.min(context.batchSize ?? defaultBatchSize, 50);
  const regionalTaskBudget = context.regionalTaskBudget ?? batchSize * 9;
  const now = nowIso(context.now);
  const leaseExpiresAt = nowIso(new Date(context.now.getTime() + leaseSeconds * 1_000));
  const claimed = await all<CheckRunRow>(
    context.db,
    `WITH available AS MATERIALIZED (
      SELECT cr.* FROM ${context.db.table('check_runs')} cr
      WHERE cr.status = 'pending'
        AND (cr.claim_expires_at IS NULL OR cr.claim_expires_at <= $4)
        AND cr.deadline_at > $4
        AND EXISTS (SELECT 1 FROM ${context.db.table(context.schedulingPolicy === 'hosted' ? 'tier_schedulable_monitors' : 'monitors')} m WHERE m.id = cr.monitor_id AND m.enabled = 1)
      ORDER BY cr.window_started_at, cr.id LIMIT $6
      FOR UPDATE OF cr SKIP LOCKED
    ), budgeted AS (
         SELECT id, SUM(expected_region_count) OVER (
           ORDER BY window_started_at ASC, id ASC
         ) AS regional_tasks
         FROM available
    ) UPDATE ${context.db.table('check_runs')} cr
     SET claim_token = $1,
       claim_expires_at = GREATEST(cr.deadline_at, $2), claimed_by = $3
     WHERE cr.id IN (
       SELECT id FROM budgeted WHERE regional_tasks <= $5
     )
     RETURNING *`,
    [context.claimToken, leaseExpiresAt, context.claimToken, now, regionalTaskBudget, batchSize],
  );
  return claimed.map(roundRowToDueRound);
}

/** Reclaim rounds abandoned by an interrupted coordinator. */
export async function reclaimExpiredRounds(
  context: CoordinatorContext,
): Promise<{ pending: number; expired: number }> {
  const timestamp = nowIso(context.now);
  const pending = await run(
    context.db,
    `UPDATE ${context.db.table('check_runs')} SET claim_token = NULL, claim_expires_at = NULL, claimed_by = NULL
     WHERE id IN (
       SELECT id FROM ${context.db.table('check_runs')}
       WHERE status = 'pending' AND claim_expires_at IS NOT NULL AND claim_expires_at <= $1
       ORDER BY claim_expires_at, id LIMIT 50 FOR UPDATE SKIP LOCKED
     )`,
    [timestamp],
  );
  const expired = await finalizeExpiredRounds(context);
  return { pending: pending.rowCount ?? 0, expired };
}

export function roundRowToDueRound(row: CheckRunRow): DueRound {
  const regions = parseJsonColumn<RegionId[]>(row.expected_regions) ?? [];
  return {
    id: row.id,
    monitorId: row.monitor_id,
    monitorUrl: row.monitor_url,
    timeoutMs: row.timeout_ms,
    windowStartedAt: row.window_started_at,
    dnsDiagnosticsEnabled: toBoolean(row.dns_diagnostics_enabled),
    regionIds: regions,
  };
}

export interface ObservationInput {
  checkRunId: string;
  monitorId: string;
  regionId: RegionId;
  scheduledWindow: string;
  status: ObservationRow['status'];
  success: boolean;
  httpStatus?: number | null;
  responseMs?: number | null;
  totalMs?: number | null;
  errorCode?: ObservationRow['error_code'];
  errorDetail?: string | null;
  placement?: string | null;
  colo?: string | null;
  finalUrl?: string | null;
  endpointEvidence?: unknown;
  redirectCount?: number | null;
  bodyBytes?: number | null;
  probeVersion?: string | null;
  responseMetadata?: unknown;
  startedAt: string;
  completedAt?: string | null;
}

/**
 * Persist one probe result. The durable unique key makes this idempotent:
 * retries or overlapping coordinators receive `inserted: false`. When the row
 * already exists, the returned id is the persisted observation's id (not a
 * throwaway candidate), so callers can safely reference it (for example when
 * linking a network diagnostic).
 */
export async function insertObservation(
  db: Database,
  observation: ObservationInput,
): Promise<{ id: string; inserted: boolean }> {
  const id = randomId();
  try {
    const result = await run(
      db,
      `INSERT INTO ${db.table('observations')} (
         id, check_run_id, monitor_id, region_id, scheduled_window, status, success,
         http_status, response_ms, total_ms, error_code, error_detail, placement, colo,
         final_url, endpoint_evidence, redirect_count, body_bytes, probe_version,
         response_metadata, started_at, completed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
       ON CONFLICT (monitor_id, region_id, scheduled_window) DO NOTHING`,
      [
        id,
        observation.checkRunId,
        observation.monitorId,
        observation.regionId,
        observation.scheduledWindow,
        observation.status,
        observation.success ? 1 : 0,
        observation.httpStatus ?? null,
        observation.responseMs ?? null,
        observation.totalMs ?? null,
        observation.errorCode ?? null,
        observation.errorDetail ?? null,
        observation.placement ?? null,
        observation.colo ?? null,
        observation.finalUrl ?? null,
        observation.endpointEvidence === undefined || observation.endpointEvidence === null
          ? null
          : JSON.stringify(observation.endpointEvidence),
        observation.redirectCount ?? null,
        observation.bodyBytes ?? null,
        observation.probeVersion ?? null,
        observation.responseMetadata === undefined || observation.responseMetadata === null
          ? null
          : JSON.stringify(observation.responseMetadata),
        observation.startedAt,
        observation.completedAt ?? null,
      ],
    );
    if ((result.rowCount ?? 0) > 0) return { id, inserted: true };
    return { id: await existingObservationId(db, observation), inserted: false };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { id: await existingObservationId(db, observation), inserted: false };
    }
    throw error;
  }
}

/** Resolve the persisted id for a durable observation key after a duplicate. */
async function existingObservationId(
  db: Database,
  observation: Pick<ObservationInput, 'monitorId' | 'regionId' | 'scheduledWindow'>,
): Promise<string> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM ${db.table('observations')}
     WHERE monitor_id = $1 AND region_id = $2 AND scheduled_window = $3 LIMIT 1`,
    [observation.monitorId, observation.regionId, observation.scheduledWindow],
  );
  return row?.id ?? '';
}

/**
 * Finalize a round once, based on the number of persisted results. The
 * `status = 'pending'` guard means the aggregate trigger only fires on the
 * first transition. Returns the new status, or `null` if the round was already
 * finalized (making repeated calls idempotent).
 */
export async function finalizeRound(
  db: Database,
  roundId: string,
  now: Date = new Date(),
): Promise<RunStatus | null> {
  const timestamp = nowIso(now);
  return db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await tx.query(`SELECT id FROM ${tx.table('check_runs')} WHERE id = $1 FOR NO KEY UPDATE`, [
      roundId,
    ]);
    const row = await first<{ status: RunStatus }>(
      tx,
      `UPDATE ${tx.table('check_runs')} cr
     SET status = CASE
           WHEN (SELECT count(*) FROM ${tx.table('observations')} WHERE check_run_id = cr.id)
                >= expected_region_count THEN 'complete'
           ELSE 'partial'
         END,
         completed_at = COALESCE(completed_at, $1),
         finalized_at = COALESCE(finalized_at, $1)
     WHERE id = $2 AND status = 'pending'
       AND (
         (SELECT count(*) FROM ${tx.table('observations')} WHERE check_run_id = cr.id)
           >= expected_region_count
         OR deadline_at <= $1
       )
     RETURNING status`,
      [timestamp, roundId],
    );
    return row?.status ?? null;
  });
}

/**
 * Finalize every pending round whose deadline has passed. A round that already
 * has all expected results is marked `complete`; only genuinely short rounds
 * become `partial`.
 */
export async function finalizeExpiredRounds(context: CoordinatorContext): Promise<number> {
  const timestamp = nowIso(context.now);
  const rows = await all<{ id: string }>(
    context.db,
    `SELECT id FROM ${context.db.table('check_runs')}
     WHERE status = 'pending' AND deadline_at <= $1 ORDER BY deadline_at, id LIMIT 50`,
    [timestamp],
  );
  let finalized = 0;
  for (const row of rows) if (await finalizeRound(context.db, row.id, context.now)) finalized += 1;
  return finalized;
}

export async function getRound(db: Database, roundId: string): Promise<CheckRunRow | null> {
  return first<CheckRunRow>(db, `SELECT * FROM ${db.table('check_runs')} WHERE id = $1 LIMIT 1`, [
    roundId,
  ]);
}
