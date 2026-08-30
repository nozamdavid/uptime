import argon2 from 'argon2';
import { afterEach, describe, expect, it } from 'vitest';
import { apiEnvSchema } from '@uptime/config';

import { assertValidAdminPasswordHash } from './auth.js';
import { buildApi } from './server.js';

const origin = 'http://localhost:5176';

function padBase64(value: string) {
  return value + '='.repeat((4 - (value.length % 4)) % 4);
}

function paddedArgon2idHash(hash: string) {
  const fields = hash.split('$');
  fields[4] = padBase64(fields[4] ?? '');
  fields[5] = padBase64(fields[5] ?? '');
  return fields.join('$');
}

async function validEnv() {
  return {
    DATABASE_URL: 'postgresql://uptime:uptime@localhost:5432/uptime',
    SESSION_COOKIE_SECURE: false,
    ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD_HASH: await argon2.hash('correct horse battery staple', {
      type: argon2.argon2id,
    }),
    SESSION_SECRET: 'a'.repeat(32),
  };
}

function fakeDatabase(passwordHash: string) {
  return {
    execute: async () => ({
      rows: [
        { id: '73d8a1ef-f98c-42fb-9482-e4c4e15f6ed1', email: 'admin@example.com', passwordHash },
      ],
    }),
  };
}

describe('admin password hash handling', () => {
  const apps: Awaited<ReturnType<typeof buildApi>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it.each([undefined, 'https://unrelated.example'])(
    'allows state-changing requests without an origin restriction (%s)',
    async (requestOrigin) => {
      const env = await validEnv();
      const app = await buildApi(env, {
        db: fakeDatabase(env.ADMIN_PASSWORD_HASH) as never,
      });
      apps.push(app);

      const response = await app.inject({
        method: 'POST',
        url: '/api/estimates',
        ...(requestOrigin ? { headers: { origin: requestOrigin } } : {}),
        payload: { regionIds: ['us-east'], intervalSeconds: 300 },
      });

      expect(response.statusCode).toBe(200);
    },
  );

  it('rejects a padded Argon2id PHC value before the API can start', async () => {
    const env = await validEnv();
    expect(apiEnvSchema.safeParse(env).success).toBe(true);
    expect(() =>
      apiEnvSchema.parse({
        ...env,
        ADMIN_PASSWORD_HASH: paddedArgon2idHash(env.ADMIN_PASSWORD_HASH),
      }),
    ).toThrow('canonical unpadded Argon2id PHC');
    await expect(
      buildApi({ ...env, ADMIN_PASSWORD_HASH: paddedArgon2idHash(env.ADMIN_PASSWORD_HASH) }),
    ).rejects.toThrow('canonical unpadded Argon2id PHC');
  });

  it('accepts a valid hash through the argon2 parser seam', async () => {
    const env = await validEnv();
    await expect(assertValidAdminPasswordHash(env.ADMIN_PASSWORD_HASH)).resolves.toBeUndefined();
  });

  it('returns a configuration error instead of leaking a parser failure for a malformed stored hash', async () => {
    const env = await validEnv();
    const app = await buildApi(env, {
      db: fakeDatabase(paddedArgon2idHash(env.ADMIN_PASSWORD_HASH)) as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { password: 'correct horse battery staple' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'auth_configuration_error',
        message: 'Authentication is temporarily unavailable',
      },
    });
  });

  it('keeps ordinary incorrect passwords as 401 responses', async () => {
    const env = await validEnv();
    const app = await buildApi(env, { db: fakeDatabase(env.ADMIN_PASSWORD_HASH) as never });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { password: 'incorrect password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'invalid_credentials', message: 'Invalid password' },
    });
  });
});
