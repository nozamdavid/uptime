import { writeFile } from 'node:fs/promises';

import { withPostgresRuntime } from '@uptime/cloudflare/postgres';

import type { CoordinatorEnv } from './env.js';
import {
  dispatchDueTenants,
  isTenantJob,
  runTenantJob,
  type TenantJob,
} from './tenant-dispatch.js';

export type SchedulerLog = (event: string, fields?: Record<string, unknown>) => void;

const minuteMs = 60_000;
export const tenantJobTimeoutMs = 5 * 60_000;

/** Messages thrown by this scheduler and `runTenantJob`; they carry no data. */
const knownFailureReasons: ReadonlySet<string> = new Set([
  'Tenant workspace lease is busy',
  'Tenant job has no matching dispatch',
  'Tenant execution lease was replaced',
  'Scheduler is stopping',
  'Invalid tenant job',
  'Tenant job timed out',
]);

/**
 * Failure details for logs. Library messages can embed connection or request
 * data, so only the error name, a short driver code, and known reasons are kept.
 */
export function describeError(error: unknown): { name: string; code?: string; reason?: string } {
  if (!(error instanceof Error)) return { name: 'unknown' };
  const code = (error as { code?: unknown }).code;
  return {
    name: /^\w{1,64}$/.test(error.name) ? error.name : 'Error',
    ...(typeof code === 'string' && /^[\w-]{1,32}$/.test(code) ? { code } : {}),
    ...(knownFailureReasons.has(error.message) ? { reason: error.message } : {}),
  };
}

export interface TenantJobQueue {
  send(job: TenantJob): Promise<void>;
}

/**
 * In-process stand-in for the Cloudflare queue binding used by `dispatchDueTenants`.
 *
 * `send` resolves only after the job has finished, so the durable outbox row is
 * marked sent only for work that completed. A rejection (busy workspace lease,
 * failed job, shutdown) reaches `dispatchDueTenants`, which keeps the row
 * pending for its normal 60 second retry.
 */
export function createTenantJobQueue(options: {
  run: (job: TenantJob) => Promise<void>;
  /** Returns false once shutdown has begun, so unstarted jobs stay pending. */
  accepting?: () => boolean;
  timeoutMs?: number;
  log: SchedulerLog;
}): TenantJobQueue {
  return {
    async send(job) {
      if (!isTenantJob(job)) throw new Error('Invalid tenant job');
      if (options.accepting && !options.accepting()) throw new Error('Scheduler is stopping');
      const fields = { workspaceId: job.workspaceId, scheduledAt: job.scheduledAt };
      const startedAt = Date.now();
      options.log('tenant_job_started', {
        ...fields,
        maintenanceOnly: job.maintenanceOnly === true,
      });
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Tenant job timed out')),
              options.timeoutMs ?? tenantJobTimeoutMs,
            );
          }),
          options.run(job),
        ]);
      } catch (error) {
        options.log('tenant_job_failed', {
          ...fields,
          durationMs: Date.now() - startedAt,
          ...describeError(error),
        });
        throw error;
      } finally {
        clearTimeout(timer);
      }
      options.log('tenant_job_completed', { ...fields, durationMs: Date.now() - startedAt });
    },
  };
}

export async function sendHeartbeat(
  heartbeat: { url?: string | undefined; file?: string | undefined } | undefined,
  ok: boolean,
  log: SchedulerLog,
): Promise<void> {
  if (heartbeat?.file) {
    try {
      await writeFile(heartbeat.file, new Date().toISOString());
    } catch (error) {
      log('heartbeat_file_failed', describeError(error));
    }
  }
  if (heartbeat?.url) {
    try {
      await fetch(ok ? heartbeat.url : heartbeat.url + '/fail', {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      log('heartbeat_ping_failed', describeError(error));
    }
  }
}

/**
 * One dispatch pass: claims due workspaces from the PostgreSQL outbox and runs
 * each through `runTenantJob`, one at a time like the Cloudflare consumer's
 * `max_concurrency = 1`. Each job opens its own session, closed on completion.
 */
export function createSchedulerTick(
  env: CoordinatorEnv,
  log: SchedulerLog,
  heartbeat?: { url?: string | undefined; file?: string | undefined },
): (minute: Date, signal: AbortSignal) => Promise<void> {
  return async (minute, signal) => {
    const queue = createTenantJobQueue({
      log,
      accepting: () => !signal.aborted,
      run: (job) =>
        withPostgresRuntime(env, (control, catalog) =>
          runTenantJob({ ...env, controlDb: control, catalog }, job),
        ),
    });
    let result;
    try {
      result = await withPostgresRuntime(env, (control, catalog) =>
        dispatchDueTenants(
          { ...env, controlDb: control, catalog, TENANT_JOBS: queue },
          // The minute stamp keeps each workspace's next_dispatch_at on the boundary despite timer jitter.
          minute,
        ),
      );
    } catch (error) {
      await sendHeartbeat({ url: heartbeat?.url }, false, log);
      throw error;
    }
    log('scheduler_dispatch', result);
    await sendHeartbeat(heartbeat, result.failed === 0, log);
  };
}

export interface MinuteScheduler {
  start(): void;
  /** Stops future ticks and waits up to `graceMs` for the active one. True when nothing is left running. */
  stop(graceMs: number): Promise<boolean>;
}

/**
 * Runs `tick` at each minute boundary. A tick is never started while the previous
 * one runs; boundaries missed during a slow tick are skipped, not queued.
 */
export function createMinuteScheduler(options: {
  enabled: boolean;
  tick: (minute: Date, signal: AbortSignal) => Promise<void>;
  log: SchedulerLog;
}): MinuteScheduler {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | null = null;

  function arm() {
    if (abort.signal.aborted) return;
    const now = Date.now();
    const target = (Math.floor(now / minuteMs) + 1) * minuteMs;
    timer = setTimeout(() => fire(target), target - now);
  }

  function fire(target: number) {
    const now = Date.now();
    if (now < target) {
      // Timers can fire a few milliseconds early; the minute stamp must not be in the future.
      timer = setTimeout(() => fire(target), target - now);
      return;
    }
    active = run(new Date(Math.floor(now / minuteMs) * minuteMs));
  }

  async function run(minute: Date) {
    const startedAt = Date.now();
    options.log('scheduler_tick_started', { minute: minute.toISOString() });
    try {
      await options.tick(minute, abort.signal);
      options.log('scheduler_tick_completed', { durationMs: Date.now() - startedAt });
    } catch (error) {
      options.log('scheduler_tick_failed', {
        durationMs: Date.now() - startedAt,
        ...describeError(error),
      });
    } finally {
      active = null;
      const skipped = Math.floor(Date.now() / minuteMs) - Math.floor(minute.getTime() / minuteMs);
      if (skipped > 0) options.log('scheduler_ticks_skipped', { count: skipped });
      arm();
    }
  }

  return {
    start() {
      if (!options.enabled) {
        options.log('scheduler_disabled');
        return;
      }
      options.log('scheduler_started');
      arm();
    },

    async stop(graceMs) {
      abort.abort();
      clearTimeout(timer);
      const current = active;
      if (!current) return true;
      let grace: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        current.then(() => true),
        new Promise<boolean>((resolve) => {
          grace = setTimeout(() => resolve(false), graceMs);
        }),
      ]);
      clearTimeout(grace);
      return drained;
    },
  };
}
