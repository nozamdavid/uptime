import { nowIso } from '@uptime/cloudflare';
import { pgAll as all, pgRun as run, type Database } from '@uptime/cloudflare/postgres';
import type { RegionId } from '@uptime/regions';
import type { DnsDiagnosticResult } from '@uptime/contracts';

import type { DiagnosticDisposition, ReservedDiagnostic } from './probe.js';

const dnsDiagnosticStaleMs = 60_000;

/** Return the UTC day containing the supplied timestamp. */
export function utcDayWindow(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/**
 * Reserve one diagnostic row per monitor/region/day. Returns only the
 * reservations this invocation won, mirroring the scheduler's once-per-day
 * snapshot semantics.
 */
export async function reserveDiagnostics(
  db: Database,
  round: { id: string; monitorId: string; windowStartedAt: string },
  regionIds: readonly RegionId[],
): Promise<Map<RegionId, ReservedDiagnostic>> {
  const windowStartedAt = utcDayWindow(new Date(round.windowStartedAt)).toISOString();
  const reservations: (readonly [RegionId, ReservedDiagnostic])[] = [];
  for (const regionId of regionIds) {
    const inserted = await all<{ id: string; region_id: RegionId; window_started_at: string }>(
      db,
      `INSERT INTO ${db.table('network_diagnostics')} (
         monitor_id, check_run_id, region_id, kind, window_started_at, lifecycle, requested_at, started_at
       ) VALUES ($1, $2, $3, 'dns_candidates', $4, 'pending', $5, $6)
       ON CONFLICT (monitor_id, region_id, kind, window_started_at) DO NOTHING
       RETURNING id, region_id, window_started_at`,
      [round.monitorId, round.id, regionId, windowStartedAt, nowIso(), nowIso()],
    );
    const insertedRow = inserted[0];
    if (!insertedRow) continue;
    reservations.push([
      regionId,
      { id: insertedRow.id, regionId, windowStartedAt: insertedRow.window_started_at },
    ]);
  }
  return new Map(reservations);
}

/** Persist a diagnostic outcome without ever affecting the target's health. */
export async function persistDiagnostic(
  db: Database,
  reserved: ReservedDiagnostic,
  observationId: string | null,
  disposition: DiagnosticDisposition,
): Promise<void> {
  if (disposition.kind === 'complete') {
    const matches =
      disposition.result.diagnosticId === reserved.id &&
      new Date(disposition.result.windowStartedAt).getTime() ===
        new Date(reserved.windowStartedAt).getTime();
    if (matches) {
      await run(
        db,
        `UPDATE ${db.table('network_diagnostics')}
         SET lifecycle = 'complete', result = $1, failure_code = NULL,
           observation_id = $2, completed_at = $3
         WHERE id = $4 AND lifecycle = 'pending'`,
        [JSON.stringify(disposition.result), observationId, nowIso(), reserved.id],
      );
      return;
    }
  }
  const failureCode =
    disposition.kind === 'invalid' || disposition.kind === 'complete'
      ? 'protocol_invalid_response'
      : 'worker_unsupported_or_missing';
  await run(
    db,
    `UPDATE ${db.table('network_diagnostics')}
     SET lifecycle = 'unavailable', failure_code = $1, observation_id = $2, completed_at = $3
     WHERE id = $4 AND lifecycle = 'pending'`,
    [failureCode, observationId, nowIso(), reserved.id],
  );
}

/** Mark diagnostics abandoned by an interrupted coordinator as unavailable. */
export async function finalizeStaleDiagnostics(db: Database, now: Date): Promise<number> {
  const result = await run(
    db,
    `UPDATE ${db.table('network_diagnostics')}
     SET lifecycle = 'unavailable', failure_code = 'scheduler_abandoned', completed_at = $1
     WHERE lifecycle = 'pending' AND requested_at <= $2`,
    [nowIso(now), nowIso(new Date(now.getTime() - dnsDiagnosticStaleMs))],
  );
  return result.rowCount ?? 0;
}

export type { DnsDiagnosticResult };
