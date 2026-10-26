import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  hashSessionToken,
  type CloudflareEnv,
} from '@uptime/cloudflare';
import {
  parsePostgresRuntimeCatalog,
  quotePostgresIdentifier,
  type Database,
  type RuntimePostgresProfile,
} from '@uptime/cloudflare/postgres';
import { createRuntimeFixture } from './testing/runtime-fixture.js';
import { hostedFetch } from './hosted-app.js';
import { recordInterest, recordInterestSignupStart } from './interest.js';

let fixture: Awaited<ReturnType<typeof createRuntimeFixture>>;
let usedTenants = new Set<number>();

beforeAll(async () => {
  fixture = await createRuntimeFixture(['full-hosted', 'full-hosted']);
}, 180_000);

afterAll(async () => {
  await fixture?.close();
}, 180_000);

describe('invite-only signup flow e2e', { timeout: 120_000 }, () => {
  it('exercises complete lifecycle: interest request, operator admission, workspace creation, first monitor, alert destination test, and status page publish', async () => {
    const context = await createHostedContext();
    context.env.INTEREST_CHECK_ONLY = 'true';

    const operator = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'operator.test',
    );
    Object.assign(context.env, { OPERATOR_DIDS: operator.did });

    const applicant = await authenticatedCookie(
      context.control,
      'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
      'applicant.test',
    );

    // ------------------------------------------------------------------------
    // (1) Signup / interest request
    // ------------------------------------------------------------------------
    const initialInterest = await fetchHosted(context, '/api/interest/session', applicant.cookie);
    expect(initialInterest.status).toBe(200);
    expect(await initialInterest.json()).toEqual({ signup: null });

    await recordInterestSignupStart(context.controlDb, 'invite-campaign');
    await recordInterest(
      context.controlDb,
      { did: applicant.did, handle: applicant.handle },
      new Date(),
      'invite-campaign',
    );

    const recordedInterest = await fetchHosted(context, '/api/interest/session', applicant.cookie);
    expect(recordedInterest.status).toBe(200);
    expect(await recordedInterest.json()).toMatchObject({
      signup: {
        did: applicant.did,
        handle: applicant.handle,
        channel: 'invite-campaign',
      },
    });

    // Before operator admission, direct app session access is blocked
    const unadmittedAccess = await fetchHosted(context, '/api/auth/session', applicant.cookie);
    expect(unadmittedAccess.status).toBe(403);
    expect(await unadmittedAccess.json()).toMatchObject({
      error: { code: 'product_not_released' },
    });

    // Operator inspects waiting interest signups
    const operatorInterest = await fetchHosted(context, '/api/operator/interest', operator.cookie);
    expect(operatorInterest.status).toBe(200);
    const signups = ((await operatorInterest.json()) as { signups: { did: string; handle: string }[] }).signups;
    expect(signups.some((s) => s.did === applicant.did && s.handle === applicant.handle)).toBe(true);

    const workspaceCountBefore = await context.control.query(
      `SELECT count(*)::integer AS count FROM ${context.control.table('workspaces')} WHERE owner_did = $1`,
      [applicant.did],
    );
    expect(workspaceCountBefore.rows[0]?.count).toBe(0);

    // ------------------------------------------------------------------------
    // (2) Manual operator admission
    // ------------------------------------------------------------------------
    const admissionResponse = await fetchHosted(
      context,
      '/api/operator/slots/TENANT_ONE/assignment',
      operator.cookie,
      {},
      {
        method: 'POST',
        body: JSON.stringify({ ownerDid: applicant.did }),
      },
    );
    expect(admissionResponse.status).toBe(200);
    const admission = (await admissionResponse.json()) as {
      workspaceId: string;
      state: string;
      bindingName: string;
      ownerDid: string;
      ownerHandle: string;
    };
    expect(admission.state).toBe('active');
    expect(admission.bindingName).toBe('TENANT_ONE');
    expect(admission.ownerDid).toBe(applicant.did);
    expect(admission.ownerHandle).toBe(applicant.handle);
    const workspaceId = admission.workspaceId;
    expect(workspaceId).toBeDefined();

    // ------------------------------------------------------------------------
    // (3) Workspace creation & verified session access
    // ------------------------------------------------------------------------
    const sessionResponse = await fetchHosted(context, '/api/auth/session', applicant.cookie);
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as {
      user: { did: string; handle: string };
      workspace: { id: string; state: string; plan: string };
      role: string;
    };
    expect(session.user.did).toBe(applicant.did);
    expect(session.workspace.id).toBe(workspaceId);
    expect(session.workspace.state).toBe('active');
    expect(session.workspace.plan).toBe('free');
    expect(session.role).toBe('owner');

    const tenantMetadata = await context.tenant.query(
      `SELECT workspace_id, plan FROM ${context.tenant.table('workspace_metadata')} WHERE id = 1`,
    );
    expect(tenantMetadata.rows[0]).toEqual({
      workspace_id: workspaceId,
      plan: 'free',
    });

    // ------------------------------------------------------------------------
    // (4) First monitor creation
    // ------------------------------------------------------------------------
    const createMonitorResponse = await fetchHosted(
      context,
      '/api/monitors',
      applicant.cookie,
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'Primary API Health',
          url: 'https://api.example.com/health',
          regionIds: ['us-east'],
          intervalSeconds: 300,
          timeoutMs: 10000,
          outageThreshold: 2,
          recoveryThreshold: 1,
        }),
      },
    );
    expect(createMonitorResponse.status).toBe(201);
    const createdMonitor = (await createMonitorResponse.json()) as {
      summary: { monitor: { id: string; name: string } };
    };
    const monitorId = createdMonitor.summary.monitor.id;
    expect(monitorId).toBeDefined();
    expect(createdMonitor.summary.monitor.name).toBe('Primary API Health');

    const monitorListResponse = await fetchHosted(context, '/api/monitors', applicant.cookie);
    expect(monitorListResponse.status).toBe(200);
    const monitorsList = (await monitorListResponse.json()) as {
      monitors: Array<{ monitor: { id: string; name: string } }>;
    };
    expect(monitorsList.monitors.some((m) => m.monitor.id === monitorId)).toBe(true);

    // ------------------------------------------------------------------------
    // (5) Alert-destination test (isolated fake fetch, no live network)
    // ------------------------------------------------------------------------
    const webhookUrl = 'https://discord.com/api/webhooks/123456789/discord-token';
    const createDestResponse = await fetchHosted(
      context,
      '/api/notification-services',
      applicant.cookie,
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'Discord Ops Alerts',
          provider: 'discord',
          enabled: true,
          config: { webhookUrl },
        }),
      },
    );
    expect(createDestResponse.status).toBe(201);
    const destService = (await createDestResponse.json()) as { service: { id: string } };
    const destinationId = destService.service.id;
    expect(destinationId).toBeDefined();

    let deliveredWebhookUrl: string | null = null;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.startsWith('https://discord.com/api/webhooks/')) {
        deliveredWebhookUrl = url;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected network call intercepted: ${url}`);
    });

    try {
      const testDestResponse = await fetchHosted(
        context,
        `/api/notification-services/${destinationId}/test`,
        applicant.cookie,
        {},
        { method: 'POST' },
      );
      expect(testDestResponse.status).toBe(200);
      expect(await testDestResponse.json()).toEqual({ success: true });
      expect(deliveredWebhookUrl).toBe(`${webhookUrl}?wait=true`);
    } finally {
      fetchSpy.mockRestore();
    }

    // ------------------------------------------------------------------------
    // (6) Status page publish
    // ------------------------------------------------------------------------
    const createPageResponse = await fetchHosted(
      context,
      '/api/status-pages',
      applicant.cookie,
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'System Services Status',
          publicSlug: 'production-status',
          groups: [
            {
              title: 'Core API Services',
              monitorIds: [monitorId],
            },
          ],
        }),
      },
    );
    expect(createPageResponse.status).toBe(201);
    const createdPage = (await createPageResponse.json()) as {
      statusPage: { id: string; title: string; publicSlug: string };
    };
    expect(createdPage.statusPage.publicSlug).toBe('production-status');

    // Public unauthenticated viewer verifies published status page
    const publicPageResponse = await fetchHosted(
      context,
      `/api/status-pages/public/production-status?workspace=${workspaceId}`,
      '',
    );
    expect(publicPageResponse.status).toBe(200);
    const publicData = (await publicPageResponse.json()) as {
      statusPage: {
        title: string;
        publicSlug: string;
        groups: Array<{
          title: string;
          monitors: Array<{ id: string; name: string }>;
        }>;
      };
    };
    expect(publicData.statusPage.title).toBe('System Services Status');
    expect(publicData.statusPage.publicSlug).toBe('production-status');
    expect(publicData.statusPage.groups[0]?.monitors[0]?.id).toBe(monitorId);
    expect(publicData.statusPage.groups[0]?.monitors[0]?.name).toBe('Primary API Health');
  });
});

async function createHostedContext() {
  for (const database of [
    fixture.control.fixture,
    ...Array.from(usedTenants, (index) => fixture.tenants[index]!),
  ]) {
    const relations = await database.adminDb.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname=$1 AND tablename <> '_postgres_migrations'",
      [database.schema],
    );
    await database.adminDb.query(
      `TRUNCATE TABLE ${relations.rows.map(({ name }) => `${quotePostgresIdentifier(database.schema)}.${quotePostgresIdentifier(name)}`).join(', ')} CASCADE`,
    );
  }
  const control = fixture.control.db;
  await control.query(`INSERT INTO ${control.table('service_controls')}(id) VALUES(1)`);
  const env: CloudflareEnv & {
    controlDb: Database;
    catalog: ReturnType<typeof parsePostgresRuntimeCatalog>;
  } = {
    ...fixture.env,
    PUBLIC_ORIGIN: 'https://api.example.com',
    POSTGRES_RUNTIME_CATALOG: JSON.stringify({ controlSchema: control.schema, sources: [] }),
    controlDb: control,
    catalog: parsePostgresRuntimeCatalog(
      JSON.stringify({ controlSchema: control.schema, sources: [] }),
    ),
  };
  delete env.REGIONS_LIST;
  delete env.DISABLE_RATE_LIMIT;
  const context = {
    control,
    controlDb: control,
    tenant: fixture.tenants[0]!.db,
    env,
    used: new Set<number>(),
  };
  usedTenants = context.used;
  context.tenant = await addTenant(context, 'TENANT_ONE', 'tenant-one');
  return context;
}

async function addTenant(
  context: {
    control: Database;
    env: typeof fixture.env & { catalog: ReturnType<typeof parsePostgresRuntimeCatalog> };
    used: Set<number>;
  },
  bindingName: string,
  sourceDatabaseId: string,
  profile: RuntimePostgresProfile = 'full-hosted',
) {
  const index = fixture.catalog.sources.findIndex(
    (source, index) => source.profile === profile && !context.used.has(index),
  );
  if (index < 0) throw new Error('Hosted fixture pool exhausted');
  context.used.add(index);
  const tenant = fixture.tenants[index]!;
  const config = JSON.parse(context.env.POSTGRES_RUNTIME_CATALOG!);
  config.sources.push({ sourceDatabaseId, schema: tenant.schema, profile });
  context.env.POSTGRES_RUNTIME_CATALOG = JSON.stringify(config);
  context.env.catalog = parsePostgresRuntimeCatalog(context.env.POSTGRES_RUNTIME_CATALOG!);
  await context.control.query(
    `INSERT INTO ${context.control.table('postgres_tenant_registry')}(source_database_id,schema_name,status) VALUES($1,$2,'available')`,
    [sourceDatabaseId, tenant.schema],
  );
  await context.control.query(
    `INSERT INTO ${context.control.table('tenant_slots')}(binding_name,database_id,status) VALUES($1,$2,'available')`,
    [bindingName, sourceDatabaseId],
  );
  return tenant.db;
}

async function authenticatedCookie(control: Database, did: string, handle: string) {
  const token = `token-${did.slice(-8)}`;
  await control.query(
    `INSERT INTO ${control.table('atproto_login_sessions')}(token_hash, did, handle, expires_at, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      await hashSessionToken(token, 's'.repeat(32)),
      did,
      handle,
      '2099-01-01T00:00:00.000Z',
      now(),
      now(),
    ],
  );
  return { did, handle, cookie: `uptime_atproto_session=${token}` };
}

async function fetchHosted(
  context: Awaited<ReturnType<typeof createHostedContext>>,
  path: string,
  cookie: string,
  extraHeaders: Record<string, string> = {},
  init: RequestInit = {},
) {
  const pending: Promise<unknown>[] = [];
  const response = await hostedFetch(
    new Request(`https://api.example.com${path}`, {
      ...init,
      headers: { cookie, ...extraHeaders },
    }),
    context.env,
    {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext,
  );
  await Promise.all(pending);
  return response;
}

function now() {
  return '2026-10-02T12:00:00.000Z';
}
