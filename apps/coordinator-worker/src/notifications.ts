import {
  batch,
  first,
  all,
  nowIso,
  notificationMessageText,
  notificationPreview,
  randomId,
  recordNotificationHistory,
  run,
  sha256Hex,
  type D1Database,
  type NotificationMessage,
  type NotificationProviderKind,
} from '@uptime/cloudflare';
import { openProviderConfig } from '@uptime/api-worker/credentials';
import type { RegionId } from '@uptime/regions';

import {
  advanceOutage,
  initialOutageState,
  reminderDue,
  type OutageEvent,
  type OutageState,
} from './notification-state.js';
import { dispatchNotification, NotificationDeliveryError } from './providers.js';
import { isQueryBudgetExceeded } from './query-metrics.js';
import { drainAll } from './concurrency.js';

interface MonitorRow {
  id: string;
  name: string | null;
  url: string;
  enabled: number;
  outage_threshold: number;
  recovery_threshold: number;
  repeat_notification_minutes: number | null;
  updated_at: string;
}

interface ServiceRow {
  id: string;
  provider: NotificationProviderKind;
  config: string;
  updated_at: string;
}

interface StateRow {
  config_fingerprint: string;
  last_window_started_at: string;
  status: 'healthy' | 'down';
  failure_streak: number;
  success_streak: number;
  outage_started_at: string | null;
  last_reminder_at: string | null;
}

interface RunRow {
  id: string;
  window_started_at: string;
  status: 'pending' | 'complete' | 'partial';
  expected: number;
  received: number;
  failures: number;
}

interface DeliveryRow {
  id: string;
  monitor_id: string;
  notification_service_id: string;
  message: string;
  attempts: number;
  provider: NotificationProviderKind;
  config: string;
}

const runHistoryLimit = 200;

export interface NotificationDependencies {
  readonly db: D1Database;
  readonly fetch: typeof fetch;
  readonly now: Date;
  /** Delivery timing is separate from the logical incident evaluation timestamp. */
  readonly liveNow?: () => Date;
  readonly enabledRegionIds: readonly RegionId[];
  readonly credentialEncryptionSecret: string;
  readonly maxAttempts: number;
  readonly leaseToken: string;
  readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
  readonly shouldContinueEvaluation?: () => boolean;
  readonly beforeDelivery?: () => void;
}

/**
 * Evaluate incident state for every monitor with notification destinations or
 * persisted state, then attempt pending deliveries.
 *
 * Every decision is derived from finalized rounds only (a pending round blocks
 * progress past it). Missing regional results yield `unknown`, never healthy.
 * The state upsert and its new delivery rows commit in one D1 batch, and the
 * unique `(event_key, notification_service_id)` makes replayed evaluations
 * idempotent.
 */
export async function processNotifications(dependencies: NotificationDependencies): Promise<void> {
  const { db } = dependencies;
  const monitors = await all<{ id: string }>(
    db,
    `SELECT id FROM monitors WHERE EXISTS (
       SELECT 1 FROM monitor_notification_services mns WHERE mns.monitor_id = monitors.id
     ) OR EXISTS (
       SELECT 1 FROM monitor_notification_state s WHERE s.monitor_id = monitors.id
     ) ORDER BY id`,
  );
  // Rotate the starting monitor each minute so a budget-limited tick cannot
  // starve IDs that sort later forever.
  const offset =
    monitors.length === 0 ? 0 : Math.floor(dependencies.now.getTime() / 60_000) % monitors.length;
  const fairOrder = [...monitors.slice(offset), ...monitors.slice(0, offset)];
  for (const monitor of fairOrder) {
    if (dependencies.shouldContinueEvaluation && !dependencies.shouldContinueEvaluation()) break;
    try {
      await evaluateMonitor(dependencies, monitor.id);
    } catch (error) {
      if (isQueryBudgetExceeded(error)) {
        break;
      }
      dependencies.log.error({
        event: 'notification_evaluation_failed',
        monitorId: monitor.id,
        error: String(error),
      });
    }
  }
  // Delivery gets its own reserved slice of the tick. Even when evaluation
  // fills its allowance, previously queued notifications must keep moving.
  dependencies.beforeDelivery?.();
  await deliverPending(dependencies);
}

async function evaluateMonitor(
  dependencies: NotificationDependencies,
  monitorId: string,
): Promise<void> {
  const { db, now } = dependencies;
  const monitor = await first<MonitorRow>(
    db,
    `SELECT id, name, url, enabled, outage_threshold, recovery_threshold,
       repeat_notification_minutes, updated_at
     FROM monitors WHERE id = ? LIMIT 1`,
    [monitorId],
  );
  if (!monitor) return;
  const services = await all<ServiceRow>(
    db,
    `SELECT ns.id, ns.provider, ns.config, ns.updated_at
     FROM notification_services ns
     JOIN monitor_notification_services mns ON mns.notification_service_id = ns.id
     WHERE mns.monitor_id = ? AND ns.enabled = 1
     ORDER BY ns.id`,
    [monitorId],
  );
  const regionRows = await all<{ region_id: RegionId }>(
    db,
    'SELECT region_id FROM monitor_regions WHERE monitor_id = ? ORDER BY region_id',
    [monitorId],
  );
  const regions = regionRows
    .map((row) => row.region_id)
    .filter((region) => dependencies.enabledRegionIds.includes(region));

  if (monitor.enabled !== 1 || services.length === 0 || regions.length === 0) {
    await batch(db, [
      {
        sql: `INSERT INTO monitor_notification_state (
                monitor_id, config_fingerprint, last_window_started_at, status,
                failure_streak, success_streak, outage_started_at, last_reminder_at, updated_at
              ) VALUES (?, 'inactive', ?, 'healthy', 0, 0, NULL, NULL, ?)
              ON CONFLICT (monitor_id) DO UPDATE SET
                config_fingerprint = 'inactive',
                last_window_started_at = excluded.last_window_started_at,
                status = 'healthy', failure_streak = 0, success_streak = 0,
                outage_started_at = NULL, last_reminder_at = NULL, updated_at = excluded.updated_at
              WHERE excluded.last_window_started_at >= monitor_notification_state.last_window_started_at`,
        values: [monitorId, nowIso(now), nowIso(now)],
      },
      {
        sql: `UPDATE notification_deliveries SET status = 'cancelled', lease_until = NULL, lease_token = NULL
              WHERE monitor_id = ? AND status IN ('pending', 'sending')`,
        values: [monitorId],
      },
    ]);
    return;
  }

  const fingerprint = await sha256Hex(
    JSON.stringify({
      url: monitor.url,
      regions,
      outage: monitor.outage_threshold,
      recovery: monitor.recovery_threshold,
      repeat: monitor.repeat_notification_minutes,
      services: services.map((service) => [service.id, service.provider, service.config]),
    }),
  );
  const stored = await first<StateRow>(
    db,
    `SELECT config_fingerprint, last_window_started_at, status, failure_streak,
       success_streak, outage_started_at, last_reminder_at
     FROM monitor_notification_state WHERE monitor_id = ? LIMIT 1`,
    [monitorId],
  );
  // Optimistic-concurrency token: the watermark observed before this
  // evaluation. The destructive cancellation below only applies while the
  // stored watermark is unchanged, so an overlapping invocation cannot cancel a
  // delivery a newer invocation just enqueued (which ON CONFLICT DO NOTHING
  // could not revive).
  const storedWatermark = stored?.last_window_started_at ?? null;
  const storedReminder = stored?.last_reminder_at ?? null;
  const storedFingerprint = stored?.config_fingerprint ?? null;
  const configuredAt = Math.max(
    Date.parse(monitor.updated_at),
    ...services.map((service) => Date.parse(service.updated_at)),
  );
  let watermark = stored ? stored.last_window_started_at : new Date(configuredAt).toISOString();
  let state: OutageState = stored
    ? {
        status: stored.status,
        failureStreak: stored.failure_streak,
        successStreak: stored.success_streak,
        outageStartedAt: stored.outage_started_at,
        lastReminderAt: stored.last_reminder_at,
      }
    : initialOutageState();
  let reset = false;
  if (stored && stored.config_fingerprint !== fingerprint) {
    state = initialOutageState();
    watermark = new Date(Math.max(Date.parse(watermark), configuredAt)).toISOString();
    reset = true;
  }

  const runs = await all<RunRow>(
    db,
    `SELECT cr.id, cr.window_started_at, cr.status, cr.expected_region_count AS expected,
       (SELECT count(*) FROM observations o WHERE o.check_run_id = cr.id) AS received,
       (SELECT count(*) FROM observations o WHERE o.check_run_id = cr.id AND o.success = 0) AS failures
     FROM check_runs cr
     WHERE cr.monitor_id = ? AND cr.window_started_at > ?
     ORDER BY cr.window_started_at ASC
     LIMIT ?`,
    [monitorId, watermark, runHistoryLimit],
  );

  const rules = {
    outageThreshold: monitor.outage_threshold,
    recoveryThreshold: monitor.recovery_threshold,
    repeatNotificationMinutes: monitor.repeat_notification_minutes,
  };
  const statements: { sql: string; values: unknown[] }[] = [];
  if (reset) {
    statements.push(
      ...cancelPending(monitorId, storedWatermark, storedReminder, storedFingerprint),
    );
  }
  let blocked = false;
  for (const round of runs) {
    if (round.status === 'pending') {
      blocked = true;
      break;
    }
    const at = round.window_started_at;
    const priorOutage = state.outageStartedAt;
    const advanced = advanceOutage(
      state,
      failuresOutcome(round.expected, round.received, round.failures),
      rules,
      at,
    );
    state = advanced.state;
    watermark = at;
    if (advanced.event) {
      statements.push(
        ...cancelPending(monitorId, storedWatermark, storedReminder, storedFingerprint),
      );
      statements.push(
        ...enqueue(
          dependencies,
          monitor,
          services,
          advanced.event,
          `${monitorId}:${round.id}:${advanced.event}`,
          at,
          state.outageStartedAt ?? priorOutage,
          storedWatermark,
          storedReminder,
          storedFingerprint,
        ),
      );
    }
  }
  const timestamp = nowIso(now);
  if (!blocked && runs.length < runHistoryLimit && reminderDue(state, rules, timestamp)) {
    const pending = await first<{ active: number }>(
      db,
      `SELECT EXISTS (
         SELECT 1 FROM notification_deliveries
         WHERE monitor_id = ? AND status IN ('pending', 'sending')
       ) AS active`,
      [monitorId],
    );
    if ((pending?.active ?? 0) === 0) {
      // Anchor the event on the previous reminder time so two overlapping
      // invocations derive the same event key and dedup instead of double-sending.
      const reminderAnchor = state.lastReminderAt ?? state.outageStartedAt ?? timestamp;
      statements.push(
        ...enqueue(
          dependencies,
          monitor,
          services,
          'reminder',
          `${monitorId}:reminder:${reminderAnchor}`,
          timestamp,
          state.outageStartedAt,
          storedWatermark,
          storedReminder,
          storedFingerprint,
        ),
      );
      state = { ...state, lastReminderAt: timestamp };
    }
  }
  statements.push({
    sql: `INSERT INTO monitor_notification_state (
            monitor_id, config_fingerprint, last_window_started_at, status,
            failure_streak, success_streak, outage_started_at, last_reminder_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (monitor_id) DO UPDATE SET
            config_fingerprint = excluded.config_fingerprint,
            last_window_started_at = excluded.last_window_started_at,
            status = excluded.status,
            failure_streak = excluded.failure_streak,
            success_streak = excluded.success_streak,
            outage_started_at = excluded.outage_started_at,
            last_reminder_at = excluded.last_reminder_at,
            updated_at = excluded.updated_at
          -- Never let an overlapping invocation with an older watermark
          -- overwrite newer incident state and replay processed rounds.
          WHERE monitor_notification_state.last_window_started_at IS ?
            AND monitor_notification_state.last_reminder_at IS ?
            AND monitor_notification_state.config_fingerprint IS ?`,
    values: [
      monitorId,
      fingerprint,
      watermark,
      state.status,
      state.failureStreak,
      state.successStreak,
      state.outageStartedAt,
      state.lastReminderAt,
      timestamp,
      storedWatermark,
      storedReminder,
      storedFingerprint,
    ],
  });
  // State transition, cancellations, and new deliveries commit atomically.
  await batch(db, statements);
}

function failuresOutcome(expected: number, received: number, failures: number) {
  if (failures > 0) return 'failure' as const;
  return expected > 0 && received === expected ? ('healthy' as const) : ('unknown' as const);
}

/**
 * Cancel superseded deliveries, but only while the incident watermark is the
 * one observed by this invocation. If a newer overlapping invocation already
 * advanced the watermark, it owns the current delivery set and this older
 * invocation must not wipe it (the cancellation could not otherwise be undone,
 * because `enqueue` uses `ON CONFLICT DO NOTHING`).
 */
function cancelPending(
  monitorId: string,
  observedWatermark: string | null,
  observedReminder: string | null,
  observedFingerprint: string | null,
): { sql: string; values: unknown[] }[] {
  return [
    {
      sql: `UPDATE notification_deliveries SET status = 'cancelled', lease_until = NULL, lease_token = NULL
            WHERE monitor_id = ? AND status IN ('pending', 'sending')
              AND (SELECT last_window_started_at FROM monitor_notification_state WHERE monitor_id = ?)
                  IS ?
              AND (SELECT last_reminder_at FROM monitor_notification_state WHERE monitor_id = ?)
                  IS ?
              AND (SELECT config_fingerprint FROM monitor_notification_state WHERE monitor_id = ?)
                  IS ?`,
      values: [
        monitorId,
        monitorId,
        observedWatermark,
        monitorId,
        observedReminder,
        monitorId,
        observedFingerprint,
      ],
    },
  ];
}

function enqueue(
  dependencies: NotificationDependencies,
  monitor: MonitorRow,
  services: readonly ServiceRow[],
  kind: OutageEvent,
  eventKey: string,
  at: string,
  outageStartedAt: string | null,
  observedWatermark: string | null,
  observedReminder: string | null,
  observedFingerprint: string | null,
): { sql: string; values: unknown[] }[] {
  const message: NotificationMessage = {
    kind,
    monitorName: monitor.name ?? monitor.url,
    monitorUrl: monitor.url,
    occurredAt: at,
    outageStartedAt,
  };
  return services.map((service) => ({
    sql: `INSERT INTO notification_deliveries (
            id, monitor_id, notification_service_id, event_key, kind, message, next_attempt_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE (SELECT last_window_started_at FROM monitor_notification_state WHERE monitor_id = ?) IS ?
              AND (SELECT last_reminder_at FROM monitor_notification_state WHERE monitor_id = ?) IS ?
              AND (SELECT config_fingerprint FROM monitor_notification_state WHERE monitor_id = ?) IS ?
          ON CONFLICT (event_key, notification_service_id) DO NOTHING`,
    values: [
      randomId(),
      monitor.id,
      service.id,
      eventKey,
      kind,
      JSON.stringify(message),
      nowIso(dependencies.now),
      monitor.id,
      observedWatermark,
      monitor.id,
      observedReminder,
      monitor.id,
      observedFingerprint,
    ],
  }));
}

/**
 * Lease and send due deliveries. A lease keeps slow provider calls outside any
 * database lock, and acknowledgement is conditional on the lease token so a
 * delivery is not marked sent by a coordinator that lost its lease.
 */
async function deliverPending(dependencies: NotificationDependencies): Promise<void> {
  const { db, leaseToken } = dependencies;
  const currentTime = dependencies.liveNow ?? (() => dependencies.now);
  const now = currentTime();
  const claimed = await all<DeliveryRow>(
    db,
    `UPDATE notification_deliveries
     SET status = 'sending', attempts = attempts + 1, lease_until = ?, lease_token = ?
     WHERE id IN (
       SELECT d.id FROM notification_deliveries d
       JOIN monitors m ON m.id = d.monitor_id
       JOIN notification_services ns ON ns.id = d.notification_service_id
       JOIN monitor_notification_services mns
         ON mns.monitor_id = m.id AND mns.notification_service_id = ns.id
       WHERE m.enabled = 1 AND ns.enabled = 1 AND d.attempts < ?
         AND (
           (d.status = 'pending' AND d.next_attempt_at <= ?)
           OR (d.status = 'sending' AND d.lease_until < ?)
         )
       ORDER BY d.next_attempt_at, d.created_at
       LIMIT 10
     )
     RETURNING id, monitor_id, notification_service_id, message, attempts,
       (SELECT provider FROM notification_services WHERE id = notification_service_id) AS provider,
       (SELECT config FROM notification_services WHERE id = notification_service_id) AS config`,
    [
      nowIso(new Date(now.getTime() + 60_000)),
      leaseToken,
      dependencies.maxAttempts,
      nowIso(now),
      nowIso(now),
    ],
  );
  await drainAll(
    claimed.map(async (delivery) => {
      const message = JSON.parse(delivery.message) as NotificationMessage;
      let preview = { text: notificationMessageText(message), preview: {} };
      const recordAttempt = async (
        status: 'sent' | 'failed',
        text: string,
        externalUrl: string | null,
        error: string | null,
      ) => {
        try {
          await recordNotificationHistory(db, {
            notificationServiceId: delivery.notification_service_id,
            monitorId: delivery.monitor_id,
            monitorName: message.monitorName,
            monitorUrl: message.monitorUrl,
            provider: delivery.provider,
            kind: message.kind,
            status,
            createdAt: currentTime(),
            text,
            externalUrl,
            error,
            preview: preview.preview,
          });
        } catch {
          dependencies.log.warn({
            event: 'notification_history_write_failed',
            deliveryId: delivery.id,
          });
        }
      };
      let receipt: Awaited<ReturnType<typeof dispatchNotification>>;
      try {
        const { config } = await openProviderConfig(
          dependencies.credentialEncryptionSecret,
          delivery.config,
        );
        preview = notificationPreview(delivery.provider, config, message);
        receipt = await dispatchNotification(
          delivery.provider,
          config,
          message,
          dependencies.fetch,
        );
      } catch (error) {
        const retryable = error instanceof NotificationDeliveryError && error.retryable;
        const retryAfter =
          error instanceof NotificationDeliveryError ? error.retryAfterSeconds : 60;
        await failDelivery(dependencies, delivery, retryable, retryAfter, error, currentTime());
        const safeError =
          error instanceof NotificationDeliveryError && !error.retryable
            ? error.message
            : 'Temporary provider failure';
        await recordAttempt('failed', preview.text, null, safeError);
        dependencies.log.warn({
          event: 'notification_delivery_failed',
          deliveryId: delivery.id,
          retryable,
        });
        return;
      }
      // If acknowledgement fails, leave the lease recoverable rather than
      // misclassifying a database error as provider rejection.
      await run(
        db,
        `UPDATE notification_deliveries
         SET status = 'sent', sent_at = ?, lease_until = NULL, lease_token = NULL, last_error = NULL
         WHERE id = ? AND status = 'sending' AND lease_token = ?`,
        [nowIso(currentTime()), delivery.id, leaseToken],
      );
      await recordAttempt('sent', receipt.text, receipt.externalUrl, null);
    }),
  );
  await run(
    db,
    `UPDATE notification_deliveries
     SET status = 'failed', lease_until = NULL, lease_token = NULL,
       last_error = 'Delivery lease expired after final attempt'
     WHERE status = 'sending' AND lease_until < ? AND attempts >= ?`,
    [nowIso(currentTime()), dependencies.maxAttempts],
  );
}

async function failDelivery(
  dependencies: NotificationDependencies,
  delivery: DeliveryRow,
  retryable: boolean,
  retryAfterSeconds: number,
  error: unknown,
  now: Date,
): Promise<void> {
  const retry = retryable && delivery.attempts < dependencies.maxAttempts;
  const backoff = Math.min(3_600, 30 * 2 ** Math.max(0, delivery.attempts - 1));
  const delay = Math.max(retryAfterSeconds, backoff);
  // Preserve an explicit terminal reason (for example unsupported SMTP) so
  // operators can inspect why a delivery will never succeed.
  const explicitReason =
    error instanceof NotificationDeliveryError && !error.retryable ? error.reason : undefined;
  await run(
    dependencies.db,
    `UPDATE notification_deliveries
     SET status = ?, next_attempt_at = ?, lease_until = NULL, lease_token = NULL, last_error = ?
     WHERE id = ? AND status = 'sending' AND lease_token = ?`,
    [
      retry ? 'pending' : 'failed',
      nowIso(new Date(now.getTime() + delay * 1_000)),
      retry
        ? 'Temporary provider failure'
        : (explicitReason ?? 'Provider rejected delivery or retries exhausted'),
      delivery.id,
      dependencies.leaseToken,
    ],
  );
}
