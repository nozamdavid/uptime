# Nine-region Cloudflare Worker placement plan

**Research date:** 2026-08-30

## Conclusion

Use nine independently deployed probe Workers: three widely separated AWS-region anchors in each of North America, Europe, and Asia. The proposed topology is sound and should be kept unchanged. It preserves the three existing logical IDs and placement hints while adding six new IDs.

Cloudflare explicit Placement Hints accept AWS identifiers as `placement.region = "aws:{region}"`; Cloudflare maps each hint to the Cloudflare data center with the lowest latency to that cloud region. The Worker does **not** run inside AWS, and the hint does not pin execution to an exact city, Cloudflare PoP, IP, or immutable data center. Cloudflare can adjust the mapping during network changes or maintenance and may distribute exceptionally high-volume workloads more broadly. Placement affects `fetch` handlers, not RPC methods or named entrypoints. [Cloudflare Placement documentation](https://developers.cloudflare.com/workers/configuration/placement/)

## Recommended registry

| Stable ID | Display name | Continent group | Provider hint | Approximate anchor | Rationale | Caveat |
| --- | --- | --- | --- | --- | --- | --- |
| `us-east` | US East (N. Virginia) | North America | `aws:us-east-1` | Northern Virginia, USA | Preserves the existing eastern-US vantage; broadly separated from Oregon and central Canada. | Placement is near the AWS region, not pinned to Virginia or a particular Cloudflare colo. |
| `us-west` | US West (Oregon) | North America | `aws:us-west-2` | Oregon, USA | Adds a transcontinental western-US vantage with strong separation from the east coast. | Placement is regional affinity, not a guaranteed Oregon execution site. |
| `canada-central` | Canada Central (Montréal) | North America | `aws:ca-central-1` | Montréal, Canada | Adds a non-US northern vantage and avoids clustering another probe in the eastern United States. | AWS calls the region “Canada (Central)”; Montréal is the announced anchor, but Cloudflare may choose any lowest-latency colo nearby. |
| `eu-west` | Europe West (Ireland) | Europe | `aws:eu-west-1` | Ireland | Preserves the existing Atlantic/western-European vantage. | Placement is regional affinity, not a fixed Irish colo. |
| `eu-north` | Europe North (Stockholm) | Europe | `aws:eu-north-1` | Stockholm, Sweden | Adds a Nordic vantage far from Ireland and northern Italy. | Placement is regional affinity, not a fixed Stockholm colo. |
| `eu-south` | Europe South (Milan) | Europe | `aws:eu-south-1` | Milan, Italy | Adds a southern-European vantage and avoids the close Spain/France pairing the product owner rejected. | AWS marks Milan opt-in for AWS customers; the monitor is only using its identifier as a Cloudflare hint, but deployment should still be proven with Wrangler and observed colo telemetry. |
| `asia` | Asia Southeast (Singapore) | Asia | `aws:ap-southeast-1` | Singapore | Preserves the existing Southeast Asian vantage. | Placement is regional affinity, not a fixed Singapore colo. |
| `asia-east` | Asia East (Tokyo) | Asia | `aws:ap-northeast-1` | Tokyo, Japan | Adds an East Asian vantage with substantial distance from Singapore and Mumbai. | Placement is regional affinity, not a fixed Tokyo colo. |
| `asia-south` | Asia South (Mumbai) | Asia | `aws:ap-south-1` | Mumbai, India | Adds a South Asian vantage and forms a broad west/east/southeast Asian triangle. | Placement is regional affinity, not a fixed Mumbai colo. |

AWS's current region registry confirms all nine codes and official names: US East (N. Virginia), US West (Oregon), Canada (Central), Europe (Ireland), Europe (Stockholm), Europe (Milan), Asia Pacific (Singapore), Asia Pacific (Tokyo), and Asia Pacific (Mumbai). It identifies only Milan among these nine as requiring opt-in for an AWS account. Cloudflare says Placement Hints support AWS region identifiers and links to AWS's full registry; because these Workers do not access an AWS account, AWS opt-in is not itself a documented Cloudflare prerequisite. The conservative rollout is nevertheless to deploy/dry-run every configuration and confirm placement metadata before enabling the new vantage. [AWS Regions and Availability Zones](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html) [AWS announcement locating Canada Central in Montréal](https://aws.amazon.com/blogs/aws/in-the-works-aws-region-in-canada/)

## Why no substitutions

- **North America:** Virginia–Oregon–Montréal is preferable to adding Ohio or northern California, which would duplicate an existing US side more closely. Mexico Central would extend farther south, but AWS marks it opt-in and it is newer; central Canada preserves a mature, enabled-by-default anchor and still adds a different national/network perspective.
- **Europe:** Ireland–Stockholm–Milan deliberately spans west, north, and south. Frankfurt would be operationally conservative but geographically less diverse than Milan. London or Paris would cluster too closely with Ireland, while Spain and Paris would recreate the nearby Spain/France pairing the user explicitly wants to avoid.
- **Asia:** Singapore–Tokyo–Mumbai creates the strongest three-way spread among established, enabled-by-default AWS regions on the Asian continent. Seoul is too close to Tokyo for this goal; Jakarta is relatively close to Singapore; Sydney/Melbourne/New Zealand are Oceania rather than Asia for product grouping.

The geographic names, countries, region codes, and enabled/opt-in status above come from AWS's first-party region table. [AWS Regions and Availability Zones](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html)

## Cloudflare deployment and capacity implications

Each vantage should remain a separate Worker service with the same source and a single `[placement] region = "aws:..."` value. Cloudflare documents placement modes/targets as mutually exclusive, so the current one-deployment-per-vantage architecture remains the clear configuration model. [Cloudflare Placement documentation](https://developers.cloudflare.com/workers/configuration/placement/) [Wrangler configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/)

Nine Worker services fit comfortably within Cloudflare's current account limits of **100 Workers on Free** and **500 on Paid**. The existing probe's small variable set also remains below the per-Worker limits of 64 variables on Free and 128 on Paid. A Free account permits 100,000 Worker requests per day; Paid has no request-count limit in the account-plan table. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

At a one-minute interval, one monitor selecting all nine regions produces `9 × 1,440 = 12,960` probe invocations per day. Therefore seven such monitors produce 90,720 daily invocations, while eight produce 103,680 and exceed the Free daily request allowance before other account traffic. This is a derived planning threshold, not a separate Cloudflare quota. Lower-frequency or smaller-region selections reduce it proportionally.

The normal HTTP fetch plus bounded redirects and the optional DNS diagnostics remain below the Free plan's documented 50 subrequests per invocation. More importantly, expanding from three to nine selected regions triples checks, stored observations, and—when enabled—daily regional DNS snapshots. The UI's existing request/day estimate must continue to multiply interval executions by the selected region count.

## Rollout caveats

1. Add the six regions additively; never rename the existing IDs `us-east`, `eu-west`, or `asia`, because they are persisted in monitor selections and historical observations.
2. Deploy all nine services through HTTP `fetch` entrypoints. Do not move placed execution to RPC or named entrypoints, which Cloudflare documents as unaffected by placement. [Cloudflare Placement documentation](https://developers.cloudflare.com/workers/configuration/placement/)
3. Run Wrangler dry-runs first, then deploy and observe `cf-placement`/colo evidence for at least 24 hours. A successful configuration validates syntax; observed telemetry validates that the actual vantages remain usefully separated.
4. Describe graphs as measurements from a Cloudflare location **near** each named AWS region. Do not claim exact-city measurements.
5. All nine probes still share Cloudflare as a provider. Geographic diversity improves regional comparison but does not provide provider-independent uptime evidence.

## Primary sources

- [Cloudflare Workers: Placement](https://developers.cloudflare.com/workers/configuration/placement/)
- [Cloudflare Workers: Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers: Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [AWS Regions and Availability Zones: Available AWS Regions](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html)
- [AWS announcement: Canada region in Montréal](https://aws.amazon.com/blogs/aws/in-the-works-aws-region-in-canada/)
