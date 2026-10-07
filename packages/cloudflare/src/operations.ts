import { randomToken } from './crypto.js';
import type { Database } from './postgres/database.js';
import { pgAll, pgRun } from './postgres/query.js';

interface PauseRow {
  scope: string;
  paused: number;
  reason: string;
  actor: string;
  changed_at: string;
}

/**
 * Explicit, reversible switch. Only the exact string "true" turns budget enforcement off;
 * unset, empty, or any other value keeps it on. Cost reporting is unaffected.
 */
export function budgetEnforcementDisabled(env?: object): boolean {
  return (env as Record<string, unknown> | undefined)?.BUDGET_ENFORCEMENT_DISABLED === 'true';
}

/**
 * With `ignoreBudget`, the persisted automatic `budget` pause row has no effect.
 * Fleet and workspace manual pauses always apply.
 */
export async function schedulingState(
  control: Database,
  workspaceId?: string,
  options: { ignoreBudget?: boolean } = {},
) {
  const rows = await pgAll<PauseRow>(
    control,
    `SELECT scope, paused, reason, actor, changed_at
     FROM ${control.table('scheduling_controls')}
     WHERE scope IN ('fleet', $1, 'budget')`,
    [workspaceId ?? 'fleet'],
  );
  const records = rows
    .filter((row) => !(options.ignoreBudget && row.scope === 'budget'))
    .map((row) => ({
      scope: row.scope,
      paused: Number(row.paused) === 1,
      reason: row.reason,
      actor: row.actor,
      changedAt: row.changed_at,
    }));
  return {
    paused: records.some((row) => row.paused),
    manual: records.filter((row) => row.scope !== 'budget'),
    automatic: records.find((row) => row.scope === 'budget' && row.paused) ?? null,
    inFlightMayComplete: true as const,
    resumeConditions: [
      'Fleet and workspace manual scheduling pauses must both be cleared',
      'Live monthly forecast must be strictly below min(20 USD, configured monthly budget)',
      'Workspace access must be active and its database identity and lease must be valid',
    ],
  };
}

export async function setSchedulingPause(
  control: Database,
  scope: string,
  paused: boolean,
  reason: string,
  actor: string,
  now = new Date(),
) {
  const changedAt = now.toISOString();
  await control.transaction(async (tx) => {
    await pgRun(
      tx,
      `INSERT INTO ${tx.table('scheduling_controls')} (scope, paused, reason, actor, changed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope) DO UPDATE SET
         paused = excluded.paused,
         reason = excluded.reason,
         actor = excluded.actor,
         changed_at = excluded.changed_at`,
      [scope, paused ? 1 : 0, reason, actor, changedAt],
    );
    await pgRun(
      tx,
      `INSERT INTO ${tx.table('workspace_events')} (id, workspace_id, event, actor_did, created_at, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomToken(16),
        scope === 'fleet' ? null : scope,
        paused ? 'scheduling_paused' : 'scheduling_resumed',
        actor,
        changedAt,
        JSON.stringify({ scope, paused, reason, inFlightMayComplete: true }),
      ],
    );
  });
}

export async function recordBudgetPause(control: Database, allowed: boolean, now: Date) {
  await pgRun(
    control,
    `INSERT INTO ${control.table('scheduling_controls')} (scope, paused, reason, actor, changed_at)
     VALUES ('budget', $1, 'Monthly forecast reached the dispatch ceiling', 'system:budget', $2)
     ON CONFLICT (scope) DO UPDATE SET
       paused = excluded.paused,
       changed_at = excluded.changed_at
     WHERE ${control.table('scheduling_controls')}.paused <> excluded.paused`,
    [allowed ? 0 : 1, now.toISOString()],
  );
}
