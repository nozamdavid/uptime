import { parseRegionsList, type CloudflareEnv } from '@uptime/cloudflare';
import { withPostgresRuntime } from '@uptime/cloudflare/postgres';

import type { LogSink } from './app.js';
import { reconcileCustomStatusDomains } from './custom-domain-http.js';
import { reconcileDueBilling } from './workspace-billing.js';

const log: LogSink = {
  warn: (bindings, message) => console.warn(message, bindings),
  error: (bindings, message) => console.error(message, bindings),
};

/** Keep host fetch receiver-neutral before passing it through app dependencies. */
export const workerFetch: typeof fetch = (input, init) => fetch(input, init);

/**
 * One scheduled reconciliation pass, run by the Node runtime's interval timer.
 * It never rejects.
 */
export async function reconcileScheduled(env: CloudflareEnv): Promise<void> {
  if (env.POSTGRES_SOURCE_DATABASE_ID !== undefined) return;
  return withPostgresRuntime(env, async (controlDb, catalog) => {
    const regions = parseRegionsList(env.REGIONS_LIST);
    // Each reconciler finishes all database work before the client closes.
    const results = [];
    for (const reconcile of [
      () => reconcileDueBilling({ control: controlDb, env, regions }, 10),
      () => reconcileCustomStatusDomains({ ...env, controlDb, catalog }, { limit: 10 }),
    ]) {
      try {
        await reconcile();
        results.push({ status: 'fulfilled' as const });
      } catch {
        results.push({ status: 'rejected' as const });
      }
    }
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected')
        log.error?.(
          {
            event: index === 0 ? 'billing_reconciliation_failed' : 'domain_reconciliation_failed',
          },
          'Scheduled reconciliation failed',
        );
    }
  }).catch(() =>
    log.error?.(
      { event: 'scheduled_configuration_failed' },
      'Scheduled runtime configuration is invalid',
    ),
  );
}
