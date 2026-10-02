import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '@uptime/database';
import type { NotificationMessage, NotificationProviderKind, RegionId } from '@uptime/contracts';
import { createNotificationProvider, NotificationDeliveryError } from '@uptime/notifications';
import {
  advanceOutage,
  classifyRound,
  initialOutageState,
  reminderDue,
  type OutageRules,
  type OutageState,
  type OutageEvent,
} from './notification-state.js';

type Executor = Pick<Database, 'execute'>;
interface Dependencies {
  db: Database;
  fetch: typeof fetch;
  now: () => Date;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
}
interface MonitorRow extends OutageRules {
  id: string;
  name: string | null;
  url: string;
  enabled: boolean;
  updatedAt: Date | string;
  regionIds: RegionId[];
}
interface StateRow extends OutageState {
  configFingerprint: string;
  lastWindowStartedAt: Date | string;
}
interface RunRow {
  id: string;
  window: Date | string;
  status: string;
  expected: number;
  received: number;
  failures: number;
}
interface DeliveryRow {
  id: string;
  provider: NotificationProviderKind;
  config: unknown;
  message: NotificationMessage;
  attempts: number;
}

async function rows<T>(db: Executor, query: Parameters<Database['execute']>[0]): Promise<T[]> {
  const result = await db.execute(query);
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}
function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

/** Transactions record decisions; leased deliveries keep network calls outside database locks. */
export class SchedulerNotifications {
  constructor(
    private readonly dependencies: Dependencies,
    private readonly enabledRegions: readonly RegionId[],
  ) {}

  async tick(): Promise<void> {
    const monitors = await rows<{ id: string }>(
      this.dependencies.db,
      sql`
      select id from monitors where exists (
        select 1 from monitor_notification_services mns where mns.monitor_id = monitors.id
      ) or exists (select 1 from monitor_notification_state s where s.monitor_id = monitors.id)
    `,
    );
    for (const monitor of monitors) {
      try {
        await this.evaluate(monitor.id);
      } catch {
        this.dependencies.log.error({
          event: 'notification_evaluation_failed',
          monitorId: monitor.id,
        });
      }
    }
    await this.deliver();
  }

  private async evaluate(id: string): Promise<void> {
    await this.dependencies.db.transaction(async (tx) => {
      // Lock the same monitor row used by configuration edits, serializing decisions across schedulers.
      const [monitor] = await rows<MonitorRow>(
        tx,
        sql`
        select m.id, m.name, m.url, m.enabled, m.updated_at as "updatedAt",
          m.outage_threshold as "outageThreshold", m.recovery_threshold as "recoveryThreshold",
          m.repeat_notification_minutes as "repeatNotificationMinutes",
          array(select region_id::text from monitor_regions where monitor_id = m.id order by region_id) as "regionIds"
        from monitors m where m.id = ${id} for update skip locked
      `,
      );
      if (!monitor) return;
      const selected = await rows<{
        id: string;
        updatedAt: Date | string;
        provider: string;
        config: unknown;
      }>(
        tx,
        sql`
        select ns.id, ns.updated_at as "updatedAt", ns.provider, ns.config from notification_services ns join monitor_notification_services mns on mns.notification_service_id = ns.id
        where mns.monitor_id = ${id} and ns.enabled order by ns.id for share of ns
      `,
      );
      const regions = monitor.regionIds.filter((region) => this.enabledRegions.includes(region));
      if (!monitor.enabled || selected.length === 0 || regions.length === 0) {
        await tx.execute(sql`
          insert into monitor_notification_state (monitor_id, config_fingerprint, last_window_started_at)
          values (${id}, 'inactive', ${this.dependencies.now().toISOString()})
          on conflict (monitor_id) do update set config_fingerprint = 'inactive', last_window_started_at = excluded.last_window_started_at,
            status = 'healthy', failure_streak = 0, success_streak = 0, outage_started_at = null, last_reminder_at = null
        `);
        await this.cancel(tx, id);
        return;
      }
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            url: monitor.url,
            regions,
            outage: monitor.outageThreshold,
            recovery: monitor.recoveryThreshold,
            repeat: monitor.repeatNotificationMinutes,
            services: selected.map((service) => [service.id, service.provider, service.config]),
          }),
        )
        .digest('hex');
      const [stored] = await rows<StateRow>(
        tx,
        sql`
        select config_fingerprint as "configFingerprint", last_window_started_at as "lastWindowStartedAt", status,
          failure_streak as "failureStreak", success_streak as "successStreak",
          outage_started_at as "outageStartedAt", last_reminder_at as "lastReminderAt"
        from monitor_notification_state where monitor_id = ${id}
      `,
      );
      const configuredAt = Math.max(
        new Date(monitor.updatedAt).getTime(),
        ...selected.map((service) => new Date(service.updatedAt).getTime()),
      );
      let watermark = stored
        ? iso(stored.lastWindowStartedAt)
        : new Date(configuredAt).toISOString();
      let state: OutageState = stored
        ? {
            status: stored.status,
            failureStreak: stored.failureStreak,
            successStreak: stored.successStreak,
            outageStartedAt: stored.outageStartedAt ? iso(stored.outageStartedAt) : null,
            lastReminderAt: stored.lastReminderAt ? iso(stored.lastReminderAt) : null,
          }
        : initialOutageState();
      if (stored && stored.configFingerprint !== fingerprint) {
        state = initialOutageState();
        watermark = new Date(Math.max(Date.parse(watermark), configuredAt)).toISOString();
        await this.cancel(tx, id);
      }
      const runs = await rows<RunRow>(
        tx,
        sql`
        select cr.id, cr.window_started_at as window, cr.status, cr.expected_region_count as expected,
          count(o.id)::integer as received, count(o.id) filter (where not o.success)::integer as failures
        from check_runs cr left join observations o on o.check_run_id = cr.id
        where cr.monitor_id = ${id} and cr.window_started_at > ${watermark}::timestamptz
        group by cr.id order by cr.window_started_at asc limit 200
      `,
      );
      let blocked = false;
      for (const run of runs) {
        // A later completed round must never overtake an earlier round still collecting results.
        if (run.status === 'pending') {
          blocked = true;
          break;
        }
        const at = iso(run.window);
        const priorOutage = state.outageStartedAt;
        const advanced = advanceOutage(
          state,
          classifyRound(run.expected, run.received, run.failures),
          monitor,
          at,
        );
        state = advanced.state;
        watermark = at;
        if (advanced.event) {
          await this.cancel(tx, id);
          await this.enqueue(
            tx,
            monitor,
            selected,
            advanced.event,
            `${id}:${run.id}:${advanced.event}`,
            at,
            state.outageStartedAt ?? priorOutage,
          );
        }
      }
      const now = this.dependencies.now().toISOString();
      // Drain history before considering timers; never replay a stack of missed reminders.
      if (!blocked && runs.length < 200 && reminderDue(state, monitor, now)) {
        const pending = await rows<{ id: string }>(
          tx,
          sql`
          select id from notification_deliveries where monitor_id = ${id} and status in ('pending', 'sending') limit 1
        `,
        );
        if (pending.length === 0) {
          await this.enqueue(
            tx,
            monitor,
            selected,
            'reminder',
            `${id}:reminder:${now}`,
            now,
            state.outageStartedAt,
          );
          state.lastReminderAt = now;
        }
      }
      await tx.execute(sql`
        insert into monitor_notification_state (monitor_id, config_fingerprint, last_window_started_at, status,
          failure_streak, success_streak, outage_started_at, last_reminder_at)
        values (${id}, ${fingerprint}, ${watermark}, ${state.status}, ${state.failureStreak}, ${state.successStreak},
          ${state.outageStartedAt}, ${state.lastReminderAt})
        on conflict (monitor_id) do update set config_fingerprint = excluded.config_fingerprint,
          last_window_started_at = excluded.last_window_started_at, status = excluded.status,
          failure_streak = excluded.failure_streak, success_streak = excluded.success_streak,
          outage_started_at = excluded.outage_started_at, last_reminder_at = excluded.last_reminder_at, updated_at = now()
      `);
    });
  }

  private async cancel(tx: Executor, monitorId: string): Promise<void> {
    await tx.execute(sql`update notification_deliveries set status = 'cancelled', lease_until = null, lease_token = null
      where monitor_id = ${monitorId} and status in ('pending', 'sending')`);
  }

  private async enqueue(
    tx: Executor,
    monitor: MonitorRow,
    services: { id: string }[],
    kind: OutageEvent,
    key: string,
    at: string,
    outageStartedAt: string | null,
  ): Promise<void> {
    const message: NotificationMessage = {
      kind,
      monitorName: monitor.name ?? monitor.url,
      monitorUrl: monitor.url,
      occurredAt: at,
      outageStartedAt,
    };
    for (const service of services) {
      await tx.execute(sql`
        insert into notification_deliveries (monitor_id, notification_service_id, event_key, kind, message)
        values (${monitor.id}, ${service.id}, ${key}, ${kind}, ${JSON.stringify(message)})
        on conflict (event_key, notification_service_id) do nothing
      `);
    }
  }

  private async deliver(): Promise<void> {
    // Keep the probe loop bounded even if a provider is slow: at most ten concurrent sends per tick.
    const lease = randomUUID();
    const pending = await rows<DeliveryRow>(
      this.dependencies.db,
      sql`
      with due as (
        select d.id from notification_deliveries d
        join monitors m on m.id = d.monitor_id
        join notification_services ns on ns.id = d.notification_service_id
        join monitor_notification_services mns on mns.monitor_id = m.id and mns.notification_service_id = ns.id
        where m.enabled and ns.enabled and d.attempts < 8 and (
          (d.status = 'pending' and d.next_attempt_at <= now()) or
          (d.status = 'sending' and d.lease_until < now())
        ) order by d.next_attempt_at, d.created_at for update of d skip locked limit 10
      ), claimed as (
        update notification_deliveries d set status = 'sending', attempts = attempts + 1,
          lease_until = now() + interval '60 seconds', lease_token = ${lease}
        from due where d.id = due.id returning d.*
      ) select c.id, c.message, c.attempts, ns.provider, ns.config
      from claimed c join notification_services ns on ns.id = c.notification_service_id
    `,
    );
    await Promise.all(
      pending.map(async (delivery) => {
        try {
          await createNotificationProvider(
            delivery.provider,
            delivery.config,
            this.dependencies.fetch,
          ).send(delivery.message);
        } catch (error) {
          const retryable =
            error instanceof NotificationDeliveryError && error.retryable && delivery.attempts < 8;
          const delay = Math.max(
            error instanceof NotificationDeliveryError ? error.retryAfterSeconds : 60,
            Math.min(3600, 30 * 2 ** (delivery.attempts - 1)),
          );
          await this.dependencies.db.execute(sql`
          update notification_deliveries set status = ${retryable ? 'pending' : 'failed'},
            next_attempt_at = now() + (${delay} * interval '1 second'), lease_until = null, lease_token = null,
            last_error = ${retryable ? 'Temporary provider failure' : 'Provider rejected delivery or retries exhausted'}
          where id = ${delivery.id} and status = 'sending' and lease_token = ${lease}
        `);
          this.dependencies.log.warn({
            event: 'notification_delivery_failed',
            deliveryId: delivery.id,
            retryable,
          });
          return;
        }
        // If acknowledgement fails, leave the lease recoverable rather than misclassifying a database error as provider rejection.
        await this.dependencies.db.execute(sql`
        update notification_deliveries set status = 'sent', sent_at = now(), lease_until = null, lease_token = null, last_error = null
        where id = ${delivery.id} and status = 'sending' and lease_token = ${lease}
      `);
      }),
    );
    await this.dependencies.db.execute(sql`
      update notification_deliveries set status = 'failed', lease_until = null, lease_token = null, last_error = 'Delivery lease expired after final attempt'
      where status = 'sending' and lease_until < now() and attempts >= 8
    `);
  }
}
