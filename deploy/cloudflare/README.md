# Cloudflare deployment files

> [!IMPORTANT]
> Cloudflare only hosts the regional probe Workers and the test target Worker. The API, scheduler, PostgreSQL database, and web UI run on the VPS; see the [hosted runbook](../../docs/deployment/free-hosted.md) and the [VPS staging runbook](../vps/staging/README.md). Staging probes are covered in the [staging guide](staging/README.md).

Run every command in this guide from the repository root.

## Configuration files

| Target | Configuration | How it is maintained |
| --- | --- | --- |
| Probes | `deploy/cloudflare/wrangler.<region>.toml` | Generated via `pnpm generate:wrangler` |
| Test target | `deploy/cloudflare/target/wrangler.toml` | Edit by hand |
| Staging | `deploy/cloudflare/staging/` | See the [staging guide](staging/README.md) |

The probe generator only owns the root `wrangler.<region>.toml` files. It does not touch the test target or staging configurations.

See the [deployment runbook](../../docs/operations/deployment-runbook.md) for the scheduler variables and secrets that pair with the probes.

## Deploy the test target

```bash
apps/probe-worker/node_modules/.bin/wrangler deploy --config deploy/cloudflare/target/wrangler.toml
```

## Deploy regional probes

Probe configurations come from the region registry in `packages/regions`. Regenerate and check them before deployment:

```bash
pnpm generate:wrangler
pnpm generate:wrangler -- --check
```

Authenticate, run a dry run, then deploy:

```bash
pnpm --filter @uptime/probe-worker exec wrangler login
scripts/deploy-workers.sh --dry-run
scripts/deploy-workers.sh --secrets-file /path/to/probe-secrets.env
```

Every deployed probe must use the same high-entropy `PROBE_SIGNING_SECRET` as the coordinator / scheduler.

Set `REGIONS_LIST` in the environment or the repository `.env` file to deploy only part of the fleet. The script preserves the listed order:

```dotenv
REGIONS_LIST="asia-east,asia-south"
```

When `REGIONS_LIST` is absent, the script deploys every generated probe. The same region list controls the API monitor editor and coordinator scheduling.

Set `WORKERS_URL_DOMAIN` on the coordinator to the account suffix reported by Wrangler, such as `account-subdomain.workers.dev`. The coordinator calls probes at `https://uptime-probe-{region}.{WORKERS_URL_DOMAIN}`.

Do not commit account IDs or secrets unless they are intentionally public.

## Probe placement

| Worker | Region | Placement hint |
| --- | --- | --- |
| `uptime-probe-us-east` | `us-east` | `aws:us-east-1` |
| `uptime-probe-us-west` | `us-west` | `aws:us-west-2` |
| `uptime-probe-canada-central` | `canada-central` | `aws:ca-central-1` |
| `uptime-probe-eu-west` | `eu-west` | `aws:eu-west-1` |
| `uptime-probe-eu-north` | `eu-north` | `aws:eu-north-1` |
| `uptime-probe-eu-south` | `eu-south` | `aws:eu-south-1` |
| `uptime-probe-asia` | `asia` | `aws:ap-southeast-1` |
| `uptime-probe-asia-east` | `asia-east` | `aws:ap-northeast-1` |
| `uptime-probe-asia-south` | `asia-south` | `aws:ap-south-1` |

Placement hints express regional affinity. They do not guarantee a fixed city, Cloudflare point of presence, or source IP.

To verify placement:
1. Point a temporary monitor at an HTTPS echo service you control.
2. Run every enabled probe long enough to collect representative results.
3. Save each result's `colo` and the echo service's source metadata.
4. Compare those records with `https://<probe>/cdn-cgi/trace`.

Workers do not reveal the full DNS chain or the final TCP destination used by `fetch`. The probe blocks forbidden literal addresses and checks redirect URLs, but private origins still need their own access controls.
