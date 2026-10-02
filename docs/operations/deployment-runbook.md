# Cloudflare deployment runbook

Run commands from the repository root. The current runtime uses Workers, D1,
R2, and Pages. PostgreSQL and Docker commands in historical migration reports
do not apply to this checkout.

## Configure resources

Use the [deployment guide](../../deploy/cloudflare/README.md) to select the
correct Wrangler files. The API and coordinator must bind `DB` to the same D1
database. The coordinator's `REPORTS` binding selects the public-report bucket.
Production configurations contain resource placeholders that must be replaced
for a new installation. Staging has separate configurations and resources.

Required secrets:

| Worker      | Secrets                                                                                |
| ----------- | -------------------------------------------------------------------------------------- |
| API         | `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_SECRET` |
| Coordinator | `PROBE_SIGNING_SECRET`, `CREDENTIAL_ENCRYPTION_SECRET`                                 |
| Probes      | `PROBE_SIGNING_SECRET`                                                                 |

Generate the admin password hash with `pnpm hash:admin`. Use the same encryption
secret for the API and coordinator, and the same signing secret for the
coordinator and every regional probe. Keep secret files untracked.

Set `WEB_ORIGIN` to the exact frontend origin and `WORKERS_URL_DOMAIN` to the
probe account suffix. Align `REGIONS_LIST` across the API and coordinator.
Use HTTPS and secure cookies for production.

## Local API development

```sh
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm --filter @uptime/api-worker dev
```

Wrangler reads local secrets from `deploy/cloudflare/api/.dev.vars`. In a second
terminal run `pnpm --filter @uptime/web dev`; Vite proxies `/api` to port 8787.
Coordinator development additionally requires its own secrets and bindings;
avoid running local checks against unintended targets or production resources.

## Deploy and verify

```sh
pnpm typecheck
pnpm test
pnpm build
scripts/deploy-app-workers.sh --dry-run
scripts/deploy-workers.sh --dry-run
```

Deploy with `scripts/deploy-app-workers.sh --secrets-file /path/to/app-secrets.env`
and `scripts/deploy-workers.sh --secrets-file /path/to/probe-secrets.env` when
ready. The app script applies remote D1 migrations first. Omitted Worker secrets
remain in place. Follow the [staging guide](../../deploy/cloudflare/staging/README.md)
for the separate Pages gateway and its API/report bindings.

Set `VITE_REPORTS_BASE_URL` to the gateway's `/reports` base URL when building
the UI. The gateway resolves public monitor URLs through the cohort pointer;
a bare R2 bucket domain does not perform this lookup.

After deployment, verify login, a regional check, stored observations,
notification delivery using an intended test destination, and the public
report's generation and freshness. Inspect `jobs.state_json` for work counts,
failures, and durations. Monitor Worker CPU/memory alongside D1 reads/writes.

## Admin credentials and recovery

`ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` bootstrap the first D1 admin; changing
the Worker secrets does not overwrite an existing row. To rotate an existing
admin, generate a new PBKDF2 hash, update the singleton row in D1 through your
authenticated database tooling, invalidate its sessions, and keep bootstrap
secrets aligned. Do not use the removed PostgreSQL reset script or place hashes
and passwords in shell history.

Rollback uses a compatible previous Worker/Pages deployment against the same
D1 schema. Keep D1 backups and check migration compatibility before rollback;
removing runtime source does not delete deployed resources or stored history.
