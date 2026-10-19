import type { Database } from './postgres/database.js';
import {
  resolvePostgresWorkspaceDatabase,
  type PostgresTenantCatalogEntry,
} from './postgres/tenancy.js';
import type {
  R2Bucket,
  R2GetOptions,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
} from './workers-types.js';

export { type PostgresTenantCatalogEntry } from './postgres/tenancy.js';

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

/** Resolve a tenant workspace database using verified PG resolver. */
export async function resolveWorkspaceDatabase(
  control: Database,
  workspaceId: string,
  catalog: readonly PostgresTenantCatalogEntry[],
): Promise<Database> {
  return resolvePostgresWorkspaceDatabase(control, workspaceId, catalog);
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
