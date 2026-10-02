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
  const env: MonitorReportEnv = { DB: db, REPORTS: reports, MONITOR_REFRESH: workflow };
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
    await f.get();
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
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const snapshots = await Promise.all(responses.map((response) => response.json()));
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[1]).toEqual(snapshots[2]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1);
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
    const first = await (await f.get()).text();
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
    expect(put).toHaveBeenCalledTimes(6);
    expect(f.instances.size).toBe(2);
  });

  it('recovers Workflow creation failure using the saved initial report', async () => {
    const f = fixture();
    const put = vi.spyOn(f.reports, 'put');
    f.create.mockRejectedValueOnce(new Error('temporary create failure'));
    expect((await f.get()).status).toBe(200);
    expect(f.row().phase).toBe('starting');
    expect((await f.get()).status).toBe(200);
    expect(f.row().phase).toBe('active');
    expect(put).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it('returns the initial report while Workflow creation continues in the background', async () => {
    const f = fixture();
    const originalCreate = f.create.getMockImplementation()!;
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    f.create.mockImplementation(async (options) => {
      await createGate;
      return originalCreate(options);
    });
    const background: Promise<unknown>[] = [];
    const request = new Request('https://reporter/reports/public/monitors/example.json');

    const response = await handleMonitorReport(request, f.env, (task) => background.push(task));

    expect(response.status).toBe(200);
    expect(f.row()).toMatchObject({ ordinal: 0, phase: 'starting' });
    expect(background).toHaveLength(1);
    expect(f.create).toHaveBeenCalledTimes(1);
    releaseCreate();
    await Promise.all(background);
    expect(f.row().phase).toBe('active');
  });

  it('keeps the initial snapshot through a prolonged Workflow service outage', async () => {
    const f = fixture();
    const put = vi.spyOn(f.reports, 'put');
    const originalCreate = f.create.getMockImplementation()!;
    f.create.mockRejectedValue(new Error('Workflow service unavailable'));
    const first = await (await f.get()).text();
    const token = f.row().token;
    vi.setSystemTime(new Date(start.getTime() + 600_000));
    expect(await (await f.get()).text()).toBe(first);
    expect(f.row().token).toBe(token);
    f.create.mockImplementation(originalCreate);
    expect(await (await f.get()).text()).toBe(first);
    expect(f.row().phase).toBe('active');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('recovers an uncertain successful Workflow creation without duplicating its initial report', async () => {
    const f = fixture();
    const original = f.create.getMockImplementation()!;
    f.create.mockImplementationOnce(async (options) => {
      await original(options);
      throw new Error('lost response');
    });
    expect((await f.get()).status).toBe(200);
    expect(f.row().phase).toBe('active');
    expect(f.instances.size).toBe(1);
  });

  it('recovers expired leases and fences retries from the old cycle and same ordinal', async () => {
    const f = fixture();
    await f.get();
    const old = [...f.instances.values()][0]!;
    vi.setSystemTime(new Date(start.getTime() + 181_000));
    await f.get();
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
    await f.get();
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
    await f.get();
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
    expect((await f.get()).status).toBe(404);
    expect(f.row().ordinal).toBe(-1);
    expect(f.reports.store.size).toBe(0);
    expect(f.create).not.toHaveBeenCalled();
    expect((await f.get()).status).toBe(404);
  });

  it('HEAD is read-only and visibility is rechecked on cached requests', async () => {
    const f = fixture();
    expect((await f.get('example', 'HEAD')).status).toBe(503);
    expect(f.create).not.toHaveBeenCalled();
    await f.get();
    const head = await f.get('example', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    f.sqlite.prepare('UPDATE monitors SET is_public = 0 WHERE id = ?').run(f.monitorId);
    expect((await f.get()).status).toBe(404);
    expect((await f.get('example', 'HEAD')).status).toBe(404);
  });

  it('releases a failed initial build for the next request to retry', async () => {
    const f = fixture();
    vi.spyOn(f.reports, 'put').mockRejectedValueOnce(new Error('R2 unavailable'));
    expect((await f.get()).status).toBe(503);
    expect(f.row().phase).toBe('idle');
    expect((await f.get()).status).toBe(200);
    expect(f.instances.size).toBe(1);
  });
});
