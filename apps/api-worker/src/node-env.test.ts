import { describe, expect, it } from 'vitest';

import { loadNodeRuntime } from './node-env.js';

const catalog = JSON.stringify({
  controlSchema: 'control',
  sources: [{ sourceDatabaseId: 'source-1', schema: 'tenant_000', profile: 'full-hosted' }],
});

const base = {
  PUBLIC_ORIGIN: 'https://uptime.example',
  POSTGRES_URL: 'postgresql://worker:pw@127.0.0.1:5432/uptime',
  POSTGRES_RUNTIME_CATALOG: catalog,
  SESSION_SECRET: 's'.repeat(32),
  CREDENTIAL_ENCRYPTION_SECRET: 'c'.repeat(32),
  OAUTH_STORAGE_SECRET: 'o'.repeat(32),
  ENVIRONMENT: 'staging',
  API_GATEWAY_TOKEN: 'g'.repeat(32),
};

describe('node runtime configuration', () => {
  it('maps variables onto the Worker env and applies safe defaults', () => {
    const { env, config } = loadNodeRuntime({ ...base, BILLING_MODE: 'mock' });
    expect(env.POSTGRES).toEqual({ connectionString: base.POSTGRES_URL });
    expect(env.BILLING_MODE).toBe('mock');
    expect(env.POSTGRES_SOURCE_DATABASE_ID).toBeUndefined();
    expect(env.REPORTS).toBeUndefined();
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8787,
      maxBodyBytes: 1_048_576,
      gatewayToken: base.API_GATEWAY_TOKEN,
      reconcileIntervalMs: 60_000,
    });
    expect(config.trustedProxies.size).toBe(0);
    expect(config.publicOrigin.origin).toBe('https://uptime.example');
  });

  it.each([
    ['PUBLIC_ORIGIN', { PUBLIC_ORIGIN: undefined }],
    ['PUBLIC_ORIGIN', { PUBLIC_ORIGIN: 'http://uptime.example' }],
    ['PUBLIC_ORIGIN', { PUBLIC_ORIGIN: 'https://uptime.example/app' }],
    ['POSTGRES_URL', { POSTGRES_URL: undefined }],
    ['POSTGRES_URL', { POSTGRES_URL: 'mysql://x' }],
    ['POSTGRES_RUNTIME_CATALOG', { POSTGRES_RUNTIME_CATALOG: undefined }],
    ['SESSION_SECRET', { SESSION_SECRET: 'short' }],
    ['OAUTH_STORAGE_SECRET', { OAUTH_STORAGE_SECRET: undefined }],
    ['POSTGRES_SOURCE_DATABASE_ID', { POSTGRES_SOURCE_DATABASE_ID: 'source-1' }],
    ['API_TRUSTED_PROXIES', { API_TRUSTED_PROXIES: 'localhost' }],
    ['API_GATEWAY_TOKEN', { API_GATEWAY_TOKEN: 'short' }],
    ['R2_', { R2_ACCESS_KEY_ID: 'id' }],
  ])('fails closed on bad %s', (_name, override) => {
    expect(() => loadNodeRuntime({ ...base, ...override } as NodeJS.ProcessEnv)).toThrow();
  });

  it('never echoes secret values in errors', () => {
    try {
      loadNodeRuntime({ ...base, POSTGRES_URL: 'mysql://user:hunter2@host/db' });
    } catch (error) {
      expect(String(error)).not.toContain('hunter2');
      return;
    }
    throw new Error('expected a failure');
  });

  it.each(['staging', 'production'])('requires a gateway token in %s', (environment) => {
    for (const token of [undefined, '', 'secret-too-short']) {
      expect(() =>
        loadNodeRuntime({ ...base, ENVIRONMENT: environment, API_GATEWAY_TOKEN: token }),
      ).toThrow(/API_GATEWAY_TOKEN (is required|must be at least 32 characters)/);
    }
    expect(loadNodeRuntime({ ...base, ENVIRONMENT: environment }).config.gatewayToken).toBe(
      base.API_GATEWAY_TOKEN,
    );
  });

  it.each(['development', 'test'])('allows an absent gateway token in %s', (environment) => {
    for (const token of [undefined, '']) {
      expect(
        loadNodeRuntime({ ...base, ENVIRONMENT: environment, API_GATEWAY_TOKEN: token }).config
          .gatewayToken,
      ).toBeNull();
    }
  });

  it('builds an R2 bucket only when every credential is present', () => {
    const { env } = loadNodeRuntime({
      ...base,
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      R2_ACCESS_KEY_ID: 'id',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_REPORTS_BUCKET: 'uptime-staging-reports',
    });
    expect(typeof env.REPORTS?.get).toBe('function');
  });
});
