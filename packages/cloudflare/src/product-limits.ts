import type { Database } from './postgres/database.js';
import { pgFirst, pgRun } from './postgres/query.js';
import { isRegionId, type RegionId } from './regions.js';

export interface ProductLimits {
  monitors: number;
  regions: number;
  allowedRegionIds: RegionId[];
}

interface ProductLimitsRow {
  monitors: number;
  regions: number;
  allowed_region_ids: string;
}

const preferredRegions: readonly RegionId[] = ['eu-west', 'us-east', 'asia'];

/** Derive the original hosted defaults from regions actually enabled in a deployment. */
export function defaultProductLimits(configuredRegionIds: readonly RegionId[]): ProductLimits {
  const configured = new Set(configuredRegionIds);
  const allowedRegionIds = [
    ...preferredRegions.filter((region) => configured.has(region)),
    ...configuredRegionIds.filter((region) => !preferredRegions.includes(region)),
  ].slice(0, 3);
  if (allowedRegionIds.length === 0) throw new Error('No deployment regions are configured');
  return {
    monitors: 3,
    regions: Math.min(3, allowedRegionIds.length),
    allowedRegionIds,
  };
}

/** Read a syntactically valid saved policy, including regions removed from a deployment. */
export async function savedWorkspaceProductLimits(
  control: Database,
  workspaceId: string,
  configuredRegionIds: readonly RegionId[],
): Promise<ProductLimits> {
  const row = await pgFirst<ProductLimitsRow>(
    control,
    `SELECT monitors, regions, allowed_region_ids
     FROM ${control.table('workspace_product_limits')}
     WHERE workspace_id = $1`,
    [workspaceId],
  );

  if (!row) return defaultProductLimits(configuredRegionIds);
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.allowed_region_ids);
  } catch {
    throw new Error(`Workspace ${workspaceId} has an invalid region policy`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > 9 ||
    parsed.some((region) => typeof region !== 'string' || !isRegionId(region)) ||
    new Set(parsed).size !== parsed.length ||
    !Number.isInteger(row.monitors) ||
    row.monitors < 0 ||
    row.monitors > 1000 ||
    !Number.isInteger(row.regions) ||
    row.regions < 1 ||
    row.regions > parsed.length
  ) {
    throw new Error(`Workspace ${workspaceId} has an invalid product policy`);
  }
  return { monitors: row.monitors, regions: row.regions, allowedRegionIds: parsed as RegionId[] };
}

/** Read a policy for dispatch, rejecting any region the deployment cannot serve. */
export async function workspaceProductLimits(
  control: Database,
  workspaceId: string,
  configuredRegionIds: readonly RegionId[],
): Promise<ProductLimits> {
  const limits = await savedWorkspaceProductLimits(control, workspaceId, configuredRegionIds);
  const configured = new Set(configuredRegionIds);
  if (limits.allowedRegionIds.some((region) => !configured.has(region))) {
    throw new Error(`Workspace ${workspaceId} policy includes a region that is not configured`);
  }
  return limits;
}

/** Save product limits locking workspace row FOR NO KEY UPDATE before mutating limits. */
export async function saveWorkspaceProductLimits(
  control: Database,
  workspaceId: string,
  limits: ProductLimits,
): Promise<ProductLimits> {
  return control.transaction(async (tx) => {
    const workspace = await pgFirst<{ id: string }>(
      tx,
      `SELECT id FROM ${tx.table('workspaces')} WHERE id = $1 FOR NO KEY UPDATE`,
      [workspaceId],
    );
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

    await pgRun(
      tx,
      `INSERT INTO ${tx.table('workspace_product_limits')}
       (workspace_id, monitors, regions, allowed_region_ids, updated_at)
       VALUES ($1, $2, $3, $4, to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       ON CONFLICT (workspace_id) DO UPDATE SET
         monitors = excluded.monitors,
         regions = excluded.regions,
         allowed_region_ids = excluded.allowed_region_ids,
         updated_at = excluded.updated_at`,
      [workspaceId, limits.monitors, limits.regions, JSON.stringify(limits.allowedRegionIds)],
    );
    return limits;
  });
}

/** Keep tenant SQL quota triggers aligned with the authoritative control-plane policy. */
export async function syncWorkspaceProductLimits(
  db: Database,
  limits: ProductLimits,
): Promise<void> {
  const result = await db.query(
    `UPDATE ${db.table('workspace_metadata')}
     SET monitor_limit = $1, region_limit = $2, allowed_region_ids = $3,
         updated_at = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     WHERE id = 1`,
    [limits.monitors, limits.regions, JSON.stringify(limits.allowedRegionIds)],
  );
  if (result.rowCount !== 1) {
    throw new Error('Tenant workspace policy metadata is unavailable');
  }
}
