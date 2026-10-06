import { describe, expect, it, beforeEach } from 'vitest';
import {
  getCloudflareUsageReport,
  clearCloudflareUsageCache,
  sanitizeErrorMessage,
  OFFICIAL_CLOUDFLARE_LIMITS,
} from './cloudflare-usage.js';

describe('Cloudflare Paid Tier Usage Adapter', () => {
  beforeEach(() => {
    clearCloudflareUsageCache();
  });

  const fixedDate = new Date('2026-10-05T12:00:00Z');

  describe('unconfigured or missing credentials', () => {
    it('returns explicit unknown status and setup instructions when credentials are missing', async () => {
      const report = await getCloudflareUsageReport({
        now: () => fixedDate,
      });

      expect(report.status).toBe('unknown');
      expect(report.isWithinAllowance).toBeNull();
      expect(report.hasHardLimitViolation).toBeNull();
      expect(report.totalEstimatedOverageCostUsd).toBeNull();
      expect(report.forecastGuardExceeded).toBeNull();
      expect(report.coverage).toContain('Account-level telemetry not configured');
      expect(report.coverage).toContain('Tenant-level metrics cannot prove');

      expect(report.setupNeeded).toBeDefined();
      expect(report.setupNeeded?.configured).toBe(false);
      expect(report.setupNeeded?.missingVariables).toEqual([
        'CLOUDFLARE_ACCOUNT_ID',
        'CLOUDFLARE_ANALYTICS_READ_TOKEN',
      ]);
      expect(report.setupNeeded?.requiredPermissions).toContain('Account Analytics: Read');

      // Every metric must be marked unknown and unconfigured — NEVER fabricated zero!
      for (const metric of report.metrics) {
        expect(metric.status).toBe('unknown');
        expect(metric.source).toBe('unconfigured');
        expect(metric.used).toBeNull();
      }
    });

    it('identifies when only apiToken is missing', async () => {
      const report = await getCloudflareUsageReport({
        accountId: 'test-account-123',
        now: () => fixedDate,
      });

      expect(report.status).toBe('unknown');
      expect(report.setupNeeded?.missingVariables).toEqual(['CLOUDFLARE_ANALYTICS_READ_TOKEN']);
    });
  });

  describe('GraphQL actual schema validation & aggregation', () => {
    it('aggregates multiple groups safely and leaves unsupported CPU sum as unknown', async () => {
      const mockFetch: typeof fetch = async (input, init) => {
        const bodyStr = typeof init?.body === 'string' ? init.body : '';

        if (bodyStr) {
          const query = (JSON.parse(bodyStr) as { query: string }).query;
          expect(query).toContain('$accountTag: string!');
          expect(query).not.toContain('String!');
          if (query.includes('GetD1Usage')) expect(query).toContain('$startDate: Date!');
          if (query.includes('GetWorkersInvocations'))
            expect(query).toContain('$startDatetime: string!');
          if (query.includes('GetQueueUsage')) expect(query).toContain('$startDatetime: Time!');
        }

        if (bodyStr.includes('workersInvocationsAdaptive')) {
          // Actual schema: workersInvocationsAdaptive supports sum { requests }
          // Returning 2 groups to verify aggregation across groups
          return new Response(
            JSON.stringify({
              data: {
                viewer: {
                  accounts: [
                    {
                      workersInvocationsAdaptive: [
                        { sum: { requests: 1_000_000 } },
                        { sum: { requests: 500_000 } },
                      ],
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (bodyStr.includes('d1AnalyticsAdaptiveGroups')) {
          // Actual schema: d1AnalyticsAdaptiveGroups supports sum { rowsRead rowsWritten }
          return new Response(
            JSON.stringify({
              data: {
                viewer: {
                  accounts: [
                    {
                      d1AnalyticsAdaptiveGroups: [
                        { sum: { rowsRead: 300_000_000, rowsWritten: 1_000_000 } },
                        { sum: { rowsRead: 200_000_000, rowsWritten: 1_000_000 } },
                      ],
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (bodyStr.includes('queueMessageOperationsAdaptiveGroups')) {
          // Actual schema: billableOperations (not operations)
          return new Response(
            JSON.stringify({
              data: {
                viewer: {
                  accounts: [
                    {
                      queueMessageOperationsAdaptiveGroups: [
                        { sum: { billableOperations: 80_000 } },
                        { sum: { billableOperations: 70_000 } },
                      ],
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const url = String(input);
        if (url.includes('/d1/database')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ file_size: 100_000_000 }],
              result_info: { total_count: 1, total_pages: 1 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (url.includes('/workers/scripts')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ id: 'script-1' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        return new Response('Not found', { status: 404 });
      };

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      // Workers Requests should be summed across all returned groups: 1.0M + 0.5M = 1.5M
      const reqMetric = report.metrics.find((m) => m.id === 'workers_requests');
      expect(reqMetric?.used).toBe(1_500_000);
      expect(reqMetric?.status).toBe('within');

      // Workers CPU sum is unsupported by GraphQL invocations sum; must be reported as unknown!
      const cpuMetric = report.metrics.find((m) => m.id === 'workers_cpu_ms');
      expect(cpuMetric?.used).toBeNull();
      expect(cpuMetric?.status).toBe('unknown');

      // D1 Rows Read: 300M + 200M = 500M
      const rowsReadMetric = report.metrics.find((m) => m.id === 'd1_rows_read');
      expect(rowsReadMetric?.used).toBe(500_000_000);

      // D1 Rows Written: 1M + 1M = 2M
      const rowsWrittenMetric = report.metrics.find((m) => m.id === 'd1_rows_written');
      expect(rowsWrittenMetric?.used).toBe(2_000_000);

      // Queues billable operations: 80k + 70k = 150k
      const queueMetric = report.metrics.find((m) => m.id === 'queues_operations');
      expect(queueMetric?.used).toBe(150_000);

      // R2 metrics are unmeasured via account API -> must be unknown
      const r2Storage = report.metrics.find((m) => m.id === 'r2_storage');
      expect(r2Storage?.used).toBeNull();
      expect(r2Storage?.status).toBe('unknown');

      // Because CPU, R2, etc. are unmeasured, overall status MUST NEVER be claimed as 'within'!
      expect(report.status).toBe('unknown');
      expect(report.isWithinAllowance).toBeNull();
      expect(report.hasHardLimitViolation).toBe(false); // All hard limits were checked (scripts, DB count, DB size)
    });

    it('marks metric unknown when GraphQL results reach the query limit (truncation risk)', async () => {
      const mockFetch: typeof fetch = async (input, init) => {
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        if (bodyStr.includes('workersInvocationsAdaptive')) {
          // Simulate 10,000 groups returned (query limit hit, truncation)
          const groups = new Array(10000).fill({ sum: { requests: 1 } });
          return new Response(
            JSON.stringify({
              data: { viewer: { accounts: [{ workersInvocationsAdaptive: groups }] } },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      const reqMetric = report.metrics.find((m) => m.id === 'workers_requests');
      expect(reqMetric?.status).toBe('unknown');
      expect(reqMetric?.used).toBeNull();
    });
  });

  describe('independent query resilience', () => {
    it('preserves workers and D1 metrics even if queues query fails or errors', async () => {
      const mockFetch: typeof fetch = async (input, init) => {
        const bodyStr = typeof init?.body === 'string' ? init.body : '';

        if (bodyStr.includes('workersInvocationsAdaptive')) {
          return new Response(
            JSON.stringify({
              data: {
                viewer: {
                  accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 2_000_000 } }] }],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (bodyStr.includes('d1AnalyticsAdaptiveGroups')) {
          return new Response(
            JSON.stringify({
              data: {
                viewer: {
                  accounts: [
                    {
                      d1AnalyticsAdaptiveGroups: [
                        { sum: { rowsRead: 10_000_000, rowsWritten: 500_000 } },
                      ],
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (bodyStr.includes('queueMessageOperationsAdaptiveGroups')) {
          // Queues query fails (e.g. 500 or GraphQL error because queues not enabled)
          return new Response(
            JSON.stringify({
              errors: [{ message: 'Queue dataset not enabled on account' }],
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const url = String(input);
        if (url.includes('/d1/database')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ file_size: 50_000_000 }],
              result_info: { total_count: 1, total_pages: 1 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (url.includes('/workers/scripts')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ id: 's1' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        return new Response('Not found', { status: 404 });
      };

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      // Workers requests and D1 succeeded
      expect(report.metrics.find((m) => m.id === 'workers_requests')?.used).toBe(2_000_000);
      expect(report.metrics.find((m) => m.id === 'd1_rows_read')?.used).toBe(10_000_000);

      // Queue metric is marked unknown due to query failure, but didn't crash other metrics
      expect(report.metrics.find((m) => m.id === 'queues_operations')?.status).toBe('unknown');
      expect(report.metrics.find((m) => m.id === 'queues_operations')?.used).toBeNull();
    });
  });

  describe('D1 REST pagination and storage validation', () => {
    it('paginates over multiple pages and aggregates database count and storage accurately', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);

        if (url.includes('/d1/database?page=1')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: [
                { uuid: 'db-1', name: 'db1', file_size: 500_000_000 },
                { uuid: 'db-2', name: 'db2', file_size: 300_000_000 },
              ],
              result_info: { page: 1, per_page: 2, total_count: 3, total_pages: 2 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (url.includes('/d1/database?page=2')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ uuid: 'db-3', name: 'db3', file_size: 200_000_000 }],
              result_info: { page: 2, per_page: 2, total_count: 3, total_pages: 2 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (url.includes('/workers/scripts')) {
          return new Response(JSON.stringify({ success: true, result: [{ id: 's1' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ data: { viewer: { accounts: [] } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      // Total count across pages: 3
      const countMetric = report.metrics.find((m) => m.id === 'd1_databases_count');
      expect(countMetric?.used).toBe(3);
      expect(countMetric?.status).toBe('within');

      // Total storage: 500M + 300M + 200M = 1,000,000,000 bytes (1 GB)
      const storageMetric = report.metrics.find((m) => m.id === 'd1_storage');
      expect(storageMetric?.used).toBe(1_000_000_000);
      expect(storageMetric?.status).toBe('within');
      // Instant point-in-time storage should NOT calculate overage bill
      expect(storageMetric?.estimatedOverageCostUsd).toBeNull();
    });

    it('marks storage unknown if any database is missing file_size metadata', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes('/d1/database')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: [
                { uuid: 'db-1', file_size: 100_000_000 },
                { uuid: 'db-2' }, // file_size missing
              ],
              result_info: { page: 1, per_page: 100, total_count: 2, total_pages: 1 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      const countMetric = report.metrics.find((m) => m.id === 'd1_databases_count');
      expect(countMetric?.used).toBe(2);
      expect(report.hasHardLimitViolation).toBeNull();

      const storageMetric = report.metrics.find((m) => m.id === 'd1_storage');
      expect(storageMetric?.used).toBeNull();
      expect(storageMetric?.status).toBe('unknown');
    });

    it('marks storage unknown when pagination exceeds bounded MAX_PAGES cap', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes('/d1/database')) {
          // Claim there are 25 pages (exceeds MAX_PAGES of 20)
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ uuid: 'db-x', file_size: 10_000_000 }],
              result_info: { page: 1, per_page: 1, total_count: 25, total_pages: 25 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      // Total count known from result_info
      expect(report.metrics.find((m) => m.id === 'd1_databases_count')?.used).toBe(25);
      // Storage incomplete because pagination was capped
      expect(report.hasHardLimitViolation).toBeNull();
      expect(report.metrics.find((m) => m.id === 'd1_storage')?.used).toBeNull();
      expect(report.metrics.find((m) => m.id === 'd1_storage')?.status).toBe('unknown');
    });

    it('marks D1 metrics unknown when REST returns 401 or errors (NEVER defaults to 0)', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes('/d1/database')) {
          return new Response('Unauthorized', { status: 401 });
        }
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      const countMetric = report.metrics.find((m) => m.id === 'd1_databases_count');
      expect(countMetric?.used).toBeNull();
      expect(countMetric?.status).toBe('unknown');

      const storageMetric = report.metrics.find((m) => m.id === 'd1_storage');
      expect(storageMetric?.used).toBeNull();
      expect(storageMetric?.status).toBe('unknown');
    });

    it('detects individual database exceeding 10 GB hard limit', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes('/d1/database')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ uuid: 'huge-db', file_size: 11_000_000_000 }, { uuid: 'unmeasured' }],
              result_info: { total_count: 2, total_pages: 1 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      expect(report.hasHardLimitViolation).toBe(true);
      expect(OFFICIAL_CLOUDFLARE_LIMITS.queues.operationChunkSizeBytes).toBe(64_000);
      expect(report.status).toBe('exceeded');
      expect(report.exceededHardLimits).toContain('D1 Database Max Size (10 GB)');
    });
  });

  describe('Workers REST validation', () => {
    it('detects when script count exceeds 500 hard limit', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes('/workers/scripts')) {
          const scripts = new Array(501).fill(0).map((_, i) => ({ id: `script-${i}` }));
          return new Response(JSON.stringify({ success: true, result: scripts }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      const scriptMetric = report.metrics.find((m) => m.id === 'workers_script_count');
      expect(scriptMetric?.used).toBe(501);
      expect(scriptMetric?.status).toBe('exceeded');
      expect(report.hasHardLimitViolation).toBe(true);
      expect(report.status).toBe('exceeded');
      expect(report.exceededHardLimits).toContain('Workers Script Count');
    });

    it('marks script count unknown when REST endpoint returns 403 (does NOT default to 0)', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const url = String(input);
        if (url.includes('/workers/scripts')) {
          return new Response('Forbidden', { status: 403 });
        }
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      const scriptMetric = report.metrics.find((m) => m.id === 'workers_script_count');
      expect(scriptMetric?.used).toBeNull();
      expect(scriptMetric?.status).toBe('unknown');
    });
  });

  describe('billed allowance overage vs hard limit vs internal forecast guard', () => {
    it('reports allowance overage and calculates cost without conflating with internal $20 guard', async () => {
      const mockFetch: typeof fetch = async (input, init) => {
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        if (bodyStr.includes('workersInvocationsAdaptive')) {
          // 15M requests (5M over 10M allowance) -> 5 * $0.30 = $1.50 overage
          return new Response(
            JSON.stringify({
              data: {
                viewer: {
                  accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 15_000_000 } }] }],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      const reqMetric = report.metrics.find((m) => m.id === 'workers_requests');
      expect(reqMetric?.status).toBe('exceeded');
      expect(reqMetric?.estimatedOverageCostUsd).toBe(1.5);

      expect(report.isWithinAllowance).toBe(false);
      expect(report.exceededIncludedUsages).toEqual(['Workers Requests']);
      expect(report.status).toBe('warning');

      // The internal $20 guard is the hosted D1 forecast; it must NOT be triggered by account overages
      expect(report.forecastGuardExceeded).toBeNull();
    });

    it('evaluates forecastGuardExceeded only when caller provides actual hosted forecast', async () => {
      const mockFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const reportSafe = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
        hostedForecastUsd: 12.5,
        forecastGuardUsd: 20.0,
      });
      expect(reportSafe.forecastGuardExceeded).toBe(false);

      clearCloudflareUsageCache();

      const reportBreached = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
        hostedForecastUsd: 22.0,
        forecastGuardUsd: 20.0,
      });
      expect(reportBreached.forecastGuardExceeded).toBe(true);
    });
  });

  describe('reporting period vs billing period & cache boundary', () => {
    it('labels reporting period as UTC calendar window and does not claim full billing compliance', async () => {
      const mockFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      expect(report.coverage).toContain('Reporting period: 2026-10-01 to 2026-10-05');
      expect(report.coverage).toContain('not verified account billing invoice cycle');
      expect(report.isWithinAllowance).toBeNull();
    });

    it('isolates cache by credentials and does not reuse cache across month boundary', async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      // 1. Initial call at 2026-10-31 23:59:00 UTC (1 minute before month end)
      const oct31 = new Date('2026-10-31T23:59:00Z');
      await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'token-A',
        fetchFn: mockFetch,
        now: () => oct31,
        ttlMs: 300_000, // 5 min TTL
      });
      const callsAfterOct = callCount;
      expect(callsAfterOct).toBeGreaterThan(0);

      // 2. Immediate call within October with same credentials should hit cache
      await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'token-A',
        fetchFn: mockFetch,
        now: () => new Date('2026-10-31T23:59:30Z'),
        ttlMs: 300_000,
      });
      expect(callCount).toBe(callsAfterOct); // No new fetch

      // 3. Call 2 minutes later across month boundary (2026-11-01 00:01:00 UTC)
      // Must NOT reuse October cache!
      const nov01 = new Date('2026-11-01T00:01:00Z');
      await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'token-A',
        fetchFn: mockFetch,
        now: () => nov01,
        ttlMs: 300_000,
      });
      expect(callCount).toBeGreaterThan(callsAfterOct); // New fetch made

      // 4. Token rotation should bypass cache
      const callsAfterNov = callCount;
      await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'token-B-rotated',
        fetchFn: mockFetch,
        now: () => nov01,
        ttlMs: 300_000,
      });
      expect(callCount).toBeGreaterThan(callsAfterNov);
    });
  });

  describe('error sanitization and robust input validation', () => {
    it('sanitizes bearer tokens, api keys, and email addresses from error messages', () => {
      const leakedError = new Error(
        'Upstream failure: Bearer cf_sec_abc123456789xyz on api_token=cf_sec_9999 for user admin@example.com',
      );
      const sanitized = sanitizeErrorMessage(leakedError);

      expect(sanitized).not.toContain('cf_sec_abc123456789xyz');
      expect(sanitized).not.toContain('cf_sec_9999');
      expect(sanitized).not.toContain('admin@example.com');
      expect(sanitized).toContain('Bearer [REDACTED]');
      expect(sanitized).toContain('api_token=[REDACTED]');
      expect(sanitized).toContain('[REDACTED_EMAIL]');
    });

    it('treats negative or NaN usage numbers as invalid/unknown', async () => {
      const mockFetch: typeof fetch = async (input, init) => {
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        if (bodyStr.includes('workersInvocationsAdaptive')) {
          return new Response(
            JSON.stringify({
              data: {
                viewer: {
                  accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: -500 } }] }],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ success: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const report = await getCloudflareUsageReport({
        accountId: 'test-acc',
        apiToken: 'test-tok',
        fetchFn: mockFetch,
        now: () => fixedDate,
      });

      const reqMetric = report.metrics.find((m) => m.id === 'workers_requests');
      expect(reqMetric?.status).toBe('unknown');
      expect(reqMetric?.used).toBeNull();
    });
  });
});
