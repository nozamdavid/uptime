import {
  mergeProviderConfig,
  publicProviderConfig,
  type NotificationProviderKind,
  type NotificationService,
} from '@uptime/contracts';

import { openProviderConfig } from './credentials.js';
import { HttpErrorLike } from './http.js';
import type { NotificationServiceRow } from './types.js';

export { retainedSecret } from '@uptime/contracts';

function invalidConfig(): never {
  throw new HttpErrorLike(400, 'validation_error', 'Request configuration does not match provider');
}

export function mergeNotificationConfig(
  provider: NotificationProviderKind,
  current: Record<string, unknown>,
  update: unknown,
): Record<string, unknown> {
  return mergeProviderConfig(provider, current, update, invalidConfig);
}

/** Open stored envelopes and project only non-secret display fields. */
export async function serializeNotificationService(
  secret: string,
  row: NotificationServiceRow,
): Promise<NotificationService> {
  const { config } = await openProviderConfig(secret, row.config);
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    enabled: row.enabled === 1,
    config: publicProviderConfig(row.provider, config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
