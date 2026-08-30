# MVP architecture

## Scope and invariants

The MVP monitors HTTP(S) URLs with `GET` from any selected subset of nine fixed logical regions: three deliberately separated anchors in each of North America, Europe, and Asia. Checks run every 60, 300, 900, 1,800, or 3,600 seconds with a 1,000–30,000 ms timeout that must be shorter than the interval. A 200–399 response is successful. Probes follow no more than five redirects, read no more than 65,536 response bytes, and never retry automatically.

The expected target-check count shown before save is:

`selected region count × (86,400 ÷ interval seconds)`

All interval presets divide a UTC day exactly. This count excludes redirect subrequests and future manual checks.

## Component topology

```text
personal admin browser
        |
        | HTTPS + session cookie
        v
 self-hosted Web UI ----> self-hosted Fastify API ----> PostgreSQL 17
                                  ^                         ^
                                  |                         |
                                  |                  exact observations
                                  |                         |
                         self-hosted scheduler -------------+
                            |       |       |
                    signed HTTPS requests, concurrently
                            |       |       |
                            v       v       v
                      Worker US  Worker EU  Worker Asia
                            \       |       /
                             bounded GET requests
                                      |
                                monitored origins
```

The browser, API, scheduler, and PostgreSQL database are controlled by the operator. The Worker fleet and its network are operated by Cloudflare. This is hybrid self-hosting and retains a correlated Cloudflare failure domain.

## Fixed regional registry

| Continent     | Logical ID       | Display name               | Cloudflare placement hint |
| ------------- | ---------------- | -------------------------- | ------------------------- |
| North America | `us-east`        | US East (N. Virginia)      | `aws:us-east-1`           |
| North America | `us-west`        | US West (Oregon)           | `aws:us-west-2`           |
| North America | `canada-central` | Canada Central (Montréal)  | `aws:ca-central-1`        |
| Europe        | `eu-west`        | Europe West (Ireland)      | `aws:eu-west-1`           |
| Europe        | `eu-north`       | Europe North (Stockholm)   | `aws:eu-north-1`          |
| Europe        | `eu-south`       | Europe South (Milan)       | `aws:eu-south-1`          |
| Asia          | `asia`           | Asia Southeast (Singapore) | `aws:ap-southeast-1`      |
| Asia          | `asia-east`      | Asia East (Tokyo)          | `aws:ap-northeast-1`      |
| Asia          | `asia-south`     | Asia South (Mumbai)        | `aws:ap-south-1`          |

Explicit placement gives regional affinity to a Cloudflare data center near the provider region. It does not guarantee a precise city, PoP, source IP, or permanently fixed data center. Each observation stores the logical region separately from observed placement/colo metadata. Placement applies to HTTP fetch handlers; the scheduler therefore invokes each probe's fetch endpoint and does not depend on Worker Cron or RPC placement. The named anchors describe useful, widely separated comparison points—not exact execution locations.

## Trust boundaries

1. **Browser to control plane.** One admin account is bootstrapped from environment configuration. The API stores only an Argon2id password hash and hashed, opaque session tokens. Cookies must be `HttpOnly`, `Secure` outside local development, and `SameSite=Strict`; state-changing endpoints require an allowed `Origin`.
2. **Scheduler to probes.** Every body is authenticated with an HMAC-SHA-256 signature over a versioned canonical payload plus issued timestamp and request ID. Probes reject stale requests, signature mismatches, a request whose logical region differs from their deployment, and oversized bodies. The signing secret is shared only by scheduler and probes.
3. **Probe to target.** A valid signed request still does not make arbitrary destinations safe. The API resolves on save, the scheduler re-resolves immediately before dispatch, and the probe rejects forbidden literal destinations and revalidates every redirect URL. Workers do not expose authoritative destination DNS/IP inspection, so production must also apply Cloudflare egress/network policy; a DNS-rebinding race remains a documented platform limitation.
4. **Control plane to database.** PostgreSQL is private to the deployment network. API and scheduler have database credentials; probes never do.

## Request lifecycle

1. The scheduler atomically leases due monitors using a database transaction and row locks (`FOR UPDATE SKIP LOCKED`). It advances `next_check_at` by interval boundaries rather than by completion time, preventing schedule drift.
2. It derives the UTC `window_started_at` boundary and inserts one `check_runs` row. `(monitor_id, window_started_at)` is unique, so restarts or multiple scheduler instances converge on one logical run.
3. The run snapshots URL and timeout. Its selected regions come from `monitor_regions`; the scheduler sends signed requests to every selected region with `SCHEDULER_MAX_CONCURRENT_PROBES` limiting aggregate in-flight probe calls (default `32`).
4. Each Worker verifies authenticity/freshness/region, validates the target, performs one bounded GET with manual redirects, and returns timing and response metadata synchronously. Target response time is measured before control-plane persistence. After the final response headers arrive, the Worker records the final URL/hostname and a bounded allowlist of CDN response signals. For an independently signed daily DNS reservation, it then performs at most three bounded Cloudflare DoH queries for the final hostname. Diagnostic time and failures never change the HTTP observation, latency, or aggregate status.
5. The scheduler upserts one observation per `(check_run_id, region_id)`. That unique key makes result persistence idempotent. A probe invocation may be repeated only as transport recovery with the same request/run identity; MVP scheduling does not automatically retry a target failure.
6. Once all expected observations arrive, the run becomes `complete`. Once its bounded collection deadline expires with fewer results, it becomes `partial`. Absence of a row is a missing/system result, not a fabricated target failure.

## Status semantics

Status is derived over expected selected regions for the latest window:

- `up`: all expected regions returned successful observations.
- `degraded`: observations are mixed success/failure, or any expected observation is missing while at least one result exists.
- `down`: a strict majority of selected regions returned target failures and there is no success that could reverse the majority with missing results filled; for one selected region its failure is down.
- `unknown`: there is no completed observation yet, or control-plane/system evidence is insufficient to claim target state.

`http_failure` means an actual HTTP response outside 200–399. `network_failure` uses the shared error taxonomy. A missing probe response is represented by a partial run and must not be collapsed into `network_failure` for the monitored target. The UI should expose each regional result and any missing region alongside aggregate status.

## SSRF and bounded-fetch controls

- Accept only absolute `http:` and `https:` URLs; reject embedded credentials and non-standard schemes.
- Resolve hostnames in the API and scheduler and reject loopback, link-local, private, carrier-grade NAT, multicast, documentation/test, and reserved IPv4/IPv6 ranges. Repeat resolution immediately before probe dispatch. The Worker repeats literal and redirect URL checks; configure Cloudflare egress/network controls because its runtime does not expose the final socket destination for authoritative IP comparison.
- Reject literal forbidden IPs and ambiguous numeric/encoded host representations.
- Follow redirects manually, maximum five; canonicalize and revalidate every destination.
- Use an abort deadline from the configured timeout. Request with cache bypass/no-store semantics.
- Consume at most 65,536 response bytes and cancel the remainder. Do not include response bodies in results.
- Do not forward admin cookies, authorization, arbitrary headers, or user-controlled request bodies.
- Sign exact request bytes and enforce timestamp skew. Apply per-deployment request-size and rate limits.

Cloudflare Workers do not expose a complete browser-style DNS/TCP/TLS timing breakdown. `response_ms` is the elapsed fetch-to-headers metric; `total_ms` includes bounded body consumption. Labels must not overclaim phase timing.

## CDN response evidence

Each observation may retain response-reported CDN evidence from the final HTTP response only. The Worker stores the normalized final hostname and bounded values for `cf-ray`, `cf-cache-status`, `x-amz-cf-pop`, `x-cache`, `x-served-by`, `x-cache-hits`, `x-vercel-id`, `server`, and `via`. It never stores arbitrary response headers or claims to observe the connected peer IP.

Conservative parsers recognize unambiguous Cloudflare, CloudFront, Fastly, and Vercel edge/POP hints. Conflicting providers, malformed values, and multi-hop values whose serving edge is ambiguous remain visible as raw allowlisted signals but do not produce a primary provider claim. Continent is explicitly an inference from the reported edge code and can be unknown. Provider headers can be spoofed by a monitored origin, so the UI labels them **provider-reported** and keeps this target-response evidence separate from the probe's own placement and Cloudflare colo.

Evidence is nullable for rolling compatibility with Workers deployed before this feature and rows recorded before the additive migration. Invalid historical JSON is contained at the database seam and logged rather than breaking request history.

## Optional DNS diagnostics

DNS diagnostics are disabled by default per monitor. When enabled, the scheduler reserves at most one snapshot per UTC day for each selected region using a unique `(monitor_id, region_id, kind, window_started_at)` database key. The reservation identity, UTC window, and maximum two-second deadline are part of the signed probe request. This makes multiple scheduler replicas converge without relying on local time or in-memory state. A stale pending reservation becomes unavailable rather than being retried repeatedly; an old Worker that omits the result is recorded as unsupported without losing its valid HTTP observation.

The Worker queries Cloudflare DoH separately for CNAME, A, and AAAA records after the HTTP measurement. It accepts only a bounded DNS JSON response with a matching question, retains at most eight normalized candidates per family, caps TTLs, and filters private, loopback, link-local, documentation, multicast, and other special-use addresses. Results are evidence of what the regional resolver returned at that time—not the address selected by `fetch`, the connected HTTP peer, a traceroute, or a geography claim. Failed or partial DNS resolution has no effect on uptime state.

Snapshots live in `network_diagnostics`, separate from observations, and are retained for 30 days in bounded cleanup batches. The ordinary expected target-check estimate remains unchanged. The form separately reports a maximum of one regional DNS snapshot and three resolver queries per selected region per day.

## Data model and query paths

- `admins` enforces one row through a singleton key; `sessions` stores token hashes and expiry.
- `monitors` contains current URL, schedule, timeout, enablement, and next due time; `monitor_regions` holds selected regions.
- `check_runs` is one logical monitor/window with a snapshot of execution inputs.
- `observations` is one exact regional result. Its `(monitor_id, region_id, started_at)` index supports regional charts; `(monitor_id, started_at)` supports request history; `(check_run_id, region_id)` prevents duplicates.
- `network_diagnostics` stores reservation lifecycle and bounded DNS snapshot JSON independently from request timing/history. Foreign keys preserve monitor/run ownership, and monitor deletion cascades its diagnostics.

All timestamps are PostgreSQL `timestamptz` and scheduling boundaries are UTC. Exact observations are retained for 90 days and DNS diagnostics for 30 days. A daily maintenance job deletes expired rows in bounded batches, then expired sessions; deleting a monitor cascades to its runs, observations, and diagnostics. Longer-term rollups are intentionally deferred until real volume or retention requirements justify them.

## Deployment

Local Docker Compose supplies PostgreSQL. API, scheduler, and web containers will join its private network in the application deployment slice. The probe source is deployed nine times with identical code and per-deployment values:

```text
probe-us-east         placement.region = aws:us-east-1       PROBE_REGION=us-east
probe-us-west         placement.region = aws:us-west-2       PROBE_REGION=us-west
probe-canada-central  placement.region = aws:ca-central-1    PROBE_REGION=canada-central
probe-eu-west         placement.region = aws:eu-west-1       PROBE_REGION=eu-west
probe-eu-north        placement.region = aws:eu-north-1      PROBE_REGION=eu-north
probe-eu-south        placement.region = aws:eu-south-1      PROBE_REGION=eu-south
probe-asia            placement.region = aws:ap-southeast-1  PROBE_REGION=asia
probe-asia-east       placement.region = aws:ap-northeast-1  PROBE_REGION=asia-east
probe-asia-south      placement.region = aws:ap-south-1      PROBE_REGION=asia-south
```

Each deployment uses a distinct HTTPS custom domain or verified public endpoint. Before production use, run a placement proof against a controlled echo target and compare returned placement metadata with Cloudflare traces for at least 24 hours. At a one-minute interval, one monitor selecting all nine regions schedules 12,960 target checks per day; on Cloudflare's Free plan, eight such monitors exceed the documented 100,000 daily Worker-request allowance before other account traffic. Monitoring remains useful from these nine perspectives, but it is not provider-independent evidence.

## Deferred beyond MVP

Alerts/incidents, custom headers or bodies, content assertions, TCP/ICMP checks, native VM probes, retries, configurable success predicates, long-term aggregates, and exact fixed-egress IPs are excluded. The signed probe contract deliberately permits a later provider-neutral native probe implementation.
