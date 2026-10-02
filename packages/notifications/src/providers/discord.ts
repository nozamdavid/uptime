import { discordConfigSchema, type NotificationMessage } from '@uptime/contracts';
import { NotificationProvider } from '../notification-provider.js';
import { post, responseError } from '../delivery.js';
import { messageText } from '../message.js';

export class DiscordNotificationProvider extends NotificationProvider {
  private readonly config;
  constructor(
    config: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    this.config = discordConfigSchema.parse(config);
  }
  async send(message: NotificationMessage): Promise<void> {
    const response = await post(this.fetchImpl, `${this.config.webhookUrl}?wait=true`, {
      content: messageText(message),
      allowed_mentions: { parse: [] },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { retry_after?: number } | null;
      throw responseError(response, body?.retry_after);
    }
  }
}
