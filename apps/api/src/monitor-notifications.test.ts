import argon2 from 'argon2';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@uptime/database';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

import { buildApi } from './server.js';

const monitorId = '30000000-0000-4000-8000-000000000001';
const serviceId = '20000000-0000-4000-8000-000000000001';
const admin = { id: '10000000-0000-4000-8000-000000000001', email: 'admin@example.com' };
const apps: Awaited<ReturnType<typeof buildApi>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('monitor notification settings', () => {
  it('persists service links and notification rules in PostgreSQL', async () => {
    const client = new PGlite();
    const passwordHash = await argon2.hash('correct horse battery staple', {
      type: argon2.argon2id,
    });
    const directory = new URL('../../../packages/database/migrations/', import.meta.url);
    for (const filename of (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      const source = await readFile(new URL(filename, directory), 'utf8');
      await client.exec(source.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
    }
    const app = await buildApi(
      {
        DATABASE_URL: 'postgresql://uptime:uptime@localhost:5432/uptime',
        SESSION_COOKIE_SECURE: false,
        ADMIN_EMAIL: admin.email,
        ADMIN_PASSWORD_HASH: passwordHash,
        SESSION_SECRET: 'a'.repeat(32),
      },
      {
        db: drizzle(client) as unknown as Database,
        now: () => new Date('2026-09-16T12:00:00.000Z'),
      },
    );
    try {
      await app.ready();
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'correct horse battery staple' },
      });
      const setCookie = login.headers['set-cookie'];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
      const serviceResponse = await app.inject({
        method: 'POST',
        url: '/api/notification-services',
        headers: { cookie },
        payload: {
          name: 'Operations email',
          provider: 'resend',
          config: {
            apiKey: 're_secret',
            from: 'uptime@example.com',
            to: ['ops@example.com'],
          },
        },
      });
      expect(serviceResponse.statusCode).toBe(201);
      expect(serviceResponse.json().service.config).toEqual({
        from: 'uptime@example.com',
        to: ['ops@example.com'],
      });
      expect(serviceResponse.body).not.toContain('re_secret');
      const createdServiceId = serviceResponse.json().service.id as string;

      const monitorResponse = await app.inject({
        method: 'POST',
        url: '/api/monitors',
        headers: { cookie },
        payload: {
          name: 'Checkout',
          url: 'https://example.com/health',
          regionIds: ['us-east'],
          intervalSeconds: 300,
          timeoutMs: 10_000,
          enabled: true,
          dnsDiagnosticsEnabled: false,
          isPublic: false,
          notificationServiceIds: [createdServiceId],
          outageThreshold: 4,
          recoveryThreshold: 3,
          repeatNotificationMinutes: 120,
        },
      });
      expect(monitorResponse.statusCode).toBe(201);
      const createdMonitorId = monitorResponse.json().summary.monitor.id as string;
      const stored = await client.query<{
        outage_threshold: number;
        recovery_threshold: number;
        repeat_notification_minutes: number;
        notification_service_id: string;
      }>(
        `select m.outage_threshold, m.recovery_threshold, m.repeat_notification_minutes,
          mns.notification_service_id
        from monitors m join monitor_notification_services mns on mns.monitor_id = m.id
        where m.id = $1`,
        [createdMonitorId],
      );
      expect(stored.rows).toEqual([
        {
          outage_threshold: 4,
          recovery_threshold: 3,
          repeat_notification_minutes: 120,
          notification_service_id: createdServiceId,
        },
      ]);

      await client.query(
        `insert into notification_deliveries
          (monitor_id, notification_service_id, event_key, kind, message)
        values ($1, $2, 'pending-outage', 'outage', '{}'::jsonb)`,
        [createdMonitorId, createdServiceId],
      );
      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/api/monitors/${createdMonitorId}`,
        headers: { cookie },
        payload: { outageThreshold: 5 },
      });
      expect(updateResponse.statusCode).toBe(200);
      const delivery = await client.query<{ status: string }>(
        `select status from notification_deliveries where event_key = 'pending-outage'`,
      );
      expect(delivery.rows).toEqual([{ status: 'cancelled' }]);

      await client.query(
        `insert into monitor_notification_state
          (monitor_id, config_fingerprint, last_window_started_at)
        values ($1, 'active-fingerprint', '2026-09-16T12:00:00.000Z')`,
        [createdMonitorId],
      );
      const disableResponse = await app.inject({
        method: 'PATCH',
        url: `/api/monitors/${createdMonitorId}`,
        headers: { cookie },
        payload: { enabled: false },
      });
      expect(disableResponse.statusCode).toBe(200);
      const enableResponse = await app.inject({
        method: 'PATCH',
        url: `/api/monitors/${createdMonitorId}`,
        headers: { cookie },
        payload: { enabled: true },
      });
      expect(enableResponse.statusCode).toBe(200);
      const state = await client.query<{ config_fingerprint: string }>(
        'select config_fingerprint from monitor_notification_state where monitor_id = $1',
        [createdMonitorId],
      );
      expect(state.rows).toEqual([{ config_fingerprint: 'invalidated' }]);

      await client.query(
        `update monitor_notification_state set config_fingerprint = 'stable'
        where monitor_id = $1`,
        [createdMonitorId],
      );
      const disableServiceResponse = await app.inject({
        method: 'PATCH',
        url: `/api/notification-services/${createdServiceId}`,
        headers: { cookie },
        payload: { enabled: false },
      });
      expect(disableServiceResponse.statusCode).toBe(200);
      const enableServiceResponse = await app.inject({
        method: 'PATCH',
        url: `/api/notification-services/${createdServiceId}`,
        headers: { cookie },
        payload: { enabled: true },
      });
      expect(enableServiceResponse.statusCode).toBe(200);
      const serviceState = await client.query<{ config_fingerprint: string }>(
        'select config_fingerprint from monitor_notification_state where monitor_id = $1',
        [createdMonitorId],
      );
      expect(serviceState.rows).toEqual([{ config_fingerprint: 'invalidated' }]);
    } finally {
      await app.close();
      await client.close();
    }
  }, 30_000);

  it('validates and persists rules and service selections in the monitor transaction', async () => {
    const passwordHash = await argon2.hash('correct horse battery staple', {
      type: argon2.argon2id,
    });
    const transactionSql: string[] = [];
    let insideTransaction = false;
    const database = {
      execute: async (query: unknown) => {
        const compiled = new PgDialect().sqlToQuery(query as never);
        if (insideTransaction) transactionSql.push(compiled.sql);
        if (compiled.sql.includes('password_hash as "passwordHash"')) {
          return { rows: [{ ...admin, passwordHash }] };
        }
        if (compiled.sql.includes('from sessions join admins')) return { rows: [admin] };
        if (compiled.sql.includes('select id from notification_services')) {
          return { rows: [{ id: serviceId }] };
        }
        if (compiled.sql.includes('insert into monitors')) {
          return {
            rows: [
              {
                id: monitorId,
                name: 'Checkout',
                url: 'https://example.com/health',
                intervalSeconds: 300,
                timeoutMs: 10_000,
                enabled: true,
                dnsDiagnosticsEnabled: false,
                isPublic: false,
                publicSlug: null,
                outageThreshold: 4,
                recoveryThreshold: 3,
                repeatNotificationMinutes: 120,
                createdAt: '2026-09-16T10:00:00.000Z',
                updatedAt: '2026-09-16T10:00:00.000Z',
              },
            ],
          };
        }
        if (compiled.sql.includes('from monitor_regions')) {
          return { rows: [{ regionId: 'us-east' }] };
        }
        return { rows: [] };
      },
      transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        insideTransaction = true;
        try {
          return await run(database);
        } finally {
          insideTransaction = false;
        }
      },
    };
    const app = await buildApi(
      {
        DATABASE_URL: 'postgresql://uptime:uptime@localhost:5432/uptime',
        SESSION_COOKIE_SECURE: false,
        ADMIN_EMAIL: admin.email,
        ADMIN_PASSWORD_HASH: passwordHash,
        SESSION_SECRET: 'a'.repeat(32),
      },
      { db: database as never, now: () => new Date('2026-09-16T12:00:00.000Z') },
    );
    apps.push(app);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'correct horse battery staple' },
    });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';

    const response = await app.inject({
      method: 'POST',
      url: '/api/monitors',
      headers: { cookie },
      payload: {
        name: 'Checkout',
        url: 'https://example.com/health',
        regionIds: ['us-east'],
        intervalSeconds: 300,
        timeoutMs: 10_000,
        enabled: true,
        dnsDiagnosticsEnabled: false,
        isPublic: false,
        notificationServiceIds: [serviceId],
        outageThreshold: 4,
        recoveryThreshold: 3,
        repeatNotificationMinutes: 120,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().summary.monitor).toMatchObject({
      notificationServiceIds: [serviceId],
      outageThreshold: 4,
      recoveryThreshold: 3,
      repeatNotificationMinutes: 120,
    });
    expect(
      transactionSql.some((query) => query.includes('select id from notification_services')),
    ).toBe(true);
    expect(transactionSql.some((query) => query.includes('insert into monitors'))).toBe(true);
    expect(
      transactionSql.some((query) => query.includes('insert into monitor_notification_services')),
    ).toBe(true);
  });
});
