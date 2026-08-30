# Cloudflare regional probe deployments

Deploy the identical Worker source nine times. The deployment names and regional affinity are intentionally explicit:

| Deployment                    | Logical region   | Placement hint       |
| ----------------------------- | ---------------- | -------------------- |
| `uptime-probe-us-east`        | `us-east`        | `aws:us-east-1`      |
| `uptime-probe-us-west`        | `us-west`        | `aws:us-west-2`      |
| `uptime-probe-canada-central` | `canada-central` | `aws:ca-central-1`   |
| `uptime-probe-eu-west`        | `eu-west`        | `aws:eu-west-1`      |
| `uptime-probe-eu-north`       | `eu-north`       | `aws:eu-north-1`     |
| `uptime-probe-eu-south`       | `eu-south`       | `aws:eu-south-1`     |
| `uptime-probe-asia`           | `asia`           | `aws:ap-southeast-1` |
| `uptime-probe-asia-east`      | `asia-east`      | `aws:ap-northeast-1` |
| `uptime-probe-asia-south`     | `asia-south`     | `aws:ap-south-1`     |

From the repository root, authenticate Wrangler, then deploy every discovered configuration with the identical high-entropy signing secret:

```bash
pnpm --filter @uptime/probe-worker exec wrangler login
scripts/deploy-workers.sh --dry-run
scripts/deploy-workers.sh --secrets-file /path/to/probe-secrets.env
```

Use a separate verified public endpoint or custom domain for each deployment and set all nine `PROBE_*_URL` variables in the scheduler environment to those endpoints. Do not set routes, account IDs, or secrets in this repository unless they are intentionally public.

## Placement verification

1. Point a temporary monitor at a controlled HTTPS echo service that records source metadata and returns request headers.
2. Invoke all nine probes for 24 hours and retain the Worker result `colo` plus the echo service records.
3. Compare the nine logical-region streams and Cloudflare Trace output (`https://<probe>/cdn-cgi/trace`) over time. The expected evidence is regional affinity, not a permanently fixed city, PoP, or source IP.
4. Record unexpected convergence or outages as a Cloudflare provider-failure caveat; these Workers do not offer provider-independent evidence.

Workers cannot reveal the full DNS resolution chain or final TCP destination used by `fetch`. The Worker rejects forbidden literal addresses and revalidates redirect URLs, but protect sensitive internal origins independently and do not use this MVP as an SSRF boundary for private networks.
