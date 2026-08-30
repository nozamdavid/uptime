# Cloudflare Workers as multi-region uptime probes

**Research date:** 2026-08-30  
**Source policy:** Primary sources only (Cloudflare product/API documentation and first-party changelogs)  
**Repository note:** The repository was empty, so there was no existing research-note convention. This note establishes `docs/research/` as a sensible location.

## Executive conclusion

**Yes, with an important qualification.** A code-owned, Cloudflare-hosted multi-region HTTP uptime and latency monitor is now feasible on ordinary Cloudflare Workers because Cloudflare introduced explicit **Placement Hints** in January 2026. A Worker can declare a target such as `placement.region = "aws:us-east-1"`; Cloudflare then runs its fetch handler in the Cloudflare data center with the lowest latency to that cloud region. This is materially different from the older model in which an ordinary Worker simply ran near the incoming caller. [Placement documentation](https://developers.cloudflare.com/workers/configuration/placement/) and [the January 2026 announcement](https://developers.cloudflare.com/changelog/post/2026-01-22-explicit-placement-hints/) confirm this.

It is **not** a hard pin to an exact Cloudflare PoP, city, machine, source IP, or even an immutable data center. Cloudflare maps a provider region to its best nearby data center and can change that mapping during maintenance or network changes. At extremely high volumes, it can distribute execution more widely. Therefore the honest product description is “latency measured from a Cloudflare execution location near each configured cloud region,” not “a server physically fixed in each named city.” [Cloudflare's Placement Hints behavior](https://developers.cloudflare.com/workers/configuration/placement/#configure-explicit-placement-hints) is explicit about this distinction.

The recommended design for a genuinely self-hosted product is:

1. Deploy one identical probe Worker service per logical region, each with a different explicit `placement.region` and a `fetch()` handler.
2. Run the control plane, scheduler, dashboard, and PostgreSQL history store in the user's own Docker environment.
3. Have the scheduler invoke each probe through an HTTP/fetch entrypoint, passing a signed check and common check-window ID. Results return synchronously, so the self-hosted server only needs outbound access.
4. Measure each outbound check with `performance.now()` around `fetch()`, record the configured logical region plus the actual `cf-placement`/trace colo, and return the result to the control plane.
5. Store exact observations and longer-term rollups in PostgreSQL. Offer Analytics Engine/D1 only as an optional Cloudflare-native deployment mode, not as the default source of truth.
6. Alert on a quorum of regional failures and separately expose region-specific degradation.

This is a **hybrid self-hosted** design: the application and its data are self-hosted, while regional probe compute remains operated by Cloudflare. It is still a single-provider probe fleet. A Cloudflare-wide network failure can affect every Worker perspective together. If “real uptime” requires provider-independent evidence or exact placement, add a native container probe on a regional VM using the same check/result contract.

## Findings at a glance

| Question | Finding | Confidence |
|---|---|---|
| Can a normal Worker be placed near a chosen region? | Yes. `placement.region` accepts AWS, GCP, and Azure region IDs. | Confirmed |
| Can it be pinned to an exact city/PoP? | No documented guarantee. Cloudflare selects and may change the nearby Cloudflare data center. | Confirmed limitation |
| Can one invocation dynamically select its execution region? | No documented runtime selector; placement configuration currently has one target. Deploy a service/environment per region. | Confirmed API shape; architecture is an inference |
| Is Smart Placement appropriate for regional probes? | No. It learns an optimal upstream location and can converge probes near the monitored service. Use explicit Placement Hints. | Confirmed behavior; design conclusion |
| Will a regional Worker's own Cron Trigger run there? | Do not rely on it. Cron runs on underutilized machines and placement only affects fetch handlers. | Confirmed |
| Can a coordinator invoke placed Workers? | Yes via HTTP/fetch entrypoints in principle. Use a public custom-domain path for the pilot; do not rely on RPC placement. | Confirmed platform primitives; invocation details require pilot verification |
| Can Regional Services force a geographic boundary? | Yes for a regionalized custom hostname, but it is an Enterprise add-on, is not exact-PoP placement, and does not apply to Cron or outgoing subrequests. | Confirmed |
| Can Durable Objects be exact regional probes? | No. Location hints are best effort, coarse, first-use only, and existing objects currently do not relocate. | Confirmed |
| Will outbound checks have a stable regional source IP? | No ordinary-Worker guarantee was found. Dedicated CDN Egress IPs are the documented option for guaranteed allowlisting/geolocation and are a separate enterprise product. | Confirmed absence of a normal guarantee; exact default behavior should be tested |
| Can Workers measure fetch latency? | Yes. Timers advance after I/O, and Cloudflare explicitly documents timing a subrequest this way. | Confirmed |
| Best native history store? | Analytics Engine for time-series charts; D1 for exact rows/longer application-controlled retention. | Confirmed capabilities; design recommendation |

## 1. Execution placement

### Default routing

Without placement configuration, Workers and Pages Functions run in a data center close to where the request is received. That means deploying the same unconfigured Worker multiple times does **not** create distinct regional probes: if the same scheduler calls all of them, they normally start near the scheduler's ingress location. [Cloudflare Placement docs](https://developers.cloudflare.com/workers/configuration/placement/) describe this default.

### Explicit Placement Hints

Cloudflare now supports three mutually exclusive targeted placement forms:

- `placement.region`, using an AWS, GCP, or Azure provider-region identifier such as `aws:us-east-1`, `gcp:europe-west1`, or `azure:southeastasia`.
- `placement.host`, which locates a single-homed layer-4 endpoint with TCP checks.
- `placement.hostname`, which locates a single-homed HTTP endpoint with HEAD checks.

For a geographically diverse monitor, **`placement.region` is the correct anchor**. The host forms would deliberately move the Worker close to the monitored host, defeating the goal of comparing distant perspectives; Cloudflare also says host placement is experimental and unsuitable for anycasted, multicast, broadcast, or replicated resources. [Placement Hints](https://developers.cloudflare.com/workers/configuration/placement/#configure-explicit-placement-hints) document all three forms and their constraints.

Cloudflare does not run a Worker inside AWS/GCP/Azure. It maps the requested provider region to the Cloudflare data center with the lowest measured latency. It automatically changes placement for network maintenance or topology changes. At monitoring-scale traffic this should give a stable logical perspective, but the actual colo must be treated as observed metadata rather than assumed from the configured label. [Cloudflare's cloud-region mapping notes](https://developers.cloudflare.com/workers/configuration/placement/#specify-a-cloud-region) provide the guarantee boundary.

The public Workers API models targeted placement as a single target and says the target array is currently limited to one. Consequently, a multi-region deployment should generate a separate Worker service/environment per logical region from the same source bundle. [Workers API placement schema](https://developers.cloudflare.com/api/resources/workers/) and [Wrangler's `placement` configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#inheritable-keys) support this interpretation.

### Placement applies to fetch handlers, not arbitrary entrypoints

Cloudflare states that both Smart Placement and explicit Placement Hints affect `fetch` event handlers, not named entrypoints or RPC methods. Workers without a fetch handler are ignored by placement. [Placement behavior and limitations](https://developers.cloudflare.com/workers/configuration/placement/#placement-behavior) is the controlling source.

This matters for the scheduler-to-probe link:

- The conservative route is to invoke each regional Worker through a production Custom Domain and its `fetch()` handler.
- Custom Domains can be called from another Worker in the same zone; routes cannot. [Routes and domains](https://developers.cloudflare.com/workers/configuration/routing/) documents that distinction.
- If the coordinator uses global `fetch()` and needs it to re-enter Cloudflare's public front door, `global_fetch_strictly_public` makes that behavior explicit. It must be scoped carefully because it can create loops. [Compatibility flag documentation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public) describes the routing semantics.
- Service Binding HTTP `fetch()` is worth testing as an optimization, but do not use RPC as the initial design. The placement page says RPC is not affected, while a later example on the same page describes a placed RPC backend. The dedicated RPC page also says Smart Placement is ignored for RPC. That first-party documentation is internally inconsistent. [Placement limitation](https://developers.cloudflare.com/workers/configuration/placement/#placement-behavior), [Service Binding interfaces](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#interfaces), and [RPC limitations](https://developers.cloudflare.com/workers/runtime-apis/rpc/#limitations) should be resolved with a deployed test before choosing the private path.

### Smart Placement is the wrong mode for this use case

Smart Placement observes request duration and upstream latency, then forwards a fetch handler only when another candidate location is significantly faster. It considers only locations in which the Worker has previously run and can leave execution at the default incoming-request location. [Smart Placement behavior](https://developers.cloudflare.com/workers/configuration/placement/#enable-smart-placement) documents these heuristics.

This is excellent for an application that needs to sit near its database, but a poor way to create explicit geographic viewpoints. Separate Smart-Placed Workers may all converge toward the same monitored origin. Use fixed logical `placement.region` values instead.

### Observing where a check really ran

When placement is enabled, Cloudflare adds a `cf-placement` header whose value includes a local/remote marker and an IATA colo code, such as `remote-LHR`. Cloudflare cautions that this header may be removed while the feature evolves. [Placement header documentation](https://developers.cloudflare.com/workers/configuration/placement/#cf-placement-header) covers both behavior and caveat.

Workers' automatic traces also include `cloudflare.colo`, described as the data center that processed the request, and `faas.invoked_region`. These are useful as an independent pilot-time verification path. [Workers trace attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/) list the fields.

Do not treat `request.cf.colo` as an unambiguous replacement under remote placement: Cloudflare documents it as the data center that the incoming request “hit,” which can mean the ingress edge rather than the remotely placed execution colo. [Incoming request metadata](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties) uses that wording. During the pilot, compare all three signals and store the actual `cf-placement` value in each check result when present.

## 2. Scheduling

Cron Triggers do not provide regional execution. Cloudflare says they run on underutilized machines to use network capacity efficiently, and execute on UTC. Placement, meanwhile, applies only to fetch handlers. [Cron Trigger background](https://developers.cloudflare.com/workers/configuration/cron-triggers/#background) and [placement limitations](https://developers.cloudflare.com/workers/configuration/placement/#placement-behavior) make per-region Cron Workers unsafe as a placement mechanism.

For the recommended hybrid design, use the self-hosted control plane's scheduler. A single unplaced Cloudflare Cron Trigger is a valid fully Cloudflare-hosted alternative, but it should only coordinate HTTP calls and must never be presented as a regional probe. On each tick the scheduler should:

1. Create a deterministic window ID from `controller.scheduledTime`.
2. Read the active monitor configuration.
3. Send a signed request for that window to every region probe's fetch endpoint concurrently.
4. Gather the results synchronously and write them to PostgreSQL; a retry reuses the same result key.
5. Record dispatch failures and missing-region results as first-class monitor data.

The handler exposes the original scheduled timestamp, and Cloudflare waits for the returned promise up to the 15-minute Cron wall-time limit. [Scheduled handler API](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) documents both. Cron expressions have one-minute granularity, and trigger changes can take up to 15 minutes to propagate. [Cron Trigger configuration](https://developers.cloudflare.com/workers/configuration/cron-triggers/) covers those operational details.

If the optional Cloudflare Cron coordinator is used, its public documentation does not state a precise at-most-once or at-least-once delivery contract. Treat duplicates and gaps as possible: make writes idempotent on `(window_id, monitor_id, logical_region)` and surface missing scheduler windows. This is a defensive inference, not a claimed Cloudflare guarantee.

## 3. Regional Services and the Data Localization Suite

Regional Services can constrain TLS termination and Worker execution for a configured Worker Custom Domain to a managed geographic region. Code and secrets are still deployed globally; only execution is regionalized. It does not apply to `workers.dev`, Queues, Cron Triggers, or other non-HTTP triggers, and it does not extend its restriction to a Worker's outgoing subrequests. [The Workers-specific Regional Services guide](https://developers.cloudflare.com/data-localization/how-to/workers/) lists these caveats.

Regional Services is an Enterprise add-on. It is a compliance product, not a performance-placement feature: within the chosen region Cloudflare chooses a performant data center based on latency, load, and connection capacity, which may not be the closest in-region colo. [Regional Services overview](https://developers.cloudflare.com/data-localization/regional-services/) explains the routing model and entitlement.

It is therefore an alternative only when a customer already has the enterprise entitlement or needs a hard jurisdictional boundary. In principle, multiple regionalized custom hostnames could select several broad regions for the same Worker code, but this should be validated with the account team. It remains less exact than a dedicated VM and much more expensive than ordinary Placement Hints. Cloudflare's compatibility table also marks Smart Placement as incompatible with Regional Services, so these mechanisms should not be stacked. [Data Localization product compatibility](https://developers.cloudflare.com/data-localization/compatibility/) documents that incompatibility.

For egress, Regional Services says the normal origin-facing address is site-local to the in-region processing data center, but explicitly recommends Dedicated CDN Egress IPs when egress geolocation or allowlisting must be guaranteed. [Regional Services egress behavior](https://developers.cloudflare.com/data-localization/regional-services/#egress-behavior-and-ingress-ips) is the relevant contract.

## 4. Durable Objects are not a substitute for regional Worker placement

Durable Objects can receive a coarse `locationHint` such as `wnam`, `enam`, `weur`, `eeur`, `apac`, or `oc`. The hint is best effort, is honored only on the first `get()` for a particular object, and can place the object near rather than inside the named region. Some hints, including South America, Africa, and the Middle East, currently spawn in another supported location. Existing Durable Objects do not currently relocate; dynamic relocation is listed as future work. [Durable Objects data location](https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint) is explicit on every one of these constraints.

Jurisdictional subnamespaces are stronger but broader: `eu`, `us`, and `fedramp` constrain where a Durable Object runs and persists data. They do not select an exact city. [Durable Objects jurisdiction documentation](https://developers.cloudflare.com/durable-objects/reference/data-location/#restrict-durable-objects-to-a-jurisdiction) lists the available boundaries.

Consequences:

- Do not use one Durable Object plus an alarm as each claimed regional probe if exact, comparable geography matters.
- Reapplying a hint cannot move an existing object. Relocation would require a new object ID and an application-level state transfer; that is an inference from the first-use/no-relocation rules.
- Durable Objects remain useful for strongly consistent alert/quorum state, incident transitions, leases, or deduplication. They should coordinate probes, not define probe geography.

## 5. Outbound checks, timing, and egress identity

### What the latency represents

The placed fetch handler makes the target `fetch()` from its execution location. This is the necessary implication of Placement Hints' documented purpose—reducing Worker-to-upstream round trips—and should be verified against a controlled echo origin in the pilot. The result represents the Cloudflare-network perspective near the configured provider region. It is not a measurement from a residential ISP, mobile carrier, or independent cloud network.

For a target also behind Cloudflare, part or all of the path can remain within Cloudflare. That is useful for measuring the served application's Cloudflare-path availability, but it is not provider-independent monitoring. Disable caching where the target permits it and label this limitation in the product.

### Measuring elapsed fetch time

Cloudflare intentionally freezes `performance.now()` and `Date.now()` while JavaScript executes, but advances them across I/O. Its documentation specifically shows wrapping a `fetch()` with `performance.now()` to obtain the subrequest duration. [Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/) confirms that this measurement is supported.

For every check, capture at least:

- `scheduled_at` and a deterministic `window_id`
- `monitor_id`, URL/method, and logical placement region
- actual placement header/colo when available
- time until response headers (`fetch` completion), called `response_ms` rather than overclaiming exact TCP/TLS phases
- optional total time after consuming a bounded response body
- HTTP status, redirect count/final URL if manually followed, success predicate, timeout/error category
- deployment version and attempt number

Workers does not expose browser-style DNS/TCP/TLS phase timing for an ordinary `fetch()` in the reviewed documentation. The safe metric is total subrequest/response latency. Use an `AbortSignal` for an explicit timeout and cap any response-body read.

Use `cache: "no-store"` and an explicit cache-busting policy where appropriate. Cloudflare's Fetch API supports `no-store` and `no-cache`, although behavior for a target already hosted on Cloudflare is still subject to that target zone's configuration. [Fetch API cache controls](https://developers.cloudflare.com/workers/runtime-apis/fetch/) document the available modes.

### Source IP and protocol constraints

No ordinary-Workers documentation reviewed promises a stable source IP per Worker or per placement region. Cloudflare's documented solution for fixed origin-facing IPs is Dedicated CDN Egress IPs; `fetch()` to an origin can use them, whereas raw Worker `connect()` sockets do not. [Dedicated CDN Egress IP compatibility with Workers](https://developers.cloudflare.com/smart-shield/configuration/dedicated-egress-ips/other-products/#workers) documents this split.

Raw TCP checks are possible with the Workers `connect()` API, but their outbound source prefix is not in Cloudflare's published IP range list; outbound connections to Cloudflare IP ranges and port 25 are blocked. ICMP ping is not a Worker primitive. [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) describes the restrictions.

If a monitored origin requires source-IP allowlisting, ordinary placed Workers alone are not a dependable fit. Either purchase dedicated egress, expose a signed monitor endpoint, or use self-managed regional hosts with known IPs.

## 6. History and comparison storage

### PostgreSQL: recommended self-hosted source of truth

For this project, keep monitor configuration, exact observations, incident state, and rollups in a self-hosted PostgreSQL database. Model one logical `check_run` per scheduled monitor window and one `observation` per `(check_run, probe_location)`. Store the configured placement separately from the observed Cloudflare colo so placement drift is visible rather than silently changing the meaning of a chart.

Start with time-partitioned observation tables and indexes for `(monitor_id, probe_location_id, started_at)`. Retain exact rows for a bounded period, then keep hourly/daily p50, p95, p99, availability, and error-count rollups. TimescaleDB or a column store can be added later if measured volume warrants it; neither is necessary for the placement proof or initial MVP.

The Cloudflare-native options below remain useful for an all-Cloudflare deployment or as supplemental telemetry, but they make the monitor less self-hosted and increase the correlated-provider failure domain.

### Workers Analytics Engine: Cloudflare-native chart option

Cloudflare explicitly categorizes Analytics Engine as its product for high-cardinality time-series metrics and service telemetry. Writes from a Worker are non-blocking; data is queried with a SQL API and can be visualized in Grafana. [Storage product guidance](https://developers.cloudflare.com/workers/platform/storage-options/) and [the Analytics Engine Worker example](https://developers.cloudflare.com/workers/examples/analytics-engine/) support this fit.

Suggested event mapping:

- index: `monitor_id:logical_region` (choose based on dominant query shape)
- blobs: monitor ID, logical region, actual colo, result/error class, status, deployment version
- doubles: response milliseconds, total milliseconds, success 0/1, body bytes

Query per-region p50/p95/p99, error rate, and availability in aligned time buckets. Weighted adaptive sampling can happen on write and read, so queries must use `_sample_interval`-aware aggregates. At normal uptime-monitor rates write sampling should be uncommon, but long-range or cross-index queries can still be downsampled. [Analytics Engine sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/) explains the model.

Hard limitations:

- Retention is three months.
- A Worker invocation can write at most 250 points.
- A point supports up to 20 blobs, 20 doubles, and one index.

[Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) provides the current values.

The published pricing model includes 100,000 writes and 10,000 reads per day on Free, or 10 million writes and 1 million reads per month on Workers Paid, followed by $0.25/additional million writes and $1/additional million reads. The same page currently says billing has not yet started and the rates are advance notice, so this must be rechecked at implementation time. [Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) is the live source.

### D1: Cloudflare-native exact rows and longer retention

D1 is a better source of truth when the UI must show every raw check, retain data beyond three months, perform exact incident reconstruction, or enforce unique window keys. Store raw recent data plus hourly/daily rollups, and prune or export according to policy.

Trade-offs:

- D1 writes go to one primary database location. Global read replication accelerates reads, but all writes are forwarded to the primary. [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) documents the topology.
- End the measured target timer before doing a D1 write so database distance cannot contaminate target latency.
- D1 Free includes 100,000 rows written per day; Paid includes 50 million per month and then charges $1 per additional million. Indexed columns add write-row usage. Paid includes 5 GB storage, then $0.75/GB-month. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) has the exact accounting rules.
- A paid D1 database is capped at 10 GB, so long raw retention requires aggregation, sharding, or export. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) lists the cap.

A pragmatic design is Analytics Engine for the hot chart path plus D1 for monitor configuration, current state, incident transitions, and exact recent checks. If one store is preferred initially, start with D1 for correctness and add Analytics Engine when chart volume/query cost demands it.

### R2 for archive

Cloudflare lists R2 as suitable for analytics datasets and log/event data. It is sensible for periodic compressed exports or rollups, not one tiny object per check. [Storage product guidance](https://developers.cloudflare.com/workers/platform/storage-options/) supports the use case. Archive design can wait until the core probe semantics are proven.

## 7. Limits and indicative cost

Relevant current Workers limits are:

| Limit | Free | Paid |
|---|---:|---:|
| Inbound Worker requests | 100,000/day | No hard request cap; usage billed |
| Subrequests per invocation | 50 | 10,000 by default |
| Simultaneous outgoing connections | 6 | 6 |
| Cron triggers per account | 5 | 250 |
| CPU per ordinary HTTP invocation | 10 ms | Up to 5 minutes (30 seconds default) |
| CPU for a Cron that runs more often than hourly | 10 ms | 30 seconds |
| Cron wall time | 15 minutes | 15 minutes |

[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) is the source. Network wait time does not count as CPU time, but response parsing, validation, and aggregation do.

Workers Paid currently has a $5/month account minimum, including 10 million inbound requests and 30 million CPU-milliseconds per month. Additional inbound requests are $0.30/million. Worker subrequests are not billed as requests, and Cloudflare does not charge Workers data transfer/egress. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/#workers) gives the current rates.

Example: **6 regions × 20 monitors × every minute**, using one isolated Worker invocation per monitor and region:

- Self-hosted scheduler invocations: none on Cloudflare.
- Regional probe invocations: `6 × 20 × 43,200 = 5,184,000/month`.
- Outbound target subrequests: **5,184,000/month**; these are unbilled.
- Analytics points or base D1 rows: **5,184,000/month**. This exceeds the Analytics Engine and D1 Free daily write allowances but fits their Paid included monthly quantities before accounting for D1 index writes.

The probe requests fit inside Workers Paid's included 10 million monthly requests, but their roughly 172,800 requests/day exceed the Free plan's 100,000/day cap. If lower request count matters, batch a small number of targets per regional invocation; keep the batch bounded so one slow target cannot delay an entire region or create large start-time skew.

For batched probes, only six outbound connections can wait simultaneously. Use a concurrency pool of at most six and a hard per-target timeout. Redirects consume additional subrequests. If a batch cannot complete comfortably before the next minute, make it smaller; the request cost remains modest.

## 8. Recommended implementation plan

### Phase 0 — placement proof, before building product features

Deploy three tiny copies of one probe Worker, for example:

- Western Europe: `aws:eu-west-1`
- Eastern North America: `aws:us-east-1`
- Asia-Pacific: `aws:ap-southeast-1`

Each must expose a fetch handler and return:

- configured logical region
- incoming `cf-placement` header if visible
- `request.cf.colo` for comparison, not as presumed truth
- Worker version
- elapsed fetch duration to a controlled echo endpoint

Enable Workers traces and compare their `cloudflare.colo` to the response metadata. Invoke all three from the same client for 24–48 hours; optionally repeat from a Cron coordinator to validate that deployment mode too. Verify that execution occurs near the three intended regions, remains distinct, and follows placement after cold starts/deployments.

Use a controlled origin that logs source IP and receive time. This tests the remaining unknowns: actual egress locality, whether Cloudflare-internal routing changes the path, and placement drift. Also attempt explicit placement on the intended Free/Paid account because the current docs explicitly say Smart Placement is on all plans but do not state a separate plan entitlement sentence for Placement Hints.

Test both:

1. Custom-Domain/global-public `fetch()` from the coordinator (baseline).
2. Service Binding HTTP `fetch()` (possible private optimization).

Reject an invocation path if the downstream code runs beside the coordinator instead of in its configured region. Do not use Service Binding RPC until the contradictory documentation is resolved empirically.

### Phase 1 — monitoring MVP

Build the following bounded components:

- **Dockerized control plane:** monitor CRUD, dashboard API, authentication, scheduler, and alert evaluation.
- **PostgreSQL persistence:** exact checks, current state, incidents, idempotent run/result keys, and time-bucketed rollups.
- **Probe Worker template:** same code deployed once per region; validates signature and freshness; only accepts configuration issued by the control plane; runs one bounded fetch and returns the result synchronously.
- **Provider-neutral probe contract:** the same signed check/result schema is implemented by both the Worker and a later native container agent.
- **Dashboard:** aligned regional series, current status by region, p50/p95/p99, availability, paired deltas, missing observations, and a visible actual-colo tooltip.
- **Alert evaluator:** fail after configurable consecutive windows and quorum (for example, two regions), with a distinct “one region degraded” event.

The probe endpoint must not become a public SSRF relay. Authenticate every job, reject arbitrary unsigned URLs, allow only HTTP(S), bound redirects/body size/time, and rate-limit invocation.

### Phase 2 — reliability and history

- Make raw result writes idempotent by window/monitor/region.
- Detect missing coordinator windows and missing regional responses.
- Keep exact recent rows, compute hourly/daily rollups, and define pruning/export retention.
- Add deployment/placement drift metrics and alert if a logical region repeatedly lands outside its expected geography.
- Test timeout, DNS failure, TLS failure, redirect loops, cached responses, slow headers, slow bodies, partial regional failure, duplicate dispatch, and scheduler gaps.
- Run the dashboard/control plane independently of the monitored targets. Keep control-plane credentials in its secret store and Cloudflare-side credentials in Worker secrets, never plain vars.

### Phase 3 — independence decision

After the Cloudflare MVP is stable, decide what “real” uptime must mean:

- If the requirement is inexpensive regional comparison from Cloudflare's network, the Worker design is sufficient.
- If the requirement is exact city/static egress, use small self-managed regional VMs or another probe platform for those regions.
- If the requirement is evidence during a Cloudflare-wide outage, add at least one scheduler/probe and one alert path outside Cloudflare. A Cloudflare-only monitor cannot remove its own provider as a correlated failure domain.

## 9. Go/no-go gates and unresolved questions

Proceed to the full MVP only after the placement proof answers these questions:

1. **Region separation:** Do three remote requests consistently report distinct processing colos near their configured cloud regions?
2. **Invocation path:** Does coordinator-to-probe Custom Domain fetch always enter the placed fetch handler? Does Service Binding HTTP fetch behave the same?
3. **Metadata:** Is `cf-placement` readable inside the handler and stable enough to persist? Can trace colo serve as an operational fallback?
4. **Egress:** Does a controlled origin see source locations consistent with the processing colos? Is any allowlist requirement compatible with non-dedicated source IPs?
5. **Timing:** Does Worker-measured response latency agree within an acceptable margin with timestamps from the controlled origin?
6. **Schedule:** What real jitter, duplicates, or gaps appear over at least several days at the one-minute cadence?
7. **Storage:** What raw-row retention and rollup policy keeps the self-hosted PostgreSQL footprint acceptable at the intended monitor/region cadence?
8. **Plan availability:** Does `placement.region` deploy successfully on the intended account plan? The reviewed docs do not list a separate entitlement restriction for it, but only Smart Placement is explicitly described as available on all plans.

The hard no-go conditions for a Workers-only design are: exact city/PoP pinning, guaranteed ordinary-Worker source IP, provider-independent monitoring, or an operational requirement that cannot tolerate Cloudflare changing the underlying placement colo. Those require externally hosted probes.
