import {
  all,
  claimDueRounds,
  finalizeRound,
  getRound,
  insertObservation,
  nowIso,
  randomToken,
  reclaimExpiredRounds,
  run,
  type CoordinatorContext,
  type DueRound,
  type MonitorRow,
} from '@uptime/cloudflare';

import type { RegionId } from '@uptime/regions';
import { probeBatchSize } from '@uptime/contracts';

import { ConcurrencyLimiter, drainAll } from './concurrency.js';
import { finalizeStaleDiagnostics, persistDiagnostic, reserveDiagnostics } from './diagnostics.js';
import type { CoordinatorConfig } from './env.js';
import {
  buildProbeItem,
  parseProbeBatchResponse,
  probeEndpointFor,
  regionalProbeBatches,
  signBatchRequest,
  type ProbeTask,
  type RegionalProbeBatch,
  type ReservedDiagnostic,
} from './probe.js';
import { validateProbeTarget } from './url-policy.js';
import {
  countStaleRounds,
  emptyMetrics,
  parseCheckpoint,
  runRetention,
  type CoordinatorMetrics,
} from './maintenance.js';
import { processNotifications } from './notifications.js';
import { publishDueReports } from './publisher.js';
import { readJob, upsertJobState } from './state.js';
import { meterDatabase } from './query-metrics.js';

const collectionGraceMs = 15_000;
// Leave room for the outer scheduled-handler lease completion and platform
// bookkeeping while enforcing the paid D1 limit of 1,000 statements.
const coordinatorStatementBudget = 890;
const probeRegionalTaskBudget = 108;

export interface CoordinatorDependencies {
  readonly fetch: typeof fetch;
  readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
  readonly now?: () => Date;
}

export interface TickResult {
  readonly runId: string;
  readonly metrics: CoordinatorMetrics;
}

export interface CoordinatorTickOptions {
  /** Keep direct callers backward compatible; scheduled publication has its own lease. */
  readonly publishReports?: boolean;
}

/**
 * One minute invocation. Steps are ordered so that recovery precedes claims and
 * a failure in publication or notifications cannot prevent the others:
 *   1. recover expired claims and finalize overdue rounds
 *   2. atomically claim due work
 *   3. snapshot expected regions/config into rounds, dispatch signed batches
 *   4. persist results idempotently and finalize rounds once
 *   5. evaluate incidents (durable deliveries) and publish reports independently
 *   6. bounded retention from persisted checkpoints
 */
export async function runCoordinatorTick(
  inputConfig: CoordinatorConfig,
  dependencies: CoordinatorDependencies,
  options: CoordinatorTickOptions = {},
): Promise<TickResult> {
  const now = dependencies.now?.() ?? new Date();
  const meter = meterDatabase(inputConfig.db);
  const config: CoordinatorConfig = {
    ...inputConfig,
    db: meter.db,
    monitorBatch: Math.min(inputConfig.monitorBatch, 50),
  };
  const runId = randomToken(8);
  const metrics = emptyMetrics(now);
  const context: CoordinatorContext = {
    db: config.db,
    now,
    enabledRegionIds: config.enabledRegionIds,
    claimToken: runId,
    batchSize: config.monitorBatch,
    regionalTaskBudget: probeRegionalTaskBudget,
    collectionGraceMs,
    probeConcurrency: config.probeConcurrency,
    probeBatchSize,
  };

  meter.setStage('recovery');
  await recoverPreviousWork(config, context, dependencies.log, metrics);
  meter.setStage('claims');
  const rounds = await claimDueWork(config, context, metrics, dependencies.log);

  meter.setStage('probes');
  const prepared = await prepareRounds(config, rounds, dependencies.log);
  await dispatchRounds(config, prepared, dependencies, metrics);
  await finalizeRounds(
    config,
    context,
    prepared.map((tasks) => tasks[0]?.round).filter(Boolean) as DueRound[],
    metrics,
  );

  // Claimed rounds are fully persisted before the hard budget is enabled.
  // Later work is retryable: notification watermarks remain unchanged and
  // report leases expire for a future tick.
  meter.setStatementLimit(600);

  // Notifications and reports are independent; one failing must not block the other.
  try {
    meter.setStage('notifications');
    await processNotifications({
      db: config.db,
      fetch: dependencies.fetch,
      now,
      liveNow: dependencies.now ?? (() => new Date()),
      enabledRegionIds: config.enabledRegionIds,
      credentialEncryptionSecret: config.credentialEncryptionSecret,
      maxAttempts: config.notificationMaxAttempts,
      leaseToken: runId,
      log: dependencies.log,
      shouldContinueEvaluation: () => meter.statementCount() < 550,
      beforeDelivery: () => meter.setStatementLimit(650),
    });
  } catch (error) {
    dependencies.log.error({ event: 'notifications_failed', error: String(error) });
    metrics.lastError = `notifications: ${String(error)}`;
  }
  if (options.publishReports ?? true) {
    try {
      meter.setStage('reports');
      meter.setStatementLimit(820);
      const publish = await publishDueReports(config, now, dependencies.log);
      metrics.reportsPublished = publish.published;
      metrics.reportsFailed = publish.failed;
    } catch (error) {
      dependencies.log.error({ event: 'reports_failed', error: String(error) });
      metrics.lastError = `reports: ${String(error)}`;
    }
  }
  try {
    meter.setStage('retention');
    meter.setStatementLimit(coordinatorStatementBudget);
    await maintenance(config, now, dependencies.log, metrics);
  } catch (error) {
    dependencies.log.error({ event: 'maintenance_failed', error: String(error) });
    metrics.lastError = `maintenance: ${String(error)}`;
  }

  metrics.lastTickAt = nowIso(now);
  metrics.updatedAt = nowIso(now);
  metrics.queryWork = meter.work;
  meter.setStatementLimit(null);
  meter.setStage('state');
  await upsertJobState(config.db, 'coordinator', {
    state: { ...collectMetrics(metrics) },
    now,
  }).catch(() => undefined);
  return { runId, metrics };
}

async function recoverPreviousWork(
  config: CoordinatorConfig,
  context: CoordinatorContext,
  log: Pick<Console, 'warn' | 'error'>,
  metrics: CoordinatorMetrics,
): Promise<void> {
  const reclaimed = await reclaimExpiredRounds(context);
  metrics.roundsFinalized += reclaimed.expired;
  metrics.staleDiagnostics = await finalizeStaleDiagnostics(config.db, context.now);
  // Overdue rounds finalized this tick (reclaimed or expired) are stale
  // monitoring and surfaced for alerting; the query is a floor, not the total.
  metrics.staleRounds = Math.max(
    reclaimed.expired,
    await countStaleRounds(config.db, context.now, 60),
  );
  if (reclaimed.pending > 0 || reclaimed.expired > 0) {
    log.warn({
      event: 'coordinator_recovered',
      pendingLeases: reclaimed.pending,
      expiredRounds: reclaimed.expired,
    });
  }
}

async function claimDueWork(
  config: CoordinatorConfig,
  context: CoordinatorContext,
  metrics: CoordinatorMetrics,
  log: Pick<Console, 'warn' | 'error'>,
): Promise<DueRound[]> {
  const candidates = await all<MonitorRow>(
    config.db,
    `SELECT * FROM monitors WHERE enabled = 1 AND next_check_at <= ?
     ORDER BY next_check_at ASC LIMIT ?`,
    [nowIso(context.now), config.monitorBatch],
  );
  const regionFilter = config.enabledRegionIds.map(() => '?').join(', ');
  const regionCounts =
    candidates.length === 0
      ? []
      : await all<{ monitor_id: string; count: number }>(
          config.db,
          `SELECT monitor_id, count(*) AS count FROM monitor_regions
           WHERE monitor_id IN (SELECT value FROM json_each(?))
             AND region_id IN (${regionFilter || 'NULL'})
           GROUP BY monitor_id`,
          [JSON.stringify(candidates.map((monitor) => monitor.id)), ...config.enabledRegionIds],
        );
  const countByMonitor = new Map(regionCounts.map((row) => [row.monitor_id, Number(row.count)]));
  const due: MonitorRow[] = [];
  let regionalTasks = 0;
  for (const monitor of candidates) {
    const count = countByMonitor.get(monitor.id) ?? 0;
    if (count === 0) continue;
    if (regionalTasks + count > probeRegionalTaskBudget) continue;
    regionalTasks += count;
    due.push(monitor);
  }
  metrics.dueMonitors = due.length;
  const rounds = await claimDueRounds(context, due);
  metrics.roundsClaimed = rounds.length;
  if (rounds.length > 0 && rounds.length === config.monitorBatch) {
    // Saturated the per-invocation bound; fan-out is warranted at this scale.
    log.warn({ event: 'coordinator_batch_saturated', rounds: rounds.length });
  }
  return rounds;
}

async function prepareRounds(
  config: CoordinatorConfig,
  rounds: readonly DueRound[],
  log: Pick<Console, 'warn' | 'error'>,
): Promise<ProbeTask[][]> {
  const prepared: ProbeTask[][] = [];
  for (const round of rounds) {
    const policy = validateProbeTarget(round.monitorUrl);
    if (!policy.ok) {
      log.warn({
        event: 'target_policy_rejected',
        roundId: round.id,
        reason: policy.reason,
      });
      await run(
        config.db,
        `UPDATE check_runs SET status = 'partial', completed_at = ?, finalized_at = ?
         WHERE id = ? AND status = 'pending'`,
        [nowIso(), nowIso(), round.id],
      );
      continue;
    }
    const reserved = round.dnsDiagnosticsEnabled
      ? await reserveDiagnostics(config.db, round, round.regionIds)
      : new Map<RegionId, ReservedDiagnostic>();
    prepared.push(
      round.regionIds.map((regionId) => {
        const diagnostic = reserved.get(regionId);
        return {
          round,
          regionId,
          reserved: diagnostic,
          item: buildProbeItem(round, diagnostic),
        };
      }),
    );
  }
  return prepared;
}

async function dispatchRounds(
  config: CoordinatorConfig,
  prepared: readonly ProbeTask[][],
  dependencies: CoordinatorDependencies,
  metrics: CoordinatorMetrics,
): Promise<void> {
  const batches = regionalProbeBatches(prepared.flat());
  const limiter = new ConcurrencyLimiter(config.probeConcurrency);
  await drainAll(
    batches.map((batch) => limiter.run(() => executeBatch(config, batch, dependencies, metrics))),
  );
}

async function executeBatch(
  config: CoordinatorConfig,
  batch: RegionalProbeBatch,
  dependencies: CoordinatorDependencies,
  metrics: CoordinatorMetrics,
): Promise<void> {
  const dispatchNow = dependencies.now?.() ?? new Date();
  const signed = await signBatchRequest(config, batch, dispatchNow);
  // The probe Worker runs batch items two at a time and applies its own
  // per-item timeout. Summing the per-item timeouts plus the collection grace
  // upper-bounds the whole batch duration.
  const timeoutMs =
    batch.tasks.reduce((total, task) => total + task.round.timeoutMs, 0) + collectionGraceMs;
  let envelope: Awaited<ReturnType<typeof parseProbeBatchResponse>>;
  try {
    const response = await dependencies.fetch(probeEndpointFor(config, batch.regionId), {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Probe batch returned ${response.status}`);
    envelope = parseProbeBatchResponse(await response.json(), batch, signed.requestId);
  } catch (error) {
    dependencies.log.warn({
      event: 'probe_batch_failed',
      regionId: batch.regionId,
      roundIds: batch.tasks.map((task) => task.round.id),
      error: String(error),
    });
    return;
  }
  await drainAll(
    batch.tasks.map(async (task) => {
      const parsed = envelope.diagnostics.get(`${task.item.checkRunId}:${task.item.monitorId}`);
      if (!parsed) {
        dependencies.log.warn({
          event: 'probe_result_missing',
          roundId: task.round.id,
          regionId: task.regionId,
        });
        return;
      }
      const inserted = await insertObservation(config.db, {
        checkRunId: task.round.id,
        monitorId: task.round.monitorId,
        regionId: task.regionId,
        scheduledWindow: task.round.windowStartedAt,
        status: parsed.observation.status,
        success: parsed.observation.success,
        httpStatus: parsed.observation.httpStatus,
        responseMs: parsed.observation.responseMs,
        totalMs: parsed.observation.totalMs,
        errorCode: parsed.observation.errorCode,
        errorDetail: parsed.observation.errorDetail,
        placement: parsed.observation.placement,
        colo: parsed.observation.colo,
        finalUrl: parsed.observation.finalUrl,
        endpointEvidence: parsed.observation.endpointEvidence,
        redirectCount: parsed.observation.redirectCount,
        bodyBytes: parsed.observation.bodyBytes,
        probeVersion: parsed.observation.probeVersion,
        startedAt: parsed.observation.startedAt,
        completedAt: parsed.observation.completedAt,
      });
      if (inserted.inserted) metrics.observationsInserted += 1;
      if (task.reserved) {
        try {
          // An empty id means the duplicate's row could not be resolved; pass
          // null rather than an invalid FK value.
          await persistDiagnostic(
            config.db,
            task.reserved,
            inserted.id === '' ? null : inserted.id,
            parsed.diagnostic,
          );
        } catch (error) {
          // A diagnostic failure must never affect the target's observed health
          // or abort the tick; it stays pending and is finalized as stale later.
          dependencies.log.warn({
            event: 'diagnostic_persist_failed',
            roundId: task.round.id,
            regionId: task.regionId,
            error: String(error),
          });
        }
      }
    }),
  );
}

async function finalizeRounds(
  config: CoordinatorConfig,
  context: CoordinatorContext,
  rounds: readonly DueRound[],
  metrics: CoordinatorMetrics,
): Promise<void> {
  const unique = new Map(rounds.map((round) => [round.id, round]));
  for (const round of unique.values()) {
    const status = await finalizeRound(config.db, round.id, context.now);
    if (status === null) continue;
    metrics.roundsFinalized += 1;
    if (status === 'partial') {
      metrics.roundsPartial += 1;
      const row = await getRound(config.db, round.id);
      const received = row
        ? ((
            await all<{ c: number }>(
              config.db,
              'SELECT COUNT(*) AS c FROM observations WHERE check_run_id = ?',
              [round.id],
            )
          )[0]?.c ?? 0)
        : 0;
      if (received === 0) metrics.unknownRounds += 1;
    }
  }
}

async function maintenance(
  config: CoordinatorConfig,
  now: Date,
  log: Pick<Console, 'warn' | 'error'>,
  metrics: CoordinatorMetrics,
): Promise<void> {
  const job = await readJob(config.db, 'retention');
  const checkpoint = parseCheckpoint(job?.cursor ?? null);
  const result = await runRetention(
    config.db,
    now,
    {
      detailedResultsRetentionDays: config.detailedResultsRetentionDays,
      dnsDiagnosticsRetentionDays: config.dnsDiagnosticsRetentionDays,
      ...(config.historyRetentionPreserveBefore === undefined
        ? {}
        : { historyRetentionPreserveBefore: config.historyRetentionPreserveBefore }),
      retentionBatchSize: 1_000,
    },
    checkpoint,
  );
  metrics.retention = {
    observationsDeleted: result.observationsDeleted,
    checkRunsDeleted: result.checkRunsDeleted,
    networkDiagnosticsDeleted: result.networkDiagnosticsDeleted,
    sessionsDeleted: result.sessionsDeleted,
    deliveriesDeleted: result.deliveriesDeleted,
    notificationHistoryDeleted: result.notificationHistoryDeleted,
  };
  await upsertJobState(config.db, 'retention', {
    now,
    cursor: result.checkpoint,
    touchCompleted: result.complete,
  });
  if (!result.complete) {
    log.warn({ event: 'retention_incomplete', deleted: result.observationsDeleted });
  }
}

function collectMetrics(metrics: CoordinatorMetrics): CoordinatorMetrics {
  return { ...metrics };
}
