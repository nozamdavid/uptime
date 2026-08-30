import { regionIdSchema } from '@uptime/contracts';
import { regions, type RegionEndpointEnvName } from '@uptime/regions';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const httpUrl = z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol));
const secret = z.string().min(32);
const envBoolean = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);
type RegionEndpointEnvShape = { readonly [Name in RegionEndpointEnvName]: typeof httpUrl };
const regionEndpointEnvShape = Object.fromEntries(
  regions.map((region) => [region.endpointEnvName, httpUrl]),
) as RegionEndpointEnvShape;
// `@phc/format`, used by the installed argon2 package, only accepts the
// unpadded base64 form emitted by argon2.hash(). A startsWith check would allow
// padded values that crash later when a user tries to log in.
const canonicalArgon2idPhc =
  /^\$argon2id\$v=19\$m=[1-9]\d*,t=[1-9]\d*,p=[1-9]\d*\$[A-Za-z0-9+/.-]+\$[A-Za-z0-9+/.-]+$/;

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export const apiEnvSchema = databaseEnvSchema.extend({
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
  PROBE_SIGNING_SECRET: secret,
  PROBE_REQUEST_MAX_SKEW_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
  ...regionEndpointEnvShape,
  SCHEDULER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
  // This is a process-wide cap for a scheduler tick. It bounds outbound Worker
  // requests when many monitors are due at once without constraining a monitor
  // to run its selected regions serially.
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
