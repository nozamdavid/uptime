/**
 * Cloudflare Workers Paid Tier Usage & Limits Adapter
 *
 * Provides an honest, verifiable account-level overview of Cloudflare resource usage against
 * official paid tier inclusions, billing overages, and technical hard limits.
 *
 * STRICT ARCHITECTURAL PRINCIPLES:
 * 1. NEVER declare an account 'within' limits from unmeasured or tenant-only metrics.
 *    If any metric is missing, unavailable, or errored, it is reported as 'unknown'.
 * 2. Unmeasured services (e.g. R2 without bucket-level queries, Workers CPU time sum
 *    not exposed in GraphQL invocations sum) must be explicitly marked 'unknown'.
 * 3. UTC calendar month queries represent a reporting period, NOT an account invoice billing cycle.
 *    Never assert full monthly allowance compliance unless the full applicable cycle is verified.
 * 4. Internal $20 guard represents the hosted D1 rolling forecast; the account usage adapter
 *    must never pretend that point-in-time account overages enforce that hosted guard.
 * 5. Sanitized error handling: never echo raw tokens, authorization headers, or unbounded responses.
 */

export interface CloudflarePaidLimits {
  workers: {
    baseFeeUsd: number;
    includedRequests: number;
    requestsOveragePricePerMillionUsd: number;
    includedCpuMs: number;
    cpuMsOveragePricePerMillionUsd: number;
    hardLimits: {
      defaultHttpCpuMs: number;
      maxConfigurableHttpCpuMs: number;
      cronFrequentCpuMs: number;
      cronInfrequentCpuMs: number;
      maxScriptsPerAccount: number;
      // Compatibility aliases
      maxHttpCpuMs: number;
      maxCronQueueCpuMs: number;
    };
  };
  d1: {
    includedRowsRead: number;
    rowsReadOveragePricePerMillionUsd: number;
    includedRowsWritten: number;
    rowsWrittenOveragePricePerMillionUsd: number;
    includedStorageBytes: number;
    storageOveragePricePerGbMonthUsd: number;
    hardLimits: {
      maxDatabasesPerAccount: number;
      maxDatabaseSizeBytes: number;
      maxAccountStorageBytes: number;
      maxQueriesPerInvocation: number;
      maxBoundParametersPerQuery: number;
      maxQueryDurationMs: number;
    };
  };
  queues: {
    includedOperations: number;
    operationsOveragePricePerMillionUsd: number;
    operationChunkSizeBytes: number;
    hardLimits: {
      maxRetentionDays: number;
    };
  };
  r2: {
    includedStorageBytes: number;
    storageOveragePricePerGbMonthUsd: number;
    includedClassAOperations: number;
    classAOveragePricePerMillionUsd: number;
    includedClassBOperations: number;
    classBOveragePricePerMillionUsd: number;
    egressFeeUsd: number;
  };
  guards: {
    internalForecastGuardUsd: number;
  };
}

/**
 * Official Cloudflare Paid Tier Thresholds & Limits (Verified from primary docs as of October 2026).
 * Primary sources:
 * - Workers Pricing: https://developers.cloudflare.com/workers/platform/pricing/ (10M requests, 30M CPU-ms included)
 * - Workers Limits: https://developers.cloudflare.com/workers/platform/limits/ (30s default HTTP CPU, 5m max configurable, 15m Cron trigger >=1h schedule, 30s Cron <1h schedule, 500 scripts max on Paid plan)
 * - D1 Pricing: https://developers.cloudflare.com/d1/platform/pricing/ (25B rows read, 50M rows written, 5 GB storage included; 1 GB = 10^9 bytes)
 * - D1 Limits: https://developers.cloudflare.com/d1/platform/limits/ (50,000 DBs per account on Paid plan, 10 GB per DB, 1 TB account storage)
 * - Queues Pricing: https://developers.cloudflare.com/queues/platform/pricing/ (1M operations included, 64 KB chunks, $0.40/M)
 * - R2 Pricing: https://developers.cloudflare.com/r2/pricing/ (10 GB storage, 1M Class A, 10M Class B, $0 egress)
 */
export const OFFICIAL_CLOUDFLARE_LIMITS: CloudflarePaidLimits = {
  workers: {
    baseFeeUsd: 5.0,
    includedRequests: 10_000_000,
    requestsOveragePricePerMillionUsd: 0.3,
    includedCpuMs: 30_000_000,
    cpuMsOveragePricePerMillionUsd: 0.02,
    hardLimits: {
      defaultHttpCpuMs: 30_000, // 30s default HTTP CPU
      maxConfigurableHttpCpuMs: 300_000, // Configurable up to 5 min on Paid plan
      cronFrequentCpuMs: 30_000, // 30s for schedules < 1 hour
      cronInfrequentCpuMs: 900_000, // 15 min for schedules >= 1 hour
      maxScriptsPerAccount: 500, // 500 scripts on Paid plan (100 on Free)
      maxHttpCpuMs: 30_000,
      maxCronQueueCpuMs: 900_000,
    },
  },
  d1: {
    includedRowsRead: 25_000_000_000, // 25 Billion
    rowsReadOveragePricePerMillionUsd: 0.001,
    includedRowsWritten: 50_000_000, // 50 Million
    rowsWrittenOveragePricePerMillionUsd: 1.0,
    includedStorageBytes: 5_000_000_000, // 5 GB (Cloudflare decimal GB: 1 GB = 10^9 bytes)
    storageOveragePricePerGbMonthUsd: 0.75,
    hardLimits: {
      maxDatabasesPerAccount: 50_000, // 50,000 databases per account on Paid plan
      maxDatabaseSizeBytes: 10_000_000_000, // 10 GB per database
      maxAccountStorageBytes: 1_000_000_000_000, // 1 TB account storage
      maxQueriesPerInvocation: 1_000,
      maxBoundParametersPerQuery: 100,
      maxQueryDurationMs: 30_000,
    },
  },
  queues: {
    includedOperations: 1_000_000, // 1 Million
    operationsOveragePricePerMillionUsd: 0.4,
    operationChunkSizeBytes: 64_000, // Cloudflare pricing uses decimal KB.
    hardLimits: {
      maxRetentionDays: 14, // Up to 14 days configurable (default 4 days)
    },
  },
  r2: {
    includedStorageBytes: 10_000_000_000, // 10 GB (10^10 bytes)
    storageOveragePricePerGbMonthUsd: 0.015,
    includedClassAOperations: 1_000_000, // 1 Million (mutate/write)
    classAOveragePricePerMillionUsd: 4.5,
    includedClassBOperations: 10_000_000, // 10 Million (read)
    classBOveragePricePerMillionUsd: 0.36,
    egressFeeUsd: 0.0, // Egress is free
  },
  guards: {
    internalForecastGuardUsd: 20.0,
  },
};

export type UsageStatus = 'within' | 'warning' | 'exceeded' | 'unknown';
export type MetricKind = 'included_usage' | 'hard_limit';
export type MetricSource = 'cloudflare_api' | 'unconfigured' | 'mock';

export interface CloudflareUsageMetric {
  id: string;
  name: string;
  category: 'workers' | 'd1' | 'queues' | 'r2';
  kind: MetricKind;
  status: UsageStatus;
  source: MetricSource;
  used: number | null;
  limit: number | null;
  unit: string;
  percentUsed: number | null;
  overageUnitPriceUsd?: number | null;
  estimatedOverageCostUsd?: number | null;
  description: string;
}

export interface SetupNeededInstructions {
  configured: boolean;
  missingVariables: string[];
  requiredPermissions: string[];
  instructions: string;
}

export interface CloudflareUsageReport {
  asOf: string;
  periodStart: string | null;
  periodEnd: string | null;
  status: UsageStatus;
  coverage: string;
  forecastGuardUsd: number;
  totalEstimatedOverageCostUsd: number | null;
  forecastGuardExceeded: boolean | null;
  isWithinAllowance: boolean | null;
  hasHardLimitViolation: boolean | null;
  exceededIncludedUsages: string[];
  exceededHardLimits: string[];
  metrics: CloudflareUsageMetric[];
  setupNeeded?: SetupNeededInstructions;
}

export interface CloudflareUsageConfig {
  accountId?: string | undefined;
  apiToken?: string | undefined;
  endpoint?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  ttlMs?: number | undefined;
  now?: (() => Date) | undefined;
  forecastGuardUsd?: number | undefined;
  hostedForecastUsd?: number | undefined;
  billingPeriodVerified?: boolean | undefined;
}

interface CacheEntry {
  report: CloudflareUsageReport;
  expiresAt: number;
}

const reportCache = new Map<string, CacheEntry>();

/**
 * Clear the in-memory usage cache (useful for tests or forced reloads).
 */
export function clearCloudflareUsageCache(): void {
  reportCache.clear();
}

/**
 * Sanitizes upstream error messages to avoid leaking tokens, auth headers, or raw html into the UI.
 */
export function sanitizeErrorMessage(rawMessage: unknown): string {
  if (!rawMessage) return 'Unknown error';
  const str = rawMessage instanceof Error ? rawMessage.message : String(rawMessage);
  return str
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
    .replace(/(apiToken|api_token|token|key|secret)=([A-Za-z0-9_\-\.]+)/gi, '$1=[REDACTED]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi, '[REDACTED_EMAIL]')
    .slice(0, 300);
}

/**
 * Validates whether a value is a finite, non-negative number.
 */
export function isValidFiniteNonNegative(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0;
}

/**
 * Computes calendar reporting period boundaries and month expiration.
 */
function getReportingPeriod(nowDate: Date): {
  startIso: string;
  endIso: string;
  startDateStr: string;
  endDateStr: string;
  monthKey: string;
  monthEndMs: number;
} {
  const year = nowDate.getUTCFullYear();
  const month = nowDate.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const startIso = start.toISOString();
  const endIso = nowDate.toISOString();
  const startDateStr = startIso.split('T')[0]!;
  const endDateStr = endIso.split('T')[0]!;
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const monthEndMs = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)).getTime();

  return {
    startIso,
    endIso,
    startDateStr,
    endDateStr,
    monthKey,
    monthEndMs,
  };
}

/**
 * Computes a quick non-reversible fingerprint of the token to isolate cache entries across rotations.
 */
function fingerprintToken(token: string): string {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

/**
 * Builds unconfigured default metrics when credentials are absent or invalid.
 */
function buildUnconfiguredMetrics(): CloudflareUsageMetric[] {
  const limits = OFFICIAL_CLOUDFLARE_LIMITS;
  return [
    {
      id: 'workers_requests',
      name: 'Workers Requests',
      category: 'workers',
      kind: 'included_usage',
      status: 'unknown',
      source: 'unconfigured',
      used: null,
      limit: limits.workers.includedRequests,
      unit: 'requests',
      percentUsed: null,
      overageUnitPriceUsd: limits.workers.requestsOveragePricePerMillionUsd,
      estimatedOverageCostUsd: null,
      description: '10M requests included per month on Paid plan ($0.30/M overage).',
    },
    {
      id: 'workers_cpu_ms',
      name: 'Workers CPU Time',
      category: 'workers',
      kind: 'included_usage',
      status: 'unknown',
      source: 'unconfigured',
      used: null,
      limit: limits.workers.includedCpuMs,
      unit: 'ms',
      percentUsed: null,
      overageUnitPriceUsd: limits.workers.cpuMsOveragePricePerMillionUsd,
      estimatedOverageCostUsd: null,
      description:
        '30M CPU milliseconds included per month on Paid plan ($0.02/M overage). Total CPU execution time is not provided by GraphQL invocations sum (percentiles only).',
    },
    {
      id: 'workers_script_count',
      name: 'Workers Script Count',
      category: 'workers',
      kind: 'hard_limit',
      status: 'unknown',
      source: 'unconfigured',
      used: null,
      limit: limits.workers.hardLimits.maxScriptsPerAccount,
      unit: 'scripts',
      percentUsed: null,
      description: 'Maximum 500 scripts allowed per Cloudflare account on Paid plan (100 on Free).',
    },
    {
      id: 'd1_rows_read',
      name: 'D1 Rows Read',
      category: 'd1',
      kind: 'included_usage',
      status: 'unknown',
      source: 'unconfigured',
      used: null,
      limit: limits.d1.includedRowsRead,
      unit: 'rows',
      percentUsed: null,
      overageUnitPriceUsd: limits.d1.rowsReadOveragePricePerMillionUsd,
      estimatedOverageCostUsd: null,
      description: '25 Billion rows read included per month ($0.001/M overage).',
    },
    {
      id: 'd1_rows_written',
      name: 'D1 Rows Written',
      category: 'd1',
      kind: 'included_usage',
      status: 'unknown',
      source: 'unconfigured',
      used: null,
      limit: limits.d1.includedRowsWritten,
      unit: 'rows',
      percentUsed: null,
      overageUnitPriceUsd: limits.d1.rowsWrittenOveragePricePerMillionUsd,
      estimatedOverageCostUsd: null,
      description: '50 Million rows written included per month ($1.00/M overage).',
    },
    {
      id: 'd1_storage',
      name: 'D1 Storage',
      category: 'd1',
      kind: 'included_usage',
      status: 'unknown',
      source: 'unconfigured',
      used: null,
      limit: limits.d1.includedStorageBytes,
      unit: 'bytes',
      percentUsed: null,
      overageUnitPriceUsd: limits.d1.storageOveragePricePerGbMonthUsd,
      estimatedOverageCostUsd: null,
      description:
        '5 GB total storage included per month on Paid plan ($0.75/GB-mo overage). Point-in-time snapshot; not multiplied by monthly rate as current bill.',
    },
    {
      id: 'd1_databases_count',
      name: 'D1 Databases Count',
      category: 'd1',
      kind: 'hard_limit',
      status: 'unknown',
      source: 'unconfigured',
      used: null,
      limit: limits.d1.hardLimits.maxDatabasesPerAccount,
      unit: 'databases',
      percentUsed: null,
      description: 'Maximum 50,000 D1 databases per account on Paid plan (10 on Free).',
    },
    {
      id: 'queues_operations',
      name: 'Queue Operations',
      category: 'queues',
      kind: 'included_usage',
      status: 'unknown',
      source: 'unconfigured',
      used: null,
      limit: limits.queues.includedOperations,
      unit: 'operations',
      percentUsed: null,
      overageUnitPriceUsd: limits.queues.operationsOveragePricePerMillionUsd,
      estimatedOverageCostUsd: null,
      description:
        '1 Million queue billable operations included monthly ($0.40/M overage, 64 KB chunks).',
    },
    {
      id: 'r2_storage',
      name: 'R2 Storage',
      category: 'r2',
      kind: 'included_usage',
      status: 'unknown',
      source: 'unconfigured',
      used: null,
      limit: limits.r2.includedStorageBytes,
      unit: 'bytes',
      percentUsed: null,
      overageUnitPriceUsd: limits.r2.storageOveragePricePerGbMonthUsd,
      estimatedOverageCostUsd: null,
      description:
        '10 GB storage included monthly ($0.015/GB-mo overage). Unmeasured via account API.',
    },
    {
      id: 'r2_class_a_operations',
      name: 'R2 Class A Operations',
      category: 'r2',
      kind: 'included_usage',
      status: 'unknown',
      source: 'unconfigured',
      used: null,
      limit: limits.r2.includedClassAOperations,
      unit: 'operations',
      percentUsed: null,
      overageUnitPriceUsd: limits.r2.classAOveragePricePerMillionUsd,
      estimatedOverageCostUsd: null,
      description:
        '1 Million Class A write/mutate operations included monthly ($4.50/M overage). Unmeasured via account API.',
    },
    {
      id: 'r2_class_b_operations',
      name: 'R2 Class B Operations',
      category: 'r2',
      kind: 'included_usage',
      status: 'unknown',
      source: 'unconfigured',
      used: null,
      limit: limits.r2.includedClassBOperations,
      unit: 'operations',
      percentUsed: null,
      overageUnitPriceUsd: limits.r2.classBOveragePricePerMillionUsd,
      estimatedOverageCostUsd: null,
      description:
        '10 Million Class B read operations included monthly ($0.36/M overage). Unmeasured via account API.',
    },
  ];
}

/**
 * Evaluates metric status, percentage used, and overage cost calculation.
 * Never estimates a monthly bill overage by multiplying instantaneous point-in-time storage bytes.
 */
function evaluateMetric(
  id: string,
  name: string,
  category: 'workers' | 'd1' | 'queues' | 'r2',
  kind: MetricKind,
  used: number | null,
  limit: number | null,
  unit: string,
  description: string,
  overagePricePerMillionUsd?: number,
  overagePricePerGbMonthUsd?: number,
  source: MetricSource = 'cloudflare_api',
): CloudflareUsageMetric {
  if (used === null || !isValidFiniteNonNegative(used)) {
    return {
      id,
      name,
      category,
      kind,
      status: 'unknown',
      source,
      used: null,
      limit,
      unit,
      percentUsed: null,
      overageUnitPriceUsd: overagePricePerMillionUsd ?? overagePricePerGbMonthUsd ?? null,
      estimatedOverageCostUsd: null,
      description,
    };
  }

  const percentUsed = limit !== null && limit > 0 ? (used / limit) * 100 : null;
  let status: UsageStatus = 'within';

  if (limit !== null) {
    if (kind === 'hard_limit') {
      if (used >= limit) {
        status = 'exceeded';
      } else if (percentUsed !== null && percentUsed >= 80) {
        status = 'warning';
      }
    } else {
      // included_usage
      if (used > limit) {
        status = 'exceeded';
      } else if (percentUsed !== null && percentUsed >= 80) {
        status = 'warning';
      }
    }
  }

  let estimatedOverageCostUsd: number | null = null;
  if (kind === 'included_usage' && limit !== null) {
    const excess = Math.max(0, used - limit);
    if (overagePricePerMillionUsd != null) {
      estimatedOverageCostUsd = (excess / 1_000_000) * overagePricePerMillionUsd;
    } else {
      // Point-in-time instant storage cannot be directly multiplied as a full monthly bill overage!
      estimatedOverageCostUsd = null;
    }
  }

  return {
    id,
    name,
    category,
    kind,
    status,
    source,
    used,
    limit,
    unit,
    percentUsed: percentUsed !== null ? Math.round(percentUsed * 100) / 100 : null,
    overageUnitPriceUsd: overagePricePerMillionUsd ?? overagePricePerGbMonthUsd ?? null,
    estimatedOverageCostUsd:
      estimatedOverageCostUsd !== null ? Math.round(estimatedOverageCostUsd * 1000) / 1000 : null,
    description,
  };
}

// Independent GraphQL queries for resilience
const WORKERS_ANALYTICS_QUERY = `
query GetWorkersInvocations($accountTag: string!, $startDatetime: string!, $endDatetime: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 10000
        filter: { datetime_geq: $startDatetime, datetime_leq: $endDatetime }
      ) {
        sum {
          requests
        }
      }
    }
  }
}
`;

const D1_ANALYTICS_QUERY = `
query GetD1Usage($accountTag: string!, $startDate: Date!, $endDate: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $startDate, date_leq: $endDate }
      ) {
        sum {
          rowsRead
          rowsWritten
        }
      }
    }
  }
}
`;

const QUEUES_ANALYTICS_QUERY = `
query GetQueueUsage($accountTag: string!, $startDatetime: Time!, $endDatetime: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      queueMessageOperationsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $startDatetime, datetime_leq: $endDatetime }
      ) {
        sum {
          billableOperations
        }
      }
    }
  }
}
`;

/**
 * Retrieves the global account-level Cloudflare Paid Tier usage report.
 *
 * Honors honest unknown statuses, independent query isolation, safe bounds aggregation,
 * bounded D1 REST pagination, month-boundary cache isolation, and sanitized error reporting.
 */
export async function getCloudflareUsageReport(
  config?: CloudflareUsageConfig,
): Promise<CloudflareUsageReport> {
  const fetchFn = config?.fetchFn ?? fetch;
  const now = config?.now ? config.now() : new Date();
  const ttlMs = config?.ttlMs ?? 300_000; // 5 minutes
  const forecastGuardUsd =
    config?.forecastGuardUsd ?? OFFICIAL_CLOUDFLARE_LIMITS.guards.internalForecastGuardUsd;
  const asOf = now.toISOString();

  const missingVariables: string[] = [];
  if (!config?.accountId) missingVariables.push('CLOUDFLARE_ACCOUNT_ID');
  if (!config?.apiToken) missingVariables.push('CLOUDFLARE_ANALYTICS_READ_TOKEN');

  // If credentials are missing, return explicit 'unknown' state with actionable instructions.
  // NEVER fabricate zero or claim compliance from tenant-level metrics!
  if (missingVariables.length > 0) {
    return {
      asOf,
      periodStart: null,
      periodEnd: null,
      status: 'unknown',
      coverage:
        'Account-level telemetry not configured. Tenant-level metrics cannot prove whether global Cloudflare limits are surpassed.',
      forecastGuardUsd,
      totalEstimatedOverageCostUsd: null,
      forecastGuardExceeded: null,
      isWithinAllowance: null,
      hasHardLimitViolation: null,
      exceededIncludedUsages: [],
      exceededHardLimits: [],
      metrics: buildUnconfiguredMetrics(),
      setupNeeded: {
        configured: false,
        missingVariables,
        requiredPermissions: ['Account Analytics: Read', 'Workers Scripts: Read', 'D1: Read'],
        instructions:
          'To monitor global Cloudflare account usage, configure an API Token with "Account Analytics: Read", "Workers Scripts: Read", and "D1: Read" permissions. Provide CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_READ_TOKEN secrets to the runtime environment.',
      },
    };
  }

  const accountId = config?.accountId;
  const apiToken = config?.apiToken;
  if (!accountId || !apiToken) {
    throw new Error('Unexpected credential validation state');
  }

  const reporting = getReportingPeriod(now);
  const nowMs = now.getTime();

  // Cache isolation: isolate by accountId, token fingerprint, and month key
  const cacheKey = `${accountId}:${fingerprintToken(apiToken)}:${reporting.monthKey}`;

  // Check cache (strictly bounded to not cross month boundary)
  const cached = reportCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return cached.report;
  }

  const graphqlEndpoint = config?.endpoint ?? 'https://api.cloudflare.com/client/v4/graphql';
  const restEndpoint = 'https://api.cloudflare.com/client/v4';

  // Timeout controller (10s max)
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort(new Error('Cloudflare telemetry request timed out'));
  }, 10_000);

  try {
    const defaultHeaders = {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    };

    // Helper for independent GraphQL queries
    async function runGraphQLQuery<T>(
      query: string,
      variables: Record<string, unknown>,
    ): Promise<T | null> {
      try {
        const res = await fetchFn(graphqlEndpoint, {
          method: 'POST',
          headers: defaultHeaders,
          body: JSON.stringify({ query, variables }),
          signal: abortController.signal,
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
        if (json.errors && json.errors.length > 0 && !json.data) {
          return null;
        }
        return json.data ?? null;
      } catch {
        return null;
      }
    }

    // 1. Fetch Workers Invocations (Independent GraphQL query)
    const workersPromise = runGraphQLQuery<{
      viewer?: {
        accounts?: Array<{
          workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }>;
        }>;
      };
    }>(WORKERS_ANALYTICS_QUERY, {
      accountTag: accountId,
      startDatetime: reporting.startIso,
      endDatetime: reporting.endIso,
    });

    // 2. Fetch D1 Rows Analytics (Independent GraphQL query)
    const d1Promise = runGraphQLQuery<{
      viewer?: {
        accounts?: Array<{
          d1AnalyticsAdaptiveGroups?: Array<{
            sum?: { rowsRead?: number; rowsWritten?: number };
          }>;
        }>;
      };
    }>(D1_ANALYTICS_QUERY, {
      accountTag: accountId,
      startDate: reporting.startDateStr,
      endDate: reporting.endDateStr,
    });

    // 3. Fetch Queues Message Operations (Independent GraphQL query)
    const queuesPromise = runGraphQLQuery<{
      viewer?: {
        accounts?: Array<{
          queueMessageOperationsAdaptiveGroups?: Array<{
            sum?: { billableOperations?: number };
          }>;
        }>;
      };
    }>(QUEUES_ANALYTICS_QUERY, {
      accountTag: accountId,
      startDatetime: reporting.startIso,
      endDatetime: reporting.endIso,
    });

    // 4. Fetch D1 databases count & storage info from REST API with bounded pagination
    const d1RestPromise = (async (): Promise<{
      databaseCount: number | null;
      totalStorageBytes: number | null;
      individualDbLimitExceeded: boolean;
    }> => {
      let page = 1;
      const perPage = 100;
      const MAX_PAGES = 20; // Up to 2,000 databases inspected
      let totalDatabases: number | null = null;
      let totalStorageBytes: number | null = 0;
      let paginationComplete = true;
      let individualDbLimitExceeded = false;

      try {
        while (page <= MAX_PAGES) {
          const d1Url = `${restEndpoint}/accounts/${encodeURIComponent(accountId)}/d1/database?page=${page}&per_page=${perPage}`;
          const res = await fetchFn(d1Url, {
            method: 'GET',
            headers: defaultHeaders,
            signal: abortController.signal,
          });

          if (!res.ok) {
            return {
              databaseCount: null,
              totalStorageBytes: null,
              individualDbLimitExceeded: false,
            };
          }

          const json = (await res.json()) as {
            success?: boolean;
            result?: Array<{ uuid?: string; name?: string; file_size?: number }>;
            result_info?: { total_count?: number; total_pages?: number };
          };

          if (json.success !== true || !Array.isArray(json.result)) {
            return {
              databaseCount: null,
              totalStorageBytes: null,
              individualDbLimitExceeded: false,
            };
          }

          if (
            totalDatabases === null &&
            typeof json.result_info?.total_count === 'number' &&
            isValidFiniteNonNegative(json.result_info.total_count)
          ) {
            totalDatabases = json.result_info.total_count;
          }

          for (const db of json.result) {
            if (isValidFiniteNonNegative(db.file_size)) {
              if (totalStorageBytes !== null) {
                totalStorageBytes += db.file_size;
              }
              if (db.file_size > OFFICIAL_CLOUDFLARE_LIMITS.d1.hardLimits.maxDatabaseSizeBytes) {
                individualDbLimitExceeded = true;
              }
            } else {
              // Missing or invalid file_size -> storage coverage is incomplete!
              totalStorageBytes = null;
            }
          }

          const totalPages = json.result_info?.total_pages ?? 1;
          if (page >= totalPages || json.result.length === 0) {
            break;
          }

          page++;
          if (page > MAX_PAGES) {
            paginationComplete = false;
            totalStorageBytes = null;
            break;
          }
        }

        if (!paginationComplete) {
          totalStorageBytes = null;
        }

        return {
          databaseCount: totalDatabases,
          totalStorageBytes,
          individualDbLimitExceeded,
        };
      } catch {
        return { databaseCount: null, totalStorageBytes: null, individualDbLimitExceeded: false };
      }
    })();

    // 5. Fetch Workers scripts count from REST API
    const workersRestPromise = (async (): Promise<number | null> => {
      try {
        const scriptsUrl = `${restEndpoint}/accounts/${encodeURIComponent(accountId)}/workers/scripts`;
        const res = await fetchFn(scriptsUrl, {
          method: 'GET',
          headers: defaultHeaders,
          signal: abortController.signal,
        });
        if (!res.ok) return null;
        const json = (await res.json()) as {
          success?: boolean;
          result?: Array<{ id?: string }>;
        };
        if (json.success !== true || !Array.isArray(json.result)) {
          return null;
        }
        return json.result.length;
      } catch {
        return null;
      }
    })();

    const [workersData, d1Data, queuesData, d1RestData, workerScriptsCount] = await Promise.all([
      workersPromise,
      d1Promise,
      queuesPromise,
      d1RestPromise,
      workersRestPromise,
    ]);

    // Parse Workers Requests (sum across all groups safely; check truncation)
    let usedRequests: number | null = null;
    const workersAccount = workersData?.viewer?.accounts?.[0];
    if (workersAccount && Array.isArray(workersAccount.workersInvocationsAdaptive)) {
      const groups = workersAccount.workersInvocationsAdaptive;
      if (groups.length >= 10000) {
        // Query reached limit; possible truncation -> coverage incomplete
        usedRequests = null;
      } else {
        let sum = 0;
        let valid = true;
        for (const g of groups) {
          const req = g.sum?.requests;
          if (isValidFiniteNonNegative(req)) {
            sum += req;
          } else {
            valid = false;
            break;
          }
        }
        usedRequests = valid ? sum : null;
      }
    }

    // Workers CPU Time: Cumulative execution time is NOT available via GraphQL invocations sum.
    // (Cloudflare GraphQL only exposes percentiles like cpuTimeP50/cpuTimeP99 under quantiles).
    // Honest representation: leave as null/unknown.
    const usedCpuMs: number | null = null;

    // Parse D1 Rows Analytics (sum across groups safely; check truncation)
    let usedD1RowsRead: number | null = null;
    let usedD1RowsWritten: number | null = null;
    const d1Account = d1Data?.viewer?.accounts?.[0];
    if (d1Account && Array.isArray(d1Account.d1AnalyticsAdaptiveGroups)) {
      const groups = d1Account.d1AnalyticsAdaptiveGroups;
      if (groups.length >= 10000) {
        usedD1RowsRead = null;
        usedD1RowsWritten = null;
      } else {
        let readSum = 0;
        let writeSum = 0;
        let valid = true;
        for (const g of groups) {
          const r = g.sum?.rowsRead;
          const w = g.sum?.rowsWritten;
          if (isValidFiniteNonNegative(r) && isValidFiniteNonNegative(w)) {
            readSum += r;
            writeSum += w;
          } else {
            valid = false;
            break;
          }
        }
        if (valid) {
          usedD1RowsRead = readSum;
          usedD1RowsWritten = writeSum;
        }
      }
    }

    // Parse Queues Operations (billableOperations)
    let usedQueueOps: number | null = null;
    const queuesAccount = queuesData?.viewer?.accounts?.[0];
    if (queuesAccount && Array.isArray(queuesAccount.queueMessageOperationsAdaptiveGroups)) {
      const groups = queuesAccount.queueMessageOperationsAdaptiveGroups;
      if (groups.length >= 10000) {
        usedQueueOps = null;
      } else {
        let sum = 0;
        let valid = true;
        for (const g of groups) {
          const ops = g.sum?.billableOperations;
          if (isValidFiniteNonNegative(ops)) {
            sum += ops;
          } else {
            valid = false;
            break;
          }
        }
        usedQueueOps = valid ? sum : null;
      }
    }

    // D1 REST metadata
    const d1DatabaseCount = d1RestData.databaseCount;
    const d1TotalStorageBytes = d1RestData.totalStorageBytes;

    const limits = OFFICIAL_CLOUDFLARE_LIMITS;

    const metrics: CloudflareUsageMetric[] = [
      evaluateMetric(
        'workers_requests',
        'Workers Requests',
        'workers',
        'included_usage',
        usedRequests,
        limits.workers.includedRequests,
        'requests',
        '10M requests included per month on Paid plan ($0.30/M overage).',
        limits.workers.requestsOveragePricePerMillionUsd,
      ),
      evaluateMetric(
        'workers_cpu_ms',
        'Workers CPU Time',
        'workers',
        'included_usage',
        usedCpuMs,
        limits.workers.includedCpuMs,
        'ms',
        '30M CPU milliseconds included per month on Paid plan ($0.02/M overage). Total CPU execution time is not provided by GraphQL invocations sum (percentiles only).',
        limits.workers.cpuMsOveragePricePerMillionUsd,
      ),
      evaluateMetric(
        'workers_script_count',
        'Workers Script Count',
        'workers',
        'hard_limit',
        workerScriptsCount,
        limits.workers.hardLimits.maxScriptsPerAccount,
        'scripts',
        'Maximum 500 scripts allowed per Cloudflare account on Paid plan (100 on Free).',
      ),
      evaluateMetric(
        'd1_rows_read',
        'D1 Rows Read',
        'd1',
        'included_usage',
        usedD1RowsRead,
        limits.d1.includedRowsRead,
        'rows',
        '25 Billion rows read included per month ($0.001/M overage).',
        limits.d1.rowsReadOveragePricePerMillionUsd,
      ),
      evaluateMetric(
        'd1_rows_written',
        'D1 Rows Written',
        'd1',
        'included_usage',
        usedD1RowsWritten,
        limits.d1.includedRowsWritten,
        'rows',
        '50 Million rows written included per month ($1.00/M overage).',
        limits.d1.rowsWrittenOveragePricePerMillionUsd,
      ),
      evaluateMetric(
        'd1_storage',
        'D1 Storage',
        'd1',
        'included_usage',
        d1TotalStorageBytes,
        limits.d1.includedStorageBytes,
        'bytes',
        '5 GB total storage included per month on Paid plan ($0.75/GB-mo overage). Point-in-time snapshot; not multiplied by monthly rate as current bill.',
        undefined,
        limits.d1.storageOveragePricePerGbMonthUsd,
      ),
      evaluateMetric(
        'd1_databases_count',
        'D1 Databases Count',
        'd1',
        'hard_limit',
        d1DatabaseCount,
        limits.d1.hardLimits.maxDatabasesPerAccount,
        'databases',
        'Maximum 50,000 D1 databases per account on Paid plan (10 on Free).',
      ),
      evaluateMetric(
        'queues_operations',
        'Queue Operations',
        'queues',
        'included_usage',
        usedQueueOps,
        limits.queues.includedOperations,
        'operations',
        '1 Million queue billable operations included monthly ($0.40/M overage, 64 KB chunks).',
        limits.queues.operationsOveragePricePerMillionUsd,
      ),
      evaluateMetric(
        'r2_storage',
        'R2 Storage',
        'r2',
        'included_usage',
        null, // R2 storage unmeasured without dedicated bucket metrics
        limits.r2.includedStorageBytes,
        'bytes',
        '10 GB storage included monthly ($0.015/GB-mo overage). Unmeasured via account API.',
        undefined,
        limits.r2.storageOveragePricePerGbMonthUsd,
      ),
      evaluateMetric(
        'r2_class_a_operations',
        'R2 Class A Operations',
        'r2',
        'included_usage',
        null,
        limits.r2.includedClassAOperations,
        'operations',
        '1 Million Class A write/mutate operations included monthly ($4.50/M overage). Unmeasured via account API.',
        limits.r2.classAOveragePricePerMillionUsd,
      ),
      evaluateMetric(
        'r2_class_b_operations',
        'R2 Class B Operations',
        'r2',
        'included_usage',
        null,
        limits.r2.includedClassBOperations,
        'operations',
        '10 Million Class B read operations included monthly ($0.36/M overage). Unmeasured via account API.',
        limits.r2.classBOveragePricePerMillionUsd,
      ),
    ];

    const exceededIncludedUsages: string[] = [];
    const exceededHardLimits: string[] = [];
    let hasUnknownIncludedUsage = false;
    let hasUnknownHardLimit = false;
    let hasWarningIncludedUsage = false;
    let knownEstimatedOverageCostUsd = 0;

    for (const m of metrics) {
      if (m.kind === 'included_usage') {
        if (m.status === 'exceeded') {
          exceededIncludedUsages.push(m.name);
        } else if (m.status === 'warning') {
          hasWarningIncludedUsage = true;
        } else if (m.status === 'unknown') {
          hasUnknownIncludedUsage = true;
        }
        if (typeof m.estimatedOverageCostUsd === 'number') {
          knownEstimatedOverageCostUsd += m.estimatedOverageCostUsd;
        }
      } else if (m.kind === 'hard_limit') {
        if (m.status === 'exceeded') {
          exceededHardLimits.push(m.name);
        } else if (m.status === 'unknown') {
          hasUnknownHardLimit = true;
        }
      }
    }

    if (d1RestData.individualDbLimitExceeded) {
      if (!exceededHardLimits.includes('D1 Database Max Size (10 GB)')) {
        exceededHardLimits.push('D1 Database Max Size (10 GB)');
      }
    }
    if (d1RestData.totalStorageBytes === null) hasUnknownHardLimit = true;

    // Hard limit violations:
    // If any hard limit is exceeded -> true
    // Else if any hard limit is unknown -> null (cannot verify absence of violation)
    // Else -> false
    const hasHardLimitViolation: boolean | null =
      exceededHardLimits.length > 0 ? true : hasUnknownHardLimit ? null : false;

    // Allowance compliance:
    // If any included usage is exceeded -> false (definitely exceeded)
    // Else if any included usage is unknown OR billing period is not verified -> null
    // Else if verified -> true
    const isWithinAllowance: boolean | null =
      exceededIncludedUsages.length > 0
        ? false
        : hasUnknownIncludedUsage || !config?.billingPeriodVerified
          ? null
          : true;

    // Total estimated overage cost:
    // Reported if known overages exist; otherwise if coverage is incomplete, null
    const totalEstimatedOverageCostUsd: number | null =
      knownEstimatedOverageCostUsd > 0
        ? Math.round(knownEstimatedOverageCostUsd * 100) / 100
        : hasUnknownIncludedUsage
          ? null
          : 0;

    // Internal $20 guard: strictly evaluates hosted forecast if provided, never conflated with point-in-time overages
    const forecastGuardExceeded: boolean | null =
      config?.hostedForecastUsd != null ? config.hostedForecastUsd >= forecastGuardUsd : null;

    // Overall status:
    // - 'exceeded' if observed hard limit violation
    // - 'warning' if observed allowance overage or utilization warning
    // - 'unknown' if any metric is unknown or invoice cycle unverified
    // - 'within' ONLY if all metrics verified within limits AND billing period verified
    let overallStatus: UsageStatus = 'unknown';
    if (hasHardLimitViolation === true) {
      overallStatus = 'exceeded';
    } else if (isWithinAllowance === false || hasWarningIncludedUsage) {
      overallStatus = 'warning';
    } else if (hasUnknownIncludedUsage || hasUnknownHardLimit || !config?.billingPeriodVerified) {
      overallStatus = 'unknown';
    } else {
      overallStatus = 'within';
    }

    // Transparent coverage description
    const verifiedMetrics: string[] = [];
    const unmeasuredMetrics: string[] = [];
    for (const m of metrics) {
      if (m.status !== 'unknown' && m.used !== null) {
        verifiedMetrics.push(m.name);
      } else {
        unmeasuredMetrics.push(m.name);
      }
    }

    let coverageDescription = `Reporting period: ${reporting.startDateStr} to ${reporting.endDateStr} (UTC calendar month-to-date; not verified account billing invoice cycle).`;
    if (verifiedMetrics.length > 0) {
      coverageDescription += ` Verified: ${verifiedMetrics.join(', ')}.`;
    }
    if (unmeasuredMetrics.length > 0) {
      coverageDescription += ` Unmeasured / unavailable via API: ${unmeasuredMetrics.join(', ')}.`;
    }

    const report: CloudflareUsageReport = {
      asOf,
      periodStart: reporting.startIso,
      periodEnd: reporting.endIso,
      status: overallStatus,
      coverage: coverageDescription,
      forecastGuardUsd,
      totalEstimatedOverageCostUsd,
      forecastGuardExceeded,
      isWithinAllowance,
      hasHardLimitViolation,
      exceededIncludedUsages,
      exceededHardLimits,
      metrics,
    };

    // Cache the report (bounded by month end)
    const expiresAt = Math.min(nowMs + ttlMs, reporting.monthEndMs);
    reportCache.set(cacheKey, {
      report,
      expiresAt,
    });

    return report;
  } catch (error) {
    const sanitizedError = sanitizeErrorMessage(error);
    return {
      asOf,
      periodStart: reporting.startIso,
      periodEnd: reporting.endIso,
      status: 'unknown',
      coverage: `Cloudflare account telemetry check failed: ${sanitizedError}`,
      forecastGuardUsd,
      totalEstimatedOverageCostUsd: null,
      forecastGuardExceeded: null,
      isWithinAllowance: null,
      hasHardLimitViolation: null,
      exceededIncludedUsages: [],
      exceededHardLimits: [],
      metrics: buildUnconfiguredMetrics(),
      setupNeeded: {
        configured: false,
        missingVariables: [],
        requiredPermissions: ['Account Analytics: Read', 'Workers Scripts: Read', 'D1: Read'],
        instructions: `Failed to query Cloudflare telemetry: ${sanitizedError}. Verify CLOUDFLARE_ACCOUNT_ID and that CLOUDFLARE_ANALYTICS_READ_TOKEN has valid permissions.`,
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
