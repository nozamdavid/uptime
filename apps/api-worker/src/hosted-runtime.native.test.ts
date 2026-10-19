import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword, resolveEffectiveEntitlements } from '@uptime/cloudflare';
import {
  pgFirst,
  quotePostgresIdentifier,
  resolveRuntimeWorkspace,
} from '@uptime/cloudflare/postgres';
import * as domains from './custom-domain-http.js';
import { budgetSummary, consumeBudget, ensureWorkspace, hostedFetch } from './hosted-app.js';
import { reconcileScheduled } from './reconcile.js';
import { createRuntimeFixture } from './testing/runtime-fixture.js';

let fixture: Awaited<ReturnType<typeof createRuntimeFixture>>;
const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const otherDid = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const legacyDid = 'did:plc:cccccccccccccccccccccccc';
const legacyId = '11111111-1111-4111-8111-111111111111';
const pending: Promise<unknown>[] = [];
const context = {
  waitUntil(promise: Promise<unknown>) {
    pending.push(promise);
  },
  passThroughOnException() {},
} as ExecutionContext;
let cookie: string;
let workspaceId: string;

beforeAll(async () => {
  fixture = await createRuntimeFixture(['full-hosted', 'full-hosted', 'legacy-staging']);
  fixture.env.OPERATOR_DIDS = did;
  cookie = await fixture.cookie(did);
  await fixture.assign(2, legacyId, legacyDid);
}, 120_000);
afterAll(async () => {
  await Promise.allSettled(pending.splice(0));
  await fixture?.close();
}, 120_000);

async function request(
  path: string,
  options: { method?: string; cookie?: string; body?: object; workspaceId?: string } = {},
) {
  return hostedFetch(
    new Request(`https://api.test${path}`, {
      method: options.method ?? 'GET',
      headers: {
        cookie: options.cookie ?? cookie,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.workspaceId ? { 'x-uptime-workspace': options.workspaceId } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    }),
    fixture.env,
    context,
  );
}

describe('native hosted runtime', () => {
  it('saves waiting workspace limits without activation and applies them on provisioning', async () => {
    const fixture = await createRuntimeFixture(['full-hosted', 'full-hosted']);
    fixture.env.OPERATOR_DIDS = did;
    const cookie = await fixture.cookie(did);
    const request = (path: string, options: { method?: string; body?: object } = {}) =>
      hostedFetch(
        new Request(`https://api.test${path}`, {
          method: options.method ?? 'GET',
          headers: { cookie, 'content-type': 'application/json' },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        }),
        fixture.env,
        context,
      );
    try {
      const control = fixture.control.db;
      const budgetObservation = fixture.env.CURRENT_BUDGET_USAGE_JSON;
      fixture.env.CURRENT_BUDGET_USAGE_JSON = undefined;
      const waiting = await ensureWorkspace(
        { ...fixture.env, controlDb: control, catalog: fixture.catalog },
        { did: 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee', handle: 'waiting-policy.test' },
      );
      expect(waiting.state).toBe('waiting_for_capacity');
      const path = `/api/operator/workspaces/${waiting.id}/limits`;
      const policy = { monitors: 7, regions: 1, allowedRegionIds: ['eu-west'] };
      const list = async () => {
        const response = await request('/api/operator/workspaces');
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          workspaces: { id: string; limits: object }[];
          budget: object;
        };
        return {
          workspace: body.workspaces.find((row) => row.id === waiting.id),
          budget: body.budget,
        };
      };
      const defaults = await resolveEffectiveEntitlements(control, waiting.id, [
        'us-east',
        'eu-west',
        'asia-south',
      ]);
      expect((await list()).workspace?.limits).toMatchObject({
        monitors: defaults.entitlements.monitors,
        regions: defaults.entitlements.regions,
        allowedRegionIds: defaults.entitlements.allowedRegionIds,
      });
      const preview = await request(`${path}/preview`, { method: 'POST', body: policy });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({
        capacity: { safe: true, actual: { monitors: 0, regionalTasks: 0 } },
      });
      expect(
        (await request(path, { method: 'PATCH', body: { ...policy, monitors: 1000 } })).status,
      ).toBe(409);
      expect(
        (await request(path, { method: 'PATCH', body: { ...policy, allowedRegionIds: ['asia'] } }))
          .status,
      ).toBe(400);
      const controlsBefore = (
        await control.query(`SELECT * FROM ${control.table('service_controls')}`)
      ).rows;
      const schedulingBefore = (
        await control.query(`SELECT * FROM ${control.table('scheduling_controls')}`)
      ).rows;
      expect((await request(path, { method: 'PATCH', body: policy })).status).toBe(200);
      const saved = await list();
      expect(saved.workspace?.limits).toMatchObject(policy);
      expect(saved.budget).toMatchObject({ forecastUsd: null, admissionOpen: false });
      expect(
        await pgFirst(
          control,
          `SELECT state,execution_lease_token FROM ${control.table('workspaces')} WHERE id=$1`,
          [waiting.id],
        ),
      ).toEqual({ state: 'waiting_for_capacity', execution_lease_token: null });
      expect(
        await pgFirst(
          control,
          `SELECT source_database_id FROM ${control.table('postgres_tenant_registry')} WHERE workspace_id=$1`,
          [waiting.id],
        ),
      ).toBeNull();
      expect(
        (await control.query(`SELECT * FROM ${control.table('service_controls')}`)).rows,
      ).toEqual(controlsBefore);
      expect(
        (await control.query(`SELECT * FROM ${control.table('scheduling_controls')}`)).rows,
      ).toEqual(schedulingBefore);
      expect(
        await pgFirst(
          control,
          `SELECT event FROM ${control.table('workspace_events')} WHERE workspace_id=$1`,
          [waiting.id],
        ),
      ).toEqual({ event: 'workspace_product_limits' });
      fixture.env.CURRENT_BUDGET_USAGE_JSON = budgetObservation;
      const activated = await ensureWorkspace(
        { ...fixture.env, controlDb: control, catalog: fixture.catalog },
        { did: waiting.owner_did, handle: 'waiting-policy.test' },
      );
      expect(activated.state).toBe('active');
      const tenant = (await resolveRuntimeWorkspace(control, fixture.catalog, waiting.id)).db;
      expect(
        await pgFirst(
          tenant,
          `SELECT monitor_limit,region_limit,allowed_region_ids FROM ${tenant.table('workspace_metadata')} WHERE id=1`,
        ),
      ).toEqual({
        monitor_limit: 7,
        region_limit: 1,
        allowed_region_ids: JSON.stringify(policy.allowedRegionIds),
      });
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it('dynamically provisions, preserves source IDs, and routes authenticated monitors', async () => {
    const firstConnection = await fixture.openConnection();
    const secondConnection = await fixture.openConnection();
    try {
      const results = await Promise.all([
        ensureWorkspace(
          { ...fixture.env, controlDb: firstConnection, catalog: fixture.catalog },
          { did, handle: 'owner.test' },
        ),
        ensureWorkspace(
          { ...fixture.env, controlDb: secondConnection, catalog: fixture.catalog },
          { did: otherDid, handle: 'other.test' },
        ),
      ]);
      expect(results.map((workspace) => workspace.state)).toEqual(['active', 'active']);
      expect(new Set(results.map((workspace) => workspace.id)).size).toBe(2);
    } finally {
      await firstConnection.close();
      await secondConnection.close();
    }
    const response = await request('/api/auth/session');
    expect(response.status).toBe(200);
    const session = (await response.json()) as {
      workspace: { id: string; state: string };
      role: string;
      isOperator: boolean;
    };
    workspaceId = session.workspace.id;
    expect(session).toMatchObject({
      workspace: { state: 'active' },
      role: 'owner',
      isOperator: true,
    });
    const resolved = await resolveRuntimeWorkspace(
      fixture.control.db,
      fixture.catalog,
      workspaceId,
    );
    expect(['source-1', 'source-2']).toContain(resolved.source.sourceDatabaseId);
    expect(
      await pgFirst(
        resolved.db,
        `SELECT database_id,workspace_id FROM ${resolved.db.table('workspace_metadata')}`,
      ),
    ).toEqual({ database_id: resolved.source.sourceDatabaseId, workspace_id: workspaceId });
    const created = await request('/api/monitors', {
      method: 'POST',
      body: {
        name: 'Native',
        url: 'https://example.com',
        regionIds: ['us-east'],
        intervalSeconds: 300,
        timeoutMs: 5000,
        outageThreshold: 2,
        recoveryThreshold: 1,
      },
    });
    expect(created.status).toBe(201);
    expect((await request('/api/monitors')).status).toBe(200);
  }, 120_000);

  it('isolates workspaces and enforces viewer, operator, and monitor quotas', async () => {
    const otherCookie = await fixture.cookie(otherDid, 'other.test');
    expect((await request('/api/auth/session', { cookie: otherCookie })).status).toBe(200);
    const control = fixture.control.db;
    await control.query(
      `INSERT INTO ${control.table('memberships')}(workspace_id,did,role,created_at) VALUES($1,$2,'viewer',$3)`,
      [workspaceId, otherDid, new Date().toISOString()],
    );
    expect((await request('/api/monitors', { cookie: otherCookie })).status).toBe(200);
    const otherBody = (await (await request('/api/monitors', { cookie: otherCookie })).json()) as {
      monitors: unknown[];
    };
    expect(otherBody.monitors).toHaveLength(0);
    expect(
      (
        await request('/api/monitors', {
          cookie: otherCookie,
          workspaceId,
          method: 'POST',
          body: {},
        })
      ).status,
    ).toBe(403);
    expect((await request('/api/operator/slots', { cookie: otherCookie })).status).toBe(403);
    const policy = {
      monitors: 1,
      regions: 3,
      allowedRegionIds: ['us-east', 'eu-west', 'asia-south'],
    };
    expect(
      (
        await request(`/api/operator/workspaces/${workspaceId}/limits`, {
          method: 'PATCH',
          body: policy,
        })
      ).status,
    ).toBe(200);
    const overQuota = await request('/api/monitors', {
      method: 'POST',
      body: {
        url: 'https://example.org',
        regionIds: ['us-east'],
        intervalSeconds: 300,
        outageThreshold: 2,
        recoveryThreshold: 1,
      },
    });
    expect(overQuota.status).toBe(409);
  }, 120_000);

  it('keeps unknown and stale cost unknown and closes admission without reading analytics credentials', async () => {
    const control = fixture.control.db;
    expect(await budgetSummary(control)).toMatchObject({
      forecastUsd: null,
      admissionOpen: false,
    });
    expect(
      await budgetSummary(control, {
        CURRENT_BUDGET_USAGE_JSON: JSON.stringify({
          month: new Date().toISOString().slice(0, 7),
          observedAt: new Date(Date.now() - 3_600_001).toISOString(),
          cloudflareCostUsd: 0,
        }),
      }),
    ).toMatchObject({ forecastUsd: null, admissionOpen: false });
    const env = {
      ...fixture.env,
      controlDb: control,
      catalog: fixture.catalog,
      CURRENT_BUDGET_USAGE_JSON: undefined,
    };
    expect(
      (
        await ensureWorkspace(env, {
          did: 'did:plc:dddddddddddddddddddddddd',
          handle: 'waiting.test',
        })
      ).state,
    ).toBe('waiting_for_capacity');
    await consumeBudget(control, 'native-limit', 1, 60);
    await expect(consumeBudget(control, 'native-limit', 1, 60)).rejects.toMatchObject({
      status: 429,
    });
  }, 120_000);

  it('isolates scheduled failures and closes clients after success, failure, and reconciliation', async () => {
    expect((await request('/health')).status).toBe(200);
    expect(
      (await request('/api/operator/workspaces/not-a-uuid/limits', { method: 'PATCH', body: {} }))
        .status,
    ).toBe(400);
    const domainReconcile = vi.spyOn(domains, 'reconcileCustomStatusDomains');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const admin = fixture.control.fixture.adminDb;
    await admin.query(
      `ALTER TABLE ${admin.table('workspace_billing')} RENAME TO workspace_billing_failure_fixture`,
    );
    try {
      await reconcileScheduled(fixture.env);
      await Promise.all(pending.splice(0));
      expect(errors).toHaveBeenCalledWith('Scheduled reconciliation failed', {
        event: 'billing_reconciliation_failed',
      });
      expect(domainReconcile).toHaveBeenCalledOnce();
      expect(await domainReconcile.mock.results[0]!.value).toEqual({ reconciled: 0, errors: 0 });
    } finally {
      await admin.query(
        `ALTER TABLE ${quotePostgresIdentifier(fixture.control.schema)}.workspace_billing_failure_fixture RENAME TO workspace_billing`,
      );
      errors.mockRestore();
      domainReconcile.mockRestore();
    }
    const role = (await fixture.control.db.query<{ role: string }>('SELECT current_user AS role'))
      .rows[0]!.role;
    expect(
      await pgFirst(
        fixture.control.fixture.adminDb,
        'SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename=$1',
        [role],
      ),
    ).toEqual({ count: 1 });
    await expect(
      fixture.control.db.query(
        `CREATE TABLE ${quotePostgresIdentifier(fixture.control.schema)}.forbidden (id text)`,
      ),
    ).rejects.toThrow('permission denied');
  }, 120_000);

  it('honors the deletion lease, purges native data, and keeps the physical source quarantined', async () => {
    const control = fixture.control.db;
    const source = (await resolveRuntimeWorkspace(control, fixture.catalog, workspaceId)).source;
    await control.query(
      `UPDATE ${control.table('workspaces')} SET execution_lease_token='busy',execution_lease_until=$1 WHERE id=$2`,
      [new Date(Date.now() + 60_000).toISOString(), workspaceId],
    );
    expect((await request('/api/workspace', { method: 'DELETE' })).status).toBe(202);
    expect((await request('/api/monitors', { method: 'POST', body: {} })).status).toBe(403);
    await control.query(
      `UPDATE ${control.table('workspaces')} SET execution_lease_until=$1 WHERE id=$2`,
      [new Date(Date.now() - 60_000).toISOString(), workspaceId],
    );
    const deleted = await request('/api/workspace', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ state: 'deleted' });
    expect(
      await pgFirst(
        control,
        `SELECT status FROM ${control.table('postgres_tenant_registry')} WHERE source_database_id=$1`,
        [source.sourceDatabaseId],
      ),
    ).toEqual({ status: 'deleting' });
    await expect(resolveRuntimeWorkspace(control, fixture.catalog, workspaceId)).rejects.toThrow();
    const tenant = fixture.tenants[Number(source.sourceDatabaseId.split('-')[1]) - 1]!.db;
    expect(
      await pgFirst(tenant, `SELECT count(*)::integer AS count FROM ${tenant.table('monitors')}`),
    ).toEqual({ count: 0 });
  }, 120_000);
});
