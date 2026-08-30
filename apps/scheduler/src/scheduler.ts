import { sql } from 'drizzle-orm';

import { regionById, type SchedulerEnv } from '@uptime/config';
import type { DnsDiagnosticResult, ProbeResponse, RegionId } from '@uptime/contracts';
import { dnsDiagnosticResultSchema, probeResponseSchema } from '@uptime/contracts';
import { createDatabase, type Database } from '@uptime/database';

import { signProbeRequest } from './signing.js';
import { assertCurrentlyPublicTarget } from './url-policy.js';
import { utcDayWindow } from './dns-diagnostics.js';
import { ConcurrencyLimiter } from './concurrency.js';

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

  public constructor(
    private readonly env: SchedulerEnv,
    private readonly dependencies: SchedulerDependencies,
  ) {
    this.probeConcurrency = new ConcurrencyLimiter(env.SCHEDULER_MAX_CONCURRENT_PROBES);
  }

  public async tick(): Promise<void> {
    await this.finalizeStaleDiagnostics();
    await this.finalizeExpiredRuns();
    const runs = await this.claimDueRuns();
    await Promise.all(runs.map((run) => this.executeRun(run)));
  }

  public async maintenance(): Promise<void> {
    const db = this.dependencies.db;
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
    /* next_check_at moves by calendar interval, never completion time. SKIP LOCKED makes replicas safe. */
    const result = await this.dependencies.db.execute(claimDueRunsQuery());
    return result as unknown as ClaimedRun[];
  }

  private async executeRun(run: ClaimedRun): Promise<void> {
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
      return;
    }
    const diagnostics = run.dns_diagnostics_enabled
      ? await this.reserveDiagnostics(run)
      : new Map<RegionId, ReservedDiagnostic>();
    const results = await Promise.all(
      run.region_ids.map(async (regionId) => {
        const reserved = diagnostics.get(regionId);
        const baseRequest = {
          checkRunId: run.id,
          monitorId: run.monitor_id,
          windowStartedAt: new Date(run.window_started_at).toISOString(),
          regionId,
          url: run.monitor_url,
          timeoutMs: run.timeout_ms,
          method: 'GET' as const,
          maxRedirects: 5 as const,
          maxBodyBytes: 65_536 as const,
          dnsDiagnostic: reserved
            ? {
                diagnosticId: reserved.id,
                windowStartedAt: reserved.windowStartedAt.toISOString(),
                deadlineMs: dnsDiagnosticDeadlineMs,
              }
            : null,
        };
        const signed = signProbeRequest(
          baseRequest,
          this.env.PROBE_SIGNING_SECRET,
          this.dependencies.now(),
        );
        try {
          const response = await this.probeConcurrency.run(() =>
            this.dependencies.fetch(probeEndpointFor(this.env, regionId), {
              method: 'POST',
              headers: signed.headers,
              body: signed.body,
              signal: AbortSignal.timeout(run.timeout_ms + collectionGraceMs),
            }),
          );
          if (!response.ok) throw new Error(`Probe returned ${response.status}`);
          const parsed = parseProbeResponseDetails(await response.json());
          if (parsed.observation.regionId !== regionId)
            throw new Error('Probe returned a mismatched region');
          return { regionId, parsed, reserved };
        } catch (error) {
          this.dependencies.log.warn({
            event: 'probe_unreachable',
            runId: run.id,
            regionId,
            error: String(error),
          });
          return { regionId, parsed: null, reserved };
        }
      }),
    );
    await Promise.all(
      results
        .filter(
          (
            result,
          ): result is {
            regionId: RegionId;
            parsed: ParsedProbeResponse;
            reserved: ReservedDiagnostic | undefined;
          } => result.parsed !== null,
        )
        .map(async (result) => {
          const observationId = await this.persistObservation(
            run,
            result.regionId,
            result.parsed.observation,
          );
          if (result.reserved) {
            await this.persistDiagnostic(result.reserved, observationId, result.parsed.diagnostic);
          }
        }),
    );
    await this.finalizeRun(run.id);
  }

  private async reserveDiagnostics(run: ClaimedRun): Promise<Map<RegionId, ReservedDiagnostic>> {
    const windowStartedAt = utcDayWindow(new Date(run.window_started_at));
    const reservations = await Promise.all(
      run.region_ids.map(async (regionId) => {
        const inserted = await schedulerRows<{
          id: string;
          regionId: RegionId;
          windowStartedAt: Date;
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
        const reservation = inserted[0];
        return reservation ? ([regionId, reservation] as const) : null;
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

/** Resolve a logical region through the one canonical registry/env-name mapping. */
export function probeEndpointFor(env: SchedulerEnv, regionId: RegionId): string {
  return env[regionById[regionId].endpointEnvName];
}

export function claimDueRunsQuery() {
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
    GROUP BY
      i.id,
      i.monitor_id,
      i.monitor_url,
      i.timeout_ms,
      i.window_started_at,
      i.dns_diagnostics_enabled
  `;
}

/**
 * Keeps the scheduler compatible with Workers deployed before endpoint evidence
 * existed. A present value is always parsed by the shared contract; it is never
 * silently discarded if malformed.
 */
export function parseProbeResponse(payload: unknown): ProbeResponse {
  return parseProbeResponseDetails(payload).observation;
}

/**
 * Core uptime data and an optional diagnostic use separate validation paths.
 * A diagnostic protocol failure is stored as diagnostic evidence, never turned
 * into a target outage.
 */
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
