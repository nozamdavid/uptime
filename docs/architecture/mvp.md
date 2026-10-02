# Cloudflare architecture

D1 is the authoritative application database. Workers implement the API,
coordinator, and regional probes; R2 holds public reports; Pages serves the UI.
The PostgreSQL runtime and Docker deployment were retired after migration.

## Responsibilities

| Module                    | Responsibility                                           |
| ------------------------- | -------------------------------------------------------- |
| `apps/api-worker`         | Sessions, monitor configuration, private/history queries |
| `apps/coordinator-worker` | Scheduling, incident evaluation, publication, retention  |
| `apps/probe-worker`       | Signed bounded target checks and optional diagnostics    |
| `apps/web`                | Admin views and public report rendering                  |
| `packages/cloudflare`     | D1 schema/helpers, R2 contracts, portable credentials    |
| `packages/contracts`      | Shared validation, payloads, notification rules          |
| `packages/regions`        | Region identity, placement, and display metadata         |

## Checks and concurrency

The coordinator runs each minute. It recovers expired claims, atomically claims
due monitor windows, snapshots expected regions and configuration into rounds,
and batches up to five checks for the same region into a signed probe request.
Regional concurrency and per-tick work are bounded. Observations have durable
uniqueness keys so replay does not create duplicate measurements.

The coordinator job lease covers dispatch and persistence. Report publication
has its own lease so slow probes do not suppress public refreshes. Notification
delivery uses per-delivery leases and conditional acknowledgements; a provider
accepting a message before an acknowledgement is lost can still cause an
at-least-once duplicate.

## Storage and public reports

Migrations live in `packages/cloudflare/src/migrations`. Apply them in order
before deploying code that uses new tables or columns. Observation triggers
maintain daily uptime aggregates and mark affected latency hours for repair.
Raw history retention does not discard accumulated daily uptime.

Status-page snapshots and their index share a cohort generation, committed
through a conditional R2 pointer. They reuse closed UTC days for daily uptime
bars and read the current day's aggregates on each refresh. Individual monitor
reports refresh independently when requested or when a published status page
shows an incident. Each monitor has one leased Workflow, which builds a
snapshot and refreshes it four times at one-minute intervals. Its D1 pointer
selects the committed R2 snapshot. Closed latency history uses persisted hourly
value frequencies and quarter-hour summaries; recent data and rolling range
boundaries use raw observations.

## Authentication and target requests

Admin credentials use PBKDF2-SHA256; session tokens are hashed with a secret
before storage. Notification credentials use authenticated encryption with the
same configured key in the API and coordinator. Public payloads omit private
configuration and notification credentials.

Regional probes validate signatures and timestamps, apply timeouts and body
limits, and validate redirect targets. Cloudflare placement is an affinity hint.
Fetch does not expose a pinned destination IP; monitoring is intended for
public targets, not unrestricted access to private origins.

## Operations

See the [deployment runbook](../operations/deployment-runbook.md) and
[Cloudflare configurations](../../deploy/cloudflare/README.md). Capacity should
be evaluated through statement counts, rows read/written, report freshness,
queued rounds, and Worker memory/CPU metrics rather than monitor count alone.
