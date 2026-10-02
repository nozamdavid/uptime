import argon2 from 'argon2';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApi } from './server.js';

const serviceId = '20000000-0000-4000-8000-000000000001';
const admin = { id: '10000000-0000-4000-8000-000000000001', email: 'admin@example.com' };
const apps: Awaited<ReturnType<typeof buildApi>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('notification services', () => {
  it('requires authentication', async () => {
    const app = await makeApp([[]]);
    const response = await app.inject({ method: 'GET', url: '/api/notification-services' });
    expect(response.statusCode).toBe(401);
  });

  it('lists services without returning provider credentials', async () => {
    const app = await makeApp([
      [],
      [{ ...admin, passwordHash: await passwordHash() }],
      [],
      [admin],
      [
        {
          id: serviceId,
          name: 'Operations Telegram',
          provider: 'telegram',
          enabled: true,
          config: { botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '-100123456' },
          createdAt: '2026-09-16T10:00:00.000Z',
          updatedAt: '2026-09-16T10:00:00.000Z',
        },
      ],
    ]);
    const cookie = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/notification-services',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      services: [
        {
          id: serviceId,
          name: 'Operations Telegram',
          provider: 'telegram',
          enabled: true,
          config: { chatId: '-100123456' },
          createdAt: '2026-09-16T10:00:00.000Z',
          updatedAt: '2026-09-16T10:00:00.000Z',
        },
      ],
    });
    expect(response.body).not.toContain('botToken');
    expect(response.body).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('returns safe fields and redacts credentials for every additional provider', async () => {
    const base = {
      enabled: true,
      createdAt: '2026-09-16T10:00:00.000Z',
      updatedAt: '2026-09-16T10:00:00.000Z',
    };
    const services = [
      {
        ...base,
        id: '20000000-0000-4000-8000-000000000002',
        name: 'Resend',
        provider: 'resend',
        config: {
          apiKey: 're_secret',
          from: 'uptime@example.com',
          to: ['ops@example.com'],
          subject: 'Alert',
        },
      },
      {
        ...base,
        id: '20000000-0000-4000-8000-000000000003',
        name: 'Gotify',
        provider: 'gotify',
        config: {
          serverUrl: 'https://push.example.com',
          applicationToken: 'gotify-secret',
          priority: 8,
        },
      },
      {
        ...base,
        id: '20000000-0000-4000-8000-000000000004',
        name: 'Webhook',
        provider: 'webhook',
        config: { webhookUrl: 'https://hooks.example.com/secret', bearerToken: 'bearer-secret' },
      },
      {
        ...base,
        id: '20000000-0000-4000-8000-000000000005',
        name: 'SMTP',
        provider: 'smtp',
        config: {
          host: 'smtp.example.com',
          port: 587,
          security: 'starttls',
          username: 'uptime',
          password: 'smtp-secret',
          from: 'uptime@example.com',
          to: ['ops@example.com'],
          subject: 'Alert',
        },
      },
      {
        ...base,
        id: '20000000-0000-4000-8000-000000000006',
        name: 'Home Assistant',
        provider: 'home-assistant',
        config: {
          serverUrl: 'http://homeassistant.local:8123',
          accessToken: 'ha-secret',
          service: 'notify',
        },
      },
    ];
    const app = await makeApp([
      [],
      [{ ...admin, passwordHash: await passwordHash() }],
      [],
      [admin],
      services,
    ]);
    const cookie = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/notification-services',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().services.map((service: { config: unknown }) => service.config)).toEqual([
      { from: 'uptime@example.com', to: ['ops@example.com'], subject: 'Alert' },
      { serverUrl: 'https://push.example.com', priority: 8 },
      {},
      {
        host: 'smtp.example.com',
        port: 587,
        security: 'starttls',
        username: 'uptime',
        from: 'uptime@example.com',
        to: ['ops@example.com'],
        subject: 'Alert',
      },
      { serverUrl: 'http://homeassistant.local:8123', service: 'notify' },
    ]);
    for (const secret of [
      're_secret',
      'gotify-secret',
      'hooks.example.com',
      'bearer-secret',
      'smtp-secret',
      'ha-secret',
    ]) {
      expect(response.body).not.toContain(secret);
    }
  });

  it('creates a service while keeping its credential write-only', async () => {
    const botToken = '123456:abcdefghijklmnopqrstuvwxyz';
    const created = {
      id: serviceId,
      name: 'Operations Telegram',
      provider: 'telegram',
      enabled: true,
      config: { botToken, chatId: '-100123456' },
      createdAt: '2026-09-16T10:00:00.000Z',
      updatedAt: '2026-09-16T10:00:00.000Z',
    };
    const app = await makeApp([
      [],
      [{ ...admin, passwordHash: await passwordHash() }],
      [],
      [admin],
      [created],
    ]);
    const cookie = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/notification-services',
      headers: { cookie },
      payload: {
        name: created.name,
        provider: created.provider,
        enabled: true,
        config: { botToken, chatId: created.config.chatId },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().service.config).toEqual({ chatId: '-100123456' });
    expect(response.body).not.toContain(botToken);
  });

  it('preserves a saved secret when an edit submits a blank secret', async () => {
    const botToken = '123456:abcdefghijklmnopqrstuvwxyz';
    const current = {
      id: serviceId,
      name: 'Operations Telegram',
      provider: 'telegram',
      enabled: true,
      config: { botToken, chatId: '-100123456' },
      createdAt: '2026-09-16T10:00:00.000Z',
      updatedAt: '2026-09-16T10:00:00.000Z',
    };
    const compiledQueries: Array<{ sql: string; params: unknown[] }> = [];
    const responses: unknown[][] = [
      [],
      [{ ...admin, passwordHash: await passwordHash() }],
      [],
      [admin],
      [current],
      [{ ...current, name: 'Primary Telegram' }],
    ];
    const database = {
      execute: async (query: unknown) => {
        compiledQueries.push(new PgDialect().sqlToQuery(query as never));
        return { rows: responses.shift() ?? [] };
      },
      transaction: async (run: (tx: unknown) => Promise<unknown>) => run(database),
    };
    const app = await buildTestApi(database);
    const cookie = await login(app);
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/notification-services/${serviceId}`,
      headers: { cookie },
      payload: {
        name: 'Primary Telegram',
        config: { botToken: '', chatId: '-100123456' },
      },
    });

    expect(response.statusCode).toBe(200);
    const update = compiledQueries.find((query) =>
      query.sql.includes('update notification_services'),
    );
    expect(
      compiledQueries.some(
        (query) =>
          query.sql.includes('from notification_services where id =') &&
          query.sql.includes('for update'),
      ),
    ).toBe(true);
    expect(update?.params).toContain(JSON.stringify(current.config));
    expect(
      compiledQueries.some((query) => query.sql.includes('update notification_deliveries')),
    ).toBe(false);
    expect(
      compiledQueries.some((query) => query.sql.includes('update monitor_notification_state')),
    ).toBe(false);
    expect(response.body).not.toContain(botToken);
  });

  it('preserves new-provider secrets and rejects unrelated update keys', async () => {
    const current = {
      id: serviceId,
      name: 'Gotify',
      provider: 'gotify',
      enabled: true,
      config: {
        serverUrl: 'https://push.example.com',
        applicationToken: 'gotify-secret',
        priority: 8,
      },
      createdAt: '2026-09-16T10:00:00.000Z',
      updatedAt: '2026-09-16T10:00:00.000Z',
    };
    const updated = { ...current, config: { ...current.config, priority: 9 } };
    const compiledQueries: Array<{ sql: string; params: unknown[] }> = [];
    const responses: unknown[][] = [
      [],
      [{ ...admin, passwordHash: await passwordHash() }],
      [],
      [admin],
      [current],
      [updated],
      [],
      [],
      [admin],
      [updated],
    ];
    const database = {
      execute: async (query: unknown) => {
        compiledQueries.push(new PgDialect().sqlToQuery(query as never));
        return { rows: responses.shift() ?? [] };
      },
      transaction: async (run: (tx: unknown) => Promise<unknown>) => run(database),
    };
    const app = await buildTestApi(database);
    const cookie = await login(app);
    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/notification-services/${serviceId}`,
      headers: { cookie },
      payload: { config: { applicationToken: '', priority: 9 } },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updateQuery = compiledQueries.find((query) =>
      query.sql.includes('update notification_services'),
    );
    expect(updateQuery?.params).toContain(JSON.stringify(updated.config));
    expect(updateResponse.body).not.toContain('gotify-secret');

    const unrelatedResponse = await app.inject({
      method: 'PATCH',
      url: `/api/notification-services/${serviceId}`,
      headers: { cookie },
      payload: { config: { chatId: '123456' } },
    });
    expect(unrelatedResponse.statusCode).toBe(400);
    expect(unrelatedResponse.json().error.code).toBe('validation_error');
  });

  it('rejects invalid provider configuration without echoing the credential', async () => {
    const app = await makeApp([
      [],
      [{ ...admin, passwordHash: await passwordHash() }],
      [],
      [admin],
    ]);
    const cookie = await login(app);
    const invalidUrl = 'http://example.com/not-a-webhook';
    const response = await app.inject({
      method: 'POST',
      url: '/api/notification-services',
      headers: { cookie },
      payload: {
        name: 'Invalid Discord',
        provider: 'discord',
        config: { webhookUrl: invalidUrl },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_error');
    expect(response.body).not.toContain(invalidUrl);
  });

  it('sends a rate-limited test through the configured provider', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const webhookUrl = 'https://discord.com/api/webhooks/123456/secret-token';
    const app = await makeApp(
      [
        [],
        [{ ...admin, passwordHash: await passwordHash() }],
        [],
        [admin],
        [
          {
            id: serviceId,
            name: 'Operations Discord',
            provider: 'discord',
            enabled: true,
            config: { webhookUrl },
            createdAt: '2026-09-16T10:00:00.000Z',
            updatedAt: '2026-09-16T10:00:00.000Z',
          },
        ],
      ],
      fetchMock,
    );
    const cookie = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/notification-services/${serviceId}/test`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${webhookUrl}?wait=true`);
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('Uptime notification test');
  });
});

async function makeApp(responses: unknown[][], notificationFetch?: typeof fetch) {
  const hash =
    responses.length > 1
      ? String((responses[1]?.[0] as { passwordHash?: string })?.passwordHash)
      : await passwordHash();
  const database = {
    execute: async () => ({ rows: responses.shift() ?? [] }),
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run(database),
  };
  const app = await buildApi(
    {
      DATABASE_URL: 'postgresql://uptime:uptime@localhost:5432/uptime',
      SESSION_COOKIE_SECURE: false,
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD_HASH: hash,
      SESSION_SECRET: 'a'.repeat(32),
    },
    {
      db: database as never,
      now: () => new Date('2026-09-16T12:00:00.000Z'),
      ...(notificationFetch ? { notificationFetch } : {}),
    },
  );
  apps.push(app);
  return app;
}

async function buildTestApi(database: object) {
  const app = await buildApi(
    {
      DATABASE_URL: 'postgresql://uptime:uptime@localhost:5432/uptime',
      SESSION_COOKIE_SECURE: false,
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD_HASH: await passwordHash(),
      SESSION_SECRET: 'a'.repeat(32),
    },
    { db: database as never, now: () => new Date('2026-09-16T12:00:00.000Z') },
  );
  apps.push(app);
  return app;
}

async function login(app: Awaited<ReturnType<typeof buildApi>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'correct horse battery staple' },
  });
  const setCookie = response.headers['set-cookie'];
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
}

function passwordHash() {
  return argon2.hash('correct horse battery staple', { type: argon2.argon2id });
}
