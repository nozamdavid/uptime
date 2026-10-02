import type { RegionId } from './regions.js';
import { all, batch, chunk, first, isUniqueViolation, run } from './db.js';
import { nowIso, randomId } from './crypto.js';
import { toBoolean } from './env.js';
import type { D1Database } from './workers-types.js';
import type {
  CheckRunRow,
  DueRound,
  MonitorRow,
  ObservationRow,
  RunStatus,
  UptimeThresholdsRow,
} from './types.js';

export interface CoordinatorContext {
  db: D1Database;
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

function enabledRegionClause(regionIds: readonly RegionId[]): {
  clause: string;
  values: RegionId[];
} {
  if (regionIds.length === 0) return { clause: 'NULL', values: [] };
  return {
    clause: regionIds.map(() => '?').join(', '),
    values: [...regionIds],
  };
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

  const regionFilter = enabledRegionClause(context.enabledRegionIds);
  // Each monitor's compare-and-set advance and its round insert are committed in
  // the same atomic batch. Advancing the schedule without inserting the round
  // (a crash between two separate batches) would permanently skip the window;
  // inserting the round without advancing would leave the monitor due forever.
  const pairs: { sql: string; values: unknown[] }[][] = [];
  for (const monitor of due) {
    const advanced = nextCheckAt(monitor.next_check_at, monitor.interval_seconds, context.now);
    const windowStartedAt = monitor.next_check_at;
    // Include time spent queued behind other regional requests. Basing this on
    // a stale scheduled window would immediately expire missed windows.
    const deadlineAt = new Date(context.now.getTime() + roundDeadlineOffset).toISOString();
    pairs.push([
      {
        // Compare-and-set: only the invocation that observed the same schedule
        // wins and advances it.
        sql: `UPDATE monitors SET next_check_at = ?
              WHERE id = ? AND next_check_at = ? AND enabled = 1`,
        values: [advanced, monitor.id, monitor.next_check_at],
      },
      {
        // The round is inserted only when this invocation won the advance: the
        // EXISTS clause checks the monitor now sits at the advanced schedule.
        // Round insertion is idempotent on `(monitor_id, window_started_at)`.
        sql: `INSERT INTO check_runs (
                monitor_id, window_started_at, expected_region_count, expected_regions,
                monitor_url, timeout_ms, dns_diagnostics_enabled, deadline_at
              )
              SELECT ?, ?, count(*), json_group_array(region_id), ?, ?, ?, ?
              FROM monitor_regions
              WHERE monitor_id = ? AND region_id IN (${regionFilter.clause})
                AND EXISTS (
                  SELECT 1 FROM monitors m
                  WHERE m.id = ? AND m.enabled = 1 AND m.next_check_at = ?
                )
              GROUP BY monitor_id
              -- A monitor with no enabled regions produces no round rather than an
              -- invalid zero-region round.
              HAVING count(*) > 0
              ON CONFLICT (monitor_id, window_started_at) DO NOTHING`,
        values: [
          monitor.id,
          windowStartedAt,
          monitor.url,
          monitor.timeout_ms,
          monitor.dns_diagnostics_enabled,
          deadlineAt,
          monitor.id,
          ...regionFilter.values,
          monitor.id,
          advanced,
        ],
      },
    ]);
  }
  // Keep each batch bounded (25 monitors = 50 statements, matching the previous
  // per-batch size); a failure between batches only leaves later monitors due
  // for the next invocation, never a skipped window.
  for (const group of chunk(pairs, 25)) {
    await batch(context.db, group.flat());
  }

  return claimPendingRounds(context);
}

/** Claim pending rounds whose lease is free or expired. */
export async function claimPendingRounds(context: CoordinatorContext): Promise<DueRound[]> {
  const leaseSeconds = context.leaseSeconds ?? defaultLeaseSeconds;
  const batchSize = context.batchSize ?? defaultBatchSize;
  const regionalTaskBudget = context.regionalTaskBudget ?? batchSize * 9;
  const now = nowIso(context.now);
  const leaseExpiresAt = nowIso(new Date(context.now.getTime() + leaseSeconds * 1_000));
  const claimed = await all<CheckRunRow>(
    context.db,
    `UPDATE check_runs
     SET claim_token = ?,
       claim_expires_at = CASE WHEN deadline_at > ? THEN deadline_at ELSE ? END,
       claimed_by = ?
     WHERE id IN (
       SELECT id FROM (
         SELECT id, SUM(expected_region_count) OVER (
           ORDER BY window_started_at ASC, id ASC
         ) AS regional_tasks
         FROM check_runs
         WHERE status = 'pending'
           AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
           AND deadline_at > ?
       ) WHERE regional_tasks <= ?
       LIMIT ?
     )
     RETURNING *`,
    [
      context.claimToken,
      leaseExpiresAt,
      leaseExpiresAt,
      context.claimToken,
      now,
      now,
      regionalTaskBudget,
      batchSize,
    ],
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
    `UPDATE check_runs SET claim_token = NULL, claim_expires_at = NULL, claimed_by = NULL
     WHERE status = 'pending' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`,
    [timestamp],
  );
  const expired = await finalizeExpiredRounds(context);
  return { pending: pending.meta.changes, expired };
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
  db: D1Database,
  observation: ObservationInput,
): Promise<{ id: string; inserted: boolean }> {
  const id = randomId();
  try {
    const result = await run(
      db,
      `INSERT INTO observations (
         id, check_run_id, monitor_id, region_id, scheduled_window, status, success,
         http_status, response_ms, total_ms, error_code, error_detail, placement, colo,
         final_url, endpoint_evidence, redirect_count, body_bytes, probe_version,
         response_metadata, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    if (result.meta.changes > 0) return { id, inserted: true };
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
  db: D1Database,
  observation: Pick<ObservationInput, 'monitorId' | 'regionId' | 'scheduledWindow'>,
): Promise<string> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM observations
     WHERE monitor_id = ? AND region_id = ? AND scheduled_window = ? LIMIT 1`,
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
  db: D1Database,
  roundId: string,
  now: Date = new Date(),
): Promise<RunStatus | null> {
  const timestamp = nowIso(now);
  const row = await first<{ status: RunStatus }>(
    db,
    `UPDATE check_runs
     SET status = CASE
           WHEN (SELECT count(*) FROM observations WHERE check_run_id = check_runs.id)
                >= expected_region_count THEN 'complete'
           ELSE 'partial'
         END,
         completed_at = COALESCE(completed_at, ?),
         finalized_at = COALESCE(finalized_at, ?)
     WHERE id = ? AND status = 'pending'
       AND (
         (SELECT count(*) FROM observations WHERE check_run_id = check_runs.id)
           >= expected_region_count
         OR deadline_at <= ?
       )
     RETURNING status`,
    [timestamp, timestamp, roundId, timestamp],
  );
  return row?.status ?? null;
}

/**
 * Finalize every pending round whose deadline has passed. A round that already
 * has all expected results is marked `complete`; only genuinely short rounds
 * become `partial`.
 */
export async function finalizeExpiredRounds(context: CoordinatorContext): Promise<number> {
  const timestamp = nowIso(context.now);
  const result = await run(
    context.db,
    `UPDATE check_runs
     SET status = CASE
           WHEN (SELECT count(*) FROM observations WHERE check_run_id = check_runs.id)
                >= expected_region_count THEN 'complete'
           ELSE 'partial'
         END,
         completed_at = COALESCE(completed_at, ?),
         finalized_at = COALESCE(finalized_at, ?)
     WHERE status = 'pending' AND deadline_at <= ?`,
    [timestamp, timestamp, timestamp],
  );
  return result.meta.changes;
}

export async function getRound(db: D1Database, roundId: string): Promise<CheckRunRow | null> {
  return first<CheckRunRow>(db, 'SELECT * FROM check_runs WHERE id = ? LIMIT 1', [roundId]);
}
