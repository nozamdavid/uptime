# Latency-breakdown feasibility for Cloudflare Worker probes

_Researched 2026-08-30. Scope: the current uptime probe and current primary documentation from Cloudflare, WHATWG/W3C, curl, Go, and Undici._

## Conclusion

An ordinary Cloudflare Worker cannot truthfully decompose one outbound `fetch()` into DNS lookup, TCP connect, TLS handshake, request upload, server processing, time to first byte, and response download. The Worker-facing Fetch and Response APIs expose the response and its body stream, but no connection timing object, selected DNS answer, peer socket, connection-reuse flag, or TLS timing. Workers' Performance API is only a subset containing elapsed timers; it does not document `PerformanceResourceTiming` entries or browser-style resource timing fields. [Workers Performance API](https://developers.cloudflare.com/workers/runtime-apis/performance/), [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/), and [Workers Response API](https://developers.cloudflare.com/workers/runtime-apis/response/)

The truthful Worker MVP is therefore:

- **Headers latency**: probe start through receipt of the final response headers, including all manually followed redirects.
- **Total sampled latency**: probe start through the bounded final-response body read, also including redirects.
- **Body-read latency**: `total - headers`, labeled as the time to consume the sampled body, not pure network download time.
- **Server-reported timings**: optional, bounded parsing of an allowlisted `Server-Timing` header, clearly labeled as untrusted target/CDN-reported metrics rather than independently measured origin processing.

DNS/connect/TLS/peer-IP truth requires a native regional probe that owns the HTTP socket. It should be a future probe type, not values inferred from extra Worker requests.

## What the current probe measures

The current Worker records one `started = Date.now()` before entering its manual redirect loop. After every `await fetch(..., { redirect: "manual" })`, it assigns `responseMs = Date.now() - started`; the final assignment therefore represents elapsed time from the beginning of the check until the **final hop's response headers** are available. It cumulatively includes DNS/connect/TLS work if the platform performed it, request transmission, server/CDN wait, all earlier redirect hops, and local gaps between hops. It cannot separate those constituents.

That interpretation follows Fetch semantics: the response is handed to the caller when its headers have been received, while the response body remains a stream the caller must consume. [WHATWG Fetch Standard](https://fetch.spec.whatwg.org/) Cloudflare likewise documents `fetch()` as returning a `Promise<Response>` and the Response body as a `ReadableStream`; body helpers resolve only after reading the body to completion. [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) and [Workers Response API](https://developers.cloudflare.com/workers/runtime-apis/response/)

The probe then reads no more than 65,536 bytes from the final response and records `totalMs`. On a successful response this is elapsed time from the original start through that bounded read. Thus `totalMs - responseMs` is a useful **sampled body-read duration**, but it is not pure download time: it can include stream scheduling, decompression/runtime I/O, backpressure, and server pauses between body chunks. When the body exceeds the cap, the metric ends after detecting the first over-limit chunk, not after downloading the entire entity.

The final-response header parser is deliberately excluded from `totalMs`, although deployed Workers freeze elapsed clocks during CPU-only JavaScript and so that subtraction will normally be zero. Cloudflare states that `Date.now()` and `performance.now()` advance only after I/O in production; they cannot measure CPU-only parsing or application processing inside the Worker. Local Wrangler timers behave differently. [Workers Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)

DNS diagnostics run after the HTTP timing is captured and are not part of successful `responseMs` or `totalMs`. They are separate resolver observations, not a decomposition of the fetch.

### Redirect semantics

Because the code uses manual redirects and a single start time, current header and total latency are **whole-chain** measurements. They do not show final-hop-only latency or per-hop timing. A later Worker enhancement could start a timer immediately before each manual `fetch()` and record a **per-hop headers duration** plus URL/status; that would still be a combined per-hop wait, not DNS/connect/TLS/TTFB phases. Redirect response bodies are currently not consumed, so per-hop “total body” timing would require an explicit, bounded read and would alter behavior and cost.

The label **TTFB** should be avoided for `responseMs`: Fetch makes the response available after response headers, not as a raw first-byte event, and the current value includes all redirects. Use **Headers latency**. For a zero-redirect request this approximates conventional TTFB from the application call boundary, but it remains a higher-level measurement. With manual redirects, separate per-hop headers latency is possible; exact wire-level TTFB for each hop is not exposed.

## API-by-API feasibility

### `performance.now()` and Resource Timing

Cloudflare documents only `performance.now()` and `performance.timeOrigin` in its supported Performance subset. Its example wraps an entire `fetch()` to measure a subrequest duration. It does not document `performance.getEntriesByType("resource")`, `PerformanceResourceTiming`, or populated `domainLookup*`, `connect*`, `secureConnectionStart`, `requestStart`, `responseStart`, and `responseEnd` fields. Browser Resource Timing shapes must not be assumed to exist merely because the global `performance` object exists. [Workers Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)

The security timer behavior also prevents deriving phases by surrounding CPU-only calls: time advances at I/O boundaries rather than continuously during deployed JavaScript. It supports measuring coarse asynchronous operations, not hidden transport milestones.

### Fetch, Response, and `cf` metadata

The documented outbound Fetch/Response surface has no transport-timing or connection-info result. `response.cf` is an optional informational object on the Workers-specific Response interface, not documented phase telemetry. Incoming `request.cf` describes the connection **from the scheduler/client to the probe Worker**—for example incoming HTTP/TLS and client RTT metadata—not the Worker's outbound connection to the monitored URL. [Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/) and [Workers Response API](https://developers.cloudflare.com/workers/runtime-apis/response/)

Consequently neither object supplies outbound DNS, connect, TLS, TTFB, download, or origin processing durations.

### Workers traces and Logpush

Workers tracing, currently open beta, automatically emits a span for an outbound Fetch call with overall timing and HTTP metadata. The documented Fetch span attributes include URL, method, protocol, status, and request/response sizes; they do **not** include DNS, TCP, TLS, request-upload, TTFB, or body-download phase fields. Cloudflare also warns that attributes are incomplete and names may change during beta. [Workers traces](https://developers.cloudflare.com/workers/observability/traces/), [supported spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/), and [trace limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/)

Traces are useful operational evidence for “which subrequest was slow” and may be exported via OTLP, but the documentation does not define the outbound span's exact body-stream lifecycle boundary. They should not be transformed into transport-phase fields in the monitor database. Root trace `cloudflare.cpu_time_ms` and `cloudflare.wall_time_ms` describe the whole Worker invocation, not origin processing or an individual network phase.

Workers Trace Event Logpush similarly describes invocation/subrequest observability, not a same-fetch phase breakdown exposed to application code. Cloudflare's **zone HTTP request** Logpush dataset does have origin-side fields such as `OriginDNSResponseTimeMs`, `OriginTCPHandshakeDurationMs`, `OriginTLSHandshakeDurationMs`, `OriginRequestHeaderSendDurationMs`, and `OriginResponseHeaderReceiveDurationMs`; a reused origin connection can produce zero handshake times. Those logs belong to traffic for a Cloudflare zone and require the relevant zone/account product and log access. They are not a portable API for this monitor's arbitrary third-party targets, are not returned synchronously to the Worker, and may describe Cloudflare's own cache/tier/origin path rather than the probe's complete HTTP transaction. [Cloudflare zone HTTP request Logpush fields](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/http_requests/)

Analytics and Diagnostics APIs do not close this gap. Workers analytics reports aggregate request/subrequest behavior, while the Diagnostics traceroute endpoint returns network hops from selected Cloudflare colos; neither decomposes this particular Fetch connection. [Cloudflare analytics with Workers](https://developers.cloudflare.com/analytics/account-and-zone-analytics/analytics-with-workers/) and [Diagnostics traceroute API](https://developers.cloudflare.com/api/resources/diagnostics/subresources/traceroutes/)

### Target-supplied `Server-Timing`

The final response's `Server-Timing` header is directly readable by a Worker and is the only practical way to add backend/application timing without another probe architecture. The W3C standard lets a server or intermediary report named metrics with optional `dur` milliseconds and `desc`; it intentionally omits a start time because clocks cannot be assumed synchronized. The sender decides the meaning and can report application, database, cache, CDN, or routing work. [W3C Server Timing](https://www.w3.org/TR/server-timing/)

It is not an independent measurement:

- arbitrary targets can omit, forge, or mislabel it;
- a CDN may replace, append, sample, or expose only its own metrics;
- reported durations can overlap and need not sum to observed latency;
- “app” or “origin” processing means only what the sender says it means;
- redirect-hop metrics disappear unless the monitor captures each manual redirect response separately.

If implemented, parse only the final response by default; retain a small allowlist of metric names configured by the monitor owner, bound the complete header and each name/description, cap metric count, accept only finite non-negative durations under a defensive maximum, store the bounded raw header and parser version, and render **Server-reported: `<name>`**. Never subtract a reported duration from observed latency to manufacture a “network time,” and never let parsing affect uptime status. For debugging redirects, an advanced view may retain separately bounded Server-Timing metrics per hop.

## Why adjacent probes do not decompose the monitored fetch

### DNS lookup

A `node:dns` or DNS-over-HTTPS request measures a separate resolver query. The HTTP stack may use a cached answer or a pooled connection; answers can rotate, differ by resolver context, or point to anycast addresses. Its elapsed time and candidates therefore cannot be assigned as the monitored fetch's DNS phase.

### `cloudflare:sockets.connect()` and `startTls()`

Workers can open an outbound TCP socket and can create a TLS socket using `secureTransport`/`startTls()`. This is a **new connection with a different API and potentially different routing**, not instrumentation of Fetch. Raw sockets to Cloudflare IP ranges are blocked, and the application would have to implement correct HTTP framing, redirects, content coding, proxy/CDN behavior, TLS policy, and HTTP protocol support itself. [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)

Even if timers around `socket.opened` or TLS I/O produce useful diagnostic samples, those values describe that separate socket. They cannot be combined with `fetch()` latency as its connect or TLS phase. `startTls()` is principally an opportunistic upgrade mechanism; it does not reveal Fetch's TLS milestone.

### Separate HEAD/fetch requests and timing endpoints

A preceding `HEAD`, connection-warming request, or request to a timing/echo service is another HTTP transaction. It can change the next fetch by warming DNS, TLS, or a pooled connection, may be routed to another CDN node, and servers often process HEAD differently from GET. A target-controlled endpoint can truthfully report its own processing time or serving identity, but only through explicit response data such as `Server-Timing`; it cannot reveal the Worker runtime's hidden phase timings.

## Why phase values may be zero, missing, or ambiguous even in native clients

HTTP clients pool connections. A reused connection performs no new DNS lookup, TCP handshake, or TLS handshake for that request, so those per-request phase durations are legitimately absent or zero. HTTP/2 and HTTP/3 can multiplex concurrent requests on one connection, preventing a simple ownership relationship between a request and connection setup. The Fetch standard explicitly models connection pools and allows an existing connection to be obtained. [WHATWG Fetch Standard](https://fetch.spec.whatwg.org/)

CDN caching also changes what “server processing” means: headers may come from the nearest cache without reaching the origin, or a tiered CDN may contact another cache before origin. Redirects can change hostnames and create multiple DNS/connection/TLS sequences. A single rolled-up DNS/connect/TLS number would be misleading unless represented per hop and accompanied by connection reuse/cache/protocol facts.

Request upload is effectively negligible for this monitor's current GET-without-body checks, but request-header send time is still hidden in Workers. “Processing” is not directly derivable from TTFB minus connection setup because network transit, proxy queues, CDN/cache work, and server execution are interleaved.

## Native regional probe option

A VM/container probe using a client that owns the socket can expose the required milestones and the connected peer IP:

- **curl/libcurl** `--write-out` reports `remote_ip`, `time_namelookup`, `time_connect`, `time_appconnect` (TLS completed), `time_pretransfer`, `time_starttransfer`, `time_redirect`, and `time_total`. Phase durations are calculated from cumulative timestamps, with reuse/redirect semantics kept explicit. [curl command-line write-out variables](https://curl.se/docs/manpage.html)
- **Go `net/http/httptrace`** provides request-scoped hooks for DNS start/done, connect start/done, TLS handshake start/done, connection acquisition/reuse, request write completion, and first response byte. The response body can then be timed to EOF or a chosen cap and the connection's remote address recorded. [Go `net/http/httptrace`](https://pkg.go.dev/net/http/httptrace) and [Go HTTP tracing overview](https://go.dev/blog/http-tracing)
- **Node/Undici** diagnostics channels expose request lifecycle events and client connection events, including the socket. Its documentation cautions that `beforeConnect` cannot be attributed to a particular request because connections are pooled and shared, so a production implementation must correlate carefully and represent reused connections explicitly. [Undici diagnostics-channel documentation](https://github.com/nodejs/undici/blob/main/docs/docs/api/DiagnosticsChannel.md)

For the cleanest future implementation, use Go `httptrace` in each self-hosted region and store per redirect hop: resolved candidates, selected peer IP/port, connection reused/idle, protocol, DNS/connect/TLS/request-written/headers/body/total timestamps, status, final URL, and bounded bytes. Treat phase fields as nullable, never as zero-by-default. Server-reported timings remain separate.

## Feasibility matrix

| Metric | Same Worker `fetch()` | Honest Worker approximation | Native probe |
|---|---:|---|---:|
| DNS lookup duration | No | Separate DNS diagnostic only; not fetch DNS | Yes when a lookup occurs |
| TCP connect duration | No | Separate raw-socket diagnostic only | Yes when a new connection occurs |
| TLS handshake duration | No | Separate TLS socket diagnostic only | Yes when a new TLS session occurs |
| Request upload | No | Current GET has no body; header send still hidden | Yes/partially, client-dependent |
| Response headers latency | **Yes** | Current `responseMs`; whole redirect chain | Yes, per hop |
| Exact wire TTFB | No | Headers latency is the closest truthful label | Yes, client hook dependent |
| Server/application processing | No | Bounded, untrusted `Server-Timing` only | Still only target telemetry or server tracing |
| Sampled body-read duration | **Yes** | `totalMs - responseMs` | Yes |
| Full response download | Only if fully consumed | Current probe intentionally caps at 64 KiB | Yes or bounded by policy |
| Worker CPU processing | Not with elapsed timers | Invocation-level trace CPU metric, not network phase | Probe process telemetry |
| Connected peer IP | No | DNS candidates are not peer IP | Yes |
| Redirect breakdown | Combined today | Per-hop headers timing can be added | Yes, full per-hop phases |

## Recommendation

1. Keep the Worker architecture and rename UI/API presentation from generic “response latency” to **Headers latency (includes redirects)** and **Total sampled latency (includes redirects; body capped at 64 KiB)**. Derive **Sampled body read** as `max(0, total - headers)`.
2. Add optional, default-off **Capture server-reported timings** only for users who control or trust the target. Parse a bounded `Server-Timing` allowlist and display it in a separate “Target/CDN reported” section. Do not call it measured processing time.
3. Do not add fabricated DNS/connect/TLS bars, separate socket samples, HEAD warming, or subtraction-based “network vs processing” estimates.
4. Optionally enable sampled Workers traces for operator debugging, but do not make beta trace spans the product's latency-breakdown data model.
5. If transport phases and peer IP become a product requirement, add a **native probe** execution mode in the nine regions. Prefer Go `httptrace`, represent phases per redirect hop, and preserve nullable/reused-connection semantics.

Firm answer: **Workers can provide a useful headers/body split and accept target-reported Server-Timing, but a real DNS/connect/TLS/TTFB breakdown of the same monitored request is not feasible with the current Worker Fetch API.**
