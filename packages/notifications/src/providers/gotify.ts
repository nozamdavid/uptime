import { gotifyConfigSchema, type NotificationMessage } from '@uptime/contracts';
import { NotificationProvider } from '../notification-provider.js';
import { post, responseError } from '../delivery.js';
import { messageText } from '../message.js';

export class GotifyNotificationProvider extends NotificationProvider {
  private readonly config;

  constructor(
    config: unknown,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
    this.config = gotifyConfigSchema.parse(config);
  }

  async send(message: NotificationMessage): Promise<void> {
    const response = await post(
      this.fetchImpl,
      `${this.config.serverUrl.replace(/\/+$/, '')}/message`,
      {
        title: 'Uptime',
        message: messageText(message),
        priority: this.config.priority,
      },
      { 'X-Gotify-Key': this.config.applicationToken },
    );
    if (!response.ok) throw responseError(response);
  }
}
