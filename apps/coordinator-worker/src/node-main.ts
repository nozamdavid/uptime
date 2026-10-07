import { createPublicOnlyFetch } from '@uptime/api-worker/node-bindings';

import {
  loadSchedulerRuntime,
  safeConfigMessage,
  type SchedulerRuntime,
} from './node-scheduler-env.js';
import { createMinuteScheduler, createSchedulerTick } from './node-scheduler.js';

/** Single-line JSON events. Fields must never carry secrets or request data. */
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

let runtime: SchedulerRuntime;
try {
  runtime = loadSchedulerRuntime(process.env);
} catch (error) {
  // Only messages that name a variable are logged; they never include its value.
  log('invalid_configuration', { message: safeConfigMessage(error) });
  process.exit(1);
}

// Replaces the Workers `global_fetch_strictly_public` guarantee for probe and notification requests.
globalThis.fetch = createPublicOnlyFetch();

const { config, env } = runtime;
const scheduler = createMinuteScheduler({
  enabled: config.enabled,
  tick: createSchedulerTick(env, log),
  log,
});

// A disabled scheduler has no timers, and this keeps the process (and its container) alive.
const keepAlive = setInterval(() => undefined, 60_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log('shutdown_started', { signal });
  clearInterval(keepAlive);
  const drained = await scheduler.stop(config.shutdownGraceMs);
  log('shutdown_complete', { drained });
  process.exit(drained ? 0 : 1);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) =>
  log('unhandled_rejection', { name: reason instanceof Error ? reason.name : 'unknown' }),
);

log('scheduler_configured', { enabled: config.enabled, environment: env.ENVIRONMENT ?? null });
scheduler.start();
