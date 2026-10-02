import { describe, expect, it } from 'vitest';

import {
  blueskyConfigSchema,
  gotifyConfigSchema,
  homeAssistantConfigSchema,
  notificationServiceCreateSchema,
  resendConfigSchema,
  smtpConfigSchema,
  webhookConfigSchema,
} from './notifications.js';

describe('notification provider contracts', () => {
  it('normalizes supported Bluesky handles and requires an app password', () => {
    expect(
      blueskyConfigSchema.parse({ handle: ' @Ops.Custom-Domain.Example ', appPassword: 'secret' }),
    ).toEqual({ handle: 'ops.custom-domain.example', appPassword: 'secret' });
    expect(blueskyConfigSchema.safeParse({ handle: 'no dot', appPassword: 'secret' }).success).toBe(
      false,
    );
    expect(
      blueskyConfigSchema.safeParse({ handle: 'ops.example.com', appPassword: ' ' }).success,
    ).toBe(false);
  });

  it('applies provider defaults', () => {
    expect(
      gotifyConfigSchema.parse({
        serverUrl: 'https://push.example.com/gotify',
        applicationToken: 'secret',
      }).priority,
    ).toBe(8);
    expect(
      smtpConfigSchema.parse({
        host: 'smtp.example.com',
        port: 587,
        from: 'uptime@example.com',
        to: ['ops@example.com'],
      }).security,
    ).toBe('starttls');
    expect(
      homeAssistantConfigSchema.parse({
        serverUrl: 'http://homeassistant.local:8123',
        accessToken: 'secret',
      }).service,
    ).toBe('notify');
  });

  it('accepts provider-specific valid configurations', () => {
    expect(
      resendConfigSchema.safeParse({
        apiKey: 're_secret',
        from: 'uptime@example.com',
        to: ['one@example.com', 'two@example.com'],
        subject: 'Service status',
      }).success,
    ).toBe(true);
    expect(
      webhookConfigSchema.safeParse({
        webhookUrl: 'https://hooks.example.com/uptime?environment=production',
        bearerToken: 'secret',
      }).success,
    ).toBe(true);
  });

  it('rejects unsafe URLs and unrelated provider fields', () => {
    expect(() =>
      gotifyConfigSchema.safeParse({ serverUrl: 'not-a-url', applicationToken: 'secret' }),
    ).not.toThrow();
    expect(
      gotifyConfigSchema.safeParse({ serverUrl: 'not-a-url', applicationToken: 'secret' }).success,
    ).toBe(false);
    expect(
      gotifyConfigSchema.safeParse({
        serverUrl: 'https://user:pass@push.example.com/?secret=1',
        applicationToken: 'secret',
      }).success,
    ).toBe(false);
    expect(
      webhookConfigSchema.safeParse({
        webhookUrl: 'https://hooks.example.com/uptime#secret',
      }).success,
    ).toBe(false);
    expect(
      notificationServiceCreateSchema.safeParse({
        name: 'Resend',
        provider: 'resend',
        config: {
          apiKey: 're_secret',
          from: 'uptime@example.com',
          to: ['ops@example.com'],
          priority: 8,
        },
      }).success,
    ).toBe(false);
  });

  it('enforces email recipient and SMTP port limits', () => {
    expect(resendConfigSchema.safeParse({ apiKey: 'secret', from: 'bad', to: [] }).success).toBe(
      false,
    );
    expect(
      smtpConfigSchema.safeParse({
        host: 'smtp.example.com',
        port: 65_536,
        from: 'uptime@example.com',
        to: ['ops@example.com'],
      }).success,
    ).toBe(false);
    expect(
      resendConfigSchema.parse({
        apiKey: 'secret',
        from: ' uptime@example.com ',
        to: [' ops@example.com '],
      }),
    ).toMatchObject({ from: 'uptime@example.com', to: ['ops@example.com'] });
  });
});
