import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadSchedulerRuntime, safeConfigMessage } from './node-scheduler-env.js';

const valid = {
  SCHEDULER_ENABLED: 'false',
  ENVIRONMENT: 'staging',
  POSTGRES_URL: 'postgresql://worker:placeholder-password@127.0.0.1:5432/uptime_staging',
  POSTGRES_RUNTIME_CATALOG_FILE: fileURLToPath(
    new URL('../../../deploy/vps/staging/catalog.json', import.meta.url),
  ),
  REGIONS_LIST: 'eu-west,us-east,asia',
  WORKERS_URL_DOMAIN: 'example.workers.dev',
  PROBE_WORKER_NAME_PREFIX: 'uptime-staging-hosted-probe-',
  PROBE_SIGNING_SECRET: 'p'.repeat(40),
  CREDENTIAL_ENCRYPTION_SECRET: 'c'.repeat(40),
  CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
  R2_ACCESS_KEY_ID: 'access-key-placeholder',
  R2_SECRET_ACCESS_KEY: 'secret-key-placeholder',
  R2_REPORTS_BUCKET: 'uptime-staging-reports',
} satisfies NodeJS.ProcessEnv;

describe('scheduler configuration', () => {
  it('loads a complete environment without inventing budget evidence', () => {
    const { config, env } = loadSchedulerRuntime(valid);
    expect(config).toEqual({ enabled: false, shutdownGraceMs: 25_000 });
    expect(env.POSTGRES).toEqual({ connectionString: valid.POSTGRES_URL });
    expect(env.REPORTS).toBeDefined();
    expect(env.CURRENT_BUDGET_USAGE_JSON).toBeUndefined();
    expect(env).not.toHaveProperty('R2_SECRET_ACCESS_KEY');
  });

  it.each([
    'SCHEDULER_ENABLED',
    'POSTGRES_URL',
    'POSTGRES_RUNTIME_CATALOG_FILE',
    'PROBE_SIGNING_SECRET',
    'CREDENTIAL_ENCRYPTION_SECRET',
    'WORKERS_URL_DOMAIN',
    'R2_SECRET_ACCESS_KEY',
  ])('fails naming %s when it is missing', (name) => {
    const source: NodeJS.ProcessEnv = { ...valid };
    delete source[name];
    expect(() => loadSchedulerRuntime(source)).toThrow(name);
  });

  it('never echoes secret values in errors', () => {
    const source = { ...valid, POSTGRES_URL: 'mysql://worker:placeholder-password@host/db' };
    expect(() => loadSchedulerRuntime(source)).toThrow(/POSTGRES_URL/);
    try {
      loadSchedulerRuntime(source);
    } catch (error) {
      expect((error as Error).message).not.toContain('placeholder-password');
    }
  });

  it('logs startup errors only when they name a variable without a value', () => {
    const logged = (overrides: NodeJS.ProcessEnv) => {
      try {
        loadSchedulerRuntime({ ...valid, ...overrides });
      } catch (error) {
        return safeConfigMessage(error);
      }
      throw new Error('expected a startup failure');
    };
    expect(logged({ PROBE_SIGNING_SECRET: undefined })).toBe(
      'Missing required binding: PROBE_SIGNING_SECRET',
    );
    expect(logged({ CREDENTIAL_ENCRYPTION_SECRET: 'short' })).toMatch(
      /^CREDENTIAL_ENCRYPTION_SECRET \(or NOTIFICATION_ENCRYPTION_KEY\) must/,
    );
    expect(logged({ WORKERS_URL_DOMAIN: undefined })).toMatch(/^WORKERS_URL_DOMAIN is required/);
    // intVar echoes the configured value, so this message must be replaced.
    const message = logged({ COORDINATOR_PROBE_CONCURRENCY: 'leaky-value-123' });
    expect(message).toBe('A configuration setting is invalid');
    expect(logged({ R2_REPORTS_BUCKET: 'Bad_Bucket!' })).toMatch(/^R2_REPORTS_BUCKET must be/);
  });

  it('requires an explicit boolean for SCHEDULER_ENABLED', () => {
    expect(() => loadSchedulerRuntime({ ...valid, SCHEDULER_ENABLED: 'yes' })).toThrow(
      'SCHEDULER_ENABLED must be true or false',
    );
    expect(loadSchedulerRuntime({ ...valid, SCHEDULER_ENABLED: 'true' }).config.enabled).toBe(true);
  });
});
