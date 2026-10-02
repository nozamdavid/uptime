import { homeAssistantConfigSchema, type NotificationMessage } from '@uptime/contracts';
import { NotificationProvider } from '../notification-provider.js';
import { post, responseError } from '../delivery.js';
import { messageText } from '../message.js';

export class HomeAssistantNotificationProvider extends NotificationProvider {
  private readonly config;

  constructor(
    config: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    this.config = homeAssistantConfigSchema.parse(config);
  }

  async send(message: NotificationMessage): Promise<void> {
    const url = `${this.config.serverUrl.replace(/\/+$/, '')}/api/services/notify/${this.config.service}`;
    const response = await post(
      this.fetchImpl,
      url,
      {
        title: 'Uptime',
        message: messageText(message),
      },
      { Authorization: `Bearer ${this.config.accessToken}` },
    );
    if (!response.ok) throw responseError(response);
  }
}
