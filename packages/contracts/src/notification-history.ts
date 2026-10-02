import { z } from 'zod';

import { notificationProviderSchema } from './notifications.js';

export const notificationHistoryEntrySchema = z.object({
  id: z.uuid(),
  notificationServiceId: z.uuid(),
  monitorId: z.uuid().nullable(),
  monitorName: z.string(),
  monitorUrl: z.string().nullable(),
  provider: notificationProviderSchema,
  kind: z.enum(['outage', 'recovery', 'reminder', 'test']),
  status: z.enum(['sent', 'failed']),
  createdAt: z.iso.datetime({ offset: true }),
  text: z.string(),
  externalUrl: z.string().nullable(),
  error: z.string().nullable(),
  preview: z.object({
    subject: z.string().optional(),
    from: z.string().optional(),
    to: z.array(z.string()).optional(),
    handle: z.string().optional(),
  }),
});

export type NotificationHistoryEntry = z.infer<typeof notificationHistoryEntrySchema>;

export const notificationHistoryResponseSchema = z.object({
  entries: z.array(notificationHistoryEntrySchema),
  nextCursor: z.string().nullable(),
});

export type NotificationHistoryResponse = z.infer<typeof notificationHistoryResponseSchema>;
