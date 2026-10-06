import { nowIso, randomId } from './crypto.js';
import type { Database } from './postgres/database.js';
import { pgRun } from './postgres/query.js';
import type { NotificationMessage, NotificationProviderKind } from './types.js';

export interface NotificationHistoryWrite {
  notificationServiceId: string;
  monitorId: string | null;
  monitorName: string;
  monitorUrl: string | null;
  provider: NotificationProviderKind;
  kind: NotificationMessage['kind'];
  status: 'sent' | 'failed';
  createdAt: Date;
  text: string;
  externalUrl: string | null;
  error: string | null;
  preview: { subject?: string; from?: string; to?: string[]; handle?: string };
}

/** Append an attempt only while its service still exists. Monitor snapshots stay readable after deletion. */
export async function recordNotificationHistory(
  db: Database,
  entry: NotificationHistoryWrite,
): Promise<void> {
  const historyTable = db.table('notification_history');
  const servicesTable = db.table('notification_services');
  const monitorsTable = db.table('monitors');

  await pgRun(
    db,
    `INSERT INTO ${historyTable} (
       id, notification_service_id, monitor_id, monitor_name, monitor_url,
       provider, kind, status, created_at, text, external_url, error, preview
     )
     SELECT $1, id,
       CASE WHEN $2::text IS NOT NULL AND EXISTS (SELECT 1 FROM ${monitorsTable} WHERE id = $2::text)
         THEN $2::text ELSE NULL END,
       COALESCE($3, 'Unknown Monitor'), $4, $5, $6, $7, $8, $9, $10, $11, $12
     FROM ${servicesTable} WHERE id = $13`,
    [
      randomId(),
      entry.monitorId,
      entry.monitorName,
      entry.monitorUrl,
      entry.provider,
      entry.kind,
      entry.status,
      nowIso(entry.createdAt),
      entry.text,
      entry.externalUrl,
      entry.error,
      JSON.stringify(entry.preview ?? {}),
      entry.notificationServiceId,
    ],
  );
}
