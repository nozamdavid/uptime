# Cloudflare Paid Tier Usage & Limits Architecture

## 1. Overview & Core Principles

This specification details the global operator architecture for verifying whether resource usage across the hosted infrastructure surpasses Cloudflare Workers Paid tier inclusions, billing overages, and technical hard limits.

### Core Architectural Rules
1. **Never Declare Account Compliance From Tenant Metrics**:
   Individual tenant database metrics (e.g. `workspace_usage_daily` in `CONTROL_DB`) only reflect product activity in tracked tenant databases. They do not account for unassigned databases, pool maintenance, coordinator cron invocations, staging imports, queue operations, failed invocations, or developer scripts. Unless verified via account-level Cloudflare APIs with valid credentials, account limit status is explicitly reported as `unknown`.
2. **Honest `unknown` on Unmeasured or Partial Metrics**:
   - If any metric is unmeasured, missing, or errored, its status is `unknown`.
   - All global booleans are strictly nullable (`isWithinAllowance: null`, `hasHardLimitViolation: null`, `forecastGuardExceeded: null`, `totalEstimatedOverageCostUsd: null`) when coverage is incomplete.
   - An account must **never** be described as "verified within allowance" if any metric is missing or unmeasured. Observed overages can still be flagged even when other metrics are unknown.
3. **Three-Way Limit Separation**:
   - **Billed Allowance Inclusions (Soft Limits)**: Included monthly allowances on the $5/mo Workers Paid plan. Exceeding these incurs metered overage charges without halting execution.
   - **Technical Hard Limits**: Architectural Cloudflare platform thresholds (e.g. 50,000 D1 databases, 500 scripts, 30s default HTTP CPU configurable to 5m, 10 GB per D1 database) where requests fail or resource creation is rejected.
   - **Internal Runaway Guard ($20.00/mo)**: An operator safety ceiling guarding against runaway cost anomalies based on the hosted rolling 31-day forecast. The account usage adapter strictly evaluates this against caller-supplied forecast metrics; it never pretends account overages enforce this guard.
4. **Reporting Period vs Invoice Billing Cycle**:
   UTC calendar month queries represent a reporting period, **not** an account invoice billing cycle. The adapter explicitly labels calendar month queries as a reporting window and will not assert full monthly allowance compliance unless the full applicable invoice cycle is verified.
5. **Independent Query Resilience**:
   Telemetry queries to Workers Invocations, D1 Analytics, Queues, and REST endpoints run independently. Failure of one service (e.g. Queues not enabled or lacking permissions) leaves only that metric `unknown` and does not break Workers or D1 reporting.
6. **Bounded REST Pagination**:
   D1 database lists are paginated (up to 20 pages / 2,000 databases) to aggregate storage safely. If pagination is capped or `file_size` is missing from database metadata, storage is marked `unknown`.
7. **Cache Month-Boundary & Credential Isolation**:
   Cached reports are strictly bounded to not exceed the UTC calendar month end, ensuring queries on the first of a new month never serve stale prior-month telemetry. Cache keys incorporate token fingerprints to prevent stale credential attribution.
8. **Sanitized Error Handling**:
   Upstream error strings are sanitized to redact Bearer tokens, API keys, and email addresses before reaching logs or UI. Requests are bounded by a 10s abort timeout.
9. **Decimal Billing Units**:
   Cloudflare storage billing uses decimal gigabytes ($1\text{ GB} = 10^9\text{ bytes} = 1,000,000,000\text{ bytes}$), not binary GiB ($2^{30}\text{ bytes}$). Point-in-time instantaneous storage is never multiplied by monthly rates as a current bill.

---

## 2. Official Cloudflare Paid Tier Thresholds (Verified October 2026)

The following thresholds and pricing reflect official Cloudflare documentation as of October 2026:

### Primary Documentation Sources
- [Cloudflare Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/) (10M requests, 30M CPU-ms included)
- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) (30s default HTTP CPU, 5m max configurable, 15m Cron trigger >=1h schedule, 30s Cron <1h schedule, 500 scripts max on Paid plan)
- [Cloudflare D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/) (25B rows read, 50M rows written, 5 GB storage included; 1 GB = 10^9 bytes)
- [Cloudflare D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) (50,000 DBs per account on Paid plan, 10 GB per DB, 1 TB account storage)
- [Cloudflare Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/) (1M operations included, 64 KB chunks, $0.40/M)
- [Cloudflare R2 Pricing](https://developers.cloudflare.com/r2/pricing/) (10 GB storage, 1M Class A, 10M Class B, $0 egress)

### Plan Inclusions & Overage Rates

| Service | Metric | Paid Plan Inclusions | Overage Pricing | Hard Platform Limit |
| :--- | :--- | :--- | :--- | :--- |\n| **Workers** | Base Plan Fee | $5.00 / month | — | — |
| **Workers** | Invocations (Requests) | 10,000,000 / month | $0.30 / million | No hard cap |
| **Workers** | CPU Execution Time | 30,000,000 ms / month | $0.02 / million ms | 30s default HTTP (up to 5m configurable); 30s cron (<1h) / 15m cron (>=1h) |
| **Workers** | Scripts per Account | Included | — | 500 scripts max (Paid plan) |
| **D1** | Rows Read | 25,000,000,000 / month | $0.001 / million | 1,000 queries / invocation |
| **D1** | Rows Written | 50,000,000 / month | $1.00 / million | 100 bound parameters / query |
| **D1** | Storage | 5 GB (total across DBs) | $0.75 / GB-month | 10 GB max / database; 1 TB account |
| **D1** | Database Count | Included | — | 50,000 databases / account |
| **Queues** | Message Operations | 1,000,000 ops / month | $0.40 / million (64 KB chunks) | 4–14 days retention |
| **R2** | Storage | 10 GB / month | $0.015 / GB-month | Unmeasured via account API |
| **R2** | Class A (Mutations) | 1,000,000 ops / month | $4.50 / million | Unmeasured via account API |
| **R2** | Class B (Reads) | 10,000,000 ops / month | $0.36 / million | Unmeasured via account API |
| **R2** | Egress | Unlimited ($0.00) | $0.00 | Free |

---

## 3. Account Analytics & Telemetry API

To retrieve global account usage without exposing mutation permissions, the adapter uses independent Cloudflare GraphQL Analytics queries and read-only REST endpoints.

### GraphQL API Endpoint
- **URL**: `POST https://api.cloudflare.com/client/v4/graphql`
- **Headers**:
  ```http
  Authorization: Bearer <CLOUDFLARE_ANALYTICS_READ_TOKEN>
  Content-Type: application/json
  ```

### 1. Workers Invocations Query
```graphql
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
```
*Note on Workers CPU*: In `workersInvocationsAdaptive`, `sum` only provides `requests`, `errors`, and `subrequests`. Total CPU execution time is not available in `sum` (only quantiles like `cpuTimeP50`, `cpuTimeP99`). The adapter honestly marks `workers_cpu_ms` as `unknown`.

### 2. D1 Analytics Query
```graphql
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
```

### 3. Queues Operations Query
```graphql
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
```
*Note on Queues*: Field is `billableOperations` (metered in 64 KB chunks, 64,000 bytes).

### REST Endpoints (Metadata & Hard Limits)
1. **D1 Databases & File Sizes**:
   - `GET https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database?page={page}&per_page=100`
   - Bounded pagination (up to 20 pages / 2,000 DBs). Accumulates `file_size`, inspects `result_info.total_count` (verified against 50,000 limit), and checks for individual DB size > 10 GB.
   - If REST returns 401 or errors, or if `file_size` is missing, storage is marked `unknown` (never defaults to 0).
2. **Workers Scripts Count**:
   - `GET https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts`
   - Validates `success: true` and counts scripts (verified against 500 limit).

---

## 4. Module Architecture: `cloudflare-usage.ts`

The module is implemented in [`apps/api-worker/src/cloudflare-usage.ts`](file:///Users/david/.codex/worktrees/f95e/uptime/apps/api-worker/src/cloudflare-usage.ts) with complete test coverage in [`apps/api-worker/src/cloudflare-usage.test.ts`](file:///Users/david/.codex/worktrees/f95e/uptime/apps/api-worker/src/cloudflare-usage.test.ts).

### Key Features
- **Injected Dependency Pattern**: Accepts `fetchFn`, `accountId`, `apiToken`, `endpoint`, `now`, `hostedForecastUsd`, and `billingPeriodVerified`.
- **Month-Boundary Caching**: 5-minute TTL (`ttlMs: 300_000`) capped by `monthEndMs` and keyed by token fingerprint and `monthKey`.
- **Independent Query Isolation**: Queries execute in parallel via `Promise.all` with individual error handling.
- **Sanitized Error Reporting**: Leaked tokens, query parameters, and email addresses are redacted before return.

---

## 5. Environment Secrets & Security Setup

- [ ] **Deferred at the user's request:** configure `CLOUDFLARE_ANALYTICS_READ_TOKEN` directly in Cloudflare on production `uptime-hosted-api` and staging `uptime-staging-oauth-api`. Restrict the token to account `8af9a4d4a03e412bbd3f2a31463ec5b6` with Account Analytics Read, Workers Scripts Read, and D1 Read. Never paste the token in chat. Metrics remain `unknown` until configured; this TODO does not block remaining work.

To activate live telemetry in the hosted environment, configure the following secrets on the API Worker:

```bash
# Set account ID
wrangler secret put CLOUDFLARE_ACCOUNT_ID --config deploy/cloudflare/hosted/api.wrangler.toml

# Set read-only analytics token
wrangler secret put CLOUDFLARE_ANALYTICS_READ_TOKEN --config deploy/cloudflare/hosted/api.wrangler.toml
```

### Required Token Permissions
Create an API Token in Cloudflare Dashboard (`Manage Account` > `API Tokens`):
- **Permissions**:
  - `Account > Account Analytics > Read`
  - `Account > Workers Scripts > Read`
  - `Account > D1 > Read`
- **Account Resources**:
  - `Include > Specific account > <Your Account>`

### Credential Gap Note
Existing local Wrangler CLI OAuth logins typically do not grant `Account Analytics: Read`. The dedicated API token `CLOUDFLARE_ANALYTICS_READ_TOKEN` is strictly required for runtime account telemetry queries.
