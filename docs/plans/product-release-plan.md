# Uptime product release plan

Release specification for a free hosted uptime monitoring service for indie developers and small teams. Prepared on 2 October 2026 from the current repository and primary platform documentation. Branch: `codex/product-release-plan`.

**Recommendation: release one bounded free plan, with a dedicated database per customer workspace, verified signup, useful alerts, and founder controls. Admit users in measured cohorts. Introduce payments only after reliability, retention, and cost are understood.**

This document specifies the broader product contract, architecture, user journeys, operations, and launch sequence. The subsequent [free first version implementation](free-v1-implementation.md) records delivered functionality and supersedes this roadmap's authentication, budget, and initial feature choices. Remaining numerical service objectives and scheduling estimates are proposed defaults, not measured capacity or customer commitments.

The user has confirmed indie developers and small teams, a free-only first release, AT Protocol login/signup, and a maximum $20 monthly operating budget. Business identity, brand/domain, and production resource configuration still require founder inputs. The implementation record and deployment runbook take precedence over earlier proposed defaults below.

Reading guide: [free limits](#3-free-release-contract), [customer journeys](#4-customer-journeys-and-screens), [database architecture](#5-tenancy-and-database-architecture), [implementation backlog](#15-implementation-work-and-acceptance-criteria), [launch gates](#17-verification-and-release-gates), and [later paid release](#19-later-paid-release-and-expansion).

## 1. Product purpose and success

### Customer and job

The first customer runs a small website or public HTTP service and wants to know when it fails, see which regions are affected, and share a clear status page. Small teams need distinct logins and simple permissions. They should not need to operate monitoring infrastructure or bring their own email delivery account.

The initial promise is: “Monitor your public services from up to three regions, receive outage and recovery alerts, and share a status page. Start free.” Explain the five-minute check interval and alert confirmation delay beside that promise.

The useful differentiator is clear regional evidence, honest freshness, easy setup, and trustworthy isolation. Monitor count alone is a weak competitive position: [UptimeRobot](https://uptimerobot.com/pricing/) advertises a 50-monitor free plan with five-minute checks; [Better Stack](https://betterstack.com/pricing) lists 10 free monitors and heartbeats plus a status page. These are current first-party offers, not evidence that our service can afford the same limits.

### Validation before broad promotion

Interview five indie developers and five small-team operators. Ask about their latest outage, current monitoring, alert noise, public status communication, setup friction, and what they trust a free provider to do. Obtain permission before using names, quotes, or logos.

Recruit 10 design-partner workspaces for the first cohort. Observe onboarding and one controlled outage/recovery test on a target they own. Keep existing monitoring alongside this product during the beta.

Proposed product targets for a cohort of at least 30 verified workspaces:

- At least 60% activate within 24 hours. Activation means a saved monitor, a completed scheduled round, and a successfully tested alert destination.
- Median onboarding time below five minutes after verification, excluding external DNS propagation.
- At least 40% of activated workspaces retain an enabled monitor and a working destination after 30 days. Dashboard visits are a separate engagement measure; unattended monitoring can still deliver value.
- Fewer than 10% need founder assistance to complete onboarding.
- At least five users identify a specific reason they would keep this service alongside or instead of their current tool.

If these targets fail, investigate the onboarding and value proposition before increasing acquisition. They are decision thresholds for this product, not industry benchmarks.

### Acquisition and learning

Before beta, prepare a two-minute setup demonstration, an example status page, a short migration guide for existing monitor URLs, and an accurate explanation of sampled uptime and alert delay. Recruit the first cohort from the founder's developer network and communities that permit product feedback requests. The founder approves and sends outreach; this plan does not authorize messages or publication.

At beta launch, publish the free-plan page and a useful technical article about regional evidence and monitoring gaps. Use the existing status-page footer as a small attribution link, with no misleading endorsement. Attribute signups to a small set of channels using consent-appropriate first-party data. Paid ads, referral rewards, and affiliate programs wait until activation/retention and acquisition economics are known.

Review activation drop-offs weekly and interview at least two affected users. Measure signup started/completed, target verified, monitor created, first scheduled result, destination test succeeded, activated, invited member joined, status page published, workspace paused/reactivated, and deleted. Event schemas exclude target URLs, secrets, message bodies, and email addresses. Monitoring activity and account activity remain distinct so a quietly healthy service is not mistaken for churn.

## 2. What exists and what must change

### Current capabilities to retain

The active architecture uses `apps/api-worker`, `apps/coordinator-worker`, `apps/probe-worker`, `apps/web`, and `packages/cloudflare`. D1 stores configuration and observations; R2 stores public reports; Pages serves React. The coordinator uses minute scheduling, bounded batches, persisted claims, idempotent observation keys, notification retries, retention, and separate report leases.

The product already has regional HTTP checks, latency charts, observation history, optional DNS diagnostics, notification destinations, public monitor reports, grouped status pages, and daily uptime aggregation. Reuse this work where it satisfies the new contract.

### Concrete gaps

- **Identity:** `packages/cloudflare/src/migrations/0001_initial.sql` enforces a singleton administrator. `apps/api-worker/src/auth.ts` seeds one administrator; login accepts a password for that administrator. Signup, customer memberships, account recovery, and verified identities are absent.
- **Tenancy:** private routes in `apps/api-worker/src/app.ts` select all monitors or individual global IDs. API and coordinator configurations bind one `DB`. There is no workspace registry, customer database allocation, or cross-customer authorization boundary.
- **Scale:** `apps/coordinator-worker/src/coordinator.ts` clamps batches to 50 monitors and limits regional tasks to 108 per tick. One global loop cannot be treated as unlimited capacity. The current estimator counts target requests, not total platform cost.
- **Public content:** public reports and R2 pointers assume the current global dataset. Snapshot generation, caches, Workflow identities, slugs, and invalidation need workspace scope.
- **Security:** `apps/api-worker/src/http.ts` uses an in-memory limiter per isolate. `apps/api-worker/src/security.ts` rejects forbidden IP literals but does not resolve and pin DNS destinations. Those limitations become release blockers for unrestricted signup.
- **Product operations:** landing/signup, self-service team settings, founder usage admin, entitlements, customer export/delete, resource provisioning, and support workflows are missing.
- **Documentation and CI:** the README describes the PostgreSQL/Docker path as retired, while those packages and CI jobs remain in the checkout. Confirm supported paths and update documentation and CI together before contributor onboarding.

Repository evidence is inspectable in [the current architecture](../architecture/mvp.md), [deployment runbook](../operations/deployment-runbook.md), and the source paths above. External constraints and later billing details are collected in [platform research](../research/saas-platform-research.md).

## 3. Free release contract

### Plan definition

Create a versioned entitlement named `free_v1`. Enforce the same contract in the UI, API, scheduler, report publisher, and notification workers. Return the limit and current usage in a structured error when a request would exceed it.

- **Workspace:** one owned workspace per verified identity. A user can also join invited workspaces. One owner and up to two additional members, three accepted or pending seats in total.
- **Monitors:** three saved monitors, including paused monitors. Deleting a monitor releases a slot after scheduling cancellation is durable. The implemented release supports HTTPS GET on port 443, public destinations, and verified control of the monitored host. HTTP support is later work.
- **Check frequency:** fixed at 300 seconds. Select one to three configured region identities. The initial hosted configuration enables `eu-west`, `us-east`, and `asia`; region names describe intended affinity rather than guaranteed cities, countries, IPs, or independent networks.
- **Checks:** 10-second target timeout; at most three redirects, with destination validation at every hop. No response body retained. Preserve a bounded response/error summary needed for diagnosis. Reject URL credentials and secret-bearing query parameters from public output.
- **History:** detailed observations and detailed latency for 24 hours; daily uptime aggregates for 30 days. Display the coverage start date and missing periods. Retention continues while a monitor is paused.
- **Status:** one hosted public status page, containing only monitors in that workspace. Public monitor sharing is optional and disabled by default. A separate preview and publication confirmation disclose exactly what becomes public.
- **Alerts:** Telegram and Discord in the first implementation, at most three configured destinations. Send outage and recovery events; repeat reminders are off. AT Protocol identity does not supply a verified email address. Built-in email requires a separately verified recipient flow and remains later work.
- **Usage:** notification tests allow three per destination per clock hour and 10 per workspace per UTC day. Manual monitor runs remain later work; the proposed future limit is 10 per workspace per UTC day with a minimum 60-second gap for a given monitor.
- **Delivery safety:** 100 newly admitted notification deliveries per workspace per UTC day, with a rolling cap of 20 per hour. Count each email recipient and each Telegram/Discord destination as a delivery, including tests. Retries belong to the original delivery and have their own maximum of eight attempts. Suppress new excess deliveries with visible reasons, retain incident state, and reserve the last 10 daily and two hourly delivery slots for recoveries. Do not retry a stale outage after a newer recovery supersedes it.
- **Storage:** operational ceiling of 100 MB per customer database. At 80 MB alert the founder and investigate retention; at 95 MB stop optional work and new monitor creation. Any emergency check pause must appear as a monitoring gap, with a user notice. This is an internal guardrail, not a claim about measured row size.
- **Price and support:** free, no card required, no automatic conversion to a paid plan. Best-effort support with a stated response target of two business days. Publish support hours in Europe/Madrid time and distinguish them from monitoring availability.

All writes that consume scarce slots must reserve them atomically. Concurrent monitor creation and concurrent invitations must never pass a count check independently and exceed the quota. Deleted database slots are never assigned to another customer until cleanup is verified; the safest default is to create a fresh database ID and shard generation.

The current code permits different intervals, up to nine regions, larger timeouts, five redirects, and outage/recovery defaults of three/two rounds. `free_v1` explicitly overrides these at creation, update, and job execution. Carry timeout/redirect limits in signed probe jobs and reject requests exceeding the policy. Keep the schema's broader limits for the internal plan; test the free API/probe policy independently. Existing founder monitors retain their recorded settings unless deliberately migrated.

Manual runs are diagnostic samples. They consume request/cost quotas but do not advance scheduled incident confirmation or enter the scheduled uptime denominator. This prevents manual clicks from changing the meaning of five-minute monitoring.

### Scope boundaries

First release includes the landing page, verification/signup, onboarding, three-member workspace, monitoring, alerts, public status, usage/settings, founder admin, backups, export/delete, and launch operations.

Later releases cover paid plans, checkout, custom status domains, unlimited team size, Slack, generic webhooks, customer-supplied email providers, DNS diagnostics, private-network agents, authenticated target requests, API tokens, Terraform, heartbeats, TCP/ICMP, browser journeys, SMS/voice, on-call schedules, enterprise SSO, and contractual SLAs. Hide unsupported choices in v1 and reject them server-side. Existing founder features may remain in a separately bounded internal plan.

### Free account lifecycle

Free monitoring continues while the account remains within published rules. Do not pause a healthy monitor merely because nobody opens the dashboard.

After 90 days without an accepted successful alert delivery, notification test, or verified member activity, request confirmation that the workspace should remain active. Send a reminder after seven days. Pause monitoring 14 days after the first notice if nobody confirms. Label the pause, retain configuration, and provide one-click reactivation subject to available capacity. History still expires under normal retention. Undeliverable notices require founder review rather than silent deletion.

Changes to free limits require at least 30 days' notice, except immediate action for abuse or service protection. Ending the service requires a proposed 60-day notice and export window where feasible. Terms must describe these policies honestly; do not promise free service forever.

## 4. Customer journeys and screens

### Landing and public information

Serve the marketing page at `/` and move the private application to `/app`. Preserve existing public monitor/status links with tested redirects or compatibility routes. Use static or prerendered marketing HTML for search and link previews while keeping the existing React application for signed-in work.

Landing content, in reading order:

1. Product name, a clear uptime-monitoring promise, “Start free,” and “Sign in.”
2. The exact free envelope: three monitors, five-minute checks, up to three regions, three team members, and one status page.
3. An accurate screenshot or seeded demonstration showing healthy, failing, and stale data. Label demonstration data.
4. Three benefits: regional evidence, actionable alerts, and clear public communication.
5. Setup explanation: verify account, verify target, create monitor, test alert.
6. Data handling, limitations, independent service-status link, and support contact.
7. FAQ covering ownership verification, alert delay, free limits, region placement, retention, team access, deletion, and future paid plans.
8. Terms, privacy, acceptable use, security contact, documentation, and operator identity.

Create `/features`, `/free-plan`, `/docs`, `/security`, `/privacy`, `/terms`, `/acceptable-use`, `/contact`, and `/changelog` only where each has useful content. No invented testimonials, customer counts, reliability guarantees, or enterprise compliance badges. A waitlist replaces signup when capacity is closed.

Provide marketing titles/descriptions, canonical URLs, sitemap, robots policy, and accurate social previews. Private app/operator pages never index. Customer status pages default to `noindex` and may opt into indexing after publication consent. Marketing performance targets are a usable first render on a mid-range mobile device and no broken signup path; measure before launch rather than claim a score without evidence.

### Signup and authentication

Selected implementation: AT Protocol OAuth through the official portable SDK, with Worker-native WebCrypto and encrypted D1 stores. The authenticated DID is the stable identity key. Handles are display identifiers and may change. Application-owned memberships and the explicit operator DID allowlist determine access.

OAuth requires PKCE, DPoP, issuer/subject verification, single-use state, and a browser-bound callback. This application's password and email login flows are absent in hosted mode. The operator should secure the underlying AT account and may protect operator routes through a separate access gateway before public launch.

Signup flow: user supplies a handle, authorizes the identity-only OAuth scope, and receives a workspace slot if admission is open. Before public launch, finalize and record acceptance of current terms and acceptable-use versions. Marketing consent remains separate, optional, and unchecked.

If authentication succeeds while provisioning fails, preserve the identity and show a retryable setup state. Do not create duplicate workspaces. If capacity fills mid-signup, show a clear waitlist state and explain the account's status. Invite recipients join the intended workspace without automatically provisioning another database.

Allow profile/email updates through verified provider flows. Prevent unsafe account linking based solely on an unverified matching email. Test OAuth cancellation, rejected email codes, expired codes, revocation, provider outages, and deletion synchronization. Account recovery must not transfer a workspace based only on a support email.

### First use

The setup checklist has four steps: verify target, create monitor, choose alert destination, send test. Offer a seeded demo separately so users can understand the dashboard before completing verification. Offer built-in email to the creator's verified address as the initial destination; adding members never automatically subscribes them to alerts. Each member explicitly accepts alert enrollment and can manage their own recipient preference.

Accept ownership proof through an exact-host HTTPS file under `/.well-known/` or a DNS TXT record containing a single-use workspace token. Bind proof to workspace and host; expire unused challenges after 24 hours. A verified apex may cover subdomains only when DNS proof and the UI explicitly establish that scope. Arbitrary third-party targets are outside v1.

Run a bounded first check once proof is complete. Show pending until a scheduled round is received. An unavailable target is a valid monitor, with a clear failed first-check result. An unverified or unsafe target cannot become enabled.

Activation is complete after a scheduled round and successful destination test. Display next check, last observation, alert threshold/delay, and the three limits most relevant to the next action. Avoid making status-page publication necessary for activation.

### Application navigation

Include Overview, Monitors, Incidents, Status page, Notifications, and Settings. Settings contains members, usage/limits, verified targets, account security, export, and delete. Workspace switching is visible for invited members with multiple memberships.

Design empty, loading, pending, no-permission, limit-reached, stale, paused, degraded-provider, provisioning-failed, and service-unavailable states. Preserve form input across recoverable failures. Use keyboard focus, readable inline errors, and explicit success feedback. Verify desktop and mobile behavior, keyboard use, reduced motion, and screen-reader flows against the [WCAG 2.2](https://www.w3.org/TR/WCAG22/) AA target.

### Team permissions

Owner: all workspace actions, members/ownership, export, deletion, and future billing. Maintainer: monitors, destinations, incidents, and publication, with no ownership or member changes. Viewer: monitoring/history and status previews, with no secret configuration or writes.

Invitations expire after seven days and consume a pending seat. They are single-use and bound to the verified recipient identity/email. Revocation releases the seat. Removing a member revokes workspace access immediately; server authorization must not rely on an unexpired client claim. Ownership transfer requires both verified identities, recent authentication, and acceptance by the recipient. The last owner cannot leave.

## 5. Tenancy and database architecture

### Ownership boundary

Create one default workspace for each customer who creates an account. Its monitors, destinations, incidents, observations, reports, and settings belong to a dedicated physical database. Invited team members share that workspace database. This gives the requested database per customer while permitting collaboration; database ownership must survive a user's email change or owner transfer.

The central control-plane D1 holds identities, memberships, workspace state, storage routing, plan assignments, aggregate usage, audit references, and public routing. It does not hold every customer's detailed observations or plaintext destination secrets. Cross-customer analytics reads aggregate usage rather than opening every customer database on a dashboard request.

### Recommended first implementation

Use ordinary Workers with bounded shards, with **up to 25 preprovisioned workspace databases per shard**, accessed through static bindings. A trusted provisioning job creates empty databases, applies the current schema, deploys the shard's bindings, validates them, and then exposes free slots in the control-plane registry. Customers are assigned an already-ready slot atomically.

Topology for 10 design partners: one public shard with 25 slots, plus the founder's separately bounded internal shard using the existing database. Topology for 50 public workspaces: public shards with 25, 25, and five slots, plus the internal shard. That provides 50 admitted public workspaces and five reserve slots, with 56 customer/internal databases in total plus the control-plane database. Each public shard is one Worker serving trusted API, report, and background operations, with one explicit D1 binding per slot. The edge/consumer workers have explicit service bindings to these shard Workers. Include all ready-but-unused resources in the cost inventory.

The edge API authenticates the user, resolves workspace membership and state, looks up a trusted shard/slot, and calls the shard Worker through a configured service binding. The shard selects the registered database binding and creates a workspace-scoped context for the existing API, coordinator, and reporter functions. Public traffic uses a separate public-routing path and explicit publication rules.

Only server-owned routing records can select a database. Never accept a database ID, binding name, or arbitrary shard URL from a customer request. Strip any client-supplied internal context headers. Bind internal calls to audience, workspace, action, request ID, expiry, and routing generation; authenticate them through service bindings and signed context. Queue consumers re-resolve routing and workspace state before acting.

[Cloudflare documents](https://developers.cloudflare.com/d1/platform/limits/) 50,000 D1 databases per paid account, a 10 GB database ceiling, and approximately 5,000 resource bindings per Worker script. Those are platform limits, not the intended launch size. Ordinary D1 access binds a database to `env`; adding a registry does not dynamically turn an arbitrary database ID into a binding. See [D1 bindings](https://developers.cloudflare.com/d1/worker-api/d1-database/).

The selected design uses deployment automation when adding a shard, not a Worker deployment for every signup. At more than 100 workspaces, review shard routing/binding growth, deployment coordination, and fleet migrations before increasing admission. Benchmark alternative routing with Workers for Platforms or per-workspace SQLite Durable Objects only if measurements justify a change. A shared customer-data database requires an explicit change to the user's isolation requirement.

### Provisioning states and failure handling

Workspace states: `pending_verification`, `waiting_for_capacity`, `provisioning`, `active`, `suspended`, `deletion_pending`, `deleting`, `deleted`. Provisioning jobs store an idempotency key, resource IDs, schema version, attempt count, lease, stage, and last error.

Allocate a slot and workspace binding with a control-plane transaction or equivalent conditional update. Mark active only after schema and routing checks succeed. A crash after resource creation must resume using the recorded resource, not allocate another. Reconcile orphan databases and incomplete jobs daily. Capacity shortage opens the waitlist; it cannot route a customer into another customer's database.

### Data model and interfaces

Control-plane entities:

- `users`: internal ID, provider subject, verified-email reference, lifecycle timestamps.
- `workspaces` and `memberships`: stable workspace ID, one owner, role, access state/version.
- `invitations`: recipient binding, token hash, expiry, consumed/revoked state.
- `workspace_storage` and `shard_slots`: database ID, shard/slot, generation, schema version, resource state.
- `plan_versions` and `workspace_entitlements`: immutable free policy version and audited overrides with expiry.
- `dispatch_jobs` and `workspace_schedule`: due time, lease, sequence, attempts, recovery cursor.
- `usage_hourly` and `usage_daily`: bounded counters, source watermarks, freshness, and cost-model version.
- `audit_events`: actor, workspace, action, reason, result, request ID, timestamp.
- `public_routes`: namespace/slug to published resource, workspace, generation, visibility/tombstone.
- `consent_records`, `export_jobs`, `deletion_jobs`, and `service_controls`.

Customer database entities preserve the existing monitors, regional configuration, check runs, observations, aggregates, destinations, delivery history, report pointers, and job state. Add verified targets, durable incidents, maintenance windows, schedule/configuration version history for coverage reconstruction, and a workspace metadata row proving the database's assigned identity and schema generation. Authentication tables belong in the control plane/provider rather than every customer database.

Define a `WorkspaceContext` containing identity, workspace, role, trusted database handle, routing generation, entitlement version, and request metadata. Private repositories require this context. Public repositories accept a narrowly scoped published-resource context. Background jobs require a trusted workspace context and lifecycle check.

Do not add `user_id` indiscriminately to observations as a substitute for physical isolation. Use workspace IDs in envelopes, logs, usage, cache keys, and global registries. Within a dedicated database, local object relationships and the workspace metadata assertion provide the boundary.

### Cross-store consistency

D1 databases and R2 do not provide one transaction covering the whole fleet. Use durable jobs/outboxes, conditional updates, idempotency keys, and reconciliation for provisioning, publication, metering, and deletion.

For scarce monitor slots, the tenant database is authoritative. Update monitor state and its outbox in one atomic operation, then publish schedule/usage hints to the control plane. A lost hint must be repairable by reconciliation. Do not permit a control-plane counter delay to allow extra enabled monitors.

Changing suspension/deletion state prevents new work at the edge and at execution. Already leased work has a bounded drain; execution and result acceptance recheck the state/generation. A restored database gets a new routing generation so old jobs and public objects cannot become current again accidentally.

During a control-plane outage, new signup, configuration writes, private authorization, and job execution fail closed when lifecycle/access state cannot be verified. Public serving follows the same publication check described below. Record the resulting monitoring gaps and use independent incident communication. Future cached execution leases require a separate revocation-bound design; do not improvise an authorization bypass during an outage.

## 6. Scheduling and reliable monitoring

### Fair dispatch

Keep a small fixed number of minute triggers. The dispatcher selects indexed due workspace rows, publishes bounded queue jobs, and advances scheduling hints through a durable outbox. One shared queue consumer initially routes jobs to the registered shard through service bindings and awaits durable completion. Queue work runs the existing bounded tenant coordinator against the correct database. Round-robin due-work selection, one active coordinator lease per workspace, and explicit per-shard concurrency limits provide fairness; a queue alone does not provide it.

Assign each workspace a stable minute phase modulo five and each monitor a stable offset. Spread onboarding's first checks across a bounded immediate queue. Reserve capacity for recovery/notifications and maintenance so probe work cannot starve them. Use per-shard and per-region concurrency limits plus a platform-wide emergency control.

Every job includes workspace ID, scheduled window, work kind, routing generation, and idempotency key. Every persisted result keeps the existing durable `(monitor, region, scheduled_window)` uniqueness. [Cloudflare Queues delivers at least once](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), so retries and duplicate delivery are expected.

Use conditional tenant leases, with a renewal policy for long work. A worker that loses the lease cannot acknowledge a newer worker's result. Queue acknowledgment follows durable completion. Dead-letter messages remain visible with a replay tool that uses the same idempotency keys.

Skip missed historical check windows after a platform interruption rather than sending a burst to every target. Record missing coverage and resume at the next current window. A scheduled interval is an intended cadence; cron and queue timing can add delay. Do not advertise exact wall-clock execution.

### Availability semantics

Define target failure separately from missing platform evidence. Current `classifyRound` treats any received regional failure as a failing round, all expected successes as healthy, and other incomplete rounds as unknown. Preserve that conservative behavior in v1 and show regional disagreement explicitly.

Default outage confirmation: two consecutive failing rounds. Default recovery: one fully healthy round. At a five-minute interval, a persistent outage usually takes **five to ten minutes plus probe and queue delay** to confirm. A regional failure can trigger an outage even when other regions succeed. State this in setup/docs and show the first-failure and confirmed-at times separately.

An unknown round resets confirmation streaks and cannot confirm recovery. No observations, partial platform delivery, or a stale report cannot produce a green healthy indicator. Label unknown/degraded monitoring separately from target down.

Uptime is the ratio of successful received observations to received observations, with coverage displayed alongside it. Missing platform checks are excluded from that ratio and mark the period incomplete; they are neither invented successes nor target downtime. A period with zero observations shows unavailable, not 100%. Persist expected scheduled opportunities and explicit gaps so coverage is independently calculable even when no round was inserted. Configuration changes, pause/resume, and maintenance alter the expected schedule prospectively and remain reconstructable.

This is sampled availability, not proof of continuous uptime. Show regional uptime and coverage so one region's missing data is visible. Planned maintenance is displayed separately and excluded from the advertised uptime denominator only for explicitly recorded windows; exports include the rule, received/success counts, expected counts, and missing coverage. The private UI, public payload, exports, and founder metrics use the same definition.

Persist incident start, confirmation, affected regions, ongoing updates, recovery, and alert outcomes. Link observations to incidents and provide a chronological incident view. Add a maintenance window with start/end, timezone display, UTC storage, and notification suppression. A manual pause is a distinct state with no fictional successful checks.

### Proposed internal service objectives

During a 14-day beta observation window, measure:

- At least 99.5% of expected scheduled regional checks produce a completed observation or an explicit classified platform failure. Also report successful platform execution separately so failure records cannot make the objective appear healthy.
- Scheduled start lag p95 below 60 seconds and p99 below 120 seconds, relative to the intended window; no workspace starved across two consecutive windows.
- Public report freshness p95 below 120 seconds after a new result. Display stale after 10 minutes without usable evidence, or immediately if the publisher declares failure.
- Notification provider acceptance p95 below 60 seconds after incident confirmation, excluding a provider's documented outage/rate-limit period. Track exclusions separately.
- Private API p95 below 500 ms for normal reads excluding authentication redirects, on the representative staging workload.

These are internal launch gates. The free release has no contractual uptime SLA. Measure delivery acceptance separately from inbox placement or the user reading the message.

## 7. Reports, public status, and retention

### Publication contract

Use a workspace-qualified namespace and stable page slug, for example `/s/<workspace-slug>/<page-slug>`, with explicit global uniqueness rules in the routing registry. Retain compatibility for the founder's existing URLs. Reserve system names and tombstone deleted public routes for 90 days to prevent immediate impersonation through reuse. Freeze the public workspace namespace after first publication in v1; editable display names remain separate.

R2 object keys, cache keys, generation pointers, publication leases, report indexes, and Workflow IDs all include workspace and resource identity. A workspace publication reads only that workspace's database. A public route never provides a general database/object lookup.

Selected routing: the gateway resolves a public registry record to the workspace/shard, then calls that shard's reporter through a service binding when a refresh is needed. Each shard publishes immutable snapshots and one conditional current-generation pointer per workspace. Use `public/<workspace-id>/...` object prefixes; remove the shared global `public/cohort.json` from customer publication paths. One workspace's failed publication retains only its own prior generation and cannot replace another workspace's manifest. Workflow classes remain in ordinary Workers with workspace-qualified instance IDs.

Public payloads use explicit allowlists: display name, published label, regional status, sampled uptime, safe latency summary, incident updates, and freshness. Hide full target URLs by default, including query strings, response headers, redirects, diagnostic evidence, notification details, and private history. Provide a preview that matches the final public payload.

Publishing a monitor inside a status page makes those selected public fields visible even if its individual monitor page is disabled. Explain that relationship before publication. Unpublishing or removing a monitor must remove it from new snapshots and invalidate relevant caches. Revocation of an existing page completes within 60 seconds; publicly shared content may already have been copied by others.

For v1 the gateway checks publication visibility/generation against the control-plane D1 primary on every public JSON request, before reading any internal snapshot cache. Return public snapshot JSON with `Cache-Control: no-store`; cache immutable snapshot bodies only inside the gateway behind that check. Public static assets can use the CDN. Serve no bucket URLs or raw object-key routes, and do not let a cached final response bypass the gateway. If publication state cannot be verified, return unavailable. This trades some reads for a simple revocation guarantee; measure public traffic and rate-limit it.

Keep R2 buckets private behind the gateway. Prevent direct access to historical objects after revocation, including conditional requests and previous generations. Separate snapshot publication time from the last completed target observation; generating a new report must not make old monitoring evidence appear fresh.

### Retention changes required

The current implementation ties latency history to detailed-result retention. The free UI must promise 24-hour latency detail and 30-day daily uptime only; free routes/API explicitly disable seven-day and 30-day latency requests instead of returning misleading partial graphs. Remove their boundary-hour raw-history assumptions from the free report path. Preserve those paths only for internal plans with sufficient retention and their own tested rules.

Bound deletion work for observations, check runs, latency frequencies, diagnostics, report generations, delivery payloads, and orphaned objects. Add bounded daily-aggregate deletion, which is absent from the current long-term aggregate policy: free rows expire when their UTC day ends more than 30 days before cleanup time. Detailed rows older than 24 hours expire in bounded passes; cleanup completes within one additional hour under normal load. UI filtering applies the published window even before physical cleanup finishes. Internal founder history follows a separate explicit retention version.

Retain account configuration until deletion and operational/security audit records for 90 days by default. Separate backups from customer-visible retention and disclose their expiry.

DNS diagnostics are disabled for new free workspaces. If retained for the founder's internal plan, their own retention and resource ceiling must be explicit. Validate that deleting detailed rows does not subtract historical daily aggregates or leak retained secret-bearing metadata into public reports.

## 8. Abuse protection and security

### Destination safety is a launch gate

Signup exposes a remote-request service. The present literal-IP and redirect checks are useful, but they do not establish safe handling of DNS rebinding or DNS names that resolve to private/reserved networks. Domain verification also does not establish a safe destination IP.

Follow the [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html): constrain schemes/ports, validate all resolved A/AAAA addresses, handle unusual IP forms and IPv6, reject private/reserved/link-local/metadata destinations, and revalidate redirects. Test DNS changes between validation and connection.

Because Workers `fetch` does not expose a destination-IP pinning primitive in the existing implementation, M0 must establish a supported safe egress mechanism. Prove platform restrictions and residual exposure with a focused threat review. If that cannot meet the gate, use a controlled probe/egress service that enforces resolved destination policy, or restrict beta to an explicitly reviewed host allowlist until that service is ready. Unrestricted target signup remains closed. Do not label a preflight DNS query as complete rebinding protection.

Apply the same policy to ownership HTTP challenges and every configurable outbound integration. For v1 Telegram and Discord use provider endpoint allowlists and validated credentials; disable generic webhook, Gotify, Home Assistant, SMTP, and Bluesky configuration for customer workspaces until separately reviewed.

### Admission and request controls

Require verified identity and an anti-bot challenge before provisioning. Enforce distributed limits, not isolate-local Maps. Proposed baseline limits: five signup starts per IP per hour, five verification sends per identity per hour, 10 invite sends per workspace per day, 60 ordinary writes per workspace per minute, and five concurrent expensive reads per workspace. Give existing verified users recoverable errors; do not use IP identity alone to ban shared-office users.

Limit each target host across all workspaces to one new request per second with a burst of five, including redirects and manual checks. If throttled, record a platform scheduling delay rather than target downtime. Probes identify the service with a documented User-Agent and an abuse contact. Follow provider acceptable-use rules and publish a process for destination owners to request exclusion.

Manual runs, notification tests, report refreshes, signup, invites, public reads, and domain challenges require their own limits. Public report reads should normally hit cached snapshots. Coalesce refresh jobs per resource and cap concurrent/queued jobs; a popular or maliciously requested status page cannot start unlimited Workflows.

### Identity, application, and secret controls

Verify server-side token issuer, audience, expiry, authorized origins, and workspace membership on every private request. Mutations require appropriate role and CSRF/origin protection for the chosen cookie or bearer-token design. Do not rely on hidden UI controls. Session revocation and member removal must be tested across open browser tabs.

Founder access uses a separate explicit allowlist/role and MFA at an access gateway or supported identity plan. No first-user-becomes-admin behavior. Store a recovery credential offline and test a break-glass procedure. Audit privileged reads and writes.

Use parameterized SQL, output escaping, a tested Content Security Policy, secure cookies where applicable, restricted CORS, dependency scanning, and secret scanning. Minimize collected response metadata. Never log authorization headers, email codes, URL secrets, provider tokens, or full notification payloads by default.

Extend credential encryption with key versioning and a tested rotation/re-encryption process. Bind encryption context to workspace and destination so copied ciphertext cannot be reused in another workspace. Probe signatures bind workspace, run, regions, expiry, and payload; prevent replay beyond an idempotent retry of the same run. Privileged provisioning API tokens are isolated from normal API/probe code and scoped to the needed account operations.

Before launch, conduct a focused independent review of tenancy, public publication, egress, auth, provisioning privileges, and deletion. Resolve all critical/high findings; record rationale and mitigation for lower findings.

## 9. Founder admin and usage accounting

### Founder application

Serve `/operator` through founder authentication and MFA, with independent server authorization. The homepage shows admitted/active/waitlisted workspaces, checks scheduled/completed/missing, dispatch lag, delivery failures, public freshness, cost forecast, storage, shard capacity, failed jobs, and security/abuse signals.

Workspace detail shows identity and membership metadata, plan version, monitor/region counts, target-check volume, D1 rows read/written, database bytes, R2/queue/Workflow usage attribution, last activity, operational state, report/alert health, provisioning/migration version, and daily/monthly cost estimate. Provide search, sorting, CSV usage export, cohort filters, and a visible data-freshness timestamp.

Actions: suspend/resume with reason, disable a specific target, retry provisioning/export/delete, replay a failed job safely, issue an expiring entitlement exception, reconcile usage, and close/reopen admission. Suspension must preserve existing data until retention/deletion says otherwise. All actions record actor, reason, scope, and result.

Support access is a time-limited, user-consented view, audited with a visible support banner. No silent impersonation, secret reveal, or arbitrary database query box in the launch admin. Emergency access follows the documented break-glass procedure. Financial/revenue views arrive with the paid release; free v1 shows acquisition and cost.

### Metering contract

Measure scheduled rounds, actual regional attempts, retries, redirects, manual checks, observations persisted, raw retention bytes, D1 reads/writes, notification events/deliveries/attempts, R2 operations/storage, public traffic, queue operations, and Workflow steps/CPU where available.

Use durable job/result identifiers and per-job watermarks for reconciliation. Distinguish actual work from unique customer-visible results: a retried request can consume cost even if its observation is deduplicated. Write aggregated usage batches, not an additional high-volume billable SQL row for every sample solely to track billing.

Measure database bytes from [D1 query metadata](https://developers.cloudflare.com/d1/worker-api/return-object/) (`size_after`) and periodic Cloudflare database metadata/analytics, verified in M0. Collect at least hourly and after provisioning/retention/export operations; display measurement time. Missing or stale measurements alert the founder and block cohort expansion, rather than trigger an automatic destructive pause based on an old number. Confirm a storage-ceiling action against a fresh measurement. Provisioning-service credentials perform account-level collection, not customer-facing API code.

Detailed customer work is recorded locally; aggregate hourly usage reaches the control plane through an idempotent outbox. Founder metrics may lag by up to 15 minutes and show that timestamp. A daily reconciliation compares source totals and Cloudflare account-level invoices/metrics. Shared costs are allocated by a documented rule and labeled estimates, not exact per-user invoices.

Display both incremental cost beyond provider allowances and fully allocated cost including platform baseline, auth, email, monitoring, and backups. Version rates and allocation assumptions. Usage accounting is operational in v1 and can support later paid entitlements; it is not a revenue forecast.

## 10. Capacity and the free-service budget

### Request volume model

For a fully used free workspace:

`3 monitors × 3 regions × (86,400 seconds / 300 seconds) = 2,592 target checks/day`

That is **77,760 target checks per 30-day month** and **2,592 raw observations retained at a time** for a 24-hour raw window, before retries/manual work. It also creates 864 monitor rounds per day. These are target requests, not Worker invocation counts or D1 row-write counts.

| Fully used workspaces | Checks per 30 days | Average regional checks per minute |
| --- | --- | --- |
| 10 | 777,600 | 18 |
| 50 | 3,888,000 | 90 |
| 100 | 7,776,000 | 180 |
| 1,000 | 77,760,000 | 1,800 |

The current single coordinator's 108-regional-task budget is already below the average for 100 fully used workspaces. Even 50 leaves little room for bursts/retries if they share that loop. Implement workspace fan-out and phase spreading before the 50-workspace cohort.

### Cost model and experiment

Costs include Worker requests/CPU, D1 rows and index/trigger amplification, storage, R2 reads/writes, queues/retries, Workflows, auth, email, backups, independent monitoring, and operational tooling. Probe batching changes Worker requests; it does not reduce actual target requests. Retention cleanup itself consumes work.

**Launch baseline: the existing Workers Paid plan, starting at $5/month, with a goal of fitting the initial cohort into included allowances and using free service tiers where they meet the requirements.** The [Workers plan](https://developers.cloudflare.com/workers/platform/pricing/) includes 10 million inbound requests and 30 million CPU milliseconds monthly. [D1](https://developers.cloudflare.com/d1/platform/pricing/) includes 25 billion rows read, 50 million rows written monthly, and 5 GB aggregate storage. The 50,000-database account limit permits the proposed topology without a per-database subscription charge; usage/storage allowances apply across the account, not separately to each database. These generous allowances make a small free launch plausible without a $100/month operating assumption.

[D1's paid pricing](https://developers.cloudflare.com/d1/platform/pricing/) currently includes 50 million row writes monthly, then $1 per additional million. Index maintenance contributes writes. Illustrative sensitivity: at 50 full workspaces, an assumed 10 billable writes per target check gives 38.88 million writes; at 20 it gives 77.76 million, before other work. These assumptions are examples to test, not measurements. The same monitor count can therefore have very different cost.

Benchmark the actual migrations, triggers, inserts, report reads, cleanup, and retries. Run 10 real staging databases, then 50; simulate 1,000-workspace routing and bursts without provisioning unnecessary production resources. Test maximum-timeout targets, incident storms, public refresh pressure, interrupted migrations, and 2× intended traffic. Measure 24-hour cost and a 30-day forecast after retention reaches steady state.

No $100/month requirement is assumed. The $5 base is a provider subscription baseline, not a guarantee of the entire product's bill. Record incremental overages and any separately selected auth/email/monitoring service charges explicitly; do not purchase paid add-ons by default. If the founder already pays for Workers Paid, the launch's additional subscription baseline is $0, with incremental usage still measured against account-wide allowances.

Admission gate: forecast the next cohort's account-wide usage from measured amplification, other existing workloads, and a 2× retry/load allowance. Prefer fitting within included allowances. If a meter exceeds its allowance, calculate the actual incremental charge and compare it with an explicitly configured founder spending ceiling; a small overage does not imply a large new budget. Record that decision before expanding. Do not silently slow existing checks or shorten published retention to fit a bill.

Alert the founder when forecast usage reaches 80% of an included allowance, showing its overage rate and estimated charge. Crossing an included allowance is a billing event, not automatically an outage or admission stop. Close new admission only when measured capacity is unsafe or the projected bill would exceed the configured spending ceiling. Provider spend alerts are not hard spending caps. Preserve core monitoring where possible, and show any emergency pause explicitly. Set an optional-work kill switch for manual runs, expensive refreshes, and diagnostics before resorting to core check suspension.

### Capacity admission

Proposed initial active-workspace ceiling: 10 for design partners, then 50 for public beta. Expansion to 100 requires a new 14-day reliability/cost review and more ready shards. “Public beta” means the landing page is public and admissions are bounded; it does not mean an unlimited signup promise.

Keep five ready reserve slots once serving 50 public workspaces, using the three-public-shard topology above, and count their storage/tooling cost. Maintain an admission queue, available-slot count, and emergency freeze. Limit exceptions through expiring founder grants with independent hard ceilings. The founder's migrated internal workspace is additional to the public admission count and included in total platform capacity and cost even if its feature limits differ. Free customer access will still require a paid provider account: Cloudflare's free D1 account limit is 10 databases, including the control plane.

## 11. Privacy, terms, and business readiness

Free software still handles personal information and customer configuration. Before launch identify the operator/legal entity and applicable jurisdictions. Do not infer the business jurisdiction solely from the founder's timezone.

Publish a privacy notice describing account identities, URLs/hostnames, retained metadata, notifications, logs, analytics, purposes/legal bases, retention, subprocessors, transfers, user rights, contact, and deletion. Publish terms and acceptable use covering free limits, permitted targets, account suspension, public publication, third-party providers, support, termination, and service limitations. For team/business customers, assess processor roles and provide an appropriate DPA where required.

The [European Commission's GDPR guidance](https://commission.europa.eu/law/law-topic/data-protection/legal-framework-eu-data-protection_en) is a starting source if EU rules apply. A database location flag alone does not establish compliance. Verify auth, email, logs, backups, support access, and probe transfers before making any residency promise.

Collect only necessary analytics. Use aggregate first-party events by default, with no advertising pixels or session recording. Obtain any jurisdiction-required consent before optional tracking. Transactional alerts and account-security messages are separate from marketing subscriptions; marketing unsubscribe must not disable critical alerts.

Document incident/privacy-breach assessment and notification responsibilities with qualified jurisdiction-specific advice. Do not invent universal legal deadlines or copy another company's terms. Paid tax, refunds, consumer purchase rights, invoicing, and merchant-of-record decisions belong to the later commercial release.

## 12. Export and deletion

Owner export produces a downloadable archive containing monitors/configuration, region settings, incidents, available observations and aggregates, status-page configuration, members, and safe notification configuration. Include schema version, timestamps, UTC units, coverage/retention rules, and a manifest. Credentials are excluded by default; never email an archive or token-bearing link to an unverified recipient.

Export runs asynchronously with a bounded resource budget. Require recent authentication, one active job per workspace, and at most one export per UTC day. Store the private archive for 24 hours and use an authenticated download or a short-lived signed URL. Show completion/failure and retry safely.

Workspace deletion requires owner authorization, recent authentication, and typed workspace confirmation. Unpublish public routes, stop new checks/deliveries, revoke memberships/access, drain or invalidate jobs, delete the database and private/public R2 objects, remove identity references and vendor data as applicable, and write a minimal non-content deletion receipt. Complete active-system deletion within seven days.

Account deletion is distinct from workspace deletion. An owner must transfer or delete owned workspaces first; an invited member can leave/delete their identity without deleting other people's monitoring. Explain these consequences in the UI.

Backups expire within a proposed maximum of 30 days. Preserve deletion tombstones outside ordinary restores and reapply them during recovery so deleted users/public pages do not reappear. Any legally necessary record retention must be documented with purpose and expiry. Never reassign a deleted customer's original database to a different customer.

## 13. Reliability, support, and disaster recovery

### Observability and alerting

Log structured events with request/job/workspace IDs and redacted fields. Collect API errors/latency, dispatch lag, regional success/unknown rates, missing rounds, lease recovery, delivery backlog/dead letters, publication age, D1 overload/storage, migration drift, export/delete failures, and cost forecast.

An external service on a different failure path checks signup/API, a synthetic monitored target, public reports, and at least one end-to-end alert destination. Keep the product's own incident-status page on independently hosted infrastructure and document how to update it if Cloudflare/auth is unavailable. All regional probes currently share Cloudflare, so do not claim independent provider coverage.

Alerts go to the founder and a configured backup contact when available. Proposed severity: tenant data exposure or widespread monitoring failure is urgent; one shard stuck or alert delivery backlog over five minutes is high; one recoverable customer provisioning failure is routine. Define escalation contacts and publish only support commitments the founder can meet.

### Backups and restore

Use D1 point-in-time recovery where supported, plus daily encrypted/exported configuration backups and a catalog inventory of every customer database, schema, routing generation, and R2 dependency. Current [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) list 30-day Time Travel on Workers Paid; verify actual account configuration before depending on it.

Proposed recovery objectives: configuration RPO at most 24 hours; one workspace restoration RTO at most four hours; control-plane recovery RTO at most four hours. Observation recovery is best effort, and gaps remain visible. Restore a tenant into a fresh isolated resource, verify it, then atomically switch routing generation. Do not overwrite other workspaces or reactivate deleted data.

Before launch demonstrate a tenant restore, control-plane restore, lost encryption-key recovery, corrupted publication pointer recovery, and expired lease recovery. Keep the runbook and encrypted recovery material accessible during an auth or vendor outage. Repeat a restore drill monthly during beta and after material storage changes.

Logical customer isolation remains an application trust boundary even with separate databases: a compromised shard Worker can access its bound slots. Restrict provisioning/operator privileges, cap slots per shard, and document this residual risk. If a later customer requires infrastructure credentials or process isolation per tenant, that is a separate isolation architecture and commercial commitment.

### Support operations

Provide a support form/email with account/workspace reference and optional diagnostics, plus a separate abuse/security contact. Do not ask for passwords or tokens. Track issues in a queue, tag recurring failure reasons, and keep a small public troubleshooting library.

Prepare runbooks for false-positive investigation, missing checks, failed email/Telegram/Discord, target exclusion, authentication outage, stuck provisioning, D1 overload, full shard, storage ceiling, budget threshold, export/delete failure, key rotation, and emergency suspension. Each runbook names detection, first safe action, customer communication, recovery, and verification.

## 14. Migration of the existing installation

Inventory actual production/staging resources and deployed versions first. Checked-in production placeholders do not prove what is deployed. Export configuration and record observation counts, public routes, secrets/key versions, and schema version before changing anything.

Create a founder identity and internal workspace in the control plane, then register the existing D1 database as that workspace's dedicated database. Preserve monitor/object IDs, destination ciphertext, history, incident state, and existing public URLs. Do not copy large history unnecessarily or let signup allocate the founder database.

Implement additive schema changes and adapters, validate routing against a staging copy, and run new code in shadow/read mode. Ensure only one scheduler generation can dispatch production checks. Cut over API routing and background ownership with explicit leases/generation; verify observation cadence, public reports, and intended alert delivery.

Keep a compatible previous Worker build and routing switch for rollback. Database migration rollback requires backups/forward repair, not an assumption that old code tolerates new constraints. Use expand/backfill/enforce/remove sequencing, compatibility ranges, batched migrations, and a per-workspace migration ledger.

Canary each fleet migration on staging, then founder, then two beta workspaces, then batches of five. Pause on errors, reconcile drift, and preserve customer service on older supported schemas. A partial fleet migration is an expected operational state with an admin view.

## 15. Implementation work and acceptance criteria

Use the following epics as the initial backlog. Each needs a focused design/issue before implementation, with the acceptance tests here carried into that issue. Product owner and operator are the founder. Engineering owns implementation/test evidence; design/security/legal specialists are named where their review is required.

### E0 Product and technical feasibility

Deliver the final free policy, brand/domain decision, architecture record, threat model, cost benchmark, SDK/provider proof, and production resource inventory. Benchmark 10 then 50 tenant databases and selected shard routing; prove safe egress or record the constrained beta host allowlist.

Acceptance: per-workspace physical isolation demonstrated; no arbitrary dynamic `env.DB` assumption; full measured cost forecast; timeout/burst workload meets capacity objective; auth/operator MFA/recovery path works; destination safety passes review. Owner: engineering, with founder product/security decisions.

### E1 Control plane and dedicated databases

Add proposed `packages/control-plane`, `packages/tenancy`, and trusted provisioning tooling; adapt `packages/cloudflare` into tenant-scoped repositories. Add schema ledger, routing generation, ready-slot inventory, idempotent allocation, reconciliation, suspension, and fleet migration.

Acceptance: concurrent signup allocates one correct database each; crashes after every provisioning stage resume; an exhausted shard creates a waitlist state; foreign object IDs, spoofed workspace/shard headers, stale generations, and orphan jobs cannot select another database. Existing founder data migrates without change in identity/history.

### E2 Authentication and collaboration

Replace customer singleton login in `apps/api-worker` and `apps/web`; implement email/GitHub signup, verification, term acceptance, session/recovery flows, own/joined workspaces, invites, roles, removal, and ownership transfer. Retire customer bootstrap secrets after migration while retaining a documented emergency operator route.

Acceptance: unverified user cannot provision/run checks; all role combinations tested against every write/read category; member removal takes immediate effect; pending invites enforce three-seat cap; invite expiry/revocation and account linking are safe; no customer gains founder permission.

### E3 Entitlements and fair background work

Create a free-policy service in contracts/API, atomic resource reservations, queue dispatcher/consumer, workspace phases, trusted envelopes, leases/idempotency, retry/dead-letter tools, and per-region/shard concurrency budgets. Split maintenance, notifications, and reports into bounded jobs where needed.

Acceptance: direct API and concurrent requests cannot create a fourth monitor or fourth seat; five-minute schedule holds under 2× cohort load; duplicated/out-of-order jobs produce one result/incident transition; suspended/deleting workspaces cannot dispatch; one slow tenant cannot starve another; a backlog resumes without historical request storms.

### E4 Monitoring and alerts as a customer product

Build verified-target management, safe target configuration, built-in email, Telegram/Discord, destination tests, durable incident timeline, maintenance windows, and explicit unknown/stale/paused states. Configure email DNS authentication and bounce/complaint handling with the chosen provider.

Acceptance: controlled outage/recovery yields the defined incident and messages; free defaults override legacy three/two confirmation settings; 10-second timeout and three-redirect policy are enforced by API and probe; regional disagreement/unknown behavior matches specification; delivery duplicates/rate limits/supersession are visible; caps cannot silently appear as successful alerts; a verified and enrolled member receives email without supplying provider credentials; unsafe destinations and all unsafe redirect variants fail.

### E5 Marketing and onboarding

Build public marketing routes, free-plan explanation, docs/legal/contact, metadata/link previews, app route migration, first-use checklist, demo, account/settings/usage states, and responsive/accessibility behavior.

Acceptance: signup through first scheduled check and tested alert succeeds on desktop/mobile; a capacity-full user sees a working waitlist; five design partners complete usability testing; core keyboard/screen-reader journeys pass; old private/public links behave as documented; all marketing claims match enforced limits.

### E6 Public status and retention

Scope publisher, reporter, storage, gateway, public routes, caches, pointers, and Workflow identifiers to workspace. Add publication preview/revocation, safe payload allowlists, 24-hour detailed and 30-day aggregate retention, historical-object cleanup, and freshness UX.

Acceptance: same local resource ID/slug across customers cannot collide; private fields do not appear in any public generation; unpublish/delete revokes serving within 60 seconds; cache/Workflow replay cannot revive content; daily history remains accurate when raw data expires; 30-day UI does not claim retained latency detail.

### E7 Usage, founder admin, and operational controls

Instrument the current `query-metrics` and job metrics, add durable aggregated usage/outboxes/reconciliation, operator dashboard, cost-model version, admission/budget switches, failed-job tooling, expiring overrides, and audited privileged actions.

Acceptance: counters distinguish attempts from unique observations; a crash between measurement and export does not double count/lose quota enforcement; dashboard freshness is visible; cost forecast reconciles with provider metrics; unauthorized operator requests fail; action audit survives retries; close-admission and suspend controls work under load.

### E8 Customer data lifecycle and operations

Build asynchronous export/delete, secure archives, vendor identity cleanup, backup/restore, tombstones, independent monitoring/status, security review, support queue/runbooks, production secrets, resource manifest, CI fixes, and migration drills.

Acceptance: export can be read and matches live objects; deleting one customer leaves another intact; account deletion correctly handles shared workspaces; restore cannot revive deleted publications/accounts; encrypted secrets remain recoverable; independent canary alerts when the product's own monitor path fails; critical/high security findings are resolved.

## 16. Delivery milestones and schedule

Planning estimate for one experienced engineer with founder decisions and occasional specialist review: **12 to 18 engineering weeks**, then allow **at least 14 days with design partners and 30 days at the 50-workspace public-beta cohort before general release**. That is at least 44 calendar days of observation across the two cohorts, with defect work potentially overlapping it. This is an estimate with explicit uncertainty around safe egress, shard provisioning, and current-code adaptation. Add two to four engineering weeks if a separate controlled egress service is required. Calendar dates are assigned after M0; no launch date is promised now.

1. **M0, one to two weeks:** E0 feasibility, production inventory, cost model, identity and egress decisions. Exit only with a viable architecture and budget envelope.
2. **M1, three to four weeks:** E1/E2 foundations and founder migration rehearsal. Exit with two isolated customers, safe auth, memberships, provisioning, and rollback evidence.
3. **M2, three to four weeks:** E3/E4 customer monitoring, quotas, fan-out, alerts, incidents, and target ownership. Exit with the complete activation journey and failure tests.
4. **M3, two to three weeks:** E5/E6 marketing, customer shell, public reports, retention. Exit with usable mobile/desktop product and publication isolation tests.
5. **M4, three to five weeks:** E7/E8 admin, lifecycle, restore/security/load drills, legal/support readiness, and beta fixes. Exit with every release gate evidenced.
6. **M5, at least 44 days of observation across cohorts:** 14 days with 10 design partners, then at least 30 days at the 50-workspace public beta after gates. Expand only after the measured review described below.

The engineering ranges total 12 to 18 weeks; cohort observation is additional, with some defect work overlapping observation. Teams may parallelize UI, legal, docs, and monitoring/admin once the interfaces are stable. Tenancy, destination safety, and quotas are dependencies for public signup.

Priority: a functioning isolated customer journey first, then safe scale and operations, then acquisition. A polished landing page can be prepared in parallel, but opening registration depends on the core gates.

## 17. Verification and release gates

### Test matrix

Extend the repository's required formatting, type, unit/integration, build, and Worker deployment dry-run checks. Update CI to exercise the supported Cloudflare path, generated configuration checks, staging gateway, tenant migrations, and browser end-to-end tests. Remove obsolete runtime checks only after confirming they cover no supported deployment.

Required scenario groups:

- Two workspaces with colliding local object IDs/slugs; every private/public API, export, report, cache, job, destination, and admin boundary.
- Signup/invite verification, expiration, replay, provider outage, ownership transfer, revoked sessions, role changes, and CSRF/origin attacks.
- All quotas, concurrency races, manual/test limits, target-host limit, and a signed queue envelope from a stale/deleted workspace.
- Scheduled timeout/partial/unknown/regional failure, maintenance, lost claims, duplicates, missing windows, false recovery prevention, delivery retries and caps.
- Failed provisioning at every stage, exhausted slots, partial migrations, schema compatibility, orphan resources, and generation cutover.
- Public publication/private-field allowlists, direct object access, cache poisoning, unpublication, tombstones, and stale snapshots.
- Retention boundaries, aggregate preservation, export contents, deletion scopes, vendor cleanup, tenant/control restore, and deletion tombstones after restore.
- Egress: IPv4/IPv6 literals, alternate encodings, mixed DNS answers, private/rebinding names, forbidden ports/schemes, redirect chains, oversized responses, and destination changes.
- Mobile/keyboard/screen-reader onboarding; controlled live email/Telegram/Discord delivery to designated test accounts; no messages to arbitrary recipients.
- Load at 2× admitted capacity, incident storm, public traffic spike, slow D1, stopped region, control-plane outage, and budget/admission switch.

Use local/unit tests for pure contracts, real Workers/D1 staging integration for platform behavior, and browser tests for critical journeys. Simulated SQL alone cannot prove production bindings, platform limits, or egress behavior.

### Public beta gate

All of the following must have evidence linked in a release checklist:

1. Free contract implemented consistently and documented; target controls, role boundaries, and physical isolation tested.
2. 10-partner activation and controlled outage/recovery journey succeeds; no unresolved critical/high security or correctness defect.
3. Cost/admission model fits the chosen budget with the defined allowance; fleet inventory and operator dashboard are accurate.
4. 14-day reliability objectives met or a narrower cohort remains closed while failures are repaired.
5. Tenant/control-plane restore, founder migration rollback, account/workspace deletion, and export demonstrated.
6. Legal identity, privacy/terms/acceptable use, security/abuse contacts, support coverage, independent status, and transactional email configured.
7. Signup close/open controls, fail-safe routing, dead letters, secrets recovery, and owner emergency access tested.
8. Production release manifest, known limitations, and rollback procedure reviewed by the founder.

A free general release follows public beta only after 30 days at the 50-workspace cohort, acceptable retention/activation results, no unresolved high-risk incidents, and confirmed operating budget. It can retain a signup cap and waitlist. “General release” describes a supported customer product, not unlimited resources.

### Launch runbook

Freeze schema/entitlement changes, capture backups, run required checks, apply canary migrations, deploy compatible Worker versions, validate bindings/secrets, deploy marketing/app/gateway, and smoke-test two customer identities plus founder access. Keep admission closed until these checks pass.

Open to the planned cohort, watch missing checks/deliveries/public freshness/cost, and run a controlled incident. Announce only the available free contract and beta limitations. Stop admission for any isolation concern, sustained scheduler breach, or budget gate failure; roll back the affected application generation and communicate visible monitoring gaps.

Review at 24 hours, seven days, 14 days, and 30 days. Record activation, monitoring reliability, alert failure/false-positive reports, support load, cost per active workspace, and the next admission decision. Interview users who fail activation or disable all monitors.

## 18. Decisions and experiments with deadlines

### Defaults that can drive implementation

Audience, free-only access, AT Protocol OAuth, and the $20 operating ceiling are confirmed. The implemented first cohort uses ten bound database slots, application-owned memberships, and Telegram/Discord alerts. The 25-slot shard design, email delivery, 50-workspace expansion, and service objectives in this roadmap require later measured release gates. The implementation record is the authority for current behavior.

### Facts the founder must supply before production launch

- **Brand/domain and operator identity:** founder owns, due before M3 content completion. Use “Uptime” as a development label; verify domain/trademark availability before publishing a brand.
- **Budget and vendor access:** founder owns, due before M0 resource experiments beyond local staging. Start with existing Workers Paid allowances and free service tiers; configure the maximum acceptable incremental bill and authorize any separately priced resources through the normal deployment process. No $100/month commitment is assumed.
- **Business/data jurisdictions:** founder with legal advice, due before M4. Determine applicable privacy/terms obligations and whether any residency commitments are intended. Default to no advertised residency promise.
- **Support and emergency contacts:** founder owns, due before M4. Default two-business-day ordinary support; name an achievable urgent incident escalation path.
- **Free policy and audience target restrictions:** founder approves the concrete section 3/8 contract before M2 freezes UX. Default to owned public hosts and published notice periods; broaden third-party monitoring only after abuse review.

### Engineering decisions resolved by M0 evidence

- **D1 routing/provisioning:** choose the proposed shard design if 10/50-workspace allocation, migration, restore, and 2× load gates pass. Otherwise present measured alternatives and their cost/operational changes; preserve the database-per-workspace requirement.
- **Safe egress:** prove the existing platform path or implement controlled egress. An explicitly reviewed host allowlist permits a limited beta; unrestricted targets wait for proof.
- **Identity:** selected AT Protocol OAuth with internal DID memberships. Verify the production callback, deletion, revocation, privacy disclosure, and operator account security before public launch.
- **Email provider:** default an HTTP provider compatible with Workers, reusing existing Resend transport where suitable. Measure sender verification, bounce/complaint hooks, rate limits, transactional deliverability, data contract, and cost before selecting the production account.
- **History write cost:** retain the current schema only if measured write amplification fits the free envelope. If it fails, reduce redundant indexes/triggers, batch aggregate updates, or separate high-volume raw history into private compressed R2 storage with a bounded query index. Such a change needs accuracy/restore/retention tests before launching, not an assumed cost saving.

Each experiment produces a short recorded decision containing measured results, chosen interface, rejected alternatives, risk, and acceptance evidence. No gate is waived just because a date approaches.

## 19. Later paid release and expansion

Free v1 builds versioned entitlements and usage; it has no checkout, payment collection, subscriptions, dunning, or customer revenue admin. Do not display fictional paid plans or collect card data in anticipation of them.

Consider paid plans after at least 30 days of real free usage and customer interviews establish a demand for faster checks, more monitors, longer history, extra members, custom domains, or additional integrations. Proposed future packaging: Free for small public projects, Pro for individual production services, Team for collaborative operations. Price from measured worst-case cost and willingness to pay; do not publish prices from provider free allowances alone.

Before selling, specify exact limits/prices/currency/tax presentation, merchant-of-record responsibility, invoicing, trials, proration, upgrades/downgrades, failed payments, grace periods, cancellation, refunds/disputes, and data retention after downgrade. Hosted checkout and a customer portal reduce payment-data exposure. Use signed/idempotent webhooks and reconcile subscription state against the provider rather than trust a checkout redirect. See [billing research](../research/saas-platform-research.md#billing-later-outside-free-v1).

Proposed downgrade rule: preserve configuration, let the user choose which monitors remain active within the new quota, and visibly pause excess monitors at the effective date. Never delete history on the checkout-return path or charge automatic overages without explicit customer agreement.

Custom domains require ownership validation, certificate lifecycle, hostname routing isolation, takeover prevention, revocation, and vendor pricing review. Faster checks require a new scheduler/egress/cost benchmark. Longer history requires measured storage/query design. More regions increase request volume and may retain the same provider failure domain.

Enterprise capabilities require their own roadmap: SSO/SCIM, auditable access, residency, procurement/security review, DPA, incident/support staffing, stronger disaster recovery, and contractual guarantees. Mobile apps, browser journeys, SMS/voice, and AI diagnosis are separate product investments with evidence of demand.

## 20. Immediate execution order

Start M0 with the storage-routing and safe-egress experiments, provider integration proof, and cost benchmark. In parallel, the founder can finalize the free contract, brand/operator details, budget, and 10 design partners.

Once the gates pass, implement **control plane and per-workspace databases → signup/memberships → enforced quotas and fair scheduling → customer alerts/incidents → marketing/public status → founder usage admin/export/delete/recovery → staged launch**. Keep the acceptance criteria and release checklist as the definition of completion for every slice.
