import { parseEnv, schedulerEnvSchema } from '@uptime/config';
import { createDatabase } from '@uptime/database';

import { Scheduler } from './scheduler.js';

const env = parseEnv(schedulerEnvSchema, process.env);
const database = createDatabase(env.DATABASE_URL);
const scheduler = new Scheduler(env, {
  db: database.db,
  fetch,
  now: () => new Date(),
  log: console,
});

let stopping = false;
let maintenanceAt = 0;
let pollTimer: NodeJS.Timeout | undefined;
let activeRun: Promise<void> | undefined;
let shutdownPromise: Promise<void> | undefined;

async function run(): Promise<void> {
  try {
    await scheduler.tick();
    if (Date.now() >= maintenanceAt) {
      await scheduler.maintenance();
      maintenanceAt = Date.now() + 60 * 60 * 1_000;
    }
  } catch (error) {
    console.error({ event: 'scheduler_tick_failed', ...safeSchedulerError(error) });
  }
}

function startRun(): void {
  if (stopping || activeRun) return;

  activeRun = run().finally(() => {
    activeRun = undefined;
    if (stopping) return;

    pollTimer = setTimeout(startRun, env.SCHEDULER_POLL_INTERVAL_MS);
    pollTimer.unref();
  });
}

function safeSchedulerError(error: unknown): Record<string, string> {
  const rootCause =
    error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
  const databaseCode =
    rootCause && 'code' in rootCause && typeof rootCause.code === 'string'
      ? rootCause.code
      : undefined;

  if (rootCause && databaseCode) {
    return {
      errorType: rootCause.name,
      databaseCode,
      databaseMessage: rootCause.message,
    };
  }

  return {
    errorType: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : 'Unknown scheduler error',
  };
}

function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  stopping = true;
  if (pollTimer) clearTimeout(pollTimer);
  console.info({ event: 'scheduler_shutdown', signal });
  shutdownPromise = (async () => {
    await activeRun;
    await database.close();
  })();
  return shutdownPromise;
}

function handleSignal(signal: NodeJS.Signals): void {
  void shutdown(signal).catch((error: unknown) => {
    console.error({ event: 'scheduler_shutdown_failed', signal, ...safeSchedulerError(error) });
    process.exitCode = 1;
  });
}

process.once('SIGINT', () => handleSignal('SIGINT'));
process.once('SIGTERM', () => handleSignal('SIGTERM'));
console.info({ event: 'scheduler_started', instanceId: env.SCHEDULER_INSTANCE_ID });
startRun();
