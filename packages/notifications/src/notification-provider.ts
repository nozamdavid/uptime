import type { NotificationMessage } from '@uptime/contracts';

/** Providers validate their own configuration and expose one delivery operation. */
export abstract class NotificationProvider {
  abstract send(message: NotificationMessage): Promise<void>;
}
