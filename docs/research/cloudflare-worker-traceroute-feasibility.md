# Cloudflare Worker traceroute feasibility

**Investigated:** 2026-08-30  
**Decision:** Do not add a checkbox named **Traceroute** to the current Cloudflare Worker probes. A real Worker-originated traceroute is not implementable with the runtime's exposed networking APIs. Defer that feature until a native regional probe adapter exists. Cloudflare's separate Diagnostics API could later be offered as an explicitly named **Cloudflare colo diagnostic trace**, but it is not the same path as the monitored HTTP request and has restrictive account permissions.

## What a real traceroute requires

Classic traceroute sends probes with successively increasing IPv4 TTL or IPv6 hop-limit values and associates ICMP Time Exceeded replies with those probes. The IETF's traceroute storage specification describes UDP probes with a specific TTL and the resulting ICMP messages; its data model includes hop addresses, RTTs, and timeout responses. [RFC 5388](https://www.rfc-editor.org/rfc/rfc5388.html)

A runtime therefore needs all of the following:

1. control over the outbound packet TTL/hop limit;
2. a probe transport such as ICMP, UDP, or TCP;
3. delivery of ICMP Time Exceeded responses (including their quoted packet data) back to the process;
4. enough bounded wall time and packet budget to repeat that operation for every hop.

Cloudflare Workers does not expose that combination.

## Worker runtime capability matrix

| Capability | Current Worker support | Consequence |
| --- | --- | --- |
| HTTP `fetch()` | Yes. Fetch provides HTTP request/response semantics and Cloudflare-specific request options. [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) | It does not expose IP TTL/hop-limit controls, raw packets, ICMP replies, the route, or even the actual connected peer IP. Repeating HTTP requests cannot reveal intermediate routers. |
| `cloudflare:sockets.connect()` | Outbound **TCP** only. Its documented options are `secureTransport` and `allowHalfOpen`; its result exposes stream I/O and possibly local/remote endpoint addresses. [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) | It can test an application-layer TCP connection, but exposes no per-connection IP TTL/hop-limit control and no ICMP Time Exceeded receive path. Cloudflare also directs port 80/443 traffic to `fetch()` and blocks some destinations. |
| `node:net` | Supported as an adapter over `cloudflare:sockets`. [Workers `node:net`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/net/) | It inherits the TCP-only substrate. A Node `net.Socket` is not a raw IP socket, and the Worker implementation does not add traceroute packet controls. |
| `node:dgram` / UDP | Listed by Cloudflare as a **non-functional stub module**, not a native API. Stub methods may no-op or throw. [Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) | A UDP traceroute cannot be implemented. Even ordinary UDP datagram I/O is unavailable through this module. |
| Raw sockets and ICMP | No raw/packet/ICMP socket API appears in the Worker runtime API catalog; the only documented general-purpose outbound socket API is TCP. [Workers runtime APIs](https://developers.cloudflare.com/workers/runtime-apis/) | The Worker cannot send ICMP Echo probes or receive router-generated ICMP Time Exceeded packets. |
| Set IPv4 TTL / IPv6 hop limit | No such option exists in the documented Fetch or TCP socket APIs. [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/), [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) | Without varying TTL/hop limit, intermediate routers cannot be elicited hop by hop. |
| OS `traceroute`, subprocesses | `node:child_process` is a non-functional stub. Workers are isolates rather than operator-controlled hosts. [Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) | The Worker cannot execute `traceroute`, `tracepath`, `mtr`, `ping`, or another host binary. WebAssembly cannot manufacture missing raw-socket privileges. |

This is a capability absence, not merely a CPU-limit problem. More compute or a longer timeout does not grant packet-level networking.

## Runtime limits if a diagnostic were delegated

An HTTP-triggered Worker currently has no fixed wall-duration limit while its caller stays connected, but the request can be canceled after the response/client disconnects. Free-plan CPU is 10 ms per invocation; paid Workers default to 30 seconds and can be configured up to five minutes. Free and paid subrequest allowances are 50 and 10,000 respectively, and at most six outgoing connections may simultaneously wait for response headers. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

A single `fetch()` to an external tracing service would be one Worker subrequest, while the remote service would incur the multiple packets, waiting time, and cost. That still would be the remote service's path—not the initiating Worker's actual HTTP connection path.

## Cloudflare products with “trace” in the name

Several Cloudflare features are easy to confuse with network traceroute:

- **Workers Traces** records application spans for handler, binding, and outbound Fetch operations. It reports operation timing and metadata, not IP hops. [Workers Traces](https://developers.cloudflare.com/workers/observability/traces/)
- **Request Trace API** evaluates the Cloudflare rules and steps that act on a synthetic HTTP request. Its response is a list of ruleset trace items, not network routers. [Request Trace API](https://developers.cloudflare.com/api/resources/request_tracers/subresources/traces/)
- **`/cdn-cgi/trace`** reports properties such as the Cloudflare `colo` serving a request. Cloudflare documents it as a way to identify the serving data center; it does not return hop-by-hop routing. [Cloudflare slow-site troubleshooting](https://developers.cloudflare.com/speed/troubleshooting/slow-website/)
- **DEX traceroute tests** run from enrolled end-user devices to a configured IP. They measure that device's path, not a Worker's path, and are scheduled at 5–60 minute intervals. [Cloudflare DEX traceroute test](https://developers.cloudflare.com/cloudflare-one/insights/dex/tests/traceroute/)
- **Cloudflare WAN traceroutes** trace between a selected Cloudflare data center and the customer's connected network. This is a Cloudflare WAN diagnostic, not general Worker runtime functionality. [Cloudflare WAN traceroutes](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-wan/analytics/traceroutes/)

Cloudflare also exposes `POST /accounts/{account_id}/diagnostics/traceroute`, which accepts target hostnames/IPs, optional source colos, maximum TTL, and packet type, and returns hops with IP, ASN, packet counts, and RTT statistics. It requires an API token with **Magic Transit Write** permission. [Cloudflare Diagnostics Traceroute API](https://developers.cloudflare.com/api/resources/diagnostics/subresources/traceroutes/methods/create/)

That API is the closest available approximation, but it must not be described as “traceroute from this Worker request”:

1. Cloudflare says it runs from requested colos, not from the Worker isolate or its exact egress connection.
2. A placement hint is regional affinity, and a Worker execution may move among colos. Even selecting the observation's reported colo later does not prove the diagnostic system shares the Worker's egress path or route.
3. A hostname can resolve differently between the HTTP fetch and the diagnostic request because of geo-DNS, time, cache state, anycast, or CDN steering. The Worker cannot supply the actual HTTP peer IP because Fetch does not expose it.
4. Storing a token with Magic Transit Write in every Internet-facing probe Worker would be an unnecessarily broad trust expansion. If used at all, the self-hosted control plane should hold the token and call the API after receiving a signed observation.

## HTTP and CDN evidence is not traceroute

There is no standards-based HTTP request or response field that makes routers disclose every network hop. HTTP operates above IP routing, while traceroute depends on controlled packet TTL/hop limit and ICMP feedback.

`Server-Timing` lets a server or intermediary publish metrics and descriptions for a request-response cycle; those publishers decide what to expose. It is not a route-discovery protocol. [W3C Server Timing](https://www.w3.org/TR/server-timing/)

Likewise, `Cf-Ray` identifies a Cloudflare data center processing a request and may reflect the data center connecting to origin when Argo or Tiered Cache is involved. It does not enumerate network hops. [Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-ray)

The app's existing final URL and provider-reported CDN evidence (`cf-ray`, `x-amz-cf-pop`, `x-served-by`, `x-vercel-id`) remains the best zero-extra-request evidence about which CDN edge answered. It intentionally answers a different question from traceroute and must remain labeled as response-reported evidence.

## Alternatives and their trust boundaries

| Alternative | What it can truthfully claim | Important difference |
| --- | --- | --- |
| Native regional VM/container probe | Real traceroute from that owned host or network namespace; can also expose the HTTP socket peer IP | Best option. It measures a controlled regional vantage, but route parity is strongest only when HTTP and traceroute use the same host, resolved destination IP, address family, egress, and close timing. |
| Operator-owned regional diagnostic endpoint or egress proxy | Trace from an operator-controlled diagnostic host; proxy may expose its connected peer IP | Trustworthy for that host/proxy, not for the Cloudflare Worker path unless all target traffic is deliberately routed through that proxy—which changes the monitored path. |
| Cloudflare Diagnostics Traceroute API | Trace from Cloudflare's diagnostic infrastructure in selected colos | Useful Cloudflare-colo approximation, but not the exact Worker Fetch path; requires account eligibility and Magic Transit Write permission. Use a distinct name and record source colo, target IP, method, and timestamp. |
| External traceroute API | Trace from the vendor's advertised probes | Adds a vendor, credential, availability, retention, and billing dependency. It measures the vendor's route, not the Worker region. Results are only as trustworthy as the vendor's source-attestation model. |
| DEX or Cloudflare WAN diagnostics | Trace from an enrolled device or Cloudflare WAN context | Valid for those products' source/target topology, not a general public URL check from a Worker. |
| Existing final URL/CDN headers | Provider-reported serving-edge evidence without extra requests | No hops or socket peer IP; origin-controlled headers can be spoofed. Lowest cost and already aligned with the current architecture. |

Cloudflare Tunnel's own diagnostic documentation reinforces the native-host distinction: on Linux, traceroute data is unavailable unless the host grants the `traceroute` binary raw/packet socket capability. [Cloudflare Tunnel diagnostic logs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/diag-logs/)

## Security, abuse, storage, and cost requirements

If a future native-probe adapter supports opt-in traceroute, the checkbox must not turn every ordinary URL check into an unbounded network scan. Apply these controls:

- Use the same signed job identity, URL policy, DNS resolution, redirect validation, and forbidden-address rules as HTTP probes. Revalidate the selected final public IP immediately before tracing; never accept a separate arbitrary trace target from the browser.
- Trace the exact resolved public IP and address family actually used by the native HTTP request when possible. Store the hostname and resolved IP separately. Never trace private, loopback, link-local, multicast, reserved, metadata-service, or post-redirect forbidden addresses.
- Permit only one bounded diagnostic per monitor/region on a separate cadence—for example, at most hourly—even when HTTP checks run every minute. Make this cadence explicit in the UI request estimate; do not hide the additional traffic behind the ordinary check count.
- Cap at 20–30 hops, one probe per hop by default, a 500–1,000 ms per-probe timeout, and a strict 15–30 second total deadline. Limit concurrency globally and per destination/account. Do not automatically retry a completed diagnostic.
- Prefer unprivileged UDP where the host platform supports it; if ICMP/raw sockets are required, isolate the helper, drop all unrelated capabilities, and never interpolate user input into a shell command.
- Store a structured, versioned result: source probe ID/region, source IP when available, target hostname/IP/address family, protocol, timestamp, hop TTL, responding IP, RTT, timeout marker, and completion reason. Bound names/annotations and hop counts. Do not store raw command output as trusted HTML.
- Treat hop IPs and reverse-DNS names as untrusted data. Escape them in the UI and avoid automatic links. IP geolocation/ASN enrichment is inference and must carry provider and lookup timestamp.
- Make diagnostics best-effort and independent from uptime state. Router ICMP filtering, MPLS, asymmetric routing, load balancing, and silent hops are normal; a partial trace must never change an HTTP observation from up to down.
- Account separately for diagnostic packets, API requests, database growth, retention, and third-party charges. A one-minute monitor in three regions would otherwise trigger 4,320 traceroutes per day, potentially tens of thousands of packets and large history rows.

## Recommendation

**Defer real traceroute until a native regional probe adapter.** Do not implement the requested checkbox in the current Worker monitor form because the Worker cannot perform what the label promises.

If Cloudflare account access makes the Diagnostics API attractive, implement it later as an optional, control-plane-owned provider named **Cloudflare colo diagnostic trace**, with an independent hourly-or-slower cadence and a clear “approximate Cloudflare colo path; not the HTTP request path” label. Do not put its API token in Workers, do not run it for every normal check, and do not present its target IP as the actual peer used by `fetch()`.

Until native probes exist, keep the current final URL and provider-reported CDN/PoP evidence as the default low-cost diagnostic signal.
