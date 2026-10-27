# Deployment runbook

Production and staging run on one VPS: the Node 24 API, minute scheduler,
PostgreSQL 18, and nginx-served web UI run in Docker Compose. Pangolin/Traefik
routes the public origin to nginx. Cloudflare hosts only the regional probe
Workers (and the probe test target).

## Build and deploy

From the repository root, build the API and scheduler bundles and web UI:

```sh
pnpm --filter @uptime/api-worker build:node
pnpm --filter @uptime/coordinator-worker build:node
VITE_API_BASE_URL=/api VITE_REPORTS_BASE_URL=/reports pnpm --filter @uptime/web build
```

Deploy the API, scheduler, and web UI by following the canonical
[VPS staging runbook](../../deploy/vps/staging/README.md). Deploy regional
probe Workers with `scripts/deploy-workers.sh` and the appropriate environment;
see the [probe deployment guide](../../deploy/cloudflare/README.md).

## Database migrations

Migration profiles and their ordered files are maintained in
[`packages/cloudflare/src/postgres/migrations/plan.ts`](../../packages/cloudflare/src/postgres/migrations/plan.ts).
Follow the migration and backup procedure in the VPS runbook before deploying
bundles that require new migrations.

## Rollback and backups

For a routine application rollback, restore the previous API and scheduler image
tags recorded on the VPS, then recreate those Compose services as described in
the VPS runbook. The previous images stay on the VPS; the runbook requires
keeping the old tag and image ID in your deploy notes. Do not restore the
database for a code rollback.

Database and configuration backups are covered by the VPS runbook's
[backup section](../../deploy/vps/staging/README.md#backups-and-restore).
