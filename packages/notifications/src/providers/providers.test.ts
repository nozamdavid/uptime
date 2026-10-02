import { describe, expect, it, vi } from 'vitest';
import type { NotificationProviderKind } from '@uptime/contracts';
import { createServer } from 'node:net';
import {
  createNotificationProvider,
  NotificationDeliveryError,
  ResendNotificationProvider,
  GotifyNotificationProvider,
  WebhookNotificationProvider,
  HomeAssistantNotificationProvider,
  SmtpNotificationProvider,
} from '../index.js';

const message = {
  kind: 'outage',
  monitorName: 'API',
  monitorUrl: 'https://example.com',
  occurredAt: '2026-09-16T12:00:00Z',
  outageStartedAt: '2026-09-16T11:58:00Z',
} as const;
const email = { from: 'uptime@example.com', to: ['ops@example.com', 'admin@example.com'] };
const configurations = [
  {
    kind: 'resend',
    config: { ...email, apiKey: 'secret-key' },
    provider: ResendNotificationProvider,
  },
  {
    kind: 'gotify',
    config: {
      serverUrl: 'http://gotify.local/push/',
      applicationToken: 'secret-token',
      priority: 0,
    },
    provider: GotifyNotificationProvider,
  },
  {
    kind: 'webhook',
    config: { webhookUrl: 'http://hooks.local/events?key=secret', bearerToken: 'secret-token' },
    provider: WebhookNotificationProvider,
  },
  {
    kind: 'home-assistant',
    config: {
      serverUrl: 'http://homeassistant.local:8123/',
      accessToken: 'secret-token',
      service: 'mobile_app_phone',
    },
    provider: HomeAssistantNotificationProvider,
  },
] as const;

describe('HTTP notification providers', () => {
  it('rejects unsupported Bluesky delivery without attempting a send', () => {
    expect(() =>
      createNotificationProvider('bluesky' as NotificationProviderKind, {}, fetch),
    ).toThrow('Unsupported notification provider: bluesky');
  });

  it.each(configurations)('registers and sends $kind', async ({ kind, config, provider }) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const instance = createNotificationProvider(kind, config, fetchMock);
    expect(instance).toBeInstanceOf(provider);
    await instance.send(message);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it('sends Resend email with bearer authentication and plain text', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'email-id' }));
    await new ResendNotificationProvider(
      { ...email, apiKey: 'secret-key', subject: 'Service incident' },
      fetchMock,
    ).send(message);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.resend.com/emails');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer secret-key',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      ...email,
      subject: 'Service incident',
      text: expect.stringContaining('OUTAGE'),
    });
  });

  it('keeps Gotify base paths and priority zero and puts its token in the header', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 1 }));
    await new GotifyNotificationProvider(configurations[1].config, fetchMock).send(message);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gotify.local/push/message');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-Gotify-Key': 'secret-token' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      priority: 0,
      title: 'Uptime',
    });
  });

  it('sends structured webhook events and optional bearer authentication', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await new WebhookNotificationProvider(configurations[2].config, fetchMock).send(message);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(configurations[2].config.webhookUrl);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer secret-token',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      ...message,
      text: expect.stringContaining('OUTAGE'),
    });
    await new WebhookNotificationProvider(
      { webhookUrl: 'https://hooks.example.com/events' },
      fetchMock,
    ).send({ ...message, kind: 'test' });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty('Authorization');
  });

  it('calls the configured Home Assistant notify service', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
    await new HomeAssistantNotificationProvider(configurations[3].config, fetchMock).send(message);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://homeassistant.local:8123/api/services/notify/mobile_app_phone',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer secret-token',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      title: 'Uptime',
      message: expect.stringContaining('OUTAGE'),
    });
  });

  it.each(configurations)(
    'sanitizes $kind failures and retains retry timing',
    async ({ kind, config }) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('secret', { status: 429, headers: { 'retry-after': '120' } }),
        );
      await expect(
        createNotificationProvider(kind, config, fetchMock).send(message),
      ).rejects.toEqual(new NotificationDeliveryError(true, 120));
      fetchMock.mockResolvedValue(new Response('secret', { status: 401 }));
      await expect(
        createNotificationProvider(kind, config, fetchMock).send(message),
      ).rejects.toEqual(new NotificationDeliveryError(false));
      fetchMock.mockRejectedValue(new Error('secret URL and token'));
      await expect(
        createNotificationProvider(kind, config, fetchMock).send(message),
      ).rejects.toEqual(new NotificationDeliveryError(true));
    },
  );
});

describe('SMTP notification provider', () => {
  const config = {
    ...email,
    host: 'localhost',
    port: 587,
    security: 'starttls',
    username: 'user',
    password: 'secret',
  };

  it.each([
    ['tls', true, false, false],
    ['starttls', false, true, false],
    ['none', false, false, true],
  ] as const)(
    'configures %s transport and closes it',
    async (security, secure, requireTLS, ignoreTLS) => {
      const transport = { sendMail: vi.fn().mockResolvedValue({ rejected: [] }), close: vi.fn() };
      const factory = vi.fn(() => transport);
      await new SmtpNotificationProvider({ ...config, security }, fetch, factory).send(message);
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          secure,
          requireTLS,
          ignoreTLS,
          tls: { rejectUnauthorized: true },
          auth: { user: 'user', pass: 'secret' },
          socketTimeout: 10_000,
        }),
      );
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ ...email, text: expect.stringContaining('OUTAGE') }),
      );
      expect(transport.close).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [{ responseCode: 450 }, true],
    [{ responseCode: 535, code: 'EAUTH' }, false],
    [{ responseCode: 454, code: 'EAUTH' }, true],
    [{ code: 'ETIMEDOUT' }, true],
    [{ code: 'ETLS' }, false],
  ])('classifies SMTP failures without exposing details', async (details, retryable) => {
    const transport = {
      sendMail: vi.fn().mockRejectedValue({ ...details, message: 'secret SMTP detail' }),
      close: vi.fn(),
    };
    await expect(
      new SmtpNotificationProvider(config, fetch, () => transport).send(message),
    ).rejects.toEqual(new NotificationDeliveryError(retryable));
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it('does not retry partial delivery and duplicate mail to accepted recipients', async () => {
    const transport = {
      sendMail: vi.fn().mockResolvedValue({ rejected: ['ops@example.com'] }),
      close: vi.fn(),
    };
    await expect(
      new SmtpNotificationProvider(config, fetch, () => transport).send(message),
    ).rejects.toEqual(new NotificationDeliveryError(false));
  });

  it('stops a stalled send at the overall deadline', async () => {
    vi.useFakeTimers();
    try {
      const transport = { sendMail: vi.fn(() => new Promise<{}>(() => {})), close: vi.fn() };
      const provider = new SmtpNotificationProvider(config, fetch, () => transport);
      const result = expect(provider.send(message)).rejects.toEqual(
        new NotificationDeliveryError(true),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(transport.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['none', 'starttls'] as const)(
    'uses %s with a real local SMTP server',
    async (security) => {
      const received: string[] = [];
      const server = createServer((socket) => {
        socket.setEncoding('utf8');
        socket.write('220 local test server\r\n');
        let buffer = '';
        let body = false;
        socket.on('data', (chunk) => {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf('\r\n')) !== -1) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (body && line !== '.') {
              received.push(line);
            } else if (body) {
              body = false;
              socket.write('250 queued\r\n');
            } else if (/^EHLO|^HELO/.test(line)) {
              socket.write('250 localhost\r\n');
            } else if (line === 'DATA') {
              body = true;
              socket.write('354 send data\r\n');
            } else if (line === 'QUIT') {
              socket.end('221 bye\r\n');
            } else if (line === 'STARTTLS') {
              socket.write('502 TLS unavailable\r\n');
            } else {
              socket.write('250 OK\r\n');
            }
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No local SMTP address');
        const delivery = createNotificationProvider('smtp', {
          ...email,
          host: '127.0.0.1',
          port: address.port,
          security,
        }).send(message);
        if (security === 'none') {
          await delivery;
          expect(received.join('\n')).toContain('OUTAGE');
          expect(received.join('\n')).toContain('To: ops@example.com, admin@example.com');
        } else {
          await expect(delivery).rejects.toEqual(new NotificationDeliveryError(false));
          expect(received).toEqual([]);
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
