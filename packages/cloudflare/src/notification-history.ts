import { nowIso, randomId } from './crypto.js';
import { run } from './db.js';
import type { NotificationProviderKind, NotificationMessage } from './types.js';
import type { D1Database } from './workers-types.js';

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
  db: D1Database,
  entry: NotificationHistoryWrite,
): Promise<void> {
  await run(
    db,
    `INSERT INTO notification_history (
       id, notification_service_id, monitor_id, monitor_name, monitor_url,
       provider, kind, status, created_at, text, external_url, error, preview
     )
     SELECT ?, id,
       CASE WHEN ? IS NOT NULL AND EXISTS (SELECT 1 FROM monitors WHERE id = ?)
         THEN ? ELSE NULL END,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     FROM notification_services WHERE id = ?`,
    [
      randomId(),
      entry.monitorId,
      entry.monitorId,
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
      JSON.stringify(entry.preview),
      entry.notificationServiceId,
    ],
  );
}
