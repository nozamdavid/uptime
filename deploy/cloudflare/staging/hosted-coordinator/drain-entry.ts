import coordinator from '../../../../apps/coordinator-worker/src/index.js';
import type { CoordinatorEnv } from '../../../../apps/coordinator-worker/src/env.js';

/**
 * Staging drain entry. The VPS scheduler owns minute dispatch, so a stale cron
 * trigger must do nothing. Queue and fetch handlers stay in place so messages
 * already queued by the old cron finish and then the consumer can be removed.
 */
export default {
  fetch: coordinator.fetch,
  queue: coordinator.queue,
  async scheduled(): Promise<void> {
    console.warn({ event: 'scheduled_fenced', owner: 'vps-scheduler' });
  },
} satisfies ExportedHandler<CoordinatorEnv>;
