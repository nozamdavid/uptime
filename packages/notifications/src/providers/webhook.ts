import { webhookConfigSchema, type NotificationMessage } from '@uptime/contracts';
import { NotificationProvider } from '../notification-provider.js';
import { post, responseError } from '../delivery.js';
import { messageText } from '../message.js';

export class WebhookNotificationProvider extends NotificationProvider {
  private readonly config;

  constructor(
    config: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    this.config = webhookConfigSchema.parse(config);
  }

  async send(message: NotificationMessage): Promise<void> {
    const response = await post(
      this.fetchImpl,
      this.config.webhookUrl,
      {
        ...message,
        text: messageText(message),
      },
      this.config.bearerToken ? { Authorization: `Bearer ${this.config.bearerToken}` } : {},
    );
    if (!response.ok) throw responseError(response);
  }
}
