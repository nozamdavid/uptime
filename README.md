# Multi-region uptime monitor

A self-hosted control plane for HTTP uptime and latency monitoring with nine Cloudflare Worker probes: US East, US West, Canada Central; Europe West, North, and South; and Asia Southeast, East, and South.

The control plane, scheduler, PostgreSQL history, and admin UI are self-hosted. Probe compute is deployed to Cloudflare Workers, so this is a hybrid self-hosted system and a single-provider probe fleet. Placement is regional affinity near a configured cloud region, not a guarantee of an exact city or Cloudflare PoP.

## Requirements

- Node.js 24+
- pnpm 11+
- Docker with Compose

## Foundation commands

```bash
cp .env.example .env
# Set ADMIN_PASSWORD_HASH, SESSION_SECRET, PROBE_SIGNING_SECRET, and all nine
# PROBE_*_URL values in .env before starting production services.
docker compose pull
docker compose up
```

This uses `DATABASE_URL` from `.env` to migrate an existing PostgreSQL database, then starts the API, scheduler, and Vite web UI. Open <http://localhost:5176>. The API is available on `127.0.0.1` at the `API_PORT` configured in `.env`. Set `SESSION_COOKIE_SECURE=true` when serving the app over HTTPS. See [the deployment runbook](docs/operations/deployment-runbook.md) for secret generation and operational checks.

Deploy the complete regional fleet with `scripts/deploy-workers.sh` after configuring the shared probe secret. Each Worker needs its own public URL in the scheduler environment (`PROBE_*_URL`); see [the deployment runbook](docs/operations/deployment-runbook.md). At one-minute frequency, a monitor using all nine regions makes 12,960 target checks per day. Cloudflare placement is regional affinity near the configured cloud region, not a guarantee of a specific city or PoP.

See [the architecture](docs/architecture/mvp.md), [the nine-region placement plan](docs/research/nine-region-placement-plan.md), and [the Cloudflare research note](docs/research/cloudflare-workers-multi-region-uptime-monitor.md).
