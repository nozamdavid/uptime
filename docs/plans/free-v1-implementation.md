# Free first version

The product implementation on `codex/product-release-plan` uses AT Protocol OAuth, dedicated D1 databases per owned workspace, and a $20 monthly operating budget. The public landing currently collects interest ahead of the free release. This document records the implemented scope and supersedes the earlier plan's authentication, budget, and initial feature choices.

## Temporary interest check

Until release, `/` and `/signup` collect interest through a single AT Protocol handle field. OAuth requests only the identity scope `atproto`. The verified callback stores one `interest_signups` row per DID with the handle, first signup timestamp, and latest signup timestamp. Repeated signup updates the handle and preserves the first signup date. It performs no AT repository writes and allocates no workspace database.

The operator page shows the total and latest 500 signups. `/api/interest/session` confirms only the signed-in user's record; the full collection is restricted to allowlisted operators. New visitors cannot create monitoring workspaces while `INTEREST_CHECK_ONLY=true`, which is the default in the hosted API and local configurations. Existing test members and operators retain product access. At release, set that variable to `false` and replace the interest form with the product signup entry point; the collected list remains available.

## Product contract

- Three saved monitors, including paused monitors. Fixed five-minute checks, up to three configured regions, HTTPS on port 443, ten-second timeouts, and verified origin ownership.
- An outage requires two failed scheduled rounds. Recovery requires one healthy round. Missing observations keep their existing unknown/coverage behavior. Repeat reminders and DNS diagnostics are unavailable.
- Twenty-four hours of detailed observations and latency; thirty days of daily uptime. One public status page. Public URLs carry a workspace identifier, and outgoing public payloads remove URL paths and query strings.
- Live public monitor reports retain the actual latest observation timestamp and show unknown after 420 seconds without a new observation, including when budget controls pause checks.
- Three notification destinations using customer-supplied Telegram or Discord credentials. Credentials are encrypted in D1 and excluded from exports. No email address is inferred from a DID.
- Notification tests allow ten attempts per workspace per UTC day and three per destination per clock hour. Login starts allow five per client address per ten-minute window and one thousand globally per UTC day. Public and private API traffic each have a twenty-thousand-request global daily ceiling.
- One owner and two additional accepted or pending seats. Invitations use the recipient DID, expire after seven days, and are accepted after that identity signs in. Owner, maintainer, and viewer permissions are checked on every request.
- Landing, login/signup, monitoring, destination settings, workspace usage, team settings, workspace switching, export, deletion, and an operator dashboard. Operator authorization is an explicit DID allowlist.

## Data and execution

`CONTROL_DB` holds identity, membership, invitations, lifecycle, a trusted database-slot inventory, budget controls, daily usage, the dispatch outbox, and encrypted OAuth state/session records. Each workspace has its own statically bound D1 database with an identity marker. Client-supplied workspace IDs require membership; client input cannot choose database bindings.

The initial deployment binds ten empty tenant databases to the API and coordinator. Registration reserves a slot atomically and becomes active only after verifying the database identity. Interrupted provisioning retries its existing reservation. Capacity exhaustion gives a waiting state. Broader shard routing remains later work.

New users are active by default after provisioning. Waiting for capacity is distinct from operator suspension. The operator can Activate a waiting workspace once a slot is available and the forecast is below the ceiling, at most $20, even while automatic admission is closed. Resume restores a suspended workspace. Local development also provides ten database slots.

The operator's slot panel shows availability and assignment, limits admissions to 1 through the smaller of ten or the registered bound pool, and holds or reopens unused slots. Lowering the limit does not evict existing workspaces. Assigned slots remain tied to their workspace and deleted slots remain quarantined. New physical databases require deployment configuration and trusted registration.

Cron records durable tenant dispatches before enqueueing. Queue consumers recheck lifecycle and budget, acquire a fenced execution lease, and use existing idempotent check keys. R2 keys are prefixed with the workspace ID. The public gateway calls the API, which checks current publication and workspace state before serving data.

Deletion blocks new private, public, and scheduled work immediately. API mutations and scheduled jobs use the same fenced execution lease. Existing operations must drain before tenant data and reports are purged; an operation already running can finish during that drain. Concurrent mutations receive a retryable busy response. Large purges resume through cron. The database slot stays quarantined, and is never automatically reused. Workspace deletion preserves the owner's AT identity record; it is not account deletion. Consumed query totals move to anonymous daily service totals, including asynchronous usage flushes arriving after deletion, so deletion cannot erase the spending forecast.

## Budget controls

Workers Paid has a $5 baseline. The configured ceiling is $20, with admission paused at a $15 service forecast to keep headroom. Scheduled work pauses at the configured ceiling. The default capacity is ten owned workspaces; increase it only after measuring actual billing.

D1 API, control-plane, and coordinator usage is measured using query metadata. Forecasts use a rolling 31-day window rather than assuming the subscription resets on the first of the month. The dashboard distinguishes estimates from the provider's bill. Enter other known costs using `PATCH /api/operator/controls`.

Workers CPU, Queues, R2 operations, unhandled traffic, other deployments, and provider billing are not a guaranteed hard cap. CPU limits, distributed request limits, Cloudflare billing alerts, and the small admission cohort bound exposure. Configure alerts and review actual account usage before publishing the service. Current allowances and rates are documented in [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Verification and release

Repository checks cover OAuth browser state, replay rejection, loopback metadata, encryption, tenant allocation, quota enforcement, access denial, viewer permissions, metering, deletion leases, report namespace isolation, and the existing monitoring behavior. Production Worker bundles must also pass Wrangler dry runs.

The local development configuration and real OAuth smoke test use the official [localhost OAuth exception](https://atproto.com/specs/oauth#localhost-client-development). The account password is entered at the authorization server only. It is never an application setting, source fixture, or request to this application's API.

Deploy using [the hosted runbook](../deployment/free-hosted.md). Before opening registration, supply the production domain and resource IDs, install secrets, register empty slots, configure the operator DID, deploy the three selected probes, enable billing alerts, and complete a production login plus an owned-target outage/recovery test.

The landing's brief privacy and acceptable-use disclosures describe actual behavior. Complete service-owner identity/contact information, reviewed customer terms, the privacy notice, support instructions, incident communication, and backup/restore drills before a public product launch. The original [release plan](product-release-plan.md) remains the broader roadmap and launch checklist. Payments, paid entitlements, paid upgrades, and checkout are absent from this version.
