import { sql } from 'drizzle-orm';

import { regionById, regionIds, type SchedulerEnv } from '@uptime/config';
import type { DnsDiagnosticResult, ProbeItem, ProbeResponse, RegionId } from '@uptime/contracts';
import {
  dnsDiagnosticResultSchema,
  probeBatchResponseSchema,
  probeBatchSize,
  probeResponseSchema,
} from '@uptime/contracts';
import { createDatabase, type Database } from '@uptime/database';

import { signProbeBatchRequest } from './signing.js';
import { assertCurrentlyPublicTarget } from './url-policy.js';
import { utcDayWindow } from './dns-diagnostics.js';
import { ConcurrencyLimiter } from './concurrency.js';
import { SchedulerNotifications } from './notifications.js';

const collectionGraceMs = 15_000;
const retentionBatchSize = 1_000;
const dnsDiagnosticDeadlineMs = 2_000;
const dnsDiagnosticStaleMs = 60_000;

interface ClaimedRun {
  id: string;
  monitor_id: string;
  monitor_url: string;
  timeout_ms: number;
  window_started_at: Date;
  region_ids: RegionId[];
  dns_diagnostics_enabled: boolean;
}

interface ReservedDiagnostic {
  id: string;
  regionId: RegionId;
  windowStartedAt: Date;
}

interface ProbeTask {
  readonly run: ClaimedRun;
  readonly regionId: RegionId;
  readonly reserved: ReservedDiagnostic | undefined;
  readonly item: ProbeItem;
}

interface RegionalProbeBatch {
  readonly regionId: RegionId;
  readonly tasks: ProbeTask[];
}

type DiagnosticDisposition =
  { kind: 'missing' } | { kind: 'invalid' } | { kind: 'complete'; result: DnsDiagnosticResult };

interface ParsedProbeResponse {
  observation: ProbeResponse;
  diagnostic: DiagnosticDisposition;
}

export interface SchedulerDependencies {
  readonly db: Database;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
}

export class Scheduler {
  private readonly probeConcurrency: ConcurrencyLimiter;
  private readonly notifications: SchedulerNotifications;

  public constructor(
    private readonly env: SchedulerEnv,
    private readonly dependencies: SchedulerDependencies,
  ) {
    this.probeConcurrency = new ConcurrencyLimiter(env.SCHEDULER_MAX_CONCURRENT_PROBES);
    this.notifications = new SchedulerNotifications(dependencies, env.REGIONS_LIST);
  }

  public async tick(): Promise<void> {
    await this.finalizeStaleDiagnostics();
    await this.finalizeExpiredRuns();
    const runs = await this.claimDueRuns();
    const prepared = await Promise.all(runs.map((run) => this.prepareRun(run)));
    const batches = regionalProbeBatches(prepared.flat());
    await Promise.all(batches.map((batch) => this.executeBatch(batch)));
    await Promise.all(runs.map((run) => this.finalizeRun(run.id)));
    try {
      await this.notifications.tick();
    } catch {
      this.dependencies.log.error({ event: 'notification_tick_failed' });
    }
  }

  public async maintenance(): Promise<void> {
    const db = this.dependencies.db;
    await db.execute(finalizeDailyUptimeRollupsQuery(this.dependencies.now()));
    await db.execute(sql`
      delete from notification_deliveries where id in (
        select id from notification_deliveries where created_at < now() - interval '90 days'
          and status in ('sent', 'cancelled', 'failed') order by created_at limit ${retentionBatchSize}
      )
    `);
    await db.execute(sql`
      WITH expired AS (
        SELECT id FROM check_runs
        WHERE created_at < now() - interval '90 days'
        ORDER BY created_at ASC
        LIMIT ${retentionBatchSize}
      )
      DELETE FROM check_runs WHERE id IN (SELECT id FROM expired)
    `);
    await db.execute(sql`
      WITH expired AS (
        SELECT id FROM network_diagnostics
        WHERE created_at < now() - interval '30 days'
        ORDER BY created_at ASC
        LIMIT ${retentionBatchSize}
      )
      DELETE FROM network_diagnostics WHERE id IN (SELECT id FROM expired)
    `);
    await db.execute(sql`
      DELETE FROM sessions WHERE id IN (
        SELECT id FROM sessions WHERE expires_at < now() ORDER BY expires_at ASC LIMIT ${retentionBatchSize}
      )
    `);
  }

  private async claimDueRuns(): Promise<ClaimedRun[]> {
    // Advance from the schedule, not completion time; SKIP LOCKED supports multiple schedulers.
    const result = await this.dependencies.db.execute(claimDueRunsQuery(this.env.REGIONS_LIST));
    return result as unknown as ClaimedRun[];
  }

  private async prepareRun(run: ClaimedRun): Promise<ProbeTask[]> {
    try {
      await assertCurrentlyPublicTarget(run.monitor_url);
    } catch (error) {
      this.dependencies.log.warn({
        event: 'target_policy_rejected',
        runId: run.id,
        error: String(error),
      });
      await this.dependencies.db.execute(sql`
        UPDATE check_runs SET status = 'partial', completed_at = now()
        WHERE id = ${run.id} AND status = 'pending'
      `);
      return [];
    }
    const diagnostics = run.dns_diagnostics_enabled
      ? await this.reserveDiagnostics(run)
      : new Map<RegionId, ReservedDiagnostic>();
    return run.region_ids.map((regionId) => {
      const reserved = diagnostics.get(regionId);
      return {
        run,
        regionId,
        reserved,
        item: {
          checkRunId: run.id,
          monitorId: run.monitor_id,
          windowStartedAt: new Date(run.window_started_at).toISOString(),
          url: run.monitor_url,
          timeoutMs: run.timeout_ms,
          method: 'GET',
          maxRedirects: 5,
          maxBodyBytes: 65_536,
          dnsDiagnostic: reserved
            ? {
                diagnosticId: reserved.id,
                windowStartedAt: reserved.windowStartedAt.toISOString(),
                deadlineMs: dnsDiagnosticDeadlineMs,
              }
            : null,
        },
      };
    });
  }

  private async executeBatch(batch: RegionalProbeBatch): Promise<void> {
    const signed = signProbeBatchRequest(
      { regionId: batch.regionId, items: batch.tasks.map((task) => task.item) },
      this.env.PROBE_SIGNING_SECRET,
      this.dependencies.now(),
    );
    try {
      const response = await this.probeConcurrency.run(() =>
        this.dependencies.fetch(probeEndpointFor(this.env, batch.regionId), {
          method: 'POST',
          headers: signed.headers,
          body: signed.body,
          signal: AbortSignal.timeout(
            batch.tasks.reduce((total, task) => total + task.run.timeout_ms, collectionGraceMs),
          ),
        }),
      );
      if (!response.ok) throw new Error(`Probe batch returned ${response.status}`);
      const envelope = probeBatchResponseSchema.parse(await response.json());
      if (envelope.requestId !== signed.requestId || envelope.regionId !== batch.regionId)
        throw new Error('Probe batch returned a mismatched identity');
      const expectedKeys = new Set(batch.tasks.map(probeTaskKey));
      const resultByKey = new Map<string, (typeof envelope.results)[number]>();
      for (const result of envelope.results) {
        const key = probeResultKey(result);
        if (!expectedKeys.has(key) || resultByKey.has(key))
          throw new Error('Probe batch returned an unexpected or duplicate result');
        resultByKey.set(key, result);
      }
      await Promise.all(
        batch.tasks.map(async (task) => {
          const result = resultByKey.get(probeTaskKey(task));
          if (!result) {
            this.dependencies.log.warn({
              event: 'probe_result_missing',
              runId: task.run.id,
              regionId: task.regionId,
            });
            return;
          }
          let parsed: ParsedProbeResponse;
          try {
            parsed = parseProbeResponseDetails(result.response);
            if (parsed.observation.regionId !== task.regionId)
              throw new Error('Probe returned a mismatched region');
          } catch (error) {
            this.dependencies.log.warn({
              event: 'probe_result_invalid',
              runId: task.run.id,
              regionId: task.regionId,
              error: String(error),
            });
            return;
          }
          const observationId = await this.persistObservation(
            task.run,
            task.regionId,
            parsed.observation,
          );
          if (task.reserved) {
            await this.persistDiagnostic(task.reserved, observationId, parsed.diagnostic);
          }
        }),
      );
    } catch (error) {
      this.dependencies.log.warn({
        event: 'probe_batch_failed',
        runIds: batch.tasks.map((task) => task.run.id),
        regionId: batch.regionId,
        error: String(error),
      });
    }
  }

  private async reserveDiagnostics(run: ClaimedRun): Promise<Map<RegionId, ReservedDiagnostic>> {
    const windowStartedAt = utcDayWindow(new Date(run.window_started_at));
    const reservations = await Promise.all(
      run.region_ids.map(async (regionId) => {
        const inserted = await schedulerRows<{
          id: string;
          regionId: RegionId;
          windowStartedAt: Date | string;
        }>(
          this.dependencies.db,
          sql`
            INSERT INTO network_diagnostics (
              monitor_id, check_run_id, region_id, kind, window_started_at, lifecycle, requested_at, started_at
            ) VALUES (
              ${run.monitor_id}, ${run.id}, ${regionId}, 'dns_candidates', ${windowStartedAt.toISOString()},
              'pending', now(), now()
            ) ON CONFLICT (monitor_id, region_id, kind, window_started_at) DO NOTHING
            RETURNING id, region_id as "regionId", window_started_at as "windowStartedAt"
          `,
        );
        const returned = inserted[0];
        if (!returned) return null;
        const reservation: ReservedDiagnostic = {
          ...returned,
          windowStartedAt: new Date(
            returned.windowStartedAt instanceof Date
              ? returned.windowStartedAt.getTime()
              : returned.windowStartedAt,
          ),
        };
        return [regionId, reservation] as const;
      }),
    );
    return new Map(
      reservations.filter(
        (value): value is readonly [RegionId, ReservedDiagnostic] => value !== null,
      ),
    );
  }

  private async persistObservation(
    run: ClaimedRun,
    regionId: RegionId,
    observation: ProbeResponse,
  ): Promise<string | null> {
    const inserted = await schedulerRows<{ id: string }>(
      this.dependencies.db,
      sql`
      INSERT INTO observations (
        check_run_id, monitor_id, region_id, status, success, http_status, response_ms, total_ms,
        error_code, error_detail, placement, colo, final_url, redirect_count, body_bytes, probe_version,
        endpoint_evidence, started_at, completed_at
      ) VALUES (
        ${run.id}, ${run.monitor_id}, ${regionId}, ${observation.status}, ${observation.success},
        ${observation.httpStatus}, ${observation.responseMs}, ${observation.totalMs}, ${observation.errorCode},
        ${observation.errorDetail}, ${observation.placement}, ${observation.colo}, ${observation.finalUrl},
        ${observation.redirectCount}, ${observation.bodyBytes}, ${observation.probeVersion},
        ${JSON.stringify(observation.endpointEvidence)},
        ${observation.startedAt}, ${observation.completedAt}
      ) ON CONFLICT (check_run_id, region_id) DO NOTHING
      RETURNING id
    `,
    );
    return inserted[0]?.id ?? null;
  }

  private async persistDiagnostic(
    reserved: ReservedDiagnostic,
    observationId: string | null,
    disposition: DiagnosticDisposition,
  ): Promise<void> {
    if (disposition.kind === 'complete') {
      const matchesReservation =
        disposition.result.diagnosticId === reserved.id &&
        new Date(disposition.result.windowStartedAt).getTime() ===
          reserved.windowStartedAt.getTime();
      if (matchesReservation) {
        await this.dependencies.db.execute(sql`
          UPDATE network_diagnostics SET lifecycle = 'complete', result = ${JSON.stringify(disposition.result)},
            failure_code = null, observation_id = ${observationId}, completed_at = now()
          WHERE id = ${reserved.id} AND lifecycle = 'pending'
        `);
        return;
      }
    }
    const failureCode =
      disposition.kind === 'invalid' || disposition.kind === 'complete'
        ? 'protocol_invalid_response'
        : 'worker_unsupported_or_missing';
    await this.dependencies.db.execute(sql`
      UPDATE network_diagnostics SET lifecycle = 'unavailable', failure_code = ${failureCode},
        observation_id = ${observationId}, completed_at = now()
      WHERE id = ${reserved.id} AND lifecycle = 'pending'
    `);
  }

  private async finalizeRun(runId: string): Promise<void> {
    await this.dependencies.db.execute(sql`
      UPDATE check_runs r SET status = CASE
        WHEN (SELECT count(*) FROM observations o WHERE o.check_run_id = r.id) = r.expected_region_count THEN 'complete'::run_status
        WHEN r.created_at + ((r.timeout_ms + ${collectionGraceMs}) * interval '1 millisecond') <= now() THEN 'partial'::run_status
        ELSE r.status END,
        completed_at = CASE WHEN (SELECT count(*) FROM observations o WHERE o.check_run_id = r.id) = r.expected_region_count
          OR r.created_at + ((r.timeout_ms + ${collectionGraceMs}) * interval '1 millisecond') <= now() THEN now() ELSE r.completed_at END
      WHERE r.id = ${runId}
    `);
  }

  private async finalizeExpiredRuns(): Promise<void> {
    await this.dependencies.db.execute(sql`
      UPDATE check_runs SET status = 'partial', completed_at = now()
      WHERE status = 'pending'
        AND created_at + ((timeout_ms + ${collectionGraceMs}) * interval '1 millisecond') <= now()
        AND (SELECT count(*) FROM observations WHERE check_run_id = check_runs.id) < expected_region_count
    `);
  }

  private async finalizeStaleDiagnostics(): Promise<void> {
    await this.dependencies.db.execute(sql`
      UPDATE network_diagnostics SET lifecycle = 'unavailable', failure_code = 'scheduler_abandoned', completed_at = now()
      WHERE lifecycle = 'pending' AND requested_at + (${dnsDiagnosticStaleMs} * interval '1 millisecond') <= now()
    `);
  }
}

function probeTaskKey(task: ProbeTask): string {
  return `${task.item.checkRunId}:${task.item.monitorId}`;
}

function probeResultKey(result: { checkRunId: string; monitorId: string }): string {
  return `${result.checkRunId}:${result.monitorId}`;
}

function regionalProbeBatches(tasks: ProbeTask[]): RegionalProbeBatch[] {
  const byRegion = new Map<RegionId, ProbeTask[]>();
  for (const task of tasks) {
    const regional = byRegion.get(task.regionId) ?? [];
    regional.push(task);
    byRegion.set(task.regionId, regional);
  }
  const batches: RegionalProbeBatch[] = [];
  for (const [regionId, regional] of byRegion) {
    for (let index = 0; index < regional.length; index += probeBatchSize) {
      batches.push({ regionId, tasks: regional.slice(index, index + probeBatchSize) });
    }
  }
  return batches;
}

/** Resolve a logical region from its canonical Worker name and the shared domain suffix. */
export function probeEndpointFor(env: SchedulerEnv, regionId: RegionId): string {
  return `https://${regionById[regionId].workerName}.${env.WORKERS_URL_DOMAIN}`;
}

export function claimDueRunsQuery(enabledRegionIds: readonly RegionId[] = regionIds) {
  const enabledRegionList = sql.join(
    enabledRegionIds.map((regionId) => sql`${regionId}`),
    sql`, `,
  );
  return sql`
    WITH due AS (
      SELECT id, url, timeout_ms, interval_seconds, dns_diagnostics_enabled, next_check_at
      FROM monitors
      WHERE enabled = true AND next_check_at <= now()
      ORDER BY next_check_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 50
    ), advanced AS (
      UPDATE monitors m
      SET next_check_at = d.next_check_at
        + (GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (now() - d.next_check_at)) / d.interval_seconds)::integer + 1)
           * d.interval_seconds * interval '1 second')
      FROM due d WHERE m.id = d.id
      RETURNING d.id, d.url, d.timeout_ms, d.interval_seconds, d.dns_diagnostics_enabled, d.next_check_at
    ), inserted AS (
      INSERT INTO check_runs (monitor_id, window_started_at, expected_region_count, monitor_url, timeout_ms, dns_diagnostics_enabled)
      SELECT a.id, a.next_check_at, COUNT(mr.region_id), a.url, a.timeout_ms, a.dns_diagnostics_enabled
      FROM advanced a JOIN monitor_regions mr ON mr.monitor_id = a.id
        AND mr.region_id IN (${enabledRegionList})
      GROUP BY a.id, a.next_check_at, a.url, a.timeout_ms, a.dns_diagnostics_enabled
      ON CONFLICT (monitor_id, window_started_at) DO NOTHING
      RETURNING id, monitor_id, monitor_url, timeout_ms, window_started_at, dns_diagnostics_enabled
    )
    SELECT
      i.id,
      i.monitor_id,
      i.monitor_url,
      i.timeout_ms,
      i.window_started_at,
      i.dns_diagnostics_enabled,
      ARRAY_AGG(mr.region_id)::text[] AS region_ids
    FROM inserted i JOIN monitor_regions mr ON mr.monitor_id = i.monitor_id
      AND mr.region_id IN (${enabledRegionList})
    GROUP BY
      i.id,
      i.monitor_id,
      i.monitor_url,
      i.timeout_ms,
      i.window_started_at,
      i.dns_diagnostics_enabled
  `;
}

export function finalizeDailyUptimeRollupsQuery(currentTime: Date) {
  const today = new Date(currentTime);
  today.setUTCHours(0, 0, 0, 0);
  return sql`
    WITH closed_runs AS (
      SELECT cr.id, cr.monitor_id,
        (cr.window_started_at AT TIME ZONE 'UTC')::date AS day
      FROM check_runs cr
      WHERE cr.window_started_at < ${today.toISOString()}
        AND cr.status IN ('complete', 'partial')
    ), daily AS (
      SELECT r.monitor_id, r.day,
        count(*)::integer AS received_count,
        count(*) FILTER (WHERE o.success)::integer AS success_count,
        avg(o.response_ms) FILTER (
          WHERE o.success AND o.response_ms IS NOT NULL
        )::double precision AS average_response_ms
      FROM closed_runs r
      JOIN observations o ON o.check_run_id = r.id
      GROUP BY r.monitor_id, r.day
    )
    INSERT INTO monitor_daily_uptime (
      monitor_id, day, uptime_percentage, average_response_ms, weight,
      received_count, success_count, source, finalized_at, created_at, updated_at
    )
    SELECT monitor_id, day,
      (success_count::double precision / received_count) * 100,
      average_response_ms, received_count::double precision,
      received_count, success_count, 'calculated', ${currentTime.toISOString()}, now(), now()
    FROM daily
    WHERE received_count > 0
    ON CONFLICT (monitor_id, day) DO UPDATE SET
      uptime_percentage = EXCLUDED.uptime_percentage,
      average_response_ms = EXCLUDED.average_response_ms,
      weight = EXCLUDED.weight,
      received_count = EXCLUDED.received_count,
      success_count = EXCLUDED.success_count,
      finalized_at = EXCLUDED.finalized_at,
      updated_at = now()
    WHERE monitor_daily_uptime.source = 'calculated'
  `;
}

/** Accept responses from Workers that predate endpoint evidence. */
export function parseProbeResponse(payload: unknown): ProbeResponse {
  return parseProbeResponseDetails(payload).observation;
}

/** Parse optional diagnostics without turning diagnostic failures into target outages. */
export function parseProbeResponseDetails(payload: unknown): ParsedProbeResponse {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const core = probeResponseSchema.parse({
      ...record,
      endpointEvidence: Object.hasOwn(record, 'endpointEvidence') ? record.endpointEvidence : null,
      dnsDiagnostic: null,
    });
    if (!Object.hasOwn(record, 'dnsDiagnostic') || record.dnsDiagnostic === null) {
      return { observation: core, diagnostic: { kind: 'missing' } };
    }
    const diagnostic = dnsDiagnosticResultSchema.safeParse(record.dnsDiagnostic);
    if (!diagnostic.success) return { observation: core, diagnostic: { kind: 'invalid' } };
    const combined = probeResponseSchema.safeParse({ ...record, dnsDiagnostic: diagnostic.data });
    if (!combined.success) return { observation: core, diagnostic: { kind: 'invalid' } };
    return { observation: core, diagnostic: { kind: 'complete', result: diagnostic.data } };
  }
  return { observation: probeResponseSchema.parse(payload), diagnostic: { kind: 'missing' } };
}

async function schedulerRows<T extends object>(
  db: { execute: (query: Parameters<Database['execute']>[0]) => Promise<unknown> },
  query: Parameters<Database['execute']>[0],
): Promise<T[]> {
  const result = await db.execute(query);
  const value = result as { rows?: unknown } | unknown[];
  return (Array.isArray(value) ? value : (value.rows ?? [])) as T[];
}
