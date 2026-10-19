import {
  parseRegionsList,
  requireBinding,
  configuredMonitorBatch,
  type CloudflareEnv,
  type R2Bucket,
} from '@uptime/cloudflare';
import type { Database, PostgresRuntimeBindings } from '@uptime/cloudflare/postgres';
import { regionById, type RegionDefinition, type RegionId } from '@uptime/regions';

/**
 * Validated coordinator configuration.
 *
 * Workers bindings arrive as strings, so numeric options are coerced. Every
 * bound is explicit because plan.md requires bounded per-invocation work.
 */
export interface ReportConfig {
  readonly db: Database;
  readonly schedulingPolicy?: 'hosted' | 'legacy';
  readonly reports: R2Bucket | null;
  readonly reportIntervalSeconds: number;
  readonly staleAfterSeconds: number;
}

export interface CoordinatorConfig extends ReportConfig {
  readonly enabledRegionIds: RegionId[];
  readonly enabledRegions: RegionDefinition[];
  readonly workersUrlDomain: string;
  /** Worker-name prefix prepended to a region id, including the trailing hyphen. */
  readonly probeWorkerNamePrefix?: string;
  readonly probeSigningSecret: string;
  readonly credentialEncryptionSecret: string;
  readonly reportScheduleDisabled?: boolean;
  readonly monitorBatch: number;
  readonly probeConcurrency: number;
  readonly probeRequestMaxSkewSeconds: number;
  readonly notificationMaxAttempts: number;
  readonly detailedResultsRetentionDays: number;
  readonly dnsDiagnosticsRetentionDays: number;
  /** Preserve history at or before this fixed import snapshot timestamp. */
  readonly historyRetentionPreserveBefore?: string;
  readonly environment: string | undefined;
}

export interface CoordinatorEnv
  extends
    Omit<CloudflareEnv, 'DB' | 'CONTROL_DB' | keyof PostgresRuntimeBindings>,
    PostgresRuntimeBindings {
  REPORTS?: R2Bucket;
  TENANT_JOBS?: { send(job: import('./tenant-dispatch.js').TenantJob): Promise<void> };
  CURRENT_BUDGET_USAGE_JSON?: string;
  /** Only "true" disables budget enforcement. Unset keeps it on. */
  BUDGET_ENFORCEMENT_DISABLED?: string;
}

/** Internal resolved report session; Worker bindings are resolved at each event. */
export interface ReportEnv extends Omit<CloudflareEnv, 'DB' | 'CONTROL_DB'> {
  DB: Database;
  REPORTS: R2Bucket;
}

function intVar(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Expected an integer between ${minimum} and ${maximum}, received ${String(value)}`,
    );
  }
  return parsed;
}

function optionalIsoTimestamp(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

function optionalSecret(source: Record<string, unknown>): string {
  const candidate =
    source['CREDENTIAL_ENCRYPTION_SECRET'] ?? source['NOTIFICATION_ENCRYPTION_KEY'] ?? undefined;
  if (typeof candidate !== 'string' || candidate.length < 32) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_SECRET (or NOTIFICATION_ENCRYPTION_KEY) must be a secret of at least 32 characters',
    );
  }
  return candidate;
}

function workerDomain(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('WORKERS_URL_DOMAIN is required to reach regional probes');
  }
  const domain = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      domain,
    )
  ) {
    throw new Error('WORKERS_URL_DOMAIN must be a bare domain such as account.workers.dev');
  }
  return domain;
}

const defaultProbeWorkerNamePrefix = 'uptime-probe-';

function probeWorkerNamePrefix(value: unknown): string {
  const prefix = value === undefined || value === null ? defaultProbeWorkerNamePrefix : value;
  if (typeof prefix !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-$/.test(prefix)) {
    throw new Error(
      'PROBE_WORKER_NAME_PREFIX must be a lowercase DNS worker-name prefix ending in a hyphen',
    );
  }
  for (const regionId of Object.keys(regionById) as RegionId[]) {
    const workerName = `${prefix}${regionId}`;
    if (workerName.length > 63) {
      throw new Error('PROBE_WORKER_NAME_PREFIX produces a worker name longer than 63 characters');
    }
  }
  return prefix;
}

function reportSettings(
  source: Pick<CoordinatorEnv, 'REPORTS'>,
  db: Database,
): ReportConfig {
  const record = source as unknown as Record<string, unknown>;
  const reportIntervalSeconds = intVar(record['REPORT_INTERVAL_SECONDS'], 60, 60, 86_400);
  return {
    db,
    reports: source.REPORTS ?? null,
    reportIntervalSeconds,
    staleAfterSeconds: reportIntervalSeconds + 120,
  };
}

export function parseReportEnv(source: ReportEnv, db: Database = source.DB): ReportConfig {
  const settings = reportSettings(source, db);
  return { ...settings, reports: requireBinding(source.REPORTS, 'REPORTS') };
}

export function parseCoordinatorEnv(source: CoordinatorEnv, db?: Database): CoordinatorConfig {
  if (!db) throw new Error('Coordinator requires an explicitly resolved PostgreSQL Database');
  const record = source as unknown as Record<string, unknown>;
  const enabledRegionIds = parseRegionsList(
    typeof record['REGIONS_LIST'] === 'string' ? (record['REGIONS_LIST'] as string) : undefined,
  );
  const historyRetentionPreserveBefore = optionalIsoTimestamp(
    record['HISTORY_RETENTION_PRESERVE_BEFORE'],
    'HISTORY_RETENTION_PRESERVE_BEFORE',
  );
  return {
    ...reportSettings(source, db),
    enabledRegionIds,
    enabledRegions: enabledRegionIds.map((regionId) => regionById[regionId]),
    workersUrlDomain: workerDomain(record['WORKERS_URL_DOMAIN']),
    probeWorkerNamePrefix: probeWorkerNamePrefix(record['PROBE_WORKER_NAME_PREFIX']),
    probeSigningSecret: requireBinding(
      typeof record['PROBE_SIGNING_SECRET'] === 'string'
        ? (record['PROBE_SIGNING_SECRET'] as string)
        : undefined,
      'PROBE_SIGNING_SECRET',
    ),
    credentialEncryptionSecret: optionalSecret(record),
    reportScheduleDisabled: record['REPORT_SCHEDULE_DISABLED'] === 'true',
    monitorBatch: configuredMonitorBatch(record),
    probeConcurrency: intVar(record['COORDINATOR_PROBE_CONCURRENCY'], 32, 1, 100),
    probeRequestMaxSkewSeconds: intVar(record['PROBE_REQUEST_MAX_SKEW_SECONDS'], 60, 15, 300),
    notificationMaxAttempts: intVar(record['NOTIFICATION_MAX_ATTEMPTS'], 8, 1, 100),
    detailedResultsRetentionDays: intVar(record['DETAILED_RESULTS_RETENTION_DAYS'], 7, 1, 3_650),
    dnsDiagnosticsRetentionDays: intVar(record['DNS_DIAGNOSTICS_RETENTION_DAYS'], 30, 1, 3_650),
    ...(historyRetentionPreserveBefore === undefined ? {} : { historyRetentionPreserveBefore }),
    environment:
      typeof record['ENVIRONMENT'] === 'string' ? (record['ENVIRONMENT'] as string) : undefined,
  };
}
