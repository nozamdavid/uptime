import { blueskyPostText, type BlueskyMessage } from './bluesky-notifications.js';
import { notificationMessageText } from './notification-providers.js';

export interface NotificationPreview {
  text: string;
  preview: { subject?: string; from?: string; to?: string[]; handle?: string };
}

/** Build the exact body text and only display-safe provider details. */
export function notificationPreview(
  provider: string,
  config: Record<string, unknown>,
  message: BlueskyMessage,
): NotificationPreview {
  if (provider === 'bluesky') {
    return {
      text: blueskyPostText(message),
      preview: {
        ...(typeof config.handle === 'string' ? { handle: config.handle } : {}),
      },
    };
  }

  const text = notificationMessageText(message);
  const preview: NotificationPreview['preview'] = {};
  if (provider === 'resend' || provider === 'smtp') {
    if (typeof config.subject === 'string' && config.subject) {
      preview.subject = config.subject;
    } else if (provider === 'resend') {
      preview.subject = 'Uptime notification';
    }
    if (typeof config.from === 'string') preview.from = config.from;
    if (Array.isArray(config.to) && config.to.every((item) => typeof item === 'string')) {
      preview.to = config.to;
    }
  }
  return { text, preview };
}
