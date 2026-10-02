// Generates every deploy/cloudflare/wrangler.*.toml from the region registry.
// Run `pnpm generate:wrangler` after changing regions or the probe version.
// Requires Node 24+ (native TypeScript imports). Supports `--check` for CI.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { regions } from '../packages/regions/src/index.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configDir = join(repoRoot, 'deploy', 'cloudflare');
const probeVersion = (
  JSON.parse(readFileSync(join(repoRoot, 'apps', 'probe-worker', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;
// Wrangler validates this date; bump only when adopting new Workers runtime behavior.
const compatibilityDate = '2026-08-30';

function renderToml(region: (typeof regions)[number]): string {
  return `name = "${region.workerName}"
main = "../../apps/probe-worker/src/index.ts"
compatibility_date = "${compatibilityDate}"
workers_dev = true

[observability]
enabled = true

[placement]
region = "${region.placementRegion}"

[vars]
PROBE_REGION = "${region.id}"
PROBE_REQUEST_MAX_SKEW_SECONDS = "60"
PROBE_MAX_REQUEST_BYTES = "65536"
PROBE_VERSION = "${probeVersion}"

# PROBE_SIGNING_SECRET is set with \`wrangler secret put\`, never in this repository.
`;
}

const checkOnly = process.argv.includes('--check');
let mismatched = 0;
for (const region of regions) {
  const path = join(configDir, region.wranglerConfigBasename);
  const expected = renderToml(region);
  if (checkOnly) {
    if (readFileSync(path, 'utf8') !== expected) {
      console.error(`generate-wrangler: ${region.wranglerConfigBasename} is stale`);
      mismatched += 1;
    }
    continue;
  }
  writeFileSync(path, expected);
  console.error(`generate-wrangler: wrote ${region.wranglerConfigBasename}`);
}
if (checkOnly && mismatched > 0) {
  console.error('generate-wrangler: run `pnpm generate:wrangler` to refresh');
  process.exit(1);
}
