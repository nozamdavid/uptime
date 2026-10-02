import { describe, expect, it } from 'vitest';
import { estimateMonthlyCost, freeLimits, tenantReportsBucket } from './tenancy.js';
import type { R2Bucket } from './workers-types.js';

describe('tenancy helpers', () => {
  it('keeps report keys inside the workspace namespace', async () => {
    const calls: string[] = [];
    const bucket: R2Bucket = {
      head: async (key) => {
        calls.push(`head:${key}`);
        return null;
      },
      get: async (key) => {
        calls.push(`get:${key}`);
        return null;
      },
      put: async (key) => {
        calls.push(`put:${key}`);
        return null;
      },
      delete: async (keys) => {
        calls.push(`delete:${Array.isArray(keys) ? keys.join(',') : keys}`);
      },
      list: async (options) => {
        calls.push(`list:${options?.prefix ?? ''}`);
        return { objects: [], truncated: false };
      },
    };
    const tenant = tenantReportsBucket(bucket, 'workspace/a');
    await tenant.put('reports/index.json', '{}');
    await tenant.delete(['reports/old.json']);
    await tenant.list({ prefix: 'reports/' });
    expect(calls).toEqual([
      'put:tenants/workspace%2Fa/reports/index.json',
      'delete:tenants/workspace%2Fa/reports/old.json',
      'list:tenants/workspace%2Fa/reports/',
    ]);
  });

  it('reports allowance based cost without presenting a hard cap', () => {
    const estimate = estimateMonthlyCost(
      { checks: 1_000_001, rowsRead: 0, rowsWritten: 1, storageBytes: 0 },
      { rowsRead: 0, rowsWritten: 0, storageBytes: 0 },
    );
    expect(estimate.baseUsd).toBe(5);
    expect(estimate.estimatedUsd).toBeGreaterThan(5);
    expect(estimate.withinAllowance).toBe(false);
    expect(freeLimits.maxMonitors).toBe(3);
  });

  it('uses paid D1 allowances and accounts for one million extra writes', () => {
    expect(estimateMonthlyCost({ rowsWritten: 51_000_000 }).estimatedUsd).toBe(6);
    expect(estimateMonthlyCost({ rowsRead: 25_001_000_000 }).overageUsd).toBe(0.001);
    expect(estimateMonthlyCost({ storageBytes: 6_000_000_000 }).overageUsd).toBe(0.75);
    expect(estimateMonthlyCost({ checks: 100_000_000 }).overageUsd).toBe(0);
  });
});
