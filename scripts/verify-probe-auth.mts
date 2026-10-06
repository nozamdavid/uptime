/**
 * Verify production probe credentials across all regions:
 *   PROBE_SIGNING_SECRET=... node scripts/verify-probe-auth.mts
 * Optional settings: WORKERS_URL_DOMAIN (default david-8af.workers.dev) and
 * PROBE_WORKER_NAME_PREFIX (default uptime-probe-).
 */
import { createHmac, randomUUID } from 'node:crypto';

const regionIds = [
  'us-east',
  'us-west',
  'canada-central',
  'eu-west',
  'eu-north',
  'eu-south',
  'asia',
  'asia-east',
  'asia-south',
] as const;

const secret = process.env.PROBE_SIGNING_SECRET;
const domain = process.env.WORKERS_URL_DOMAIN ?? 'david-8af.workers.dev';
const workerPrefix = process.env.PROBE_WORKER_NAME_PREFIX ?? 'uptime-probe-';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: PROBE_SIGNING_SECRET=... node scripts/verify-probe-auth.mts [--help]\n' +
      'Checks signed single-item batches against all nine regional probe Workers. ' +
      'Optional: WORKERS_URL_DOMAIN, PROBE_WORKER_NAME_PREFIX.',
  );
  process.exit(0);
}

if (!secret) {
  console.error('PROBE_SIGNING_SECRET is required.');
  process.exit(2);
}
const signingSecret = secret;

if (!domain || domain.includes('/') || domain.includes(':')) {
  console.error('WORKERS_URL_DOMAIN must be a hostname without a scheme or port.');
  process.exit(2);
}

const now = new Date().toISOString();
const timeoutMs = 5_000;

async function verifyRegion(regionId: (typeof regionIds)[number]): Promise<string | null> {
  const requestId = randomUUID();
  const checkRunId = randomUUID();
  const monitorId = randomUUID();
  const body = JSON.stringify({
    requestId,
    issuedAt: now,
    regionId,
    items: [
      {
        checkRunId,
        monitorId,
        windowStartedAt: now,
        url: 'https://example.com/',
        timeoutMs,
        method: 'GET',
        maxRedirects: 5,
        maxBodyBytes: 65_536,
      },
    ],
  });
  const signature = createHmac('sha256', signingSecret)
    .update(`v1\n${now}\n${requestId}\n${body}`)
    .digest('base64url');
  const endpoint = `https://${workerPrefix}${regionId}.${domain}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-uptime-signature-version': 'v1',
        'x-uptime-issued-at': now,
        'x-uptime-request-id': requestId,
        'x-uptime-signature': signature,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 200) return `HTTP ${response.status}`;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return 'response was not valid JSON';
    }
    if (payload === null || typeof payload !== 'object') {
      return 'response did not match the probe batch contract';
    }
    const envelope = payload as Record<string, unknown>;
    if (
      envelope.requestId !== requestId ||
      envelope.regionId !== regionId ||
      !Array.isArray(envelope.results)
    ) {
      return 'response request or region identity did not match';
    }
    if (envelope.results.length !== 1) {
      return 'response did not contain the requested single result';
    }
    const firstResult: unknown = envelope.results[0];
    if (firstResult === null || typeof firstResult !== 'object') {
      return 'response did not contain the requested single result';
    }
    const resultRecord = firstResult as Record<string, unknown>;
    if (
      resultRecord.checkRunId !== checkRunId ||
      resultRecord.monitorId !== monitorId ||
      !('response' in resultRecord)
    ) {
      return 'response did not contain the requested single result';
    }
    const result = resultRecord.response;
    if (
      result === null ||
      typeof result !== 'object' ||
      !('regionId' in result) ||
      result.regionId !== regionId
    ) {
      return 'probe result region did not match';
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'request failed';
  }
}

const outcomes = await Promise.all(
  regionIds.map(async (regionId) => [regionId, await verifyRegion(regionId)] as const),
);
let failures = 0;
for (const [regionId, error] of outcomes) {
  if (error) {
    failures += 1;
    console.error(`FAIL ${regionId}: ${error}`);
  } else {
    console.log(`PASS ${regionId}`);
  }
}

if (failures > 0) {
  console.error(`${failures} of ${regionIds.length} regional auth checks failed.`);
  process.exitCode = 1;
} else {
  console.log(`All ${regionIds.length} regional auth checks passed.`);
}
