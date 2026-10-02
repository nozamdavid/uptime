import {
  blueskyConfigSchema,
  discordConfigSchema,
  gotifyConfigSchema,
  homeAssistantConfigSchema,
  resendConfigSchema,
  telegramConfigSchema,
  webhookConfigSchema,
  type NotificationMessage,
  type NotificationProviderKind,
} from '@uptime/contracts';
import {
  buildNotificationRequest,
  checkNotificationResponse,
  notificationMessageText,
  notificationReceiptUrl,
  postNotificationRequest,
  sendBlueskyNotification,
  type BlueskyDeliveryPhase,
  type NotificationReceipt,
} from '@uptime/cloudflare';

import { HttpErrorLike } from './http.js';

export interface ProviderDelivery {
  send(message: NotificationMessage): Promise<NotificationReceipt>;
}

class BlueskyTestError extends Error {
  constructor(
    readonly phase: BlueskyDeliveryPhase,
    readonly upstreamStatus?: number,
  ) {
    super('Bluesky notification test failed');
    this.name = 'BlueskyTestError';
  }
}

function responseError(response: Response, retryAfter?: number): Error {
  const seconds = retryAfter ?? Number(response.headers.get('retry-after'));
  const suffix =
    Number.isFinite(seconds) && seconds > 0 ? ` (retry after ${Math.ceil(seconds)}s)` : '';
  return new Error(`Provider responded with HTTP ${response.status}${suffix}`);
}

/**
 * Workers-compatible notification providers.
 *
 * LIMITATION: SMTP is intentionally not implemented in this Worker. The
 * Workers runtime can open outbound TCP sockets via `cloudflare:sockets` to
 * ports 465/587 (only port 25 is blocked), so SMTP is possible in principle;
 * a full SMTP/STARTTLS client is simply out of scope here. SMTP services
 * therefore cannot send a test from the API Worker; use an HTTP provider
 * (telegram, discord, resend, gotify, webhook, home-assistant) instead.
 */
export class UnsupportedProviderError extends Error {
  constructor(provider: string) {
    super(`Provider "${provider}" is not supported in the Workers runtime`);
    this.name = 'UnsupportedProviderError';
  }
}

export function createNotificationProvider(
  kind: NotificationProviderKind,
  config: unknown,
  fetchImpl: typeof fetch = fetch,
): ProviderDelivery {
  if (kind === 'smtp') throw new UnsupportedProviderError('smtp');
  if (kind === 'bluesky') {
    const parsed = blueskyConfigSchema.parse(config);
    return {
      async send(message) {
        return sendBlueskyNotification(
          fetchImpl,
          parsed,
          message,
          (response, phase) => {
            throw new BlueskyTestError(phase, response.status);
          },
          (_error, phase) => {
            throw new BlueskyTestError(phase);
          },
          (phase) => {
            throw new BlueskyTestError(phase);
          },
        );
      },
    };
  }
  const parsed = {
    telegram: telegramConfigSchema,
    discord: discordConfigSchema,
    resend: resendConfigSchema,
    gotify: gotifyConfigSchema,
    webhook: webhookConfigSchema,
    'home-assistant': homeAssistantConfigSchema,
  }[kind].parse(config) as Record<string, unknown>;
  const requiredString = (key: string) => String(parsed[key]);
  const requiredStringArray = (key: string) => parsed[key] as string[];
  const numberOr = (key: string, fallback: number) => (parsed[key] as number) ?? fallback;
  return {
    async send(message) {
      const request = buildNotificationRequest(
        kind,
        parsed,
        message,
        requiredString,
        requiredStringArray,
        numberOr,
      );
      const response = await postNotificationRequest(fetchImpl, request);
      const payload = await checkNotificationResponse(
        kind,
        response,
        (failedResponse, retryAfter) => {
          throw responseError(failedResponse, retryAfter);
        },
      );
      return {
        text: notificationMessageText(message),
        externalUrl: notificationReceiptUrl(kind, payload),
      };
    },
  };
}

export function providerTestError(error: unknown): HttpErrorLike {
  if (error instanceof BlueskyTestError) {
    const phase = error.phase.replace(/_/g, ' ');
    const status = error.upstreamStatus ? ` (HTTP ${error.upstreamStatus})` : '';
    return new HttpErrorLike(
      502,
      'notification_failed',
      `Bluesky test failed during ${phase}${status}`,
    );
  }
  if (error instanceof UnsupportedProviderError) {
    return new HttpErrorLike(
      501,
      'provider_unsupported',
      `${error.message}. Use an HTTP provider.`,
    );
  }
  return new HttpErrorLike(
    502,
    'notification_failed',
    'The notification service could not send a test',
  );
}
