import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMinuteScheduler,
  createTenantJobQueue,
  describeError,
  sendHeartbeat,
} from './node-scheduler.js';
import type { TenantJob } from './tenant-dispatch.js';

const job: TenantJob = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  scheduledAt: '2026-10-05T12:00:00.000Z',
  routingGeneration: 1,
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('tenant job queue', () => {
  it('rejects when a tenant job times out', async () => {
    const queue = createTenantJobQueue({
      run: () => new Promise<void>(() => undefined),
      timeoutMs: 20,
      log: vi.fn(),
    });
    await expect(queue.send(job)).rejects.toThrow('Tenant job timed out');
  });

  it('resolves only after the job has finished', async () => {
    const work = deferred();
    const run = vi.fn(() => work.promise);
    const queue = createTenantJobQueue({ run, log: vi.fn() });
    let sent = false;
    const sending = queue.send(job).then(() => {
      sent = true;
    });
    await Promise.resolve();
    expect(run).toHaveBeenCalledWith(job);
    expect(sent).toBe(false);
    work.resolve();
    await sending;
    expect(sent).toBe(true);
  });

  it('rejects when the job fails so the outbox retry stays active', async () => {
    const log = vi.fn();
    const queue = createTenantJobQueue({
      run: () => Promise.reject(new Error('Tenant workspace lease is busy')),
      log,
    });
    await expect(queue.send(job)).rejects.toThrow('Tenant workspace lease is busy');
    expect(log).toHaveBeenCalledWith(
      'tenant_job_failed',
      expect.objectContaining({ workspaceId: job.workspaceId }),
    );
  });

  it('rejects invalid jobs and jobs offered during shutdown without running them', async () => {
    const run = vi.fn();
    let accepting = true;
    const queue = createTenantJobQueue({ run, accepting: () => accepting, log: vi.fn() });
    await expect(queue.send({ ...job, workspaceId: 'nope' })).rejects.toThrow('Invalid tenant job');
    accepting = false;
    await expect(queue.send(job)).rejects.toThrow('Scheduler is stopping');
    expect(run).not.toHaveBeenCalled();
  });

  it('logs only the error name, a short code, and known reasons', async () => {
    const log = vi.fn();
    const leaky = Object.assign(new Error('password authentication failed, token=hunter2'), {
      code: '28P01',
    });
    const queue = createTenantJobQueue({ run: () => Promise.reject(leaky), log });
    await expect(queue.send(job)).rejects.toThrow();
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
    expect(log).toHaveBeenCalledWith(
      'tenant_job_failed',
      expect.objectContaining({ name: 'Error', code: '28P01' }),
    );
    expect(describeError(new Error('Tenant workspace lease is busy'))).toEqual({
      name: 'Error',
      reason: 'Tenant workspace lease is busy',
    });
    expect(describeError(Object.assign(new Error('x'), { code: 'bad code with spaces' }))).toEqual({
      name: 'Error',
    });
  });
});

describe('scheduler heartbeat', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pings the success and failure URLs', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', fetch);
    const heartbeat = { url: 'https://heartbeat.example/check' };
    await sendHeartbeat(heartbeat, true, vi.fn());
    await sendHeartbeat(heartbeat, false, vi.fn());
    expect(fetch).toHaveBeenNthCalledWith(1, heartbeat.url, {
      method: 'GET',
      signal: expect.any(AbortSignal),
    });
    expect(fetch).toHaveBeenNthCalledWith(2, heartbeat.url + '/fail', {
      method: 'GET',
      signal: expect.any(AbortSignal),
    });
  });

  it('logs a rejected ping without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unreachable')));
    const log = vi.fn();
    await expect(
      sendHeartbeat({ url: 'https://heartbeat.example/check' }, true, log),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('heartbeat_ping_failed', { name: 'Error' });
  });
});

describe('minute scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T12:00:30.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays idle when disabled', async () => {
    const tick = vi.fn(async () => undefined);
    const log = vi.fn();
    createMinuteScheduler({ enabled: false, tick, log }).start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tick).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('scheduler_disabled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ticks on minute boundaries and never overlaps a slow tick', async () => {
    const running = deferred();
    const tick = vi
      .fn<(minute: Date) => Promise<void>>()
      .mockImplementationOnce(() => running.promise)
      .mockResolvedValue(undefined);
    const log = vi.fn();
    createMinuteScheduler({ enabled: true, tick, log }).start();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick.mock.calls[0]![0].toISOString()).toBe('2026-10-05T12:01:00.000Z');

    // Two boundaries pass while the first tick is still running.
    await vi.advanceTimersByTimeAsync(150_000);
    expect(tick).toHaveBeenCalledTimes(1);

    running.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith('scheduler_ticks_skipped', { count: 2 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(tick.mock.calls[1]![0].toISOString()).toBe('2026-10-05T12:04:00.000Z');
  });

  it('keeps running after a failed tick', async () => {
    const tick = vi
      .fn<(minute: Date) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const log = vi.fn();
    createMinuteScheduler({ enabled: true, tick, log }).start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      'scheduler_tick_failed',
      expect.objectContaining({ name: 'Error' }),
    );
  });

  it('stops future ticks and waits for the active tick within the grace period', async () => {
    const running = deferred();
    let signal!: AbortSignal;
    const tick = vi.fn((_minute: Date, abort: AbortSignal) => {
      signal = abort;
      return running.promise;
    });
    const scheduler = createMinuteScheduler({ enabled: true, tick, log: vi.fn() });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);

    const stopping = scheduler.stop(10_000);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    running.resolve();
    await expect(stopping).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an undrained tick when the grace period ends first', async () => {
    const tick = vi.fn(() => new Promise<void>(() => undefined));
    const scheduler = createMinuteScheduler({ enabled: true, tick, log: vi.fn() });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const stopping = scheduler.stop(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stopping).resolves.toBe(false);
  });

  it('stops immediately when idle', async () => {
    const tick = vi.fn(async () => undefined);
    const scheduler = createMinuteScheduler({ enabled: true, tick, log: vi.fn() });
    scheduler.start();
    await expect(scheduler.stop(1_000)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(tick).not.toHaveBeenCalled();
  });
});
