import type {
  D1Database,
  R2Bucket,
  R2GetOptions,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
} from './workers-types.js';

export interface TenantBindingEnv {
  readonly DB: D1Database;
  readonly CONTROL_DB?: D1Database;
  readonly [binding: string]: unknown;
}

export interface FreeLimits {
  readonly maxRegions: 3;
  readonly minIntervalSeconds: 300;
  readonly maxTimeoutMs: 10_000;
  readonly maxMonitors: 3;
  readonly maxStatusPages: 1;
  readonly maxNotificationDestinations: 3;
  readonly detailedRetentionDays: 1;
  readonly aggregateRetentionDays: 30;
  readonly dnsDiagnostics: false;
}

export const freeLimits: FreeLimits = {
  maxRegions: 3,
  minIntervalSeconds: 300,
  maxTimeoutMs: 10_000,
  maxMonitors: 3,
  maxStatusPages: 1,
  maxNotificationDestinations: 3,
  detailedRetentionDays: 1,
  aggregateRetentionDays: 30,
  dnsDiagnostics: false,
};

export interface MeasuredUsage {
  readonly checks?: number;
  readonly rowsRead?: number;
  readonly rowsWritten?: number;
  readonly storageBytes?: number;
}

export interface UsageAllowances {
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly storageBytes: number;
}

export interface MonthlyCostEstimate {
  readonly baseUsd: 5;
  readonly estimatedUsd: number;
  readonly overageUsd: number;
  readonly withinAllowance: boolean;
}

const defaultAllowances: UsageAllowances = {
  rowsRead: 25_000_000_000,
  rowsWritten: 50_000_000,
  storageBytes: 5_000_000_000,
};

/** D1 estimate only. Check counts are not billable Workers request/CPU measurements. */
export function estimateMonthlyCost(
  usage: MeasuredUsage,
  allowances: UsageAllowances = defaultAllowances,
): MonthlyCostEstimate {
  const overage = (key: keyof UsageAllowances, rate: number) =>
    Math.max(0, Number(usage[key] ?? 0) - allowances[key]) * rate;
  const overageUsd =
    overage('rowsRead', 0.000000001) +
    overage('rowsWritten', 0.000001) +
    overage('storageBytes', 0.00000000075);
  return {
    baseUsd: 5,
    overageUsd,
    estimatedUsd: 5 + overageUsd,
    withinAllowance: overageUsd === 0,
  };
}

interface WorkspaceSlotRow {
  binding_name: string;
  workspace_id: string;
  database_id: string;
  status: string;
}

interface WorkspaceMetadataRow {
  workspace_id: string;
  database_id: string | null;
  plan: string;
}

/** Resolve a statically bound tenant database and verify its identity metadata. */
export async function resolveWorkspaceDatabase(
  env: TenantBindingEnv,
  workspaceId: string,
): Promise<D1Database> {
  if (!env.CONTROL_DB) return env.DB;
  const slot = await env.CONTROL_DB.prepare(
    `SELECT binding_name, workspace_id, database_id, status
       FROM tenant_slots WHERE workspace_id = ? LIMIT 1`,
  )
    .bind(workspaceId)
    .first<WorkspaceSlotRow>();
  if (!slot || slot.status !== 'assigned' || slot.workspace_id !== workspaceId) {
    throw new Error(`Workspace ${workspaceId} has no assigned tenant database`);
  }
  const database = env[slot.binding_name];
  if (!database || typeof (database as D1Database).prepare !== 'function') {
    throw new Error(`Missing tenant database binding: ${slot.binding_name}`);
  }
  const metadata = await (database as D1Database)
    .prepare(
      `SELECT workspace_id, database_id, plan FROM workspace_metadata
       WHERE id = 1 LIMIT 1`,
    )
    .first<WorkspaceMetadataRow>()
    .catch((error) => {
      throw new Error(`Tenant database metadata is unavailable: ${String(error)}`);
    });
  if (
    !metadata ||
    metadata.workspace_id !== workspaceId ||
    (metadata.database_id !== null && metadata.database_id !== slot.database_id) ||
    metadata.plan !== 'free'
  ) {
    throw new Error(`Tenant database identity mismatch for workspace ${workspaceId}`);
  }
  return database as D1Database;
}

function prefixed(prefix: string, key: string): string {
  return `${prefix}${key}`;
}

function withKey<T extends R2Object>(object: T | null, key: string): T | null {
  if (!object) return null;
  // Native R2 methods live on its prototype and require their original receiver.
  return new Proxy(object, {
    get(target, property) {
      if (property === 'key') return key;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Scope every report object to tenants/<workspace-id>/. */
export function tenantReportsBucket(bucket: R2Bucket, workspaceId: string): R2Bucket {
  const prefix = `tenants/${encodeURIComponent(workspaceId)}/`;
  return {
    async head(key) {
      return withKey(await bucket.head(prefixed(prefix, key)), key);
    },
    async get(key, options?: R2GetOptions) {
      const object =
        options === undefined
          ? await bucket.get(prefixed(prefix, key))
          : await bucket.get(prefixed(prefix, key), options);
      return withKey(object as R2ObjectBody | null, key);
    },
    async put(key, value, options?: R2PutOptions) {
      return withKey(await bucket.put(prefixed(prefix, key), value, options), key);
    },
    async delete(keys) {
      const scoped = Array.isArray(keys)
        ? keys.map((key) => prefixed(prefix, key))
        : prefixed(prefix, keys);
      await bucket.delete(scoped);
    },
    async list(options) {
      const result = await bucket.list({
        ...options,
        prefix: prefixed(prefix, options?.prefix ?? ''),
      });
      return {
        ...result,
        objects: result.objects.map((object) => withKey(object, object.key.slice(prefix.length))!),
      };
    },
  };
}
