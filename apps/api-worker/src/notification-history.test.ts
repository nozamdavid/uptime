import { afterEach, describe, expect, it } from 'vitest';
import { recordNotificationHistory } from '@uptime/cloudflare';

import { sealProviderConfig } from './credentials.js';
import { createTestContext, login, request, type TestContext } from './testing/test-utils.js';

const contexts: TestContext[] = [];
const serviceId = '00000000-0000-4000-8000-0000000000a1';
const secondServiceId = '00000000-0000-4000-8000-0000000000a2';

async function setup(notificationFetch?: typeof fetch): Promise<TestContext> {
  const ctx = await createTestContext(notificationFetch ? { notificationFetch } : {});
  contexts.push(ctx);
  const sealed = await sealProviderConfig('c'.repeat(32), {
    webhookUrl: 'https://hooks.example.test/secret-path',
    bearerToken: 'secret-token',
  });
  // The history read needs no decryption and must never expose sealed config.
  ctx.sqlite
    .prepare(
      `INSERT INTO notification_services (id, name, provider, config)
       VALUES (?, 'Webhook', 'webhook', ?)`,
    )
    .run(serviceId, sealed);
  return ctx;
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.sqlite.close();
});

describe('notification history', () => {
  it('requires admin authentication, validates cursors, and distinguishes missing services', async () => {
    const ctx = await setup();
    const path = `/api/notification-services/${serviceId}/history`;
    expect((await request(ctx.app, path)).status).toBe(401);
    const { cookie } = await login(ctx.app);
    expect((await request(ctx.app, `${path}?cursor=bad`, { cookie })).status).toBe(400);
    expect(
      (
        await request(
          ctx.app,
          '/api/notification-services/00000000-0000-4000-8000-0000000000ff/history',
          { cookie },
        )
      ).status,
    ).toBe(404);
  });

  it('aggregates providers across services with stable newest first pagination', async () => {
    const ctx = await setup();
    const secondSealed = await sealProviderConfig('c'.repeat(32), { handle: 'uptime.test' });
    ctx.sqlite
      .prepare(
        `INSERT INTO notification_services (id, name, provider, config)
         VALUES (?, 'Bluesky', 'bluesky', ?)`,
      )
      .run(secondServiceId, secondSealed);
    ctx.sqlite
      .prepare('UPDATE notification_services SET enabled = 0 WHERE id = ?')
      .run(secondServiceId);
    expect(
      (
        ctx.sqlite
          .prepare('SELECT enabled FROM notification_services WHERE id = ?')
          .get(secondServiceId) as {
          enabled: number;
        }
      ).enabled,
    ).toBe(0);
    const instant = new Date('2026-09-30T10:00:00.000Z');
    for (let index = 0; index < 29; index += 1) {
      const bluesky = index % 2 === 1;
      await recordNotificationHistory(ctx.db, {
        notificationServiceId: bluesky ? secondServiceId : serviceId,
        monitorId: '30000000-0000-4000-8000-000000000001',
        monitorName: `Monitor ${index}`,
        monitorUrl: 'https://example.test/health',
        provider: bluesky ? 'bluesky' : 'webhook',
        kind: index === 0 ? 'test' : 'outage',
        status: index === 1 ? 'failed' : 'sent',
        createdAt:
          index === 27
            ? new Date('2026-09-30T11:00:00.000Z')
            : index === 28
              ? new Date('2026-09-30T09:00:00.000Z')
              : instant,
        text: `Alert ${index}`,
        externalUrl: null,
        error: null,
        preview: { subject: 'safe preview' },
      });
    }
    expect((await request(ctx.app, '/api/notification-history')).status).toBe(401);
    const { cookie } = await login(ctx.app);
    expect(
      (await request(ctx.app, '/api/notification-history?cursor=bad', { cookie })).status,
    ).toBe(400);
    const firstResponse = await request(ctx.app, '/api/notification-history', { cookie });
    const first = (await firstResponse.json()) as {
      entries: Array<Record<string, unknown>>;
      nextCursor: string;
    };
    expect(first.entries).toHaveLength(25);
    expect(first.nextCursor).toBeTruthy();
    expect(new Set(first.entries.map((entry) => entry.provider))).toEqual(
      new Set(['webhook', 'bluesky']),
    );
    expect(first.entries.every((entry) => typeof entry.notificationServiceId === 'string')).toBe(
      true,
    );
    expect(first.entries[0]).toMatchObject({ createdAt: '2026-09-30T11:00:00.000Z' });
    const secondResponse = await request(
      ctx.app,
      `/api/notification-history?cursor=${encodeURIComponent(first.nextCursor)}`,
      { cookie },
    );
    const second = (await secondResponse.json()) as {
      entries: Array<Record<string, unknown>>;
      nextCursor: null;
    };
    expect(second.entries).toHaveLength(4);
    expect(second.nextCursor).toBeNull();
    const allEntries = [...first.entries, ...second.entries];
    expect(new Set(allEntries.map((entry) => entry.id)).size).toBe(29);
    expect(allEntries).toEqual(
      [...allEntries].sort((left, right) => {
        const leftCreatedAt = String(left.createdAt);
        const rightCreatedAt = String(right.createdAt);
        if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt < rightCreatedAt ? 1 : -1;
        const leftId = String(left.id);
        const rightId = String(right.id);
        return leftId === rightId ? 0 : leftId < rightId ? 1 : -1;
      }),
    );
    expect(new Set(allEntries.map((entry) => entry.notificationServiceId))).toEqual(
      new Set([serviceId, secondServiceId]),
    );
    expect(allEntries.find((entry) => entry.kind === 'test')).toMatchObject({ monitorUrl: null });
    expect(allEntries.find((entry) => entry.status === 'failed')).toBeTruthy();
    expect(allEntries.at(-1)).toMatchObject({ createdAt: '2026-09-30T09:00:00.000Z' });
    expect(JSON.stringify(allEntries)).not.toContain('secret-token');
    expect(JSON.stringify(allEntries)).not.toContain('secret-path');
  });

  it('pages newest first without duplicates and retains monitor snapshots after deletion', async () => {
    const ctx = await setup();
    const monitorId = '30000000-0000-4000-8000-000000000001';
    ctx.sqlite
      .prepare(
        `INSERT INTO monitors (id, name, url, interval_seconds, timeout_ms, next_check_at)
         VALUES (?, 'Original', 'https://example.test/health', 60, 1000, '2026-09-30T00:00:00.000Z')`,
      )
      .run(monitorId);
    for (let index = 0; index < 27; index += 1) {
      await recordNotificationHistory(ctx.db, {
        notificationServiceId: serviceId,
        monitorId,
        monitorName: 'Original',
        monitorUrl: 'https://example.test/health',
        provider: 'webhook',
        kind: 'outage',
        status: 'sent',
        createdAt: new Date('2026-09-30T10:00:00.000Z'),
        text: `Alert ${index}`,
        externalUrl: null,
        error: null,
        preview: {},
      });
    }
    ctx.sqlite.prepare('DELETE FROM monitors WHERE id = ?').run(monitorId);
    const { cookie } = await login(ctx.app);
    const path = `/api/notification-services/${serviceId}/history`;
    const first = (await (await request(ctx.app, path, { cookie })).json()) as {
      entries: Array<Record<string, unknown>>;
      nextCursor: string;
    };
    expect(first.entries).toHaveLength(25);
    expect(first.nextCursor).toBeTruthy();
    expect(first.entries[0]).toMatchObject({
      monitorId: null,
      monitorName: 'Original',
      monitorUrl: 'https://example.test/health',
      status: 'sent',
    });
    const second = (await (
      await request(ctx.app, `${path}?cursor=${encodeURIComponent(first.nextCursor)}`, { cookie })
    ).json()) as { entries: Array<{ id: string }>; nextCursor: null };
    expect(second.entries).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const ids = [
      ...first.entries.map((entry) => entry.id),
      ...second.entries.map((entry) => entry.id),
    ];
    expect(new Set(ids).size).toBe(27);
    expect(JSON.stringify(first)).not.toContain('secret-token');
    expect(JSON.stringify(first)).not.toContain('secret-path');
  });

  it('records test successes and failures without storing provider credentials', async () => {
    let responseStatus = 200;
    const sent: string[] = [];
    const ctx = await setup((async (input) => {
      sent.push(String(input));
      return new Response('{}', { status: responseStatus });
    }) as typeof fetch);
    const { cookie } = await login(ctx.app);
    const path = `/api/notification-services/${serviceId}`;
    expect((await request(ctx.app, `${path}/test`, { method: 'POST', cookie })).status).toBe(200);
    responseStatus = 503;
    expect((await request(ctx.app, `${path}/test`, { method: 'POST', cookie })).status).toBe(502);
    expect(sent).toHaveLength(2);
    const history = await request(ctx.app, `${path}/history`, { cookie });
    const body = await history.text();
    const entries = (JSON.parse(body) as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries.map((entry) => entry.status).sort()).toEqual(['failed', 'sent']);
    expect(entries.every((entry) => entry.kind === 'test')).toBe(true);
    expect(
      entries.every(
        (entry) =>
          entry.text === 'Uptime notification test\nYour notification service is connected.',
      ),
    ).toBe(true);
    expect(body).not.toContain('secret-token');
    expect(body).not.toContain('secret-path');
  });

  it('cleans up encoded legacy Bluesky links and hides test monitor URLs', async () => {
    const ctx = await setup();
    await recordNotificationHistory(ctx.db, {
      notificationServiceId: serviceId,
      monitorId: null,
      monitorName: 'Uptime notification test',
      monitorUrl: 'https://example.com',
      provider: 'webhook',
      kind: 'test',
      status: 'sent',
      createdAt: new Date('2026-09-30T10:00:00.000Z'),
      text: 'Test notification',
      externalUrl: null,
      error: null,
      preview: {},
    });
    await recordNotificationHistory(ctx.db, {
      notificationServiceId: serviceId,
      monitorId: '30000000-0000-4000-8000-000000000001',
      monitorName: 'Homepage',
      monitorUrl: 'https://example.com/health',
      provider: 'bluesky',
      kind: 'outage',
      status: 'sent',
      createdAt: new Date('2026-09-30T09:00:00.000Z'),
      text: 'Homepage is down',
      externalUrl:
        'https://bsky.app/profile/did%3Aplc%3Almkzmvv6sdxntwtyxpg7fqqq/post/3mwqioyqzrt2b',
      error: null,
      preview: {},
    });
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, `/api/notification-services/${serviceId}/history`, {
      cookie,
    });
    const body = (await response.json()) as {
      entries: Array<{ externalUrl: string | null; kind: string; monitorUrl: string | null }>;
    };
    expect(body.entries[0]).toMatchObject({ kind: 'test', monitorUrl: null });
    expect(body.entries[1]?.externalUrl).toBe(
      'https://bsky.app/profile/did:plc:lmkzmvv6sdxntwtyxpg7fqqq/post/3mwqioyqzrt2b',
    );
  });

  it('does not report a successful send as failed when history storage fails', async () => {
    let sends = 0;
    const ctx = await setup((async () => {
      sends += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    ctx.sqlite.exec(
      `CREATE TRIGGER reject_notification_history BEFORE INSERT ON notification_history
       BEGIN SELECT RAISE(FAIL, 'test write failure'); END`,
    );
    const { cookie } = await login(ctx.app);
    const response = await request(ctx.app, `/api/notification-services/${serviceId}/test`, {
      method: 'POST',
      cookie,
    });
    expect(response.status).toBe(200);
    expect(sends).toBe(1);
  });
});
