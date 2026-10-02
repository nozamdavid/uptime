import { regionIdSchema } from '@uptime/contracts';
import { parseRegionList } from '@uptime/regions';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const secret = z.string().min(32);
const envBoolean = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);
const workerUrlDomain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'must be a bare domain such as account.workers.dev',
  );
const regionList = z
  .string()
  .optional()
  .transform((value, context) => {
    try {
      return parseRegionList(value);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'REGIONS_LIST is invalid',
      });
      return z.NEVER;
    }
  });
// Match the unpadded PHC form emitted and accepted by the installed argon2 package.
const canonicalArgon2idPhc =
  /^\$argon2id\$v=19\$m=[1-9]\d*,t=[1-9]\d*,p=[1-9]\d*\$[A-Za-z0-9+/.-]+\$[A-Za-z0-9+/.-]+$/;

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export const apiEnvSchema = databaseEnvSchema.extend({
  REGIONS_LIST: regionList,
  API_HOST: nonEmpty.default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  API_TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
  SESSION_COOKIE_SECURE: envBoolean.default(false),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD_HASH: z
    .string()
    .regex(canonicalArgon2idPhc, 'must be a canonical unpadded Argon2id PHC string'),
  SESSION_SECRET: secret,
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(31_536_000).default(604_800),
});

export const schedulerEnvSchema = databaseEnvSchema.extend({
  REGIONS_LIST: regionList,
  PROBE_SIGNING_SECRET: secret,
  PROBE_REQUEST_MAX_SKEW_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
  WORKERS_URL_DOMAIN: workerUrlDomain,
  SCHEDULER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
  // Process-wide limit for concurrent Worker requests.
  SCHEDULER_MAX_CONCURRENT_PROBES: z.coerce.number().int().min(1).max(100).default(32),
  SCHEDULER_INSTANCE_ID: nonEmpty,
});

export const probeEnvSchema = z.object({
  PROBE_REGION: regionIdSchema,
  PROBE_SIGNING_SECRET: secret,
  PROBE_REQUEST_MAX_SKEW_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
  PROBE_MAX_REQUEST_BYTES: z.coerce.number().int().positive().max(65_536).default(65_536),
  PROBE_VERSION: nonEmpty,
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type SchedulerEnv = z.infer<typeof schedulerEnvSchema>;
export type ProbeEnv = z.infer<typeof probeEnvSchema>;

export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, unknown>,
): z.output<T> {
  return schema.parse(source);
}
