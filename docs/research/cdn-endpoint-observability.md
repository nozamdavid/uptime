# CDN endpoint observability from Cloudflare Workers

_Researched 2026-08-30. Scope: official Cloudflare runtime/network documentation and first-party CDN documentation._

## Conclusion

The monitor can reliably record the **final HTTP URL after redirects** and can collect **best-effort CDN evidence from the final response headers**. It cannot, through the ordinary Cloudflare Workers `fetch()` API, obtain the actual remote socket IP, the DNS answer selected by `fetch()`, the TLS peer certificate/connection details, or an internal “CDN URL.” The documented Worker `Response` exposes the Fetch API response plus a small Cloudflare-specific `cf` property, but no remote-address, DNS, or TLS-peer field; the documented `fetch()` API likewise exposes no connection-info result. This is a conclusion from the documented API surface, not a claim about Cloudflare's private network telemetry. [Workers Response API](https://developers.cloudflare.com/workers/runtime-apis/response/) and [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) define that surface.

Therefore the product should not show a field called **Final endpoint IP** as a measured fact. A useful and honest MVP is:

- **Final URL** — observed directly while manually following redirects; already implemented by this project.
- **CDN evidence** — a small allowlist of response-header values, parsed into provider/POP hints when recognized.
- **DNS candidates** — optional A/AAAA/CNAME observations from a separate DNS query, explicitly labeled as candidates rather than the connection endpoint.
- **Inferred location** — a POP-code mapping or IP-geolocation estimate with source and confidence, never an assertion of physical socket location.

That is enough to answer the practical question as: **“The EU probe received a response carrying provider-authored evidence for a European edge”**, not **“we proved the TCP connection terminated at this European IP/server.”**

## What is directly observable

### Final redirect URL

The project already performs `fetch(..., { redirect: "manual" })`, validates each `Location`, and stores the last requested URL as `finalUrl`. This is the actual URL selected by the monitor's redirect traversal. It may still be a customer hostname fronted by a CDN; CDNs normally do not redirect visitors to a unique edge-server URL.

This field is strong evidence for application-layer routing only. It does not expose which DNS answer or network endpoint served it.

### Final response headers

The Worker can read the final `Response.headers`. A provider-specific allowlist can yield useful evidence:

| Provider | Evidence to retain | Official meaning | Important qualification |
|---|---|---|---|
| Cloudflare | `cf-ray`, optionally `cf-cache-status`, `server` | Cloudflare says the suffix of response `Cf-Ray` is the three-letter code of the data center processing the request. With Argo or Tiered Cache, it may instead reflect the data center connecting to origin. [Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-ray) | Strong provider/colo evidence for the response path, but the suffix is not an IP and may describe a different hop under tiering. Cloudflare notes Ray IDs are not guaranteed unique. [Ray ID reference](https://developers.cloudflare.com/fundamentals/reference/cloudflare-ray-id/) |
| Amazon CloudFront | `x-amz-cf-pop`, `x-cache`, optionally `server-timing` | AWS examples show `X-Amz-Cf-Pop` as a CloudFront response header. CloudFront's optional `Server-Timing` `cdn-pop` metric is explicitly the POP that handled the request. [CloudFront function response example](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-tutorial.html#functions-tutorial-verify) and [CloudFront Server-Timing semantics](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/understanding-response-headers-policies.html#server-timing-header) | `Server-Timing` must be enabled by the distribution owner and may be sampled. POP codes identify CloudFront locations, not the origin and not necessarily a single physical server.
| Fastly | `x-served-by`, optionally `x-cache`, `x-cache-hits` | Fastly says `X-Served-By` identifies the cache server acting as delivery node and embeds a datacenter code. With shielding or Next-gen WAF there can be multiple identities. [Fastly X-Served-By](https://www.fastly.com/documentation/reference/http/http-headers/X-Served-By/) | Fastly warns nodes move, identifiers/codes can be reused, and values should not be compared as stable identity over time. On shielded cached responses, an upstream entry can describe when an object was originally cached rather than the current request. [Fastly shielding diagnostics](https://www.fastly.com/documentation/guides/concepts/shielding/#debugging)
| Vercel | `x-vercel-id` when present in the response | Vercel says this response header reveals the edge region handling a request and any function execution region; its request-header reference describes it as the list of Vercel regions hit. [Vercel request path](https://vercel.com/blog/life-of-a-vercel-request-navigating-the-edge-network) and [Vercel header reference](https://vercel.com/docs/headers/request-headers#x-vercel-id) | Treat the value as a Vercel path hint, not an IP or proof of where a separate origin ran.
| Akamai | only opt-in/debug results, if deliberately requested | Akamai documents `Pragma: akamai-x-cache-on` producing `X-Cache`, and related diagnostic pragma headers. [Akamai Pragma headers](https://techdocs.akamai.com/edge-diagnostics/docs/pragma-headers) | Do not send diagnostic pragma headers by default: they change the request and can expose cache keys, serials, or request identifiers. Ordinary responses do not provide a simple documented geographic POP header in the reviewed source.

Fly.io's `Fly-Region` is documented as a header added to the **request delivered to the application**, describing the original incoming connection region; it is not documented as a general response header available to this monitor. [Fly public-service headers](https://fly.io/docs/networking/services/#http-connection-handler) Accordingly it should not be parsed from arbitrary responses as a first-party contract unless the application deliberately echoes it.

These headers are materially better than IP geolocation for the question “which CDN edge handled this response,” because the CDN itself defines their semantics. They remain best-effort: a target can remove them; intermediary behavior can change them; a non-CDN origin can emit the same header names; and any arbitrary monitored server can spoof header values. Detection should therefore be labeled **response-reported**, not cryptographically verified.

## What is not directly observable

### Actual fetch socket endpoint and TLS peer

The reviewed Workers `fetch()` and `Response` references expose no remote IP/port, chosen DNS answer, connection-reuse flag, TLS peer certificate, ALPN, or DNS/TCP/TLS phase data. [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) and [Workers Response API](https://developers.cloudflare.com/workers/runtime-apis/response/) Consequently:

- a value obtained through DNS cannot be claimed as the address used by `fetch()`;
- a redirect-resolved URL is not a CDN node URL;
- timing cannot be assigned to DNS/TCP/TLS phases from this API;
- raw TCP `connect()` would create a different request path and would not reveal what the HTTP `fetch()` used.

Cloudflare's `resolveOverride` can direct an outbound request's origin resolution to another hostname, but it controls routing rather than reporting the address that was selected. [Workers Request `cf` options](https://developers.cloudflare.com/workers/runtime-apis/request/#requestinitcfproperties)

### DNS observations

Workers now support most of `node:dns` by issuing DNS-over-HTTPS queries to Cloudflare 1.1.1.1. `resolve4`, `resolve6`, and CNAME-oriented resolver methods can be used, while `lookup`, `lookupService`, and `resolve` are not implemented. Each DNS request consumes a Worker subrequest. [Workers `node:dns`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/)

The Worker can also call Cloudflare's public DoH endpoint directly. Cloudflare supports RFC wire-format queries and a JSON format, but warns that the JSON schema has no formal RFC and can vary; wire format is recommended for critical use. [Cloudflare DoH API](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/) and [DoH JSON warning](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)

These mechanisms can record what **a separate Cloudflare resolver query** returned at approximately the same time. They do not prove what the `fetch()` implementation used because:

- the HTTP stack can use a cached DNS result or an existing pooled connection;
- answers can rotate between queries and vary by resolver location or ECS policy;
- CNAME traversal can end in several A/AAAA candidates;
- anycast allows one address to be announced by many physical sites.

Cloudflare explains that its proxied hostnames return shared Anycast addresses, where the same IP is announced from data centers worldwide. [Cloudflare IP addresses](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/) Its CDN architecture reference likewise distinguishes DNS-unicast selection from Anycast routing and explains that DNS-based selection may follow the recursive resolver rather than the client. [Cloudflare CDN architecture](https://developers.cloudflare.com/reference-architecture/architectures/cdn/#routing-requests-to-cdn-nodes) Thus even an accurate A/AAAA answer often cannot locate a CDN edge.

## Can the product say “the EU probe hit Europe?”

Use a tiered answer:

1. **High confidence, provider-reported POP:** a recognized, documented provider header contains a POP code mapped using that provider's current location list. UI: “Response reported CloudFront POP DUB2 (Europe).” This proves the response carried that provider evidence; it does not prove a unique physical server/IP.
2. **Medium confidence, provider/path evidence without a resolved mapping:** recognized header identifies the CDN but its code is unknown, multi-hop, or ambiguous. UI: “Fastly path reported IAD → LHR; current serving-edge interpretation: LHR.” Preserve the raw bounded value for debugging.
3. **Low confidence, DNS/IP inference:** separately resolved candidate addresses are geolocated to Europe. UI: “DNS candidate IP geolocates to Europe (not the fetch endpoint).” Never use this alone for compliance, routing assertions, or incident failure.
4. **Unknown:** no recognized evidence. Absence must not mean “not a CDN” or “wrong region.”

IP geolocation is explicitly an estimate: Cloudflare says no physical location is inherently bound to an IP and provides no accuracy SLA; it advises against using IP geolocation as the sole signal for precise or compliance-critical location. [Cloudflare IP geolocation limitations](https://developers.cloudflare.com/network/ip-geolocation/#accuracy-and-limitations) Cloudflare also notes that Anycast traffic may be routed somewhere other than the geographically closest facility when reliability requires it. [Cloudflare geographic routing](https://developers.cloudflare.com/support/troubleshooting/general-troubleshooting/geographic-traffic-routing/)

The desired assertion can therefore be presented as an observational comparison—EU/US/Asia probes received provider-reported POP evidence in these continents—not as a guarantee that bytes never left a jurisdiction.

## Recommended data model and labels

Keep raw and inferred data separate so future parsers do not rewrite history:

```text
observed_final_url             URL | null     // direct HTTP observation
cdn_evidence_provider         enum | null    // cloudflare, cloudfront, fastly, vercel, akamai
cdn_evidence_header           text | null    // e.g. cf-ray; allowlisted only
cdn_evidence_value            text | null    // bounded/sanitized raw value
cdn_pop_code                  text | null    // parser output
cdn_pop_continent             text | null    // mapping output, if known
cdn_evidence_confidence       enum           // provider_reported, inferred, unknown
cdn_evidence_source_version   text | null    // parser/mapping version
dns_observed_at               timestamp | null
dns_cname_chain               json | null    // bounded names, TTLs where returned
dns_candidate_ips             json | null    // bounded A/AAAA + TTL, never "connected IP"
ip_geo_provider               text | null
ip_geo_country/continent      text | null
ip_geo_accuracy_radius_km     integer | null
```

Recommended UI terms:

- **Final URL**
- **CDN response evidence**
- **Reported edge / POP**
- **Inferred continent**
- **DNS candidates (not connection IPs)**
- **No CDN evidence reported**

Avoid **CDN URL**, **final endpoint**, **connected IP**, **physical server**, and **verified location** unless a future probe platform provides socket-level telemetry.

Do not store all response headers. Store only a fixed allowlist, lowercase header name, bounded value (for example 512 bytes), parsed result, and parser version. General headers can include cookies, authorization-derived application data, tracing identifiers, internal infrastructure names, and customer information. Ray IDs, CloudFront request IDs, and similar values are useful for debugging but increase history cardinality and retention footprint; store them only if the UI needs per-request correlation and expire them with raw observation retention.

DNS/geo enrichment must be isolated from availability: query failure must not turn an otherwise successful check into a failure. Revalidate every redirect target before any DNS enrichment, preserve the existing SSRF controls, bound CNAME depth and answer counts, reject private/special-use addresses before geolocation calls, and apply strict timeouts. Each `node:dns`/DoH lookup consumes subrequest budget, and an external geolocation API adds latency, cost, availability dependency, and disclosure of monitored host IPs. [Workers DNS subrequest accounting](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/) and [Workers subrequest limits](https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits)

## Recommended scope

### MVP

Implement without additional network calls:

1. Keep the current manually observed `finalUrl` and redirect count.
2. Capture only final-response `cf-ray`, `cf-cache-status`, `x-amz-cf-pop`, `x-cache`, `x-served-by`, `x-cache-hits`, `x-vercel-id`, and bounded `server`/`via` hints.
3. Parse Cloudflare, CloudFront, Fastly, and Vercel evidence into provider, raw reported path/POP, inferred continent, confidence=`provider_reported`, and parser version.
4. Show the raw evidence and an explicit label such as “Response reported a European CDN edge.” Show `Unknown` when absent or unparseable.
5. Never let evidence collection affect check success, timeout, or latency timing; capture headers after `fetch()` resolves and before the bounded body read.

This directly addresses regional CDN comparison with no extra DNS/geolocation service, little cost, and the strongest evidence available inside ordinary Workers.

### Deferred

- **DNS candidates:** add opt-in `node:dns` A/AAAA/CNAME observations only if users need DNS-change diagnostics. Run after the measured fetch, cap the work, and display separately from the request endpoint.
- **IP geolocation:** add only to DNS candidates, with provider, lookup timestamp, accuracy radius/confidence where available, cache, retention policy, and a prominent inference label.
- **Akamai active diagnostics:** opt-in per monitor, never default, because diagnostic request headers alter the request and may reveal operational values.
- **Socket-truth probes:** if exact remote IP/TLS peer becomes a hard requirement, add self-managed regional VM/container probes using a lower-level HTTP client that exposes socket and DNS telemetry. Those would be a separate probe type and measurement path, not an enhancement Workers currently document for `fetch()`.

The MVP should be described as **CDN edge evidence and inferred locality**, not endpoint-location proof.
