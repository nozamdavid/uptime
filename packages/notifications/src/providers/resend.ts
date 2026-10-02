import { resendConfigSchema, type NotificationMessage } from '@uptime/contracts';
import { NotificationProvider } from '../notification-provider.js';
import { post, responseError } from '../delivery.js';
import { messageText } from '../message.js';

export class ResendNotificationProvider extends NotificationProvider {
  private readonly config;

  constructor(
    config: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    this.config = resendConfigSchema.parse(config);
  }

  async send(message: NotificationMessage): Promise<void> {
    const response = await post(
      this.fetchImpl,
      'https://api.resend.com/emails',
      {
        from: this.config.from,
        to: this.config.to,
        subject: this.config.subject || 'Uptime notification',
        text: messageText(message),
      },
      { Authorization: `Bearer ${this.config.apiKey}` },
    );
    if (!response.ok) throw responseError(response);
  }
}
