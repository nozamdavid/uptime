# Cloudflare Staging Probes

> [!IMPORTANT]
> The staging API, scheduler, and PostgreSQL 18 database run on a dedicated Debian 12 VPS (`217.217.227.164`). Cloudflare staging only hosts probe Workers and the test target. For the VPS deployment and operations guide, see [deploy/vps/staging/README.md](../../vps/staging/README.md).

This environment is isolated from production. Every staging Worker uses the `uptime-staging` namespace.

---

## Cloudflare Staging Resources

| Resource | Staging Value | Role |
| --- | --- | --- |
| **Regional Probes** | `uptime-staging-probe-{region}` | Probe Workers executing HTTP health checks across regional Cloudflare PoPs (`probes/`) |
| **Hosted Probes** | `uptime-staging-hosted-probe-{region}` | Regional probe Workers for hosted tenant checks (`hosted-probes/`) |
| **Controlled Target** | `uptime-staging-target` | Probe healthcheck target (`target/`) |
| **PostgreSQL Catalog** | `postgresql-runtime-catalog.json` | Schema catalog mapping for the VPS PostgreSQL runtime |

---

## Worker Deployments

### Regional Probe Fleet
```bash
scripts/deploy-workers.sh --environment staging
```

### Controlled Target
```bash
apps/probe-worker/node_modules/.bin/wrangler deploy --config deploy/cloudflare/staging/target/wrangler.toml
```

---

## Safety Rules

- **Protected Secrets**: Never commit or print probe or scheduler secrets. Keep secrets files at mode `0600`.
- **Shared Signing Secret**: Staging probes must use the same `PROBE_SIGNING_SECRET` as the staging VPS scheduler.
