# `@uptime/cloudflare` schema reference

This package holds the shared PostgreSQL schema, row types, and database helpers
for the Node API and coordinator services running on the VPS.

Migrations are PostgreSQL SQL files under `src/postgres/migrations`:

- `control` — the hosted control plane: admins, workspaces, the Postgres tenant
  registry, product limits and tiers, operator operations, and billing.
- `tenant` — the per-workspace schema: monitors, status pages, notification
  services and deliveries, check rounds, observations, diagnostics, daily
  aggregates, jobs, and report publications.
- `legacy` — the tenant set plus the staging or production identity verified
  during a legacy import.
- `data-import` — trigger toggles wrapped around a legacy data import.

`getMigrationFilesForProfile` and `loadMigrationsForProfile` in
`src/postgres/migrations/plan.ts` resolve the ordered file list for each
profile. `applyPostgresMigrations` in `src/postgres/migrate.ts` records applied
migration ids in the schema's `_postgres_migrations` ledger and refuses edited
files; each schema is created through a trusted identifier and migrations run
under an advisory lock.

## Conventions

- **IDs** are text UUIDv4 values; `crypto.randomId()` supplies them in
  application code.
- **Timestamps** are ISO-8601 UTC text with milliseconds, e.g.
  `2026-09-20T18:40:00.000Z`. `nowIso()` is the app-side helper.
- **Flags** are integers constrained to `0|1`, so `toBoolean` in `env.ts` can
  read them without branching per caller.
- **Nested configuration** maps to contract JSON objects stored in `text`
  columns with a JSON validity check (`config`, `uptime_thresholds`,
  `endpoint_evidence`, `response_metadata`, `message`, `expected_regions`,
  `result`, `state_json`, `cursor`).
- **Indexed / selected fields** always have their own scalar column
  (`enabled`, `next_check_at`, `public_slug`, `provider`, `status`, ...).
- Enum-like text columns use `CHECK` lists mirroring `@uptime/contracts`.
- Foreign keys are declared and enforced by PostgreSQL.

## Hosted product limits

`control/0004_workspace_product_limits.sql` stores optional per-workspace
overrides for saved monitor count, regions per monitor, and configured region
access. Workspaces without an override use the deployment defaults: three
monitors and the preferred configured regions.

Tenant migration `tenant/0015_workspace_product_limits.sql` mirrors the active
policy in `workspace_metadata`. Triggers use that row to enforce monitor and
region quotas during writes, including concurrent requests.

## Row types

`src/types.ts` declares the raw row shapes the query layer returns
(`MonitorRow`, `CheckRunRow`, `ObservationRow`, `MonitorDailyUptimeRow`,
`ReportPublicationRow`, ...). `src/postgres/tables.ts` lists the table names per
profile.

Tests that need a real database use `@uptime/cloudflare/testing/postgres` and
require `POSTGRES_TEST_ADMIN_URL`.
