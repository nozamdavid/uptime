import { z } from 'zod';

export const notificationProviderSchema = z.enum([
  'telegram',
  'discord',
  'resend',
  'gotify',
  'webhook',
  'smtp',
  'home-assistant',
  'bluesky',
]);
export type NotificationProviderKind = z.infer<typeof notificationProviderSchema>;

const requiredSecretSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !/[\r\n]/.test(value), 'Secret cannot contain line breaks');
const optionalSecretSchema = requiredSecretSchema.optional();
const optionalPasswordSchema = z.string().min(1).max(4_096).optional();
const emailSchema = z.string().trim().pipe(z.email().max(320));
const recipientsSchema = z.array(emailSchema).min(1).max(50);
const subjectSchema = z
  .string()
  .trim()
  .max(200)
  .transform((value) => value || undefined)
  .optional();

function isHttpUrl(value: string, allowQuery: boolean) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (allowQuery || !url.search)
    );
  } catch {
    return false;
  }
}
const serverUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .pipe(z.url())
  .refine((value) => isHttpUrl(value, false), 'Enter a valid HTTP(S) server URL');
const genericWebhookUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .pipe(z.url())
  .refine(
    (value) => isHttpUrl(value, true),
    'Enter a valid HTTP(S) webhook URL without credentials or a fragment',
  );

export const telegramConfigSchema = z
  .object({
    botToken: z
      .string()
      .trim()
      .regex(/^\d+:[A-Za-z0-9_-]{20,200}$/, 'Enter a valid Telegram bot token'),
    chatId: z
      .string()
      .trim()
      .regex(/^(?:-?\d+|@[A-Za-z][A-Za-z0-9_]{4,})$/, 'Enter a chat ID or channel username'),
  })
  .strict();
export const discordConfigSchema = z
  .object({
    webhookUrl: z
      .string()
      .trim()
      .max(2_048)
      .pipe(z.url())
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          url.hostname === 'discord.com' &&
          !url.port &&
          !url.username &&
          !url.password &&
          !url.hash &&
          !url.search &&
          /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)
        );
      }, 'Use an HTTPS Discord webhook URL from discord.com'),
  })
  .strict();
export const resendConfigSchema = z
  .object({
    apiKey: requiredSecretSchema,
    from: emailSchema,
    to: recipientsSchema,
    subject: subjectSchema,
  })
  .strict();
export const gotifyConfigSchema = z
  .object({
    serverUrl: serverUrlSchema,
    applicationToken: requiredSecretSchema,
    priority: z.number().int().min(0).max(10).default(8),
  })
  .strict();
export const webhookConfigSchema = z
  .object({
    webhookUrl: genericWebhookUrlSchema,
    bearerToken: optionalSecretSchema,
  })
  .strict();
export const smtpConfigSchema = z
  .object({
    host: z.string().trim().min(1).max(253).regex(/^\S+$/, 'Host cannot contain whitespace'),
    port: z.number().int().min(1).max(65_535),
    security: z.enum(['tls', 'starttls', 'none']).default('starttls'),
    username: z
      .string()
      .trim()
      .max(320)
      .transform((value) => value || undefined)
      .optional(),
    password: optionalPasswordSchema,
    from: emailSchema,
    to: recipientsSchema,
    subject: subjectSchema,
  })
  .strict();
export const homeAssistantConfigSchema = z
  .object({
    serverUrl: serverUrlSchema,
    accessToken: requiredSecretSchema,
    service: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/, 'Use a lowercase Home Assistant service slug')
      .default('notify'),
  })
  .strict();
export const blueskyConfigSchema = z
  .object({
    handle: z
      .string()
      .trim()
      .toLowerCase()
      .transform((value) => (value.startsWith('@') ? value.slice(1) : value))
      .pipe(
        z
          .string()
          .max(253)
          .regex(
            /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
            'Enter a valid Bluesky handle',
          ),
      ),
    appPassword: requiredSecretSchema,
  })
  .strict();

const serviceFields = {
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
};
export const notificationServiceCreateSchema = z.discriminatedUnion('provider', [
  z.object({ ...serviceFields, provider: z.literal('telegram'), config: telegramConfigSchema }),
  z.object({ ...serviceFields, provider: z.literal('discord'), config: discordConfigSchema }),
  z.object({ ...serviceFields, provider: z.literal('resend'), config: resendConfigSchema }),
  z.object({ ...serviceFields, provider: z.literal('gotify'), config: gotifyConfigSchema }),
  z.object({ ...serviceFields, provider: z.literal('webhook'), config: webhookConfigSchema }),
  z.object({ ...serviceFields, provider: z.literal('smtp'), config: smtpConfigSchema }),
  z.object({
    ...serviceFields,
    provider: z.literal('home-assistant'),
    config: homeAssistantConfigSchema,
  }),
  z.object({ ...serviceFields, provider: z.literal('bluesky'), config: blueskyConfigSchema }),
]);
export type NotificationServiceCreate = z.infer<typeof notificationServiceCreateSchema>;

export const notificationServiceUpdateSchema = z
  .object({
    name: serviceFields.name.optional(),
    enabled: z.boolean().optional(),
    config: z
      .object({
        botToken: z.string().trim().max(220).optional(),
        chatId: z.string().trim().max(120).optional(),
        webhookUrl: z.string().trim().max(2_048).optional(),
        apiKey: z.string().trim().max(4_096).optional(),
        from: z.string().trim().max(320).optional(),
        to: z.array(z.string().trim().max(320)).max(50).optional(),
        subject: z.string().trim().max(200).optional(),
        serverUrl: z.string().trim().max(2_048).optional(),
        applicationToken: z.string().trim().max(4_096).optional(),
        priority: z.number().int().min(0).max(10).optional(),
        bearerToken: z.string().trim().max(4_096).optional(),
        host: z.string().trim().max(253).optional(),
        port: z.number().int().min(1).max(65_535).optional(),
        security: z.enum(['tls', 'starttls', 'none']).optional(),
        username: z.string().trim().max(320).optional(),
        password: z.string().max(4_096).optional(),
        accessToken: z.string().trim().max(4_096).optional(),
        service: z.string().trim().max(64).optional(),
        handle: z.string().trim().max(253).optional(),
        appPassword: z.string().max(4_096).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export type NotificationServiceUpdate = z.infer<typeof notificationServiceUpdateSchema>;

export const notificationServiceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provider: notificationProviderSchema,
  enabled: z.boolean(),
  config: z.object({
    chatId: z.string().optional(),
    from: z.string().optional(),
    to: z.array(z.string()).optional(),
    subject: z.string().optional(),
    serverUrl: z.string().optional(),
    priority: z.number().optional(),
    host: z.string().optional(),
    port: z.number().optional(),
    security: z.enum(['tls', 'starttls', 'none']).optional(),
    username: z.string().optional(),
    service: z.string().optional(),
    handle: z.string().optional(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NotificationService = z.infer<typeof notificationServiceSchema>;

export const monitorNotificationFields = {
  notificationServiceIds: z
    .array(z.uuid())
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Services must be unique')
    .optional(),
  outageThreshold: z.number().int().min(1).max(100).optional(),
  recoveryThreshold: z.number().int().min(1).max(100).optional(),
  repeatNotificationMinutes: z.number().int().min(1).max(10_080).nullable().optional(),
};

export interface NotificationMessage {
  kind: 'outage' | 'recovery' | 'reminder' | 'test';
  monitorName: string;
  monitorUrl: string;
  occurredAt: string;
  outageStartedAt: string | null;
}
