import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';

import {
  handleMonitorReport,
  refreshMonitorSnapshot,
  runMonitorRefreshCycle,
  startIncidentMonitorRefreshes,
  type MonitorRefreshParams,
  type MonitorReportEnv,
} from './on-demand-monitor.js';
import { FakeR2 } from './testing-r2.js';
import { makeDatabase, seedMonitor } from './testing.js';

const start = new Date('2026-09-27T12:00:00.000Z');

function fixture() {
  const { sqlite, db } = makeDatabase();
  const monitorId = seedMonitor(sqlite, { isPublic: 1, publicSlug: 'example' });
  const reports = new FakeR2();
  const instances = new Map<string, MonitorRefreshParams>();
  const create = vi.fn(async (options: { id: string; params: MonitorRefreshParams }) => {
    if (instances.has(options.id)) throw new Error('already exists');
    instances.set(options.id, options.params);
    return { id: options.id };
  });
  const workflow = {
    create,
    get: async (id: string) => ({
      status: async () => {
        if (!instances.has(id)) throw new Error('not found');
        return { status: 'running' };
      },
    }),
  } as unknown as Workflow<MonitorRefreshParams>;
  const env: MonitorReportEnv = {
    DB: db,
    REPORTS: reports,
    MONITOR_REFRESH: workflow,
    MONITOR_INITIAL_REPORT_WAIT_MS: '0',
  };
  const get = (reference = 'example', method = 'GET') =>
    handleMonitorReport(
      new Request(`https://reporter/reports/public/monitors/${reference}.json`, { method }),
      env,
    );
  const row = () =>
    sqlite.prepare('SELECT * FROM monitor_report_refresh WHERE monitor_id = ?').get(monitorId) as {
      token: string;
      ordinal: number;
      phase: string;
      generated_at: string;
      object_key: string;
      last_build_metrics: string;
    };
  return { sqlite, db, monitorId, reports, instances, create, env, get, row };
}

/** Explicitly run the durable initial step for tests that need a cached report. */
async function buildInitial(f: ReturnType<typeof fixture>): Promise<Response> {
  await f.get();
  const params = f.instances.get(f.row().token)!;
  expect(params.initialInWorkflow).toBe(true);
  await runInitial(f, params);
  return f.get();
}

async function runInitial(f: ReturnType<typeof fixture>, params: MonitorRefreshParams) {
  const pause = new Error('pause after initial');
  await expect(
    runMonitorRefreshCycle(f.env, params, {
      do: async (name: string, _options: unknown, callback: () => Promise<boolean>) => {
        expect(name).toBe('initial');
        return callback();
      },
      sleep: async () => {
        throw pause;
      },
    } as unknown as Pick<WorkflowStep, 'do' | 'sleep'>),
  ).rejects.toBe(pause);
  expect(f.row().ordinal).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('demand-triggered monitor refresh', () => {
  function advancePollsAutomatically() {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay = 0) => {
      vi.setSystemTime(Date.now() + delay);
      queueMicrotask(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
  }

  it('waits for a cold durable initial Workflow snapshot and shares it across concurrent GETs', async () => {
    const f = fixture();
    f.env.MONITOR_INITIAL_REPORT_WAIT_MS = '20000';
    advancePollsAutomatically();
    const first = f.get();
    const second = f.get();
    while (f.instances.size === 0) await Promise.resolve();
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    expect(f.instances.size).toBe(1);
    expect(f.row().ordinal).toBe(-1);
    const params = [...f.instances.values()][0]!;
    await runInitial(f, params);
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('returns the replacement initial snapshot instead of stale cached data', async () => {
    const f = fixture();
    const old = await (await buildInitial(f)).text();
    f.env.MONITOR_INITIAL_REPORT_WAIT_MS = '20000';
    advancePollsAutomatically();
    vi.setSystemTime(new Date(start.getTime() + 181_000));
    const pending = f.get();
    while (f.instances.size < 2) await Promise.resolve();
    const params = f.instances.get(f.row().token)!;
    expect(f.row().ordinal).toBe(-1);
    await runInitial(f, params);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).not.toBe(old);
  });

  it('bounds the wait and returns a retryable 503 when no initial snapshot commits', async () => {
    const f = fixture();
    f.env.MONITOR_INITIAL_REPORT_WAIT_MS = '20000';
    advancePollsAutomatically();
    const pending = f.get();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(f.row().ordinal).toBe(-1);
  });

  it('rereads the cached body when startup retry commits a replacement initial snapshot', async () => {
    const f = fixture();
    const old = await (await buildInitial(f)).text();
    vi.setSystemTime(new Date(start.getTime() + 181_000));
    f.create.mockRejectedValueOnce(new Error('temporary startup failure'));
    await startIncidentMonitorRefreshes(f.env, [f.monitorId]);
    expect(f.row()).toMatchObject({ phase: 'starting', ordinal: -1 });
    const create = f.create.getMockImplementation()!;
    f.create.mockImplementationOnce(async (options) => {
      const instance = await create(options);
      await runInitial(f, options.params);
      return instance;
    });

    const result = await f.get();

    expect(result.status).toBe(200);
    expect(f.row().ordinal).toBe(0);
    expect(await result.json()).toMatchObject({
      generatedAt: JSON.parse(f.reports.store.get(f.row().object_key)!.body).generatedAt,
    });
    expect(f.reports.store.get(f.row().object_key)!.body).not.toBe(old);
  });

  it.each(['claimed', 'claim loser'])(
    'keeps polling when %s refresh state is temporarily absent',
    async (caller) => {
      const f = fixture();
      if (caller === 'claim loser') await f.get();
      f.env.MONITOR_INITIAL_REPORT_WAIT_MS = '20000';
      advancePollsAutomatically();
      const prepare = f.db.prepare.bind(f.db);
      let missingReads = caller === 'claim loser' ? 3 : 0;
      f.create.mockImplementationOnce(async (options) => {
        f.instances.set(options.id, options.params);
        missingReads = 1;
        return { id: options.id };
      });
      vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
        const statement = prepare(sql);
        if (missingReads > 0 && sql.startsWith('SELECT * FROM monitor_report_refresh')) {
          missingReads -= 1;
          const bind = statement.bind.bind(statement);
          vi.spyOn(statement, 'bind').mockImplementation((...args) => {
            const bound = bind(...args);
            const all = bound.all.bind(bound);
            vi.spyOn(bound, 'all').mockImplementationOnce((async () => ({
              ...(await all()),
              results: [],
            })) as typeof bound.all);
            return bound;
          });
        }
        return statement;
      });

      const result = await f.get();

      expect(result.status).toBe(503);
      expect(Date.now() - start.getTime()).toBe(20_000);
      expect(missingReads).toBe(0);
    },
  );

  it.each(['before claim', 'during startup'])(
    'waits for a cold snapshot committed %s whose body becomes readable later',
    async (commit) => {
      const f = fixture();
      if (commit === 'before claim') await buildInitial(f);
      else {
        const create = f.create.getMockImplementation()!;
        f.create.mockImplementationOnce(async (options) => {
          const instance = await create(options);
          await runInitial(f, options.params);
          return instance;
        });
      }
      f.env.MONITOR_INITIAL_REPORT_WAIT_MS = '20000';
      advancePollsAutomatically();
      const get = f.reports.get.bind(f.reports);
      vi.spyOn(f.reports, 'get').mockImplementation(async (key) =>
        Date.now() < start.getTime() + 1_000 ? null : get(key),
      );

      const result = await f.get();

      expect(result.status).toBe(200);
      expect(await result.text()).toBe(f.reports.store.get(f.row().object_key)!.body);
      expect(Date.now() - start.getTime()).toBe(1_000);
      expect(f.create).toHaveBeenCalledTimes(1);
    },
  );

  it('creates a durable GET initial Workflow before any history write', async () => {
    const f = fixture();
    const put = vi.spyOn(f.reports, 'put');
    const background: Promise<unknown>[] = [];
    const result = await handleMonitorReport(
      new Request('https://reporter/reports/public/monitors/example.json'),
      f.env,
      (task) => background.push(task),
    );
    expect(result.status).toBe(503);
    expect(result.headers.get('retry-after')).toBe('1');
    expect(put).not.toHaveBeenCalled();
    expect(background).toHaveLength(1);
    await Promise.all(background);
    const params = [...f.instances.values()][0]!;
    expect(params).toMatchObject({ monitorId: f.monitorId, initialInWorkflow: true });
    expect(f.row()).toMatchObject({ ordinal: -1, phase: 'active' });
    expect((await f.get()).status).toBe(503);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
    await runInitial(f, params);
    expect(put).toHaveBeenCalledTimes(1);
    expect((await f.get()).status).toBe(200);
  });

  it('protects startup before the first DB read when the caller is dropped', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = f.db.prepare.bind(f.db);
    const prepareSpy = vi.spyOn(f.db, 'prepare').mockImplementationOnce((sql) => {
      const statement = prepare(sql);
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, 'bind').mockImplementation((...args) => {
        const bound = bind(...args);
        const all = bound.all.bind(bound);
        vi.spyOn(bound, 'all').mockImplementation((async () => {
          await gate;
          return all();
        }) as typeof bound.all);
        return bound;
      });
      return statement;
    });
    const background: Promise<unknown>[] = [];
    // Abandon the returned response promise, as a disconnected HTTP caller would.
    void handleMonitorReport(
      new Request('https://reporter/reports/public/monitors/example.json'),
      f.env,
      (task) => {
        expect(prepareSpy).not.toHaveBeenCalled();
        background.push(task);
      },
    );
    try {
      expect(background).toHaveLength(1);
      expect(f.create).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await Promise.all(background);
    expect(f.create).toHaveBeenCalledTimes(1);
    const params = [...f.instances.values()][0]!;
    expect(params.initialInWorkflow).toBe(true);
    expect(f.reports.store.size).toBe(0);
    await runInitial(f, params);
    expect((await f.get()).status).toBe(200);
  });

  it('preserves a live legacy building lease and resumes its committed initial report', async () => {
    const f = fixture();
    await f.get();
    const token = f.row().token;
    f.instances.clear();
    f.create.mockClear();
    f.sqlite
      .prepare("UPDATE monitor_report_refresh SET phase = 'building' WHERE monitor_id = ?")
      .run(f.monitorId);
    expect((await f.get()).status).toBe(503);
    expect(f.row()).toMatchObject({ token, phase: 'building', ordinal: -1 });
    expect(f.create).not.toHaveBeenCalled();
    expect(await refreshMonitorSnapshot(f.env, { monitorId: f.monitorId, token }, 0)).toBe(true);
    expect((await f.get()).status).toBe(200);
    expect(f.instances.get(token)).toEqual({ monitorId: f.monitorId, token });
    expect(f.row()).toMatchObject({ token, ordinal: 0, phase: 'active' });
  });

  it.each([false, true])(
    'reclaims only an expired legacy building lease (cached=%s)',
    async (cached) => {
      const f = fixture();
      if (cached) await buildInitial(f);
      else await f.get();
      const old = { monitorId: f.monitorId, token: f.row().token };
      f.sqlite
        .prepare(
          "UPDATE monitor_report_refresh SET phase = 'building', ordinal = -1 WHERE monitor_id = ?",
        )
        .run(f.monitorId);
      vi.setSystemTime(new Date(start.getTime() + 181_000));
      const put = vi.spyOn(f.reports, 'put');
      expect((await f.get()).status).toBe(cached ? 200 : 503);
      expect(f.row().token).not.toBe(old.token);
      expect(put).not.toHaveBeenCalled();
      expect(await refreshMonitorSnapshot(f.env, old, 0)).toBe(false);
      await runInitial(f, f.instances.get(f.row().token)!);
      expect((await f.get()).status).toBe(200);
    },
  );

  it('builds a disabled public monitor on GET while incident startup excludes it', async () => {
    const f = fixture();
    f.sqlite.prepare('UPDATE monitors SET enabled = 0 WHERE id = ?').run(f.monitorId);
    await startIncidentMonitorRefreshes(f.env, [f.monitorId]);
    expect(f.create).not.toHaveBeenCalled();
    expect((await f.get()).status).toBe(503);
    await runInitial(f, f.instances.get(f.row().token)!);
    expect((await f.get()).status).toBe(200);
  });

  it('starts incident work without building history in the caller, then builds initial plus four refreshes', async () => {
    const f = fixture();
    const put = vi.spyOn(f.reports, 'put');
    await startIncidentMonitorRefreshes(f.env, [f.monitorId, f.monitorId]);
    expect(put).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.row()).toMatchObject({ ordinal: -1, phase: 'active' });
    const params = [...f.instances.values()][0]!;
    expect(params.initialInWorkflow).toBe(true);
    const steps: string[] = [];
    const step = {
      sleep: async (name: string) => {
        expect(f.row().phase).toBe('active');
        steps.push(name);
        vi.setSystemTime(new Date(Date.now() + 60_000));
      },
      do: async (name: string, _options: unknown, callback: () => Promise<boolean>) => {
        steps.push(name);
        return callback();
      },
    } as unknown as Pick<WorkflowStep, 'do' | 'sleep'>;
    await runMonitorRefreshCycle(f.env, params, step);
    expect(steps).toEqual([
      'initial',
      'wait-1',
      'refresh-1',
      'wait-2',
      'refresh-2',
      'wait-3',
      'refresh-3',
      'wait-4',
      'refresh-4',
    ]);
    expect(put).toHaveBeenCalledTimes(5);
    expect(f.row()).toMatchObject({ ordinal: 4, phase: 'idle' });
    await startIncidentMonitorRefreshes(f.env, [f.monitorId]);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(5);
  });

  it('shares the atomic claim between concurrent GETs and incident publications', async () => {
    const f = fixture();
    const create = f.create.getMockImplementation()!;
    f.create.mockImplementation(async (options) => {
      const instance = await create(options);
      if (options.params.initialInWorkflow) await refreshMonitorSnapshot(f.env, options.params, 0);
      return instance;
    });
    await Promise.all([
      f.get(),
      startIncidentMonitorRefreshes(f.env, [f.monitorId]),
      startIncidentMonitorRefreshes(f.env, [f.monitorId, f.monitorId]),
    ]);
    expect(f.instances.size).toBe(1);
    const token = f.row().token;
    await startIncidentMonitorRefreshes(f.env, [f.monitorId]);
    expect(f.row().token).toBe(token);
    expect(f.instances.size).toBe(1);
    expect(f.create.mock.calls.every(([options]) => options.id === token)).toBe(true);
  });

  it('retries uncertain incident startup with the same token, including through GET', async () => {
    const f = fixture();
    await buildInitial(f);
    const put = vi.spyOn(f.reports, 'put');
    vi.setSystemTime(new Date(start.getTime() + 181_000));
    f.create.mockRejectedValueOnce(new Error('service unavailable'));
    await startIncidentMonitorRefreshes(f.env, [f.monitorId]);
    const token = f.row().token;
    expect(f.row()).toMatchObject({ ordinal: -1, phase: 'starting' });
    expect((await f.get()).status).toBe(200);
    expect(f.row()).toMatchObject({ token, ordinal: -1, phase: 'active' });
    expect(put).not.toHaveBeenCalled();
    expect(f.instances.size).toBe(2);
  });

  it('recovers expired incident leases and fences old initial attempts', async () => {
    const f = fixture();
    await startIncidentMonitorRefreshes(f.env, [f.monitorId]);
    const old = [...f.instances.values()][0]!;
    vi.setSystemTime(new Date(start.getTime() + 181_000));
    await startIncidentMonitorRefreshes(f.env, [f.monitorId]);
    const current = [...f.instances.values()][1]!;
    expect(await refreshMonitorSnapshot(f.env, old, 0)).toBe(false);
    expect(await refreshMonitorSnapshot(f.env, current, 0)).toBe(true);
    expect(await refreshMonitorSnapshot(f.env, current, 0)).toBe(true);
    expect(f.row().ordinal).toBe(0);
  });

  it('renews an expired unstarted incident before retrying its same Workflow token', async () => {
    const f = fixture();
    const create = f.create.getMockImplementation()!;
    f.create.mockRejectedValueOnce(new Error('service unavailable'));
    await startIncidentMonitorRefreshes(f.env, [f.monitorId]);
    const token = f.row().token;
    vi.setSystemTime(new Date(start.getTime() + 600_000));
    f.create.mockImplementationOnce(async (options) => {
      const instance = await create(options);
      expect(await refreshMonitorSnapshot(f.env, options.params, 0)).toBe(true);
      return instance;
    });
    await startIncidentMonitorRefreshes(f.env, [f.monitorId]);
    expect(f.row()).toMatchObject({ token, phase: 'active', ordinal: 0 });
    expect(f.instances.size).toBe(1);
  });

  it('recognizes uncertain successful incident creation without making another instance', async () => {
    const f = fixture();
    const create = f.create.getMockImplementation()!;
    f.create.mockImplementationOnce(async (options) => {
      await create(options);
      throw new Error('lost create response');
    });
    await startIncidentMonitorRefreshes(f.env, [f.monitorId]);
    expect(f.row()).toMatchObject({ phase: 'active', ordinal: -1 });
    await startIncidentMonitorRefreshes(f.env, [f.monitorId]);
    expect(f.instances.size).toBe(1);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('retries failed initial Workflow writes without repeating a committed initial ordinal', async () => {
    const f = fixture();
    await startIncidentMonitorRefreshes(f.env, [f.monitorId]);
    const params = [...f.instances.values()][0]!;
    const put = vi.spyOn(f.reports, 'put').mockRejectedValueOnce(new Error('R2 temporary failure'));
    await expect(refreshMonitorSnapshot(f.env, params, 0)).rejects.toThrow('R2 temporary failure');
    expect(f.row().ordinal).toBe(-1);
    expect(await refreshMonitorSnapshot(f.env, params, 0)).toBe(true);
    expect(await refreshMonitorSnapshot(f.env, params, 0)).toBe(true);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('caps startup after excluding active monitors and makes progress through a widespread outage', async () => {
    const f = fixture();
    const ids = Array.from({ length: 45 }, (_, index) =>
      seedMonitor(f.sqlite, { id: `incident-${String(index).padStart(2, '0')}`, isPublic: 1 }),
    );
    await startIncidentMonitorRefreshes(f.env, ids);
    expect(f.instances.size).toBe(20);
    await startIncidentMonitorRefreshes(f.env, ids);
    expect(f.instances.size).toBe(40);
    await startIncidentMonitorRefreshes(f.env, ids);
    expect(f.instances.size).toBe(45);
    expect(f.reports.store.size).toBe(0);
    const disabled = seedMonitor(f.sqlite, { enabled: 0, isPublic: 1 });
    await startIncidentMonitorRefreshes(f.env, [disabled]);
    expect(f.instances.size).toBe(45);
  });

  it('builds one canonical initial report for simultaneous slug and id requests', async () => {
    const f = fixture();
    const put = vi.spyOn(f.reports, 'put');
    const responses = await Promise.all([f.get(), f.get(f.monitorId), f.get()]);
    expect(responses.map((response) => response.status)).toEqual([503, 503, 503]);
    expect(put).not.toHaveBeenCalled();
    expect(f.instances.size).toBe(1);
    await refreshMonitorSnapshot(f.env, [...f.instances.values()][0]!, 0);
    const ready = await Promise.all([f.get(), f.get(f.monitorId), f.get()]);
    expect(ready.map((response) => response.status)).toEqual([200, 200, 200]);
    const snapshots = await Promise.all(ready.map((response) => response.json()));
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[1]).toEqual(snapshots[2]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(f.create.mock.calls.every(([options]) => options.id === f.row().token)).toBe(true);
    expect(f.row()).toMatchObject({
      ordinal: 0,
      phase: 'active',
      generated_at: start.toISOString(),
    });
    expect(JSON.parse(f.row().last_build_metrics)).toMatchObject({ committed: true, ordinal: 0 });
  });

  it('serves cached reports during the cycle even when older than the freshness window', async () => {
    const f = fixture();
    const put = vi.spyOn(f.reports, 'put');
    const first = await (await buildInitial(f)).text();
    vi.setSystemTime(new Date(start.getTime() + 121_000));
    expect(await (await f.get()).text()).toBe(first);
    expect(put).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('sleeps then refreshes four times, stops, and allows another demand cycle', async () => {
    const f = fixture();
    const put = vi.spyOn(f.reports, 'put');
    await f.get();
    const params = [...f.instances.values()][0]!;
    const sleeps: string[] = [];
    const step = {
      sleep: async (name: string) => {
        sleeps.push(name);
        vi.setSystemTime(new Date(Date.now() + 60_000));
      },
      do: async (_name: string, _options: unknown, callback: () => Promise<boolean>) => callback(),
    } as unknown as Pick<WorkflowStep, 'do' | 'sleep'>;
    await runMonitorRefreshCycle(f.env, params, step);
    expect(sleeps).toEqual(['wait-1', 'wait-2', 'wait-3', 'wait-4']);
    expect(put).toHaveBeenCalledTimes(5);
    expect(f.row()).toMatchObject({ ordinal: 4, phase: 'idle' });
    expect(f.reports.store.size).toBe(1);
    await f.get();
    expect(put).toHaveBeenCalledTimes(5);
    vi.setSystemTime(new Date(Date.now() + 120_001));
    await f.get();
    expect(put).toHaveBeenCalledTimes(5);
    expect(f.instances.size).toBe(2);
    await refreshMonitorSnapshot(f.env, [...f.instances.values()][1]!, 0);
    expect(put).toHaveBeenCalledTimes(6);
  });

  it('retries cold Workflow creation failure with the same token and no HTTP build', async () => {
    const f = fixture();
    const put = vi.spyOn(f.reports, 'put');
    f.create.mockRejectedValueOnce(new Error('temporary create failure'));
    expect((await f.get()).status).toBe(503);
    expect(f.row().phase).toBe('starting');
    const token = f.row().token;
    expect((await f.get()).status).toBe(503);
    expect(f.row().phase).toBe('active');
    expect(f.row().token).toBe(token);
    expect(put).not.toHaveBeenCalled();
    await refreshMonitorSnapshot(f.env, f.instances.get(token)!, 0);
    expect((await f.get()).status).toBe(200);
    expect(put).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it('protects a claimed cold refresh while Workflow creation is pending', async () => {
    const f = fixture();
    const originalCreate = f.create.getMockImplementation()!;
    let releaseCreate!: () => void;
    let reachedCreate!: () => void;
    const atCreate = new Promise<void>((resolve) => {
      reachedCreate = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    f.create.mockImplementation(async (options) => {
      reachedCreate();
      await createGate;
      return originalCreate(options);
    });
    const background: Promise<unknown>[] = [];
    const request = new Request('https://reporter/reports/public/monitors/example.json');

    const pending = handleMonitorReport(request, f.env, (task) => background.push(task));
    await atCreate;

    expect(f.row()).toMatchObject({ ordinal: -1, phase: 'starting' });
    expect(f.reports.store.size).toBe(0);
    expect(background).toHaveLength(1);
    expect(f.create).toHaveBeenCalledTimes(1);
    releaseCreate();
    await Promise.all(background);
    expect((await pending).status).toBe(503);
    expect(f.row().phase).toBe('active');
  });

  it('rebuilds a stale snapshot after its starting lease expires during a Workflow outage', async () => {
    const f = fixture();
    const put = vi.spyOn(f.reports, 'put');
    const originalCreate = f.create.getMockImplementation()!;
    const first = await (await buildInitial(f)).text();
    vi.setSystemTime(new Date(start.getTime() + 181_000));
    f.create.mockRejectedValue(new Error('Workflow service unavailable'));
    expect(await (await f.get()).text()).toBe(first);
    const token = f.row().token;
    vi.setSystemTime(new Date(start.getTime() + 600_000));
    expect(await (await f.get()).text()).toBe(first);
    expect(f.row().token).not.toBe(token);
    f.create.mockImplementation(originalCreate);
    expect(await (await f.get()).text()).toBe(first);
    expect(f.row().phase).toBe('active');
    await refreshMonitorSnapshot(f.env, f.instances.get(f.row().token)!, 0);
    expect(await (await f.get()).text()).not.toBe(first);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1])(
    'rebuilds a six-hour-old cached snapshot with an expired starting lease at ordinal %i',
    async (ordinal) => {
      const f = fixture();
      const staleAt = new Date(start.getTime() - 6 * 60 * 60 * 1_000);
      vi.setSystemTime(staleAt);
      const stale = await (await buildInitial(f)).text();
      const oldToken = f.row().token;
      vi.setSystemTime(start);
      const put = vi.spyOn(f.reports, 'put');
      f.sqlite
        .prepare(
          `UPDATE monitor_report_refresh
           SET phase = 'starting', ordinal = ?, generated_at = ?, lease_until = ?
           WHERE monitor_id = ?`,
        )
        .run(ordinal, staleAt.toISOString(), start.toISOString(), f.monitorId);
      const background: Promise<unknown>[] = [];
      const request = new Request('https://reporter/reports/public/monitors/example.json');

      const result = await handleMonitorReport(request, f.env, (task) => background.push(task));
      expect(result.status).toBe(200);
      expect(await result.text()).toBe(stale);
      expect(f.row().token).not.toBe(oldToken);
      expect(f.row().ordinal).toBe(-1);
      expect(put).not.toHaveBeenCalled();
      expect(background).toHaveLength(1);
      await Promise.all(background);
      expect(f.row().phase).toBe('active');
      await refreshMonitorSnapshot(f.env, f.instances.get(f.row().token)!, 0);
      expect(await (await f.get()).text()).not.toBe(stale);
      expect(f.row().ordinal).toBe(0);
      expect(f.row().generated_at).toBe(start.toISOString());
      expect(put).toHaveBeenCalledTimes(1);
    },
  );

  it('recovers an uncertain successful Workflow creation without duplicating its initial report', async () => {
    const f = fixture();
    const original = f.create.getMockImplementation()!;
    f.create.mockImplementationOnce(async (options) => {
      await original(options);
      throw new Error('lost response');
    });
    expect((await f.get()).status).toBe(503);
    expect(f.row().phase).toBe('active');
    expect(f.instances.size).toBe(1);
    await refreshMonitorSnapshot(f.env, [...f.instances.values()][0]!, 0);
    expect((await f.get()).status).toBe(200);
  });

  it('recovers expired leases and fences retries from the old cycle and same ordinal', async () => {
    const f = fixture();
    await buildInitial(f);
    const old = [...f.instances.values()][0]!;
    vi.setSystemTime(new Date(start.getTime() + 181_000));
    await buildInitial(f);
    const current = [...f.instances.values()][1]!;
    const put = vi.spyOn(f.reports, 'put');
    expect(await refreshMonitorSnapshot(f.env, old, 1)).toBe(false);
    vi.setSystemTime(new Date(Date.now() + 60_000));
    expect(await refreshMonitorSnapshot(f.env, current, 1)).toBe(true);
    const committedKey = f.row().object_key;
    expect(await refreshMonitorSnapshot(f.env, current, 1)).toBe(true);
    expect(f.row().object_key).toBe(committedKey);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('a late concurrent attempt cannot overwrite the winning snapshot or its diagnostics', async () => {
    const f = fixture();
    await buildInitial(f);
    const params = [...f.instances.values()][0]!;
    vi.setSystemTime(new Date(start.getTime() + 60_000));
    let resume!: () => void;
    let reachedPut!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const atPut = new Promise<void>((resolve) => {
      reachedPut = resolve;
    });
    const nativePut = f.reports.put.bind(f.reports);
    vi.spyOn(f.reports, 'put').mockImplementationOnce(async (...args) => {
      reachedPut();
      await paused;
      return nativePut(...args);
    });
    const oldAttempt = refreshMonitorSnapshot(f.env, params, 1);
    await atPut;
    vi.setSystemTime(new Date(start.getTime() + 61_000));
    expect(await refreshMonitorSnapshot(f.env, params, 1)).toBe(true);
    const winner = f.row();
    resume();
    expect(await oldAttempt).toBe(false);
    expect(f.row().object_key).toBe(winner.object_key);
    expect(f.row().generated_at).toBe(winner.generated_at);
    expect(f.row().last_build_metrics).toBe(winner.last_build_metrics);
    expect(f.reports.store.size).toBe(1);
  });

  it('Workflow refresh retries a failed put without repeating a committed ordinal', async () => {
    const f = fixture();
    await buildInitial(f);
    const params = [...f.instances.values()][0]!;
    vi.setSystemTime(new Date(start.getTime() + 60_000));
    const put = vi.spyOn(f.reports, 'put').mockRejectedValueOnce(new Error('temporary R2 error'));
    await expect(refreshMonitorSnapshot(f.env, params, 1)).rejects.toThrow('temporary R2 error');
    expect(f.row().ordinal).toBe(0);
    expect(await refreshMonitorSnapshot(f.env, params, 1)).toBe(true);
    expect(await refreshMonitorSnapshot(f.env, params, 1)).toBe(true);
    expect(f.row().ordinal).toBe(1);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('fails closed after visibility removal, including a removal during the R2 write', async () => {
    const f = fixture();
    const nativePut = f.reports.put.bind(f.reports);
    vi.spyOn(f.reports, 'put').mockImplementation(async (...args) => {
      const result = await nativePut(...args);
      f.sqlite.prepare('UPDATE monitors SET is_public = 0 WHERE id = ?').run(f.monitorId);
      return result;
    });
    expect((await f.get()).status).toBe(503);
    expect(await refreshMonitorSnapshot(f.env, [...f.instances.values()][0]!, 0)).toBe(false);
    expect(f.row().ordinal).toBe(-1);
    expect(f.reports.store.size).toBe(0);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect((await f.get()).status).toBe(404);
  });

  it('HEAD is read-only and visibility is rechecked on cached requests', async () => {
    const f = fixture();
    expect((await f.get('example', 'HEAD')).status).toBe(503);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.row()).toBeUndefined();
    await buildInitial(f);
    const before = f.row();
    vi.setSystemTime(new Date(start.getTime() + 181_000));
    const background: Promise<unknown>[] = [];
    const head = await handleMonitorReport(
      new Request('https://reporter/reports/public/monitors/example.json', { method: 'HEAD' }),
      f.env,
      (task) => background.push(task),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(f.row()).toEqual(before);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(background).toHaveLength(0);
    f.sqlite.prepare('UPDATE monitors SET is_public = 0 WHERE id = ?').run(f.monitorId);
    expect((await f.get()).status).toBe(404);
    expect((await f.get('example', 'HEAD')).status).toBe(404);
  });

  it('leaves a failed durable initial build for Workflow retry and cold GET polling', async () => {
    const f = fixture();
    vi.spyOn(f.reports, 'put').mockRejectedValueOnce(new Error('R2 unavailable'));
    expect((await f.get()).status).toBe(503);
    const params = [...f.instances.values()][0]!;
    await expect(refreshMonitorSnapshot(f.env, params, 0)).rejects.toThrow('R2 unavailable');
    expect(f.row()).toMatchObject({ phase: 'active', ordinal: -1 });
    expect((await f.get()).status).toBe(503);
    expect(await refreshMonitorSnapshot(f.env, params, 0)).toBe(true);
    expect((await f.get()).status).toBe(200);
    expect(f.instances.size).toBe(1);
  });
});
