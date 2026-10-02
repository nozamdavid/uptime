import type { NotificationProviderKind } from '@uptime/contracts';
import { DiscordNotificationProvider } from './providers/discord.js';
import { TelegramNotificationProvider } from './providers/telegram.js';
import { ResendNotificationProvider } from './providers/resend.js';
import { GotifyNotificationProvider } from './providers/gotify.js';
import { WebhookNotificationProvider } from './providers/webhook.js';
import { SmtpNotificationProvider } from './providers/smtp.js';
import { HomeAssistantNotificationProvider } from './providers/home-assistant.js';
import type { NotificationProvider } from './notification-provider.js';

export type { NotificationMessage } from '@uptime/contracts';
export { NotificationProvider } from './notification-provider.js';
export { NotificationDeliveryError } from './delivery.js';
export { DiscordNotificationProvider } from './providers/discord.js';
export { TelegramNotificationProvider } from './providers/telegram.js';
export { ResendNotificationProvider } from './providers/resend.js';
export { GotifyNotificationProvider } from './providers/gotify.js';
export { WebhookNotificationProvider } from './providers/webhook.js';
export { SmtpNotificationProvider } from './providers/smtp.js';
export { HomeAssistantNotificationProvider } from './providers/home-assistant.js';

type SupportedNotificationProviderKind = Exclude<NotificationProviderKind, 'bluesky'>;

const providers = {
  telegram: TelegramNotificationProvider,
  discord: DiscordNotificationProvider,
  resend: ResendNotificationProvider,
  gotify: GotifyNotificationProvider,
  webhook: WebhookNotificationProvider,
  smtp: SmtpNotificationProvider,
  'home-assistant': HomeAssistantNotificationProvider,
} satisfies Record<
  SupportedNotificationProviderKind,
  new (config: unknown, fetchImpl?: typeof fetch) => NotificationProvider
>;

export function createNotificationProvider(
  kind: NotificationProviderKind,
  config: unknown,
  fetchImpl: typeof fetch = fetch,
): NotificationProvider {
  if (!(kind in providers)) {
    throw new Error(`Unsupported notification provider: ${kind}`);
  }
  const Provider = providers[kind as SupportedNotificationProviderKind];
  return new Provider(config, fetchImpl);
}
