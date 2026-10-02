import {
  blueskyConfigSchema,
  discordConfigSchema,
  gotifyConfigSchema,
  homeAssistantConfigSchema,
  resendConfigSchema,
  smtpConfigSchema,
  telegramConfigSchema,
  webhookConfigSchema,
  type NotificationProviderKind,
  type NotificationService,
} from './notifications.js';

const schemas = {
  telegram: telegramConfigSchema,
  discord: discordConfigSchema,
  resend: resendConfigSchema,
  gotify: gotifyConfigSchema,
  webhook: webhookConfigSchema,
  smtp: smtpConfigSchema,
  'home-assistant': homeAssistantConfigSchema,
  bluesky: blueskyConfigSchema,
};
const secretFields: Record<NotificationProviderKind, readonly string[]> = {
  telegram: ['botToken'],
  discord: ['webhookUrl'],
  resend: ['apiKey'],
  gotify: ['applicationToken'],
  webhook: ['webhookUrl', 'bearerToken'],
  smtp: ['password'],
  'home-assistant': ['accessToken'],
  bluesky: ['appPassword'],
};

export function providerConfigKeysAreValid(
  provider: NotificationProviderKind,
  config: Record<string, unknown>,
): boolean {
  const shape = schemas[provider].shape;
  return Object.keys(config).every((key) => Object.hasOwn(shape, key));
}

export function retainedSecret(next: unknown, current: unknown, trim = true): unknown {
  if (typeof next !== 'string') return current;
  const candidate = trim ? next.trim() : next;
  return candidate.length > 0 ? candidate : current;
}

/** Keep blank secrets, clear explicitly blank optional text, and validate the merged config. */
export function mergeProviderConfig(
  provider: NotificationProviderKind,
  current: Record<string, unknown>,
  update: unknown,
  invalidConfig: () => never,
): Record<string, unknown> {
  if (!update || typeof update !== 'object') return current;
  const next = update as Record<string, unknown>;
  if (!providerConfigKeysAreValid(provider, next)) invalidConfig();
  const merged = Object.fromEntries(
    Object.keys(schemas[provider].shape).map((key) => {
      let value = next[key] ?? current[key];
      if (secretFields[provider].includes(key)) {
        value = retainedSecret(next[key], current[key], key !== 'password');
      } else if ((key === 'subject' || key === 'username') && key in next) {
        value = typeof next[key] === 'string' ? next[key].trim() || undefined : next[key];
      }
      return [key, value];
    }),
  );
  const validated = schemas[provider].parse(merged);
  return Object.fromEntries(Object.entries(validated).filter(([, value]) => value !== undefined));
}

/** Explicit allowlists prevent stored credentials from entering API responses. */
export function publicProviderConfig(
  provider: NotificationProviderKind,
  config: Record<string, unknown>,
): NotificationService['config'] {
  switch (provider) {
    case 'telegram':
      return { chatId: valueString(config.chatId) };
    case 'resend':
      return {
        from: valueString(config.from),
        to: valueStringArray(config.to),
        ...optionalPublicString('subject', config.subject),
      };
    case 'gotify':
      return { serverUrl: valueString(config.serverUrl), priority: Number(config.priority) };
    case 'smtp':
      return {
        host: valueString(config.host),
        port: Number(config.port),
        security: config.security as 'tls' | 'starttls' | 'none',
        from: valueString(config.from),
        to: valueStringArray(config.to),
        ...optionalPublicString('username', config.username),
        ...optionalPublicString('subject', config.subject),
      };
    case 'home-assistant':
      return { serverUrl: valueString(config.serverUrl), service: valueString(config.service) };
    case 'bluesky':
      return { handle: valueString(config.handle) };
    case 'discord':
    case 'webhook':
      return {};
  }
}

function valueString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function valueStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function optionalPublicString<K extends 'subject' | 'username'>(
  key: K,
  value: unknown,
): Record<K, string> | Record<string, never> {
  return typeof value === 'string' ? ({ [key]: value } as Record<K, string>) : {};
}
