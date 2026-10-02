import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { hashSessionToken, type R2Bucket } from '@uptime/cloudflare';
import { createD1Adapter, createTestDatabase } from '@uptime/cloudflare/testing';

import { consumeBudget, ensureWorkspace, hostedFetch } from './hosted-app.js';

const controlSchema = readFileSync(
  new URL('../../../packages/cloudflare/src/control-migrations/0001_control.sql', import.meta.url),
  'utf8',
);
const databases: ReturnType<typeof createTestDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('hosted control plane', () => {
  it('uses a DID-only principal DTO and ignores an inaccessible workspace header', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
      'owner.bsky.social',
    );
    const response = await fetchHosted(context, '/api/auth/session', owner.cookie);
    expect(response.status).toBe(200);
    const session = (await response.json()) as {
      user: Record<string, unknown>;
      workspace: { id: string };
    };
    expect(session.user).toEqual({ did: owner.did, handle: 'owner.bsky.social' });
    expect(session.user).not.toHaveProperty('email');

    context.control
      .prepare(
        `INSERT INTO users(did, handle, state, created_at, updated_at, last_seen_at)
       VALUES ('did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', 'other.bsky.social', 'active', ?, ?, ?)`,
      )
      .run(now(), now(), now());
    context.control
      .prepare(
        `INSERT INTO workspaces(id, owner_did, name, state, plan, created_at, updated_at)
       VALUES ('11111111-1111-4111-8111-111111111111', 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', 'Other', 'active', 'free', ?, ?)`,
      )
      .run(now(), now());

    const denied = await fetchHosted(context, '/api/monitors', owner.cookie, {
      'x-uptime-workspace': '11111111-1111-4111-8111-111111111111',
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('blocks suspended users before provisioning or tenant dispatch', async () => {
    const context = await createHostedContext();
    const user = await authenticatedCookie(
      context.control,
      'did:plc:cccccccccccccccccccccccc',
      'suspended.bsky.social',
    );
    context.control
      .prepare(
        `INSERT INTO users(did, handle, state, created_at, updated_at, last_seen_at)
       VALUES (?, ?, 'suspended', ?, ?, ?)`,
      )
      .run(user.did, 'suspended.bsky.social', now(), now(), now());

    const response = await fetchHosted(context, '/api/auth/session', user.cookie);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'account_suspended',
    );
    expect(
      context.control
        .prepare('SELECT count(*) AS count FROM workspaces WHERE owner_did = ?')
        .get(user.did),
    ).toEqual({ count: 0 });
  });

  it('atomically caps distributed request budgets', async () => {
    const context = await createHostedContext();
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => consumeBudget(context.controlDb, 'test:did', 5, 60)),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(5);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(3);
    const row = context.control
      .prepare('SELECT count FROM request_budgets WHERE key = ?')
      .get('test:did') as { count: number };
    expect(row.count).toBe(5);
  });

  it('allocates one empty tenant slot per owner and verifies tenant identity', async () => {
    const context = await createHostedContext();
    const principal = { did: 'did:plc:dddddddddddddddddddddddd', handle: 'new.bsky.social' };
    const first = await ensureWorkspace(context.env, principal);
    const second = await ensureWorkspace(context.env, principal);
    expect(first.id).toBe(second.id);
    expect(first.state).toBe('active');
    expect(
      context.control
        .prepare('SELECT count(*) AS count FROM tenant_slots WHERE status = ?')
        .get('assigned'),
    ).toEqual({ count: 1 });
    expect(
      context.tenant
        .prepare('SELECT workspace_id, plan FROM workspace_metadata WHERE id = 1')
        .get(),
    ).toEqual({
      workspace_id: first.id,
      plan: 'free',
    });
  });

  it('keeps free monitor quotas in the tenant database transaction', async () => {
    const context = await createHostedContext();
    const workspace = await ensureWorkspace(context.env, {
      did: 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee',
      handle: 'quota.bsky.social',
    });
    const insert = context.tenant.prepare(
      `INSERT INTO monitors (id, name, url, interval_seconds, timeout_ms, enabled,
        dns_diagnostics_enabled, uptime_thresholds, outage_threshold, recovery_threshold, next_check_at)
       VALUES (?, 'm', 'https://example.com', 300, 10000, 1, 0, '{}', 2, 1, ?)`,
    );
    for (let index = 0; index < 3; index += 1)
      insert.run(`00000000-0000-4000-8000-00000000000${index}`, now());
    expect(() => insert.run('00000000-0000-4000-8000-000000000009', now())).toThrow(
      'free_monitor_limit',
    );
    expect(workspace.state).toBe('active');
  });

  it('denies viewer writes even when they select a workspace they can read', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:ffffffffffffffffffffffff',
      'owner.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const viewer = await authenticatedCookie(
      context.control,
      'did:plc:gggggggggggggggggggggggg',
      'viewer.bsky.social',
    );
    context.control
      .prepare(
        `INSERT INTO users(did, handle, state, created_at, updated_at, last_seen_at)
       VALUES (?, ?, 'active', ?, ?, ?)`,
      )
      .run(viewer.did, 'viewer.bsky.social', now(), now(), now());
    context.control
      .prepare('INSERT INTO memberships(workspace_id, did, role, created_at) VALUES (?, ?, ?, ?)')
      .run(workspaceId, viewer.did, 'viewer', now());

    const response = await hostedFetch(
      new Request('https://api.example.com/api/monitors', {
        method: 'POST',
        headers: { cookie: viewer.cookie, 'x-uptime-workspace': workspaceId },
        body: JSON.stringify({}),
      }),
      context.env,
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('leaves one concurrent workspace allocation waiting when only one slot exists', async () => {
    const context = await createHostedContext();
    const [one, two] = await Promise.all([
      ensureWorkspace(context.env, {
        did: 'did:plc:hhhhhhhhhhhhhhhhhhhhhhhh',
        handle: 'one.bsky.social',
      }),
      ensureWorkspace(context.env, {
        did: 'did:plc:iiiiiiiiiiiiiiiiiiiiiiii',
        handle: 'two.bsky.social',
      }),
    ]);
    expect([one.state, two.state].sort()).toEqual(['active', 'waiting_for_capacity']);
    expect(
      context.control
        .prepare("SELECT count(*) AS count FROM tenant_slots WHERE status = 'assigned'")
        .get(),
    ).toEqual({ count: 1 });
  });

  it('deletes populated tenant rows before marking a workspace deleted', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:jjjjjjjjjjjjjjjjjjjjjjjj',
      'delete.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    context.tenant
      .prepare(
        `INSERT INTO monitors (id, name, url, interval_seconds, timeout_ms, enabled,
        dns_diagnostics_enabled, uptime_thresholds, outage_threshold, recovery_threshold, next_check_at)
       VALUES ('00000000-0000-4000-8000-000000000099', 'delete me', 'https://example.com', 300, 10000, 1, 0, '{}', 2, 1, ?)`,
      )
      .run(now());

    const response = await hostedFetch(
      new Request('https://api.example.com/api/workspace', {
        method: 'DELETE',
        headers: { cookie: owner.cookie },
      }),
      context.env,
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(context.tenant.prepare('SELECT count(*) AS count FROM monitors').get()).toEqual({
      count: 0,
    });
    expect(
      context.control.prepare('SELECT state FROM workspaces WHERE id = ?').get(workspaceId),
    ).toEqual({ state: 'deleted' });
    expect(
      context.control
        .prepare('SELECT status FROM tenant_slots WHERE workspace_id = ?')
        .get(workspaceId),
    ).toEqual({ status: 'deleting' });
  });

  it('requires target ownership, redacts public URLs, and removes public access on suspension', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:kkkkkkkkkkkkkkkkkkkkkkkk',
      'test.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const monitor = {
      name: 'Public test',
      url: 'https://example.com/private?token=secret',
      regionIds: ['eu-west'],
      intervalSeconds: 300,
      timeoutMs: 10000,
      isPublic: true,
      publicSlug: 'public-test',
    };
    const denied = await fetchHosted(
      context,
      '/api/monitors',
      owner.cookie,
      {},
      { method: 'POST', body: JSON.stringify(monitor) },
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'target_unverified' } });
    context.tenant
      .prepare(
        'INSERT INTO verified_targets(id,origin,token,expires_at,created_at,verified_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        '11111111-1111-4111-8111-111111111112',
        'https://example.com',
        'challenge',
        '2099-01-01T00:00:00.000Z',
        now(),
        now(),
      );
    const created = await fetchHosted(
      context,
      '/api/monitors',
      owner.cookie,
      {},
      { method: 'POST', body: JSON.stringify(monitor) },
    );
    expect(created.status).toBe(201);
    const publicPath = `/api/monitors/public/public-test?workspace=${workspaceId}`;
    const report = await fetchHosted(context, publicPath, '');
    expect(report.status).toBe(200);
    const published = await report.text();
    expect(published).toContain('https://example.com');
    expect(published).not.toContain('token=secret');
    expect(published).not.toContain('/private');
    context.control
      .prepare("UPDATE workspaces SET state = 'suspended' WHERE id = ?")
      .run(workspaceId);
    expect((await fetchHosted(context, publicPath, '')).status).toBe(404);
    const suspendedSession = await fetchHosted(context, '/api/auth/session', owner.cookie);
    expect(await suspendedSession.json()).toMatchObject({
      workspace: { state: 'suspended' },
      usage: { monitors: 1 },
    });
  });

  it('marks a stale public monitor report unknown using the latest observation timestamp', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:staleeeeeeeeeeeeeeeeeeeee',
      'stale.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const monitorId = '11111111-1111-4111-8111-111111111116';
    const runId = '11111111-1111-4111-8111-111111111117';
    const observedAt = new Date(Date.now() - 15 * 60_000).toISOString();
    context.tenant
      .prepare(
        `INSERT INTO monitors(id,name,url,interval_seconds,timeout_ms,is_public,public_slug,outage_threshold,recovery_threshold,next_check_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        monitorId,
        'Stale public monitor',
        'https://example.com',
        300,
        10000,
        1,
        'stale-public',
        2,
        1,
        observedAt,
        observedAt,
        observedAt,
      );
    context.tenant
      .prepare('INSERT INTO monitor_regions(monitor_id,region_id) VALUES(?,?)')
      .run(monitorId, 'eu-west');
    context.tenant
      .prepare(
        `INSERT INTO check_runs(id,monitor_id,window_started_at,status,expected_region_count,expected_regions,monitor_url,timeout_ms,deadline_at,completed_at,finalized_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        runId,
        monitorId,
        observedAt,
        'complete',
        1,
        '["eu-west"]',
        'https://example.com',
        10000,
        observedAt,
        observedAt,
        observedAt,
      );
    context.tenant
      .prepare(
        `INSERT INTO observations(id,check_run_id,monitor_id,region_id,scheduled_window,status,success,http_status,response_ms,total_ms,started_at,completed_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        '11111111-1111-4111-8111-111111111118',
        runId,
        monitorId,
        'eu-west',
        observedAt,
        'success',
        1,
        200,
        100,
        120,
        observedAt,
        observedAt,
      );
    Object.assign(context.env, { REPORTS: {} as R2Bucket });
    const response = await fetchHosted(
      context,
      `/reports/public/monitors/${monitorId}.json?workspace=${workspaceId}`,
      '',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      generatedAt: observedAt,
      latestObservationAt: observedAt,
      summary: { status: 'unknown', latestByRegion: { 'eu-west': { success: true } } },
    });
  });

  it('returns validation errors for private targets and atomically caps notification test attempts', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:llllllllllllllllllllllll',
      'test.bsky.social',
    );
    const privateTarget = await fetchHosted(
      context,
      '/api/workspace/targets',
      owner.cookie,
      {},
      { method: 'POST', body: JSON.stringify({ origin: 'https://127.0.0.1' }) },
    );
    expect(privateTarget.status).toBe(400);
    expect(await privateTarget.json()).toMatchObject({ error: { code: 'forbidden_address' } });
    const path = '/api/notification-services/11111111-1111-4111-8111-111111111113/test';
    for (let index = 0; index < 3; index++)
      expect((await fetchHosted(context, path, owner.cookie, {}, { method: 'POST' })).status).toBe(
        404,
      );
    expect((await fetchHosted(context, path, owner.cookie, {}, { method: 'POST' })).status).toBe(
      429,
    );
  });

  it('scopes report objects to the workspace and rejects snapshots containing removed private monitors', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:mmmmmmmmmmmmmmmmmmmmmmmm',
      'reports.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    const pageId = '11111111-1111-4111-8111-111111111114';
    context.tenant
      .prepare('INSERT INTO status_pages(id,title,public_slug) VALUES(?,?,?)')
      .run(pageId, 'Services', 'services');
    const accessed: string[] = [];
    let monitorIds: string[] = [];
    const reports = {
      async get(key: string) {
        accessed.push(key);
        const data = key.endsWith('cohort.json')
          ? { generation: '123' }
          : key.endsWith('/status-pages.json')
            ? { statusPages: [{ id: pageId, publicSlug: 'services' }] }
            : {
                statusPage: {
                  id: pageId,
                  publicSlug: 'services',
                  groups: [{ monitors: monitorIds.map((id) => ({ id })) }],
                },
              };
        return {
          async json<T>() {
            return data as T;
          },
        };
      },
    } as unknown as R2Bucket;
    Object.assign(context.env, { REPORTS: reports });
    const path = `/reports/public/status-pages/${pageId}.json?workspace=${workspaceId}`;
    expect((await fetchHosted(context, path, '')).status).toBe(200);
    expect(accessed).toContain(
      `tenants/${workspaceId}/public/cohorts/123/status-pages/services.json`,
    );
    expect(accessed.every((key) => key.startsWith(`tenants/${workspaceId}/`))).toBe(true);
    monitorIds = ['11111111-1111-4111-8111-111111111115'];
    expect((await fetchHosted(context, path, '')).status).toBe(503);
    context.tenant.prepare('DELETE FROM status_pages WHERE id = ?').run(pageId);
    expect((await fetchHosted(context, path, '')).status).toBe(404);
    const index = await fetchHosted(
      context,
      `/reports/public/status-pages.json?workspace=${workspaceId}`,
      '',
    );
    expect(await index.json()).toMatchObject({ statusPages: [] });
  });

  it('fences private mutations and defers deletion until an existing operation drains', async () => {
    const context = await createHostedContext();
    const owner = await authenticatedCookie(
      context.control,
      'did:plc:nnnnnnnnnnnnnnnnnnnnnnnn',
      'leases.bsky.social',
    );
    const session = await fetchHosted(context, '/api/auth/session', owner.cookie);
    const workspaceId = ((await session.json()) as { workspace: { id: string } }).workspace.id;
    context.control
      .prepare(
        "UPDATE workspaces SET execution_lease_token = 'in-flight', execution_lease_until = '2099-01-01T00:00:00.000Z' WHERE id = ?",
      )
      .run(workspaceId);
    const mutation = await fetchHosted(
      context,
      '/api/monitors',
      owner.cookie,
      {},
      { method: 'POST', body: '{}' },
    );
    expect(mutation.status).toBe(409);
    expect(await mutation.json()).toMatchObject({ error: { code: 'workspace_busy' } });
    const deletion = await fetchHosted(
      context,
      '/api/workspace',
      owner.cookie,
      {},
      { method: 'DELETE' },
    );
    expect(deletion.status).toBe(202);
    expect(await deletion.json()).toEqual({ state: 'deleting' });
    context.control
      .prepare(
        'UPDATE workspaces SET execution_lease_token = NULL, execution_lease_until = NULL WHERE id = ?',
      )
      .run(workspaceId);
    const complete = await fetchHosted(
      context,
      '/api/workspace',
      owner.cookie,
      {},
      { method: 'DELETE' },
    );
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ state: 'deleted' });
  });
});

async function createHostedContext() {
  const control = createTestDatabase();
  const tenant = createTestDatabase();
  databases.push(control, tenant);
  control.exec(controlSchema);
  control
    .prepare(
      `INSERT INTO tenant_slots(binding_name, workspace_id, database_id, status)
     VALUES ('TENANT_ONE', NULL, 'tenant-one', 'available')`,
    )
    .run();
  const controlDb = createD1Adapter(control);
  const tenantDb = createD1Adapter(tenant);
  const env = {
    CONTROL_DB: controlDb,
    DB: tenantDb,
    TENANT_ONE: tenantDb,
    PUBLIC_ORIGIN: 'https://api.example.com',
    SESSION_SECRET: 's'.repeat(32),
    OAUTH_STORAGE_SECRET: 'o'.repeat(32),
    CREDENTIAL_ENCRYPTION_SECRET: 'c'.repeat(32),
    ENVIRONMENT: 'test',
  } as Parameters<typeof hostedFetch>[1];
  return { control, controlDb, tenant, env };
}

async function authenticatedCookie(
  control: ReturnType<typeof createTestDatabase>,
  did: string,
  handle: string,
) {
  const token = `token-${did.slice(-8)}`;
  control
    .prepare(
      `INSERT INTO atproto_login_sessions(token_hash, did, handle, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      await hashSessionToken(token, 's'.repeat(32)),
      did,
      handle,
      '2099-01-01T00:00:00.000Z',
      now(),
      now(),
    );
  return { did, cookie: `uptime_atproto_session=${token}` };
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
