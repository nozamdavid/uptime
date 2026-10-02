interface WorkerNotificationMessage {
  kind: 'outage' | 'recovery' | 'reminder' | 'test';
  monitorName: string;
  monitorUrl: string;
  occurredAt: string;
  outageStartedAt: string | null;
}

export interface NotificationRequest {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
}

export interface NotificationReceipt {
  text: string;
  externalUrl: string | null;
}

export function notificationMessageText(message: WorkerNotificationMessage): string {
  if (message.kind === 'test')
    return 'Uptime notification test\nYour notification service is connected.';
  const title = { outage: 'OUTAGE', recovery: 'RECOVERED', reminder: 'STILL DOWN' }[message.kind];
  const lines = [
    title,
    message.monitorName.slice(0, 120),
    message.monitorUrl.slice(0, 1200),
    `Time: ${message.occurredAt}`,
  ];
  if (message.outageStartedAt) lines.push(`Outage started: ${message.outageStartedAt}`);
  return lines.join('\n');
}

export function buildNotificationRequest(
  provider: string,
  config: Record<string, unknown>,
  message: WorkerNotificationMessage,
  requiredString: (key: string) => string,
  requiredStringArray: (key: string) => string[],
  numberOr: (key: string, fallback: number) => number,
): NotificationRequest {
  const text = notificationMessageText(message);
  switch (provider) {
    case 'telegram':
      return {
        url: `https://api.telegram.org/bot${requiredString('botToken')}/sendMessage`,
        body: {
          chat_id: requiredString('chatId'),
          text,
          link_preview_options: { is_disabled: true },
        },
      };
    case 'discord':
      return {
        url: `${requiredString('webhookUrl')}?wait=true`,
        body: { content: text, allowed_mentions: { parse: [] } },
      };
    case 'resend':
      return {
        url: 'https://api.resend.com/emails',
        headers: { Authorization: `Bearer ${requiredString('apiKey')}` },
        body: {
          from: requiredString('from'),
          to: requiredStringArray('to'),
          subject:
            typeof config.subject === 'string' && config.subject
              ? config.subject
              : 'Uptime notification',
          text,
        },
      };
    case 'gotify':
      return {
        url: `${requiredString('serverUrl').replace(/\/+$/, '')}/message`,
        headers: { 'X-Gotify-Key': requiredString('applicationToken') },
        body: {
          title: 'Uptime',
          message: text,
          priority: numberOr('priority', 8),
        },
      };
    case 'webhook':
      return {
        url: requiredString('webhookUrl'),
        headers:
          typeof config.bearerToken === 'string' && config.bearerToken
            ? { Authorization: `Bearer ${config.bearerToken}` }
            : {},
        body: { ...message, text },
      };
    case 'home-assistant':
      return {
        url: `${requiredString('serverUrl').replace(/\/+$/, '')}/api/services/notify/${requiredString(
          'service',
        )}`,
        headers: { Authorization: `Bearer ${requiredString('accessToken')}` },
        body: { title: 'Uptime', message: text },
      };
    default:
      throw new Error(`Unsupported HTTP notification provider: ${provider}`);
  }
}

export async function postNotificationRequest(
  fetchImpl: typeof fetch,
  request: NotificationRequest,
  onFetchError: (error: unknown) => never = (error) => {
    throw error;
  },
): Promise<Response> {
  try {
    return await fetchImpl(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return onFetchError(error);
  }
}

export async function checkNotificationResponse(
  provider: string,
  response: Response,
  onFailure: (response: Response, retryAfter?: number) => never,
): Promise<unknown> {
  let payload: unknown = null;
  if (provider === 'telegram') {
    const body = (await safeResponseJson(response)) as {
      ok?: boolean;
      parameters?: { retry_after?: number };
    } | null;
    if (!response.ok || body?.ok !== true) onFailure(response, body?.parameters?.retry_after);
    payload = body;
  } else if (provider === 'discord' && !response.ok) {
    const body = (await safeResponseJson(response)) as { retry_after?: number } | null;
    onFailure(response, body?.retry_after);
  } else if (!response.ok) {
    onFailure(response);
  } else if (provider === 'discord') {
    payload = await safeResponseJson(response);
  }
  return payload;
}

async function safeResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

export function notificationReceiptUrl(provider: string, payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  if (provider === 'telegram') {
    const result = value.result;
    if (typeof result !== 'object' || result === null) return null;
    const message = result as Record<string, unknown>;
    if (!Number.isSafeInteger(message.message_id) || (message.message_id as number) <= 0)
      return null;
    const chat = message.chat;
    if (typeof chat !== 'object' || chat === null) return null;
    const room = chat as Record<string, unknown>;
    if (
      (room.type === 'channel' || room.type === 'supergroup') &&
      typeof room.username === 'string' &&
      /^[A-Za-z0-9_]{5,32}$/.test(room.username)
    ) {
      return `https://t.me/${room.username}/${message.message_id}`;
    }
    if (
      room.type === 'supergroup' &&
      typeof room.id === 'number' &&
      Number.isSafeInteger(room.id) &&
      /^-100[0-9]+$/.test(String(room.id))
    ) {
      return `https://t.me/c/${String(room.id).slice(4)}/${message.message_id}`;
    }
  }
  if (provider === 'discord') {
    const id = value.id;
    const channelId = value.channel_id;
    const guildId = value.guild_id;
    if (
      typeof id === 'string' &&
      /^\d+$/.test(id) &&
      typeof channelId === 'string' &&
      /^\d+$/.test(channelId) &&
      (guildId === undefined || (typeof guildId === 'string' && /^\d+$/.test(guildId)))
    ) {
      return `https://discord.com/channels/${guildId ?? '@me'}/${channelId}/${id}`;
    }
  }
  return null;
}
