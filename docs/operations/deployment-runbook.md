# Local and Cloudflare Worker deployment runbook

This runbook assumes `zsh` and that commands start in the repository root:

```sh
cd /Users/david/uptime
```

The API, scheduler, and web UI run in Docker Compose against an existing PostgreSQL database. Only the nine probe processes run on Cloudflare Workers: three separated anchors in North America, Europe, and Asia. The local stack exposes Vite on port 5176 and Fastify on the `API_PORT` configured in `.env`; both bind to `127.0.0.1`.

## 1. Prerequisites and one-time setup

Install:

- Node.js 24 or later. The root `package.json` rejects older engines; do not treat a successful run with an engine warning as the supported production configuration.
- pnpm 11 (the lockfile was produced with pnpm 11.24.0).
- Docker with the Compose plugin.
- A Cloudflare account with Workers enabled. A Cloudflare-managed zone is additionally required if using custom probe domains.

Check the toolchain and install the locked dependencies:

```sh
node --version
pnpm --version
docker compose version
pnpm install --frozen-lockfile
pnpm --filter @uptime/probe-worker exec wrangler --version
```

The checked-in lockfile currently resolves Wrangler 4.127.1. Authenticate interactively and verify which Cloudflare account will receive the deployments:

```sh
pnpm --filter @uptime/probe-worker exec wrangler login --use-keyring
pnpm --filter @uptime/probe-worker exec wrangler whoami
```

On a remote machine where the browser cannot return to Wrangler's local callback, use `wrangler login --device` instead. Cloudflare documents both OAuth login, device login, credential storage, and `whoami` in the [Wrangler general commands reference](https://developers.cloudflare.com/workers/wrangler/commands/general/). For non-interactive CI, use a narrowly scoped `CLOUDFLARE_API_TOKEN`; do not commit it.

## 2. Configure Docker Compose, migrations, and admin credentials

Create the local configuration:

```sh
cp .env.example .env
```

Generate the admin's Argon2id password hash without putting the plaintext password in shell history:

```sh
read -s 'UPTIME_ADMIN_PASSWORD?Admin password: '
echo
export UPTIME_ADMIN_PASSWORD
pnpm --filter @uptime/api exec node --input-type=module -e 'import argon2 from "argon2"; const password = process.env.UPTIME_ADMIN_PASSWORD; if (!password) throw new Error("Password is empty"); console.log(await argon2.hash(password, { type: argon2.argon2id }));'
unset UPTIME_ADMIN_PASSWORD
```

Copy the printed hash into `.env`. Quote it so the shell does not expand the `$` characters when `.env` is sourced:

```dotenv
ADMIN_PASSWORD_HASH='$argon2id$...'
```

Generate two independent secrets and put their outputs into `SESSION_SECRET` and `PROBE_SIGNING_SECRET` respectively:

```sh
openssl rand -hex 32
openssl rand -hex 32
```

Complete these local values in `.env`:

```dotenv
DATABASE_URL=postgresql://uptime:password@database.example.com:5432/uptime
API_HOST=0.0.0.0
API_PORT=3000
SESSION_COOKIE_SECURE=false
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD_HASH='$argon2id$...'
SESSION_SECRET=replace-with-first-generated-secret
SESSION_TTL_SECONDS=604800
PROBE_SIGNING_SECRET=replace-with-second-generated-secret
PROBE_REQUEST_MAX_SKEW_SECONDS=60
SCHEDULER_POLL_INTERVAL_MS=1000
SCHEDULER_INSTANCE_ID=local-1
SCHEDULER_MAX_CONCURRENT_PROBES=32
```

All nine `PROBE_*_URL` values are not used by the API and can remain placeholders until the Workers are deployed. `SCHEDULER_MAX_CONCURRENT_PROBES=32` bounds aggregate in-flight Worker requests; reduce it if the self-hosted scheduler has constrained network capacity. Keep `.env` private; it is already ignored by `.gitignore`.

`DATABASE_URL` is passed unchanged to the migration, API, and scheduler containers. Its hostname must therefore be reachable from Docker. For a database running on the Docker host, use `host.docker.internal` on Docker Desktop rather than `localhost`. Requests are not restricted by their `Origin` header. Set `SESSION_COOKIE_SECURE=true` when the browser reaches the app over HTTPS.

Start the control plane. Compose runs migrations against `DATABASE_URL`, then starts the API and scheduler; Vite starts after the API health check succeeds:

```sh
docker compose pull
docker compose up
docker compose ps
curl --fail http://localhost:${API_PORT:-3000}/health
```

Compose pulls the prebuilt `linux/amd64` images from `dmarcosm/uptime-{api,web,migrate,scheduler}:latest`. Open <http://localhost:5176>; check Fastify at `http://localhost:$API_PORT/health`. Use `docker compose up -d` when detached logs are preferred; inspect them with `docker compose logs -f migrate api scheduler web`. Migration failures intentionally prevent the API and scheduler from starting. Re-run a completed migration job with `docker compose run --rm migrate` after adding a migration, then `docker compose up -d`.

The Compose file does not create or manage PostgreSQL. Back up, secure, and monitor the database independently. If it requires a private CA or nonstandard network path, make that available to the containers before starting.

The API inserts the configured admin only when the `admins` table is empty. Changing `ADMIN_EMAIL` or `ADMIN_PASSWORD_HASH` after that first bootstrap does not update the existing database row.

### Reset the admin credentials later

Use the repository script so the configured Argon2 hash is validated before any database access. A read-only check reports only the singleton count and whether the configured hash matches the stored hash:

```sh
scripts/reset-admin.sh --check
```

To update the email and password hash, confirm interactively:

```sh
scripts/reset-admin.sh --apply
```

For an automated, already-authorized reset, add `--yes`. The operation locks exactly one singleton admin in a transaction, preserves monitors and history, and invalidates all existing sessions. Keep a protected copy of the prior hash or a database backup if rollback may be needed. Use `--env-file PATH` to load a different environment file; never pass credentials as command-line arguments.

## 3. Run the API and web UI locally, without checks

The application processes do not load the root `.env` file themselves. Source it in every terminal that runs the API or scheduler.

Terminal 1 — API:

```sh
cd /Users/david/uptime
set -a
source .env
set +a
pnpm --filter @uptime/api dev
```

Verify it separately:

```sh
curl --fail http://localhost:${API_PORT:-3000}/health
```

Terminal 2 — web UI:

```sh
cd /Users/david/uptime
pnpm --filter @uptime/web dev
```

Open <http://localhost:5176> and sign in with the plaintext password used to create the hash. Vite proxies `/api` to `http://127.0.0.1:3000`; override that only when needed with `UPTIME_API_PROXY_TARGET`.

### Port collision override

If the API port is already occupied, use a different API port without stopping unrelated processes. Set these values in the API environment (for example, in `.env`):

```dotenv
API_PORT=3010
SESSION_COOKIE_SECURE=false
```

Source that environment before starting the API, then launch the web UI with the matching proxy target:

```sh
set -a
source .env
set +a
pnpm --filter @uptime/api dev
UPTIME_API_PROXY_TARGET=http://127.0.0.1:3010 pnpm --filter @uptime/web dev
```

Open <http://localhost:5176>. The API and web processes do not auto-load the root `.env`; source it explicitly as shown, and do not kill unrelated processes to free a port.

At this point the admin UI and CRUD paths work, but no observations are produced because the scheduler is intentionally not running.

Stop the API and Vite with `Ctrl-C`. The external PostgreSQL database continues running independently.

## 4. Run and smoke-test one Worker locally

`wrangler dev` runs a local `workerd` at `http://localhost:8787`; this tests Worker runtime behavior but **does not prove Cloudflare regional placement**. Cloudflare documents the local endpoint and runtime behavior in the [`wrangler dev` reference](https://developers.cloudflare.com/workers/wrangler/commands/workers/).

Create a temporary dotenv file outside the repository containing only the probe secret, then start the existing US East config:

```sh
cd /Users/david/uptime
WORKER_ENV_FILE="$(mktemp)"
chmod 600 "$WORKER_ENV_FILE"
sed -n '/^PROBE_SIGNING_SECRET=/p' .env > "$WORKER_ENV_FILE"
test "$(wc -l < "$WORKER_ENV_FILE" | tr -d ' ')" = 1
pnpm --filter @uptime/probe-worker exec wrangler dev \
  --config ../../deploy/cloudflare/wrangler.us-east.toml \
  --env-file "$WORKER_ENV_FILE"
```

Cloudflare supports a dotenv file passed to local Wrangler and warns not to commit local secrets; see [local environment variables and secrets](https://developers.cloudflare.com/workers/local-development/environment-variables/). Using a temporary file here also avoids the repository gap that `.dev.vars` is not currently ignored by `.gitignore`.

In another terminal, send a correctly signed probe to the local Worker. This uses the scheduler's real signing implementation and the safe public example target:

```sh
cd /Users/david/uptime
set -a
source .env
set +a
PROBE_URL=http://127.0.0.1:8787 TARGET_URL=https://example.com \
pnpm --filter @uptime/scheduler exec tsx -e 'import { randomUUID } from "node:crypto"; import { signProbeRequest } from "./src/signing.ts"; void (async () => { const signed = signProbeRequest({ checkRunId: randomUUID(), monitorId: randomUUID(), windowStartedAt: new Date().toISOString(), regionId: "us-east", url: process.env.TARGET_URL, timeoutMs: 5000, method: "GET", maxRedirects: 5, maxBodyBytes: 65536 }, process.env.PROBE_SIGNING_SECRET); const response = await fetch(process.env.PROBE_URL, { method: "POST", headers: signed.headers, body: signed.body }); console.log(response.status); console.log(await response.text()); })();'
```

Expected result: HTTP `200` followed by a JSON observation whose `regionId` is `us-east`. A `401` means the local Worker and terminal do not have the same signing secret. Stop Wrangler with `Ctrl-C`, then remove the exact temporary file:

```sh
unlink "$WORKER_ENV_FILE"
```

To test another config locally, substitute any `wrangler.<region>.toml` and use its matching `regionId` in the signed request. Only run one on the default port at a time.

DNS diagnostics require no additional secret or Cloudflare account setting. They are disabled by default on every monitor. After applying migration `0002_dns_diagnostics.sql`, enable **Collect DNS diagnostics** in a monitor's settings and redeploy the Workers so they understand the signed diagnostic instruction. The scheduler reserves at most one snapshot per UTC day and selected region. Expect up to three Cloudflare DoH subrequests per snapshot; the UI labels their A/AAAA/CNAME results as candidates, never as the HTTP peer IP.

## 5. Deploy all nine Workers

The checked-in configs already define these separate Worker names and explicit Placement Hints:

| Config                         | Worker                        | Logical region   | Placement hint       |
| ------------------------------ | ----------------------------- | ---------------- | -------------------- |
| `wrangler.us-east.toml`        | `uptime-probe-us-east`        | `us-east`        | `aws:us-east-1`      |
| `wrangler.us-west.toml`        | `uptime-probe-us-west`        | `us-west`        | `aws:us-west-2`      |
| `wrangler.canada-central.toml` | `uptime-probe-canada-central` | `canada-central` | `aws:ca-central-1`   |
| `wrangler.eu-west.toml`        | `uptime-probe-eu-west`        | `eu-west`        | `aws:eu-west-1`      |
| `wrangler.eu-north.toml`       | `uptime-probe-eu-north`       | `eu-north`       | `aws:eu-north-1`     |
| `wrangler.eu-south.toml`       | `uptime-probe-eu-south`       | `eu-south`       | `aws:eu-south-1`     |
| `wrangler.asia.toml`           | `uptime-probe-asia`           | `asia`           | `aws:ap-southeast-1` |
| `wrangler.asia-east.toml`      | `uptime-probe-asia-east`      | `asia-east`      | `aws:ap-northeast-1` |
| `wrangler.asia-south.toml`     | `uptime-probe-asia-south`     | `asia-south`     | `aws:ap-south-1`     |

Cloudflare's supported syntax is `[placement] region = "{provider}:{region}"`. The Worker executes in a Cloudflare data center selected for low latency to that provider region, not inside AWS and not at a guaranteed city or PoP. See [Placement Hints](https://developers.cloudflare.com/workers/configuration/placement/).

Validate every Worker bundle locally, with no deployment:

```sh
scripts/deploy-workers.sh --dry-run
```

Create a temporary deploy file containing the **same** `PROBE_SIGNING_SECRET` that is in the scheduler's `.env`:

```sh
DEPLOY_SECRETS_FILE="$(mktemp)"
chmod 600 "$DEPLOY_SECRETS_FILE"
sed -n '/^PROBE_SIGNING_SECRET=/p' .env > "$DEPLOY_SECRETS_FILE"
test "$(wc -l < "$DEPLOY_SECRETS_FILE" | tr -d ' ')" = 1
```

Deploy code and the secret together to every Worker:

```sh
scripts/deploy-workers.sh --secrets-file "$DEPLOY_SECRETS_FILE"
unlink "$DEPLOY_SECRETS_FILE"
unset DEPLOY_SECRETS_FILE
```

The `--secrets-file` flow uploads secrets alongside code without committing them. It is distributed to all nine Workers by the discovery-based deploy script. Existing secrets omitted from later deploy files are preserved. Cloudflare documents this behavior in [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/). Interactive `wrangler secret put PROBE_SIGNING_SECRET --config ...` is also possible per Worker, but it creates and immediately deploys a new Worker version; use the shared file/script procedure for fleet consistency.

Each deploy prints its public `workers.dev` URL because the configs currently set `workers_dev = true`. Record all nine complete HTTPS origins, assign them below, and make unsigned, non-probing reachability checks:

```sh
US_EAST_WORKER_URL='https://uptime-probe-us-east.<account-subdomain>.workers.dev'
US_WEST_WORKER_URL='https://uptime-probe-us-west.<account-subdomain>.workers.dev'
CANADA_CENTRAL_WORKER_URL='https://uptime-probe-canada-central.<account-subdomain>.workers.dev'
EU_WEST_WORKER_URL='https://uptime-probe-eu-west.<account-subdomain>.workers.dev'
EU_NORTH_WORKER_URL='https://uptime-probe-eu-north.<account-subdomain>.workers.dev'
EU_SOUTH_WORKER_URL='https://uptime-probe-eu-south.<account-subdomain>.workers.dev'
ASIA_WORKER_URL='https://uptime-probe-asia.<account-subdomain>.workers.dev'
ASIA_EAST_WORKER_URL='https://uptime-probe-asia-east.<account-subdomain>.workers.dev'
ASIA_SOUTH_WORKER_URL='https://uptime-probe-asia-south.<account-subdomain>.workers.dev'
curl -i "$US_EAST_WORKER_URL/"
curl -i "$US_WEST_WORKER_URL/"
curl -i "$CANADA_CENTRAL_WORKER_URL/"
curl -i "$EU_WEST_WORKER_URL/"
curl -i "$EU_NORTH_WORKER_URL/"
curl -i "$EU_SOUTH_WORKER_URL/"
curl -i "$ASIA_WORKER_URL/"
curl -i "$ASIA_EAST_WORKER_URL/"
curl -i "$ASIA_SOUTH_WORKER_URL/"
```

The expected response to `GET` is `405 method_not_allowed`; that proves the endpoint is reachable without asking it to monitor a target. A `POST` without a valid signature should return `401`.

Put the actual URLs in the root `.env`:

```dotenv
PROBE_US_EAST_URL=https://replace-with-us-east-worker-url
PROBE_US_WEST_URL=https://replace-with-us-west-worker-url
PROBE_CANADA_CENTRAL_URL=https://replace-with-canada-central-worker-url
PROBE_EU_WEST_URL=https://replace-with-eu-west-worker-url
PROBE_EU_NORTH_URL=https://replace-with-eu-north-worker-url
PROBE_EU_SOUTH_URL=https://replace-with-eu-south-worker-url
PROBE_ASIA_URL=https://replace-with-asia-worker-url
PROBE_ASIA_EAST_URL=https://replace-with-asia-east-worker-url
PROBE_ASIA_SOUTH_URL=https://replace-with-asia-south-worker-url
```

### Optional production custom domains

Cloudflare recommends a Worker Route or Custom Domain instead of `workers.dev` for production. This Worker is itself the origin, so a Custom Domain is the appropriate choice. It requires an active Cloudflare zone and cannot reuse a hostname that already has a CNAME. See [Routes and domains](https://developers.cloudflare.com/workers/configuration/routing/) and [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

The current configs contain no production domains. To manage them as code, add a distinct block to each corresponding TOML file and redeploy:

```toml
[[routes]]
pattern = "probe-us-east.example.com"
custom_domain = true
```

Use distinct names such as `probe-us-east`, `probe-us-west`, `probe-canada-central`, `probe-eu-west`, `probe-eu-north`, `probe-eu-south`, `probe-asia-southeast`, `probe-asia-east`, and `probe-asia-south`, then update all scheduler URLs. Set `workers_dev = false` too if the `workers.dev` endpoints should be disabled. Do not configure dashboard-only routes and then assume they are durable: Cloudflare recommends treating Wrangler configuration as the source of truth, and later deploys can reconcile routes with the checked-in config ([Wrangler configuration source of truth](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)).

## 6. Start the scheduler against the deployed Workers

Keep PostgreSQL and the API running, add at least one enabled monitor through the UI, and then start Terminal 3:

```sh
cd /Users/david/uptime
set -a
source .env
set +a
pnpm --filter @uptime/scheduler dev
```

The scheduler polls PostgreSQL, claims due monitors, and invokes every selected regional URL concurrently. New monitors are scheduled on the next configured UTC interval boundary, so the first observation is not necessarily immediate. Stop new checks safely with `Ctrl-C`; existing data remains available to the API and UI.

For a local persistent installation, use the Compose stack from section 2. It runs the existing API and scheduler commands under Docker restart policies and exposes the Vite development server on port 5176. This is intentionally a simple local stack, not a TLS-terminating production web deployment.

## 7. Production order, logs, placement proof, and rollback

Recommended cutover order:

1. Prepare `.env` with a container-reachable `DATABASE_URL`, the admin hash, a fresh `SESSION_SECRET`, a fresh `PROBE_SIGNING_SECRET`, and `SESSION_COOKIE_SECURE=true` when using HTTPS.
2. Run `docker compose pull`, then start `docker compose up`; the migration container applies migrations before the API and scheduler run.
3. For production, replace the Vite development server with an operator-provided static web server and TLS reverse proxy; enable secure session cookies with `SESSION_COOKIE_SECURE=true`.
4. Stop the scheduler (`docker compose stop scheduler`) before first probe deployment or signing-secret rotation.
5. Deploy all nine Workers with one shared fresh signing secret, configure their final domains, and safely verify `405`/`401` responses.
6. Put those exact HTTPS URLs and the same secret in `.env`, then start one scheduler instance with `docker compose up -d scheduler`.
7. Add a controlled public HTTPS monitor, wait for its next interval, and inspect all nine regional observations before enabling the remaining monitors. A one-minute monitor using every region performs 12,960 checks/day; [Cloudflare's Workers limits](https://developers.cloudflare.com/workers/platform/limits/) document a 100,000-request/day Free-plan allowance, so eight such monitors exceed it before other account traffic.

Tail live invocation and exception logs in separate terminals:

```sh
pnpm --filter @uptime/probe-worker exec wrangler tail uptime-probe-us-east --format pretty
pnpm --filter @uptime/probe-worker exec wrangler tail uptime-probe-us-west --format pretty
pnpm --filter @uptime/probe-worker exec wrangler tail uptime-probe-canada-central --format pretty
pnpm --filter @uptime/probe-worker exec wrangler tail uptime-probe-eu-west --format pretty
pnpm --filter @uptime/probe-worker exec wrangler tail uptime-probe-eu-north --format pretty
pnpm --filter @uptime/probe-worker exec wrangler tail uptime-probe-eu-south --format pretty
pnpm --filter @uptime/probe-worker exec wrangler tail uptime-probe-asia --format pretty
pnpm --filter @uptime/probe-worker exec wrangler tail uptime-probe-asia-east --format pretty
pnpm --filter @uptime/probe-worker exec wrangler tail uptime-probe-asia-south --format pretty
```

`wrangler tail` is Cloudflare's live log stream and may sample high-volume traffic; filters are available for method, status, search text, and version ([Wrangler tail reference](https://developers.cloudflare.com/workers/wrangler/commands/workers/#tail)). The Worker intentionally does not log request bodies or secrets.

Placement verification must use deployed signed checks, not `wrangler dev`:

1. Monitor a public HTTPS endpoint you control from all nine regions.
2. Retain at least 24 hours of observations and compare each row's logical `regionId`, `placement`, and `colo`.
3. Expect regional affinity and possible placement changes, not a fixed source IP, city, or PoP. Cloudflare may move execution for network conditions and documents that the `cf-placement` header used by this MVP may change while placement remains in beta ([Placement behavior and header](https://developers.cloudflare.com/workers/configuration/placement/#cf-placement-header)).
4. Treat simultaneous regional loss as a possible correlated Cloudflare failure; this nine-Worker fleet is not provider-independent evidence.

To inspect deployments and roll back one Worker to its immediately preceding version:

```sh
pnpm --filter @uptime/probe-worker exec wrangler deployments list --config ../../deploy/cloudflare/wrangler.us-east.toml
pnpm --filter @uptime/probe-worker exec wrangler rollback --config ../../deploy/cloudflare/wrangler.us-east.toml
```

Repeat with any affected region config as needed. With no version ID, rollback defaults to the version uploaded before the latest; it immediately creates an active rollback deployment across that Worker's routes and domains. See Cloudflare's [`rollback` reference](https://developers.cloudflare.com/workers/wrangler/commands/workers/#rollback). The safest fleet-wide emergency stop is still `docker compose stop scheduler`, because that halts new target requests without destroying deployments or history.

Deleting a Worker is destructive and is not a rollback. Only for deliberate decommissioning:

```sh
pnpm --filter @uptime/probe-worker exec wrangler delete --name uptime-probe-us-east
```

## Security and platform caveats

- **Signing secret:** all nine Workers and the scheduler must use the exact same value, at least 32 characters. For rotation, stop the scheduler, update every Worker, update the scheduler environment, and only then restart it. Never put the value in TOML, a command argument, logs, or source control.
- **Placement:** `[placement].region` is a Cloudflare routing hint toward an AWS/GCP/Azure region. It is not deployment inside that provider, a residency guarantee, or a permanent PoP assignment. It affects fetch handlers, which is why this architecture invokes each Worker over HTTP.
- **DNS/SSRF boundary:** the API resolves a monitor hostname when saving, the scheduler resolves it again before dispatch, and the Worker rejects forbidden literal addresses and revalidates redirects. Cloudflare Workers do not expose the authoritative final DNS/TCP socket destination to this code, leaving a DNS-rebinding race. Monitor only intentionally public targets, protect internal origins independently, and do not treat this service as a general-purpose SSRF boundary.
- **Public endpoint:** a Worker URL is Internet-reachable. Its protection is the HMAC, timestamp skew check, request identity, size limits, and region match. Do not put Cloudflare Access in front unless the scheduler is also configured to authenticate to Access; this MVP has no Access client credentials support.
- **Control plane:** Compose contains migrations, API, scheduler, and a Vite development server. PostgreSQL and the Cloudflare Workers are external. Arrange production TLS, static web serving, secret injection, and database backups separately.
