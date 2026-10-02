import { describe, expect, it, vi } from 'vitest';
import {
  DiscordNotificationProvider,
  TelegramNotificationProvider,
  NotificationDeliveryError,
} from './index.js';
import { discordConfigSchema } from '@uptime/contracts';

const message = {
  kind: 'outage',
  monitorName: '@everyone API',
  monitorUrl: 'https://example.com',
  occurredAt: '2026-09-16T12:00:00Z',
  outageStartedAt: '2026-09-16T11:58:00Z',
} as const;
const token = '123456:abcdefghijklmnopqrstuvwxyz';
const webhookUrl = 'https://discord.com/api/webhooks/123456/secret-token';

describe('notification provider classes', () => {
  it('uses Telegram sendMessage with plain text and no preview', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    await new TelegramNotificationProvider({ botToken: token, chatId: '-100123' }, fetchMock).send(
      message,
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      chat_id: '-100123',
      text: expect.stringContaining('OUTAGE'),
      link_preview_options: { is_disabled: true },
    });
    expect(init?.redirect).toBe('error');
  });
  it('waits for Discord confirmation and disables mentions', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: '123' }));
    await new DiscordNotificationProvider({ webhookUrl }, fetchMock).send(message);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${webhookUrl}?wait=true`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      allowed_mentions: { parse: [] },
    });
  });
  it('handles Telegram logical rejection even with HTTP 200', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: false, description: 'secret detail' }));
    await expect(
      new TelegramNotificationProvider({ botToken: token, chatId: '123' }, fetchMock).send(message),
    ).rejects.toMatchObject({ retryable: false });
  });
  it('preserves rate-limit timing without exposing provider response text', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ retry_after: 120, message: token }, { status: 429 }));
    await expect(
      new DiscordNotificationProvider({ webhookUrl }, fetchMock).send(message),
    ).rejects.toMatchObject({ retryable: true, retryAfterSeconds: 120 });
  });
  it('sanitizes network failures that contain credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(webhookUrl));
    await expect(
      new DiscordNotificationProvider({ webhookUrl }, fetchMock).send(message),
    ).rejects.toEqual(new NotificationDeliveryError(true));
  });
  it.each([
    'https://evil.test/api/webhooks/123/token',
    'http://discord.com/api/webhooks/123/token',
    'https://discord.com.evil.test/api/webhooks/123/token',
    'https://discord.com/api/webhooks/123/token?wait=false',
    'https://discord.com/api/webhooks/123/token/extra',
  ])('rejects unsafe webhook URL %s', (url) => {
    expect(discordConfigSchema.safeParse({ webhookUrl: url }).success).toBe(false);
  });
});
