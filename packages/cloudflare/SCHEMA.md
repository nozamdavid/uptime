# `@uptime/cloudflare` schema reference

This package contains the shared D1 schema, row types, and database helpers for
the Cloudflare API and coordinator Workers.

- Migrations live in `src/migrations/*.sql`. Apply them through the API or
  coordinator Wrangler configuration so Wrangler uses the correct database.
- Runtime code uses WebCrypto and has no `node:*` imports.
- Tests apply the migrations to `node:sqlite` and require Node.js 24.

For deployment commands, use the
[Cloudflare migration guide](../../docs/cloudflare-migration.md). This document
is a schema reference, not a deployment runbook.

## Conventions

- **IDs** are UUIDv4 text. The schema supplies a SQLite `DEFAULT` expression and
  `crypto.randomId()` provides the same shape in application code.
- **Timestamps** are ISO-8601 UTC text with milliseconds, e.g.
  `2026-09-20T18:40:00.000Z`. This is lexicographically sortable and understood
  by SQLite `date()`/`datetime()`. `nowIso()` is the app-side helper.
- **Booleans** are `INTEGER NOT NULL CHECK (x IN (0,1))`.
- **Nested configuration** that maps to a contract JSON object is stored in a
  `TEXT CHECK (json_valid(x))` column (`config`, `uptime_thresholds`,
  `endpoint_evidence`, `response_metadata`, `message`, `expected_regions`,
  `result`, `state_json`, `cursor`).
- **Indexed / selected fields** always have their own scalar column
  (`enabled`, `next_check_at`, `public_slug`, `provider`, `status`, ...).
- Enum-like text columns use `CHECK` lists mirroring `@uptime/contracts`.
- Foreign keys are declared; D1 enforces them.

## Entity-to-table map

| plan.md entity                     | table(s)                                                     |
| ---------------------------------- | ------------------------------------------------------------ |
| Monitors                           | `monitors`, `monitor_regions`                                |
| Status pages                       | `status_pages`, `status_page_groups`, `status_page_monitors` |
| Notification providers             | `notification_services`                                      |
| Check rounds                       | `check_runs`                                                 |
| Results                            | `observations`                                               |
| Monitor / incident state           | `monitor_notification_state`, `monitor_daily_uptime`         |
| Notification deliveries            | `notification_deliveries`, `monitor_notification_services`   |
| Daily aggregates                   | `monitor_daily_uptime`                                       |
| Auth                               | `admins`, `sessions`                                         |
| Maintenance / publication progress | `jobs`, `report_publications`                                |
| Diagnostics                        | `network_diagnostics`                                        |
| Display                            | `badges`                                                     |

## Tables

### `admins`

Single-admin model preserved from the PostgreSQL schema.

| column                     | type                       | notes                                                                     |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `id`                       | TEXT PK                    | uuid default                                                              |
| `singleton_key`            | INTEGER NOT NULL DEFAULT 1 | UNIQUE, CHECK = 1                                                         |
| `email`                    | TEXT NOT NULL              | UNIQUE                                                                    |
| `password_hash`            | TEXT NOT NULL              | Workers-compatible `pbkdf2-sha256$...` string (at most 100000 iterations) |
| `created_at`, `updated_at` | TEXT                       | ISO                                                                       |

### `sessions`

| column                       | type          | notes                                             |
| ---------------------------- | ------------- | ------------------------------------------------- |
| `id`                         | TEXT PK       |                                                   |
| `admin_id`                   | TEXT NOT NULL | FK admins ON DELETE CASCADE                       |
| `token_hash`                 | TEXT NOT NULL | UNIQUE. HMAC-SHA256 base64url of the cookie token |
| `expires_at`                 | TEXT NOT NULL | indexed                                           |
| `created_at`, `last_seen_at` | TEXT          |                                                   |

Indexes: `(admin_id, expires_at)`, `(expires_at)`.

### `badges`

`id`, `name` (UNIQUE on `lower(name)`, length 1..40), `color` (`#rrggbb`),
`created_at`.

### `monitors`

| column                        | type                                                               | notes                                   |
| ----------------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| `id`                          | TEXT PK                                                            |                                         |
| `name`                        | TEXT NULL                                                          |                                         |
| `url`                         | TEXT NOT NULL                                                      | CHECK starts `http://`/`https://`       |
| `interval_seconds`            | INTEGER NOT NULL                                                   | CHECK in preset list                    |
| `timeout_ms`                  | INTEGER NOT NULL                                                   | CHECK 1000..30000 and `< interval*1000` |
| `enabled`                     | INTEGER NOT NULL DEFAULT 1                                         |                                         |
| `dns_diagnostics_enabled`     | INTEGER NOT NULL DEFAULT 0                                         |                                         |
| `is_public`                   | INTEGER NOT NULL DEFAULT 0                                         |                                         |
| `public_slug`                 | TEXT NULL                                                          | UNIQUE, format CHECK matches contract   |
| `badge_id`                    | TEXT NULL                                                          | FK badges ON DELETE SET NULL            |
| `uptime_thresholds`           | TEXT NOT NULL DEFAULT `{"green":99.5,"lightGreen":99,"orange":90}` | JSON, CHECK `json_valid`                |
| `outage_threshold`            | INTEGER NOT NULL DEFAULT 3                                         | CHECK 1..100                            |
| `recovery_threshold`          | INTEGER NOT NULL DEFAULT 2                                         | CHECK 1..100                            |
| `repeat_notification_minutes` | INTEGER NULL                                                       | CHECK 1..10080                          |
| `report_interval_seconds`     | INTEGER NOT NULL DEFAULT 60                                        | public report cadence                   |
| `next_check_at`               | TEXT NOT NULL                                                      | scheduling cursor                       |
| `created_at`, `updated_at`    | TEXT                                                               |                                         |

Index: `monitors_due_idx (enabled, next_check_at)`.

### `monitor_regions`

`monitor_id` FK cascade, `region_id` (region CHECK), `created_at`.
PK `(monitor_id, region_id)`, index `(region_id, monitor_id)`.

### `status_pages`

`id`, `title`, `public_slug` NULL UNIQUE, `report_interval_seconds INTEGER NOT
NULL DEFAULT 60`, `created_at`, `updated_at`.

### `status_page_groups`

`id`, `status_page_id` FK cascade, `title`, `position` (>=0), `width`
(`full|half`), `show_badges` bool, `created_at`.
UNIQUE `(status_page_id, position)`, UNIQUE `(id, status_page_id)`.

### `status_page_monitors`

`status_page_id`, `group_id`, `monitor_id`, `position` (>=0), `created_at`.
PK `(status_page_id, monitor_id)`, UNIQUE `(group_id, position)`, composite FK
`(group_id, status_page_id)` -> `status_page_groups(id, status_page_id)`, index
`(monitor_id)`.

### `check_runs` (rounds)

| column                                       | type                            | notes                                      |
| -------------------------------------------- | ------------------------------- | ------------------------------------------ |
| `id`                                         | TEXT PK                         |                                            |
| `monitor_id`                                 | TEXT NOT NULL                   | FK monitors cascade                        |
| `window_started_at`                          | TEXT NOT NULL                   | scheduled window                           |
| `status`                                     | TEXT NOT NULL DEFAULT `pending` | `pending`, `complete`, or `partial`        |
| `expected_region_count`                      | INTEGER NOT NULL                | CHECK 1..9                                 |
| `expected_regions`                           | TEXT NOT NULL DEFAULT `[]`      | JSON array snapshot                        |
| `monitor_url`                                | TEXT NOT NULL                   | config snapshot                            |
| `timeout_ms`                                 | INTEGER NOT NULL                | config snapshot                            |
| `dns_diagnostics_enabled`                    | INTEGER NOT NULL DEFAULT 0      | config snapshot                            |
| `config_fingerprint`                         | TEXT NULL                       | monitor config snapshot fingerprint        |
| `deadline_at`                                | TEXT NOT NULL                   | window + timeout + grace                   |
| `claim_token`                                | TEXT NULL                       | lease token                                |
| `claim_expires_at`                           | TEXT NULL                       | lease expiry                               |
| `claimed_by`                                 | TEXT NULL                       | worker identity                            |
| `created_at`, `completed_at`, `finalized_at` | TEXT                            | `finalized_at` set once incident logic ran |

UNIQUE `(monitor_id, window_started_at)`, UNIQUE `(id, monitor_id)`.
Indexes: `(monitor_id, window_started_at)`, `(status, window_started_at)`,
partial `(status, claim_expires_at) WHERE status='pending'`,
partial `(status, deadline_at) WHERE status='pending'`.

Atomic claim pattern (D1 has no `SKIP LOCKED`): an `UPDATE ... SET
claim_token=?, claim_expires_at=? WHERE id IN (SELECT ...) ... RETURNING *` under
D1's single-writer serialization. Expired leases are reclaimed by updating rows
whose `claim_expires_at < now`.

### `observations` (results)

| column                    | type             | notes                                           |
| ------------------------- | ---------------- | ----------------------------------------------- |
| `id`                      | TEXT PK          |                                                 |
| `check_run_id`            | TEXT NOT NULL    | FK `(check_run_id, monitor_id)` -> check_runs   |
| `monitor_id`              | TEXT NOT NULL    |                                                 |
| `region_id`               | TEXT NOT NULL    | region CHECK                                    |
| `scheduled_window`        | TEXT NOT NULL    | denormalized window for the durable key         |
| `status`                  | TEXT NOT NULL    | `success`, `http_failure`, or `network_failure` |
| `success`                 | INTEGER NOT NULL | CHECK 0/1                                       |
| `http_status`             | INTEGER NULL     | 100..599                                        |
| `response_ms`, `total_ms` | REAL NULL        | >= 0                                            |
| `error_code`              | TEXT NULL        | contract enum                                   |
| `error_detail`            | TEXT NULL        |                                                 |
| `placement`, `colo`       | TEXT NULL        | execution location                              |
| `final_url`               | TEXT NULL        |                                                 |
| `endpoint_evidence`       | TEXT NULL        | JSON contract object                            |
| `redirect_count`          | INTEGER NULL     | 0..5                                            |
| `body_bytes`              | INTEGER NULL     | >= 0                                            |
| `probe_version`           | TEXT NULL        |                                                 |
| `response_metadata`       | TEXT NULL        | JSON                                            |
| `started_at`              | TEXT NOT NULL    | observation time                                |
| `completed_at`            | TEXT NULL        |                                                 |
| `created_at`              | TEXT NOT NULL    | retention cursor                                |

**Durable uniqueness:** `UNIQUE (monitor_id, region_id, scheduled_window)`.
Retries/overlaps that re-insert the same observation do nothing.
Indexes: `(check_run_id)`, `(monitor_id, started_at)`,
`(monitor_id, region_id, started_at)`, `(error_code, started_at)`,
`(created_at)`.

### `network_diagnostics`

Mirrors the existing table: `id`, `monitor_id` FK cascade, `check_run_id`,
`observation_id` FK set null, `region_id`, `kind` DEFAULT `dns_candidates`,
`window_started_at`, `lifecycle` (`pending|complete|unavailable`), `result` JSON,
`failure_code` CHECK, `requested_at`, `started_at`, `completed_at`, `created_at`.
UNIQUE `(monitor_id, region_id, kind, window_started_at)`.

### `notification_services` (providers)

`id`, `name`, `provider` CHECK (7 contract kinds), `enabled` bool,
`config` TEXT JSON NOT NULL (opaque provider config, including encrypted
credentials; keys never leave Worker secrets), `created_at`, `updated_at`.

### `monitor_notification_services`

PK `(monitor_id, notification_service_id)`, both FKs cascade, index on service.

### `monitor_notification_state` (incident state)

`monitor_id` PK FK cascade, `config_fingerprint TEXT NOT NULL`,
`last_window_started_at TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'healthy'`
CHECK `healthy|down`, `failure_streak`, `success_streak`,
`outage_started_at`, `last_reminder_at`, `updated_at`.

### `notification_deliveries`

`id`, `monitor_id`, `notification_service_id`, `event_key`, `kind` CHECK
`outage|recovery|reminder`, `message` TEXT JSON, `status` CHECK
`pending|sending|sent|cancelled|failed`, `attempts INTEGER DEFAULT 0`,
`next_attempt_at`, `lease_until`, `lease_token`, `created_at`, `sent_at`,
`last_error`. UNIQUE `(event_key, notification_service_id)`.
Indexes: `(status, next_attempt_at)`, `(monitor_id)`.

### `monitor_daily_uptime` (exact daily aggregates)

| column                                     | type                               | notes                                |
| ------------------------------------------ | ---------------------------------- | ------------------------------------ |
| `monitor_id`                               | TEXT NOT NULL                      | FK monitors cascade                  |
| `day`                                      | TEXT NOT NULL                      | `YYYY-MM-DD`, UTC                    |
| `uptime_percentage`                        | REAL NOT NULL                      | 0..100                               |
| `average_response_ms`                      | REAL NULL                          | successful samples only              |
| `weight`                                   | REAL NOT NULL DEFAULT 1            | calculated rows use `received_count` |
| `received_count`                           | INTEGER NULL                       | exact                                |
| `success_count`                            | INTEGER NULL                       | exact                                |
| `response_sum_ms`                          | REAL NOT NULL DEFAULT 0            | exact sum, successful samples        |
| `response_count_ms`                        | INTEGER NOT NULL DEFAULT 0         | exact count                          |
| `source`                                   | TEXT NOT NULL DEFAULT `calculated` | imported sources keep their tag      |
| `finalized_at`, `created_at`, `updated_at` | TEXT                               |                                      |

PK `(monitor_id, day)`; index `(day, monitor_id)`. Counts may be `NULL`
together for imported history rows that only carry an explicit percentage.
Store sums/counts, never pre-averaged values.

**Idempotent exact accumulation.** `check_runs_finalize_aggregate` adds
observations when a pending round first becomes complete or partial.
`observations_accumulate_finalized` handles late observations. Both recompute
percentages and averages from stored sums and counts.

Observation uniqueness and the round transition guard prevent duplicate
contributions. The `source='calculated'` condition protects imported rows.
Deleting retained raw results does not decrement aggregates, so daily history
survives.

### `jobs` (maintenance / coordination progress)

`name` PK, `lease_token`, `lease_until`, `cursor` TEXT JSON, `state_json` TEXT
JSON, `last_started_at`, `last_completed_at`, `updated_at`.

### `report_publications` (R2 publication progress)

`report_key` PK (e.g. `status-page:<uuid>`, `monitor:<uuid>`, `index`), `kind`
CHECK `status-page|monitor|index`, `status_page_id`/`monitor_id` nullable FKs
cascade, `object_key` NOT NULL, `schema_version`, `generation INTEGER DEFAULT 0`,
`generated_at`, `latest_observation_at`, `source_watermark`, `status` CHECK
`pending|complete|failed`, `attempts`, `last_error`, `lease_until`,
`lease_token`, `updated_at`. `generation` lets a publisher refuse to overwrite a
newer object with an older snapshot.

## TypeScript interface

```ts
import type {
  CloudflareEnv, // Workers bindings: DB (D1), REPORTS? (R2), secrets, vars
  MonitorRow,
  CheckRunRow,
  ObservationRow,
  NotificationServiceRow,
  MonitorNotificationStateRow,
  NotificationDeliveryRow,
  MonitorDailyUptimeRow,
  StatusPageRow,
  ReportPublicationRow,
  RegionId,
} from '@uptime/cloudflare';
```

`Env` shape (`src/env.ts`):

```ts
interface CloudflareEnv {
  DB: D1Database;
  REPORTS?: R2Bucket;
  SESSION_SECRET?: string;
  PROBE_SIGNING_SECRET?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD_HASH?: string;
  SESSION_TTL_SECONDS?: string;
  REGIONS_LIST?: string;
  WORKERS_URL_DOMAIN?: string;
  ENVIRONMENT?: string;
  [binding: string]: unknown;
}
```

## Helper modules

| Module              | Purpose                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| `regions.ts`        | Region IDs and validation                                                    |
| `env.ts`            | Worker bindings and environment parsing                                      |
| `crypto.ts`         | IDs, tokens, session hashing, and password hashing                           |
| `db.ts`             | Typed D1 query, batch, retry, and chunking helpers                           |
| `storage.ts`        | Round claims, observations, round finalization, and daily uptime persistence |
| `reports.ts`        | Report publication scheduling and claims                                     |
| `testing/sqlite.ts` | Local migrations and the SQLite-backed D1 test adapter                       |

The package root exports the public helpers and row types. Read the source or
generated TypeScript declarations for the exact export list; this table only
describes where each concern lives.

## Quick start

```ts
import { all, claimDueRounds, nowIso, parseRegionsList } from '@uptime/cloudflare';

export default {
  async scheduled(_event, env: CloudflareEnv) {
    const due = await all<MonitorRow>(
      env.DB,
      'SELECT * FROM monitors WHERE enabled = 1 AND next_check_at <= ? ORDER BY next_check_at LIMIT 50',
      [nowIso()],
    );
    const rounds = await claimDueRounds(
      {
        db: env.DB,
        now: new Date(),
        enabledRegionIds: parseRegionsList(env.REGIONS_LIST),
        claimToken: crypto.randomUUID(),
      },
      due,
    );
    // dispatch to regional probes, insertObservation(...), finalizeRound(...)
  },
};
```

Bind `DB` (D1), optional `REPORTS` (R2), and the secrets above. Consumers can
use `@cloudflare/workers-types` or the dependency-free structural
`D1Database`/`R2Bucket` interfaces exported from `workers-types.ts`.

## Missing-result semantics

- A region with no `observations` row contributes nothing to `received_count`;
  missing probes are therefore distinguishable from failed targets (which do
  contribute a non-success row).
- `check_runs.status='partial'` marks a window whose deadline passed with fewer
  results than `expected_region_count`.
- Incident evaluation reads `(expected_region_count, received, failures)` per
  finalized round; `received < expected` with zero failures is `unknown`, never
  healthy.
