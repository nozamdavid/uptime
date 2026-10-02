import { describe, expect, it } from 'vitest';

import { parseCoordinatorEnv } from './env.js';

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: {} as never,
    REPORTS: {} as never,
    PROBE_SIGNING_SECRET: 'x'.repeat(40),
    CREDENTIAL_ENCRYPTION_SECRET: 'y'.repeat(40),
    WORKERS_URL_DOMAIN: 'account.workers.dev',
    REGIONS_LIST: 'us-east,eu-west',
    ENVIRONMENT: 'test',
    ...overrides,
  } as never;
}

describe('coordinator env', () => {
  it('parses bindings and applies documented defaults', () => {
    const config = parseCoordinatorEnv(baseEnv());
    expect(config.enabledRegionIds).toEqual(['us-east', 'eu-west']);
    expect(config.probeWorkerNamePrefix).toBe('uptime-probe-');
    expect(config.reportIntervalSeconds).toBe(60);
    expect(config.staleAfterSeconds).toBe(180);
    expect(config.monitorBatch).toBe(50);
    expect(config.probeConcurrency).toBe(32);
    expect(config.notificationMaxAttempts).toBe(8);
    expect(config.detailedResultsRetentionDays).toBe(7);
    expect(config.historyRetentionPreserveBefore).toBeUndefined();
  });

  it('normalizes a configured history retention preservation boundary', () => {
    const config = parseCoordinatorEnv(
      baseEnv({ HISTORY_RETENTION_PRESERVE_BEFORE: '2026-09-21T16:22:10.021+02:00' }),
    );
    expect(config.historyRetentionPreserveBefore).toBe('2026-09-21T14:22:10.021Z');
  });

  it('accepts an isolated probe worker name prefix', () => {
    const config = parseCoordinatorEnv(
      baseEnv({ PROBE_WORKER_NAME_PREFIX: 'uptime-staging-probe-' }),
    );
    expect(config.probeWorkerNamePrefix).toBe('uptime-staging-probe-');
  });

  it.each(['', 'Uptime-staging-probe-', 'uptime.staging-', '-uptime-staging-', 'staging'])(
    'rejects invalid probe worker name prefix %j',
    (prefix) => {
      expect(() => parseCoordinatorEnv(baseEnv({ PROBE_WORKER_NAME_PREFIX: prefix }))).toThrow(
        /PROBE_WORKER_NAME_PREFIX/,
      );
    },
  );

  it('rejects a prefix that makes the worker DNS label too long', () => {
    expect(() =>
      parseCoordinatorEnv(baseEnv({ PROBE_WORKER_NAME_PREFIX: `${'a'.repeat(49)}-` })),
    ).toThrow(/longer than 63/);
  });

  it('coerces numeric vars and accepts the legacy encryption secret name', () => {
    const config = parseCoordinatorEnv(
      baseEnv({
        CREDENTIAL_ENCRYPTION_SECRET: undefined,
        NOTIFICATION_ENCRYPTION_KEY: 'z'.repeat(40),
        COORDINATOR_MONITOR_BATCH: '25',
        REPORT_INTERVAL_SECONDS: '120',
      }),
    );
    expect(config.credentialEncryptionSecret).toBe('z'.repeat(40));
    expect(config.monitorBatch).toBe(25);
    expect(config.reportIntervalSeconds).toBe(120);
    expect(config.staleAfterSeconds).toBe(240);
  });

  it('rejects missing secrets and bad domains', () => {
    expect(() => parseCoordinatorEnv(baseEnv({ CREDENTIAL_ENCRYPTION_SECRET: 'short' }))).toThrow(
      /CREDENTIAL_ENCRYPTION_SECRET/,
    );
    expect(() => parseCoordinatorEnv(baseEnv({ WORKERS_URL_DOMAIN: 'not a domain' }))).toThrow(
      /WORKERS_URL_DOMAIN/,
    );
  });
});
