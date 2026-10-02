import { afterEach, describe, expect, it } from 'vitest';

import {
  createTestContext,
  login,
  request,
  seedMonitor,
  type TestContext,
} from './testing/test-utils.js';

const contexts: TestContext[] = [];
const json = (response: Response): Promise<any> => response.json();

async function context() {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.db.close();
});

const monitorA = '30000000-0000-4000-8000-000000000001';
const monitorB = '30000000-0000-4000-8000-000000000002';

describe('status page CRUD', () => {
  it('creates, reads, lists, updates and deletes a status page', async () => {
    const ctx = await context();
    seedMonitor(ctx.sqlite, { id: monitorA, regions: ['us-east', 'eu-west'] });
    seedMonitor(ctx.sqlite, { id: monitorB, regions: ['us-east'] });
    const { cookie } = await login(ctx.app);

    const created = await request(ctx.app, '/api/status-pages', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Acme status',
        publicSlug: 'acme',
        groups: [{ title: 'Core', monitorIds: [monitorA], width: 'half', showBadges: true }],
      }),
    });
    expect(created.status).toBe(201);
    const statusPage = (await json(created)).statusPage;
    expect(statusPage.title).toBe('Acme status');
    expect(statusPage.monitorCount).toBe(1);
    expect(statusPage.groups[0].monitors[0].id).toBe(monitorA);

    const listed = await request(ctx.app, '/api/status-pages', { cookie });
    expect((await json(listed)).statusPages).toHaveLength(1);

    const updated = await request(ctx.app, `/api/status-pages/${statusPage.id}`, {
      method: 'PUT',
      cookie,
      body: JSON.stringify({
        title: 'Acme platform',
        publicSlug: 'acme',
        groups: [
          {
            title: 'Everything',
            monitorIds: [monitorA, monitorB],
            width: 'full',
            showBadges: false,
          },
        ],
      }),
    });
    expect(updated.status).toBe(200);
    expect((await json(updated)).statusPage.monitorCount).toBe(2);

    const deleted = await request(ctx.app, `/api/status-pages/${statusPage.id}`, {
      method: 'DELETE',
      cookie,
    });
    expect(deleted.status).toBe(204);
    const missing = await request(ctx.app, `/api/status-pages/${statusPage.id}`, { cookie });
    expect(missing.status).toBe(404);
  });

  it('enforces unique public slugs', async () => {
    const ctx = await context();
    seedMonitor(ctx.sqlite, { id: monitorA });
    const { cookie } = await login(ctx.app);
    await request(ctx.app, '/api/status-pages', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'One', publicSlug: 'acme', groups: [] }),
    });
    const conflict = await request(ctx.app, '/api/status-pages', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Two', publicSlug: 'acme', groups: [] }),
    });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error.code).toBe('slug_conflict');
  });

  it('rejects a monitor that appears on two groups', async () => {
    const ctx = await context();
    seedMonitor(ctx.sqlite, { id: monitorA });
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, '/api/status-pages', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Dup',
        groups: [
          { title: 'One', monitorIds: [monitorA] },
          { title: 'Two', monitorIds: [monitorA] },
        ],
      }),
    });
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe('validation_error');
  });

  it('rejects unknown monitors', async () => {
    const ctx = await context();
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, '/api/status-pages', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Bad',
        groups: [{ title: 'Core', monitorIds: ['30000000-0000-4000-8000-000000000099'] }],
      }),
    });
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe('invalid_monitor');
  });
});
