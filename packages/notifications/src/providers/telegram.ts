import { telegramConfigSchema, type NotificationMessage } from '@uptime/contracts';
import { NotificationProvider } from '../notification-provider.js';
import { post, responseError } from '../delivery.js';
import { messageText } from '../message.js';

export class TelegramNotificationProvider extends NotificationProvider {
  private readonly config;
  constructor(
    config: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    this.config = telegramConfigSchema.parse(config);
  }
  async send(message: NotificationMessage): Promise<void> {
    const response = await post(
      this.fetchImpl,
      `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
      {
        chat_id: this.config.chatId,
        text: messageText(message),
        link_preview_options: { is_disabled: true },
      },
    );
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      parameters?: { retry_after?: number };
    } | null;
    if (!response.ok || body?.ok !== true)
      throw responseError(response, body?.parameters?.retry_after);
  }
}
