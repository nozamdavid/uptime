import { describe, expect, it } from 'vitest';
import { tenantReportsBucket } from './tenancy.js';
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
});
