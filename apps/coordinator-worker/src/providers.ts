import type { NotificationMessage } from '@uptime/contracts';
import {
  buildNotificationRequest,
  checkNotificationResponse,
  notificationMessageText,
  notificationReceiptUrl,
  postNotificationRequest,
  sendBlueskyNotification,
  type NotificationReceipt,
} from '@uptime/cloudflare';

/**
 * Workers-portable notification providers.
 *
 * HTTP provider requests share their builders and response handling with the
 * API Worker through `@uptime/cloudflare`. SMTP configuration remains stored
 * for compatibility, but SMTP delivery is unsupported in Workers and is
 * reported as a terminal configuration error (see `dispatchNotification`).
 */

export const messageText = notificationMessageText;

export class NotificationDeliveryError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly retryAfterSeconds = 60,
    /** Persisted verbatim as the delivery's `last_error` for terminal cases. */
    readonly reason?: string,
  ) {
    super(
      reason ??
        (retryable
          ? 'Notification delivery temporarily failed'
          : 'Notification service rejected the message; check its settings'),
    );
    this.name = 'NotificationDeliveryError';
  }
}

function responseError(response: Response, retryAfter?: number): NotificationDeliveryError {
  const seconds = retryAfter ?? Number(response.headers.get('retry-after'));
  return new NotificationDeliveryError(
    response.status === 429 || response.status >= 500,
    Number.isFinite(seconds) && seconds > 0 ? Math.min(86_400, Math.ceil(seconds)) : 60,
  );
}

function requireString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new NotificationDeliveryError(false);
  }
  return value;
}

function requireStringArray(config: Record<string, unknown>, key: string): string[] {
  const value = config[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new NotificationDeliveryError(false);
  }
  return value as string[];
}

function numberOr(config: Record<string, unknown>, key: string, fallback: number): number {
  return typeof config[key] === 'number' ? (config[key] as number) : fallback;
}

/** Dispatch one already-decrypted provider config to its provider. */
export async function dispatchNotification(
  provider: string,
  config: Record<string, unknown>,
  message: NotificationMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<NotificationReceipt> {
  if (provider === 'smtp') {
    throw new NotificationDeliveryError(
      false,
      60,
      'SMTP is not supported in the Cloudflare Workers runtime; use Resend or an HTTP provider',
    );
  }
  if (provider === 'bluesky') {
    return sendBlueskyNotification(
      fetchImpl,
      {
        handle: requireString(config, 'handle'),
        appPassword: requireString(config, 'appPassword'),
      },
      message,
      (response) => {
        throw responseError(response);
      },
      () => {
        throw new NotificationDeliveryError(true);
      },
      () => {
        throw new NotificationDeliveryError(true);
      },
    );
  }
  if (
    !['telegram', 'discord', 'resend', 'gotify', 'webhook', 'home-assistant'].includes(provider)
  ) {
    throw new NotificationDeliveryError(false, 60, `Unknown notification provider: ${provider}`);
  }
  const request = buildNotificationRequest(
    provider,
    config,
    message,
    (key) => requireString(config, key),
    (key) => requireStringArray(config, key),
    (key, fallback) => numberOr(config, key, fallback),
  );
  const response = await postNotificationRequest(fetchImpl, request, () => {
    // Fetch errors can contain the request URL, including provider credentials.
    throw new NotificationDeliveryError(true);
  });
  const payload = await checkNotificationResponse(
    provider,
    response,
    (failedResponse, retryAfter) => {
      throw responseError(failedResponse, retryAfter);
    },
  );
  return {
    text: notificationMessageText(message),
    externalUrl: notificationReceiptUrl(provider, payload),
  };
}
