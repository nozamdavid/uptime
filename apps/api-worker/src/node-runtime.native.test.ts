import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { reconcileScheduled } from './index.js';
import { loadNodeRuntime, type NodeRuntime } from './node-env.js';
import { createNodeServer, type NodeServer } from './node-server.js';
import { createRuntimeFixture } from './testing/runtime-fixture.js';

const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const gatewayToken = 'g'.repeat(32);

let fixture: Awaited<ReturnType<typeof createRuntimeFixture>>;
let runtime: NodeRuntime;
let node: NodeServer;
let base: string;
let cookie: string;

beforeAll(async () => {
  fixture = await createRuntimeFixture(['full-hosted']);
  cookie = await fixture.cookie(did);
  // Same shape as the process environment of the deployed Node API.
  runtime = loadNodeRuntime({
    PUBLIC_ORIGIN: 'https://api.test',
    ENVIRONMENT: 'test',
    POSTGRES_URL: (fixture.env.POSTGRES as unknown as { connectionString: string })
      .connectionString,
    POSTGRES_RUNTIME_CATALOG: fixture.env.POSTGRES_RUNTIME_CATALOG,
    SESSION_SECRET: fixture.env.SESSION_SECRET,
    OAUTH_STORAGE_SECRET: fixture.env.OAUTH_STORAGE_SECRET,
    CREDENTIAL_ENCRYPTION_SECRET: fixture.env.CREDENTIAL_ENCRYPTION_SECRET,
    REGIONS_LIST: fixture.env.REGIONS_LIST,
    BILLING_MODE: 'mock',
    OPERATOR_DIDS: did,
    API_GATEWAY_TOKEN: gatewayToken,
    API_TRUSTED_PROXIES: '127.0.0.1,::1',
  } as NodeJS.ProcessEnv);
  node = createNodeServer(runtime);
  await new Promise<void>((resolve) => node.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise((resolve) => node.server?.close(resolve));
  await fixture?.close();
}, 120_000);

describe('node runtime against PostgreSQL', () => {
  it('serves health and an ordinary database request through Node', async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const headers = { cookie, 'x-uptime-gateway-token': gatewayToken };
    expect((await fetch(`${base}/api/operator/workspaces`, { headers: { cookie } })).status).toBe(
      403,
    );
    const workspaces = await fetch(`${base}/api/operator/workspaces`, { headers });
    expect(workspaces.status).toBe(200);
    expect(await workspaces.json()).toHaveProperty('workspaces');
  });

  it('runs scheduled reconciliation with the Node environment', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(reconcileScheduled(runtime.env)).resolves.toBeUndefined();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
