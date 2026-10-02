import { z } from 'zod';
import { regionIds } from '@uptime/regions';
import { monitorNotificationFields } from './notifications.js';

export * from './notifications.js';
export * from './notification-config.js';
export * from './notification-history.js';
export * from './monitor-summary.js';
export * from './uptime.js';
export * from './notification-state.js';
export * from './ip-policy.js';
export * from './report-types.js';

export { regionIds, type RegionId } from '@uptime/regions';

export { calculateTargetChecksPerDay } from './estimate.js';

export const regionIdSchema = z.enum(regionIds);

export const intervalSecondsValues = [
  60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 1_200, 1_500, 1_800,
  2_100, 2_400, 2_700, 3_000, 3_300, 3_600,
] as const;
export type IntervalSeconds = (typeof intervalSecondsValues)[number];

/** Slider presets shared by the monitor editor; the source of truth for allowed intervals. */
export const checkIntervalPresets: readonly IntervalSeconds[] = intervalSecondsValues;
/** Bounds shared by the monitor editor and the timeout schema below. */
export const timeoutConstraints = Object.freeze({ minimumMs: 1_000, maximumMs: 30_000 });
export const intervalSecondsSchema = z.custom<IntervalSeconds>(
  (value) => typeof value === 'number' && intervalSecondsValues.includes(value as IntervalSeconds),
  'Check frequency must be 1–15 minutes or a 5-minute increment up to 60 minutes',
);

export const timeoutMsSchema = z.number().int().min(1_000).max(30_000);
export const httpUrlSchema = z
  .url()
  .refine(
    (url) => ['http:', 'https:'].includes(new URL(url).protocol),
    'URL must use HTTP or HTTPS',
  );

export function normalizeMonitorUrl(value: string) {
  const trimmed = value.trim();
  return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const monitorInputUrlSchema = z.string().transform(normalizeMonitorUrl).pipe(httpUrlSchema);

export const badgeSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});
export type Badge = z.infer<typeof badgeSchema>;
export const badgeCreateSchema = badgeSchema.pick({ name: true });
export type BadgeCreate = z.infer<typeof badgeCreateSchema>;

export const uptimeThresholdsSchema = z
  .object({
    green: z.number().min(0).max(100).default(99.5),
    lightGreen: z.number().min(0).max(100).default(99),
    orange: z.number().min(0).max(100).default(90),
  })
  .refine(
    ({ green, lightGreen, orange }) => orange <= lightGreen && lightGreen <= green,
    'Uptime thresholds must descend from green to orange',
  );
export type UptimeThresholds = z.infer<typeof uptimeThresholdsSchema>;
export const defaultUptimeThresholds: UptimeThresholds = {
  green: 99.5,
  lightGreen: 99,
  orange: 90,
};

export function normalizePublicMonitorSlug(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

export const publicMonitorSlugSchema = z
  .string()
  .transform(normalizePublicMonitorSlug)
  .pipe(
    z
      .string()
      .min(3, 'Public slug must be at least 3 characters')
      .max(64, 'Public slug must be at most 64 characters')
      .regex(
        /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/,
        'Public slug can contain lowercase letters, numbers, dots, and single hyphens',
      ),
  )
  .refine((value) => !z.uuid().safeParse(value).success, 'Public slug cannot be a UUID');
export const publicStatusPageSlugSchema = publicMonitorSlugSchema;

export const regionSelectionSchema = z
  .array(regionIdSchema)
  .min(1)
  .max(regionIds.length)
  .refine((values) => new Set(values).size === values.length, 'Regions must be unique');

const monitorFieldsSchema = z.object({
  ...monitorNotificationFields,
  name: z.string().trim().min(1).max(120).nullable().optional(),
  url: monitorInputUrlSchema,
  regionIds: regionSelectionSchema,
  intervalSeconds: intervalSecondsSchema,
  timeoutMs: timeoutMsSchema,
  enabled: z.boolean().default(true),
  dnsDiagnosticsEnabled: z.boolean().default(false),
  isPublic: z.boolean().default(false),
  publicSlug: z.union([publicMonitorSlugSchema, z.null()]).optional(),
  badgeId: z.union([z.uuid(), z.null()]).optional(),
  uptimeThresholds: uptimeThresholdsSchema.optional(),
});

export const monitorCreateSchema = monitorFieldsSchema.superRefine((value, context) => {
  if (value.timeoutMs >= value.intervalSeconds * 1_000) {
    context.addIssue({
      code: 'custom',
      path: ['timeoutMs'],
      message: 'Timeout must be shorter than the check interval',
    });
  }
});
export type MonitorCreate = z.infer<typeof monitorCreateSchema>;

export const monitorUpdateSchema = monitorFieldsSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export type MonitorUpdate = z.infer<typeof monitorUpdateSchema>;

export const monitorBulkFrequencyUpdateSchema = z.object({
  monitorIds: z.array(z.uuid()).min(1).max(100),
  intervalSeconds: intervalSecondsSchema,
});
export type MonitorBulkFrequencyUpdate = z.infer<typeof monitorBulkFrequencyUpdateSchema>;

export const monitorBulkBadgeUpdateSchema = z.object({
  monitorIds: z.array(z.uuid()).min(1).max(100),
  badgeId: z.union([z.uuid(), z.null()]),
});
export type MonitorBulkBadgeUpdate = z.infer<typeof monitorBulkBadgeUpdateSchema>;

export const statusPageGroupInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  monitorIds: z.array(z.uuid()),
  width: z.enum(['full', 'half']).default('full'),
  showBadges: z.boolean().default(true),
});
export const statusPageSaveSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    publicSlug: z.union([publicStatusPageSlugSchema, z.null()]).optional(),
    groups: z.array(statusPageGroupInputSchema).max(20),
  })
  .superRefine((value, context) => {
    const monitorIds = value.groups.flatMap((group) => group.monitorIds);
    if (new Set(monitorIds).size !== monitorIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['groups'],
        message: 'A monitor can appear only once on a status page',
      });
    }
  });
export type StatusPageSave = z.infer<typeof statusPageSaveSchema>;

export const estimateRequestSchema = z.object({
  regionIds: regionSelectionSchema,
  intervalSeconds: intervalSecondsSchema,
});
export type EstimateRequest = z.infer<typeof estimateRequestSchema>;

export const estimateResponseSchema = z.object({
  regionCount: z.number().int().min(1),
  intervalSeconds: intervalSecondsSchema,
  targetChecksPerDay: z.number().int().positive(),
  excludes: z.array(z.enum(['redirects', 'manual-checks'])),
});
export type EstimateResponse = z.infer<typeof estimateResponseSchema>;

export const runStatusSchema = z.enum(['pending', 'complete', 'partial']);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const observationStatusSchema = z.enum(['success', 'http_failure', 'network_failure']);
export type ObservationStatus = z.infer<typeof observationStatusSchema>;
export const observationErrorCodeSchema = z.enum([
  'timeout',
  'dns',
  'connection',
  'tls',
  'redirect_limit',
  'response_too_large',
  'invalid_response',
  'probe_rejected',
  'probe_unreachable',
  'unknown',
]);
export type ObservationErrorCode = z.infer<typeof observationErrorCodeSchema>;
export const aggregateStatusSchema = z.enum(['up', 'degraded', 'down', 'unknown']);
export type AggregateStatus = z.infer<typeof aggregateStatusSchema>;

export const endpointSignalNameSchema = z.enum([
  'cf-ray',
  'cf-cache-status',
  'x-amz-cf-pop',
  'x-cache',
  'x-served-by',
  'x-cache-hits',
  'x-vercel-id',
  'server',
  'via',
]);
export type EndpointSignalName = z.infer<typeof endpointSignalNameSchema>;

export const endpointSignalSchema = z.object({
  name: endpointSignalNameSchema,
  value: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[\x20-\x7e]+$/),
});
export type EndpointSignal = z.infer<typeof endpointSignalSchema>;

export const cdnProviderSchema = z.enum(['cloudflare', 'cloudfront', 'fastly', 'vercel']);
export type CdnProvider = z.infer<typeof cdnProviderSchema>;

export const cdnEvidenceHeaderSchema = z.enum([
  'cf-ray',
  'x-amz-cf-pop',
  'x-served-by',
  'x-vercel-id',
]);
export type CdnEvidenceHeader = z.infer<typeof cdnEvidenceHeaderSchema>;

export const endpointContinentSchema = z.enum([
  'africa',
  'asia',
  'europe',
  'north_america',
  'oceania',
  'south_america',
]);
export type EndpointContinent = z.infer<typeof endpointContinentSchema>;

export const parsedCdnEvidenceSchema = z.object({
  provider: cdnProviderSchema,
  reportedEdge: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[A-Za-z0-9-]+$/),
  inferredContinent: endpointContinentSchema.nullable(),
  confidence: z.literal('provider_reported'),
  evidenceHeader: cdnEvidenceHeaderSchema,
  parserVersion: z.string().min(1).max(32),
});
export type ParsedCdnEvidence = z.infer<typeof parsedCdnEvidenceSchema>;

export const endpointEvidenceSchema = z.object({
  finalHostname: z.string().min(1).max(253),
  signals: z
    .array(endpointSignalSchema)
    .max(10)
    .refine(
      (signals) => new Set(signals.map((signal) => signal.name)).size === signals.length,
      'Endpoint signal names must be unique',
    ),
  primaryCdn: parsedCdnEvidenceSchema.nullable(),
});
export type EndpointEvidence = z.infer<typeof endpointEvidenceSchema>;

export const monitorSchema = z.object({
  ...monitorNotificationFields,
  id: z.uuid(),
  name: z.string().nullable(),
  url: httpUrlSchema,
  regionIds: regionSelectionSchema,
  intervalSeconds: intervalSecondsSchema,
  timeoutMs: timeoutMsSchema,
  enabled: z.boolean(),
  dnsDiagnosticsEnabled: z.boolean().default(false),
  isPublic: z.boolean().default(false),
  publicSlug: publicMonitorSlugSchema.nullable().default(null),
  badge: badgeSchema.nullable().optional(),
  uptimeThresholds: uptimeThresholdsSchema.optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Monitor = z.infer<typeof monitorSchema>;

export const dnsDiagnosticInstructionSchema = z.object({
  diagnosticId: z.uuid(),
  windowStartedAt: z.iso.datetime({ offset: true }),
  deadlineMs: z.number().int().min(100).max(2_000),
});
export type DnsDiagnosticInstruction = z.infer<typeof dnsDiagnosticInstructionSchema>;

export const dnsDiagnosticErrorCodeSchema = z.enum([
  'timeout',
  'resolver_failure',
  'invalid_hostname',
]);
export type DnsDiagnosticErrorCode = z.infer<typeof dnsDiagnosticErrorCodeSchema>;

export const dnsCandidateSchema = z.object({
  address: z.string().min(2).max(45),
  ttl: z.number().int().min(0).max(604_800),
});
export type DnsCandidate = z.infer<typeof dnsCandidateSchema>;

export const dnsDiagnosticResultSchema = z.object({
  diagnosticId: z.uuid(),
  windowStartedAt: z.iso.datetime({ offset: true }),
  finalHostname: z.string().min(1).max(253),
  resolver: z.literal('cloudflare-doh'),
  observedAt: z.iso.datetime({ offset: true }),
  status: z.enum(['success', 'partial', 'failed']),
  cnameCandidates: z.array(z.string().min(1).max(253)).max(8),
  aCandidates: z.array(dnsCandidateSchema).max(8),
  aaaaCandidates: z.array(dnsCandidateSchema).max(8),
  filteredAddressCount: z.number().int().nonnegative(),
  errorCode: dnsDiagnosticErrorCodeSchema.nullable(),
  schemaVersion: z.literal('1'),
  parserVersion: z.literal('1'),
});
export type DnsDiagnosticResult = z.infer<typeof dnsDiagnosticResultSchema>;

export const observationSchema = z.object({
  id: z.uuid(),
  checkRunId: z.uuid(),
  monitorId: z.uuid(),
  regionId: regionIdSchema,
  status: observationStatusSchema,
  success: z.boolean(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  responseMs: z.number().nonnegative().nullable(),
  totalMs: z.number().nonnegative().nullable(),
  errorCode: observationErrorCodeSchema.nullable(),
  errorDetail: z.string().nullable(),
  placement: z.string().nullable(),
  colo: z.string().nullable(),
  finalUrl: httpUrlSchema.nullable(),
  endpointEvidence: endpointEvidenceSchema.nullable(),
  dnsDiagnostic: dnsDiagnosticResultSchema.nullable().default(null),
  redirectCount: z.number().int().min(0).max(5).nullable(),
  bodyBytes: z.number().int().nonnegative().nullable(),
  probeVersion: z.string().nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Observation = z.infer<typeof observationSchema>;

export const monitorSummarySchema = z.object({
  monitor: monitorSchema,
  status: aggregateStatusSchema,
  latestByRegion: z.record(regionIdSchema, observationSchema.nullable()),
  targetChecksPerDay: z.number().int().positive(),
});
export type MonitorSummary = z.infer<typeof monitorSummarySchema>;

/** Public monitor data; request evidence and diagnostics remain admin-only. */
export const publicLatestObservationSchema = z.object({
  regionId: regionIdSchema,
  status: observationStatusSchema,
  success: z.boolean(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  responseMs: z.number().nonnegative().nullable(),
  totalMs: z.number().nonnegative().nullable(),
  errorCode: observationErrorCodeSchema.nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type PublicLatestObservation = z.infer<typeof publicLatestObservationSchema>;

export const publicMonitorSchema = monitorSchema.omit({
  dnsDiagnosticsEnabled: true,
  notificationServiceIds: true,
  outageThreshold: true,
  recoveryThreshold: true,
  repeatNotificationMinutes: true,
});
export type PublicMonitor = z.infer<typeof publicMonitorSchema>;

export const publicMonitorSummarySchema = z.object({
  monitor: publicMonitorSchema,
  status: aggregateStatusSchema,
  latestByRegion: z.record(regionIdSchema, publicLatestObservationSchema.nullable()),
  targetChecksPerDay: z.number().int().positive(),
});
export type PublicMonitorSummary = z.infer<typeof publicMonitorSummarySchema>;

export const latencyPointSchema = z.object({
  observedAt: z.iso.datetime({ offset: true }),
  regionId: regionIdSchema,
  responseMs: z.number().nonnegative().nullable(),
  success: z.boolean(),
});
export const latencyStatsSchema = z.object({
  regionId: regionIdSchema,
  sampleCount: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  p50Ms: z.number().nonnegative().nullable(),
  p95Ms: z.number().nonnegative().nullable(),
  p99Ms: z.number().nonnegative().nullable(),
});

export const probeBatchSize = 5;

export const probeItemSchema = z.object({
  checkRunId: z.uuid(),
  monitorId: z.uuid(),
  windowStartedAt: z.iso.datetime({ offset: true }),
  url: httpUrlSchema,
  timeoutMs: timeoutMsSchema,
  method: z.literal('GET'),
  maxRedirects: z.literal(5),
  maxBodyBytes: z.literal(65_536),
  dnsDiagnostic: dnsDiagnosticInstructionSchema.nullable().optional(),
});
export type ProbeItem = z.infer<typeof probeItemSchema>;

export const probeRequestSchema = probeItemSchema.extend({
  requestId: z.uuid(),
  issuedAt: z.iso.datetime({ offset: true }),
  regionId: regionIdSchema,
});
export type ProbeRequest = z.infer<typeof probeRequestSchema>;

export const probeBatchRequestSchema = z.object({
  requestId: z.uuid(),
  issuedAt: z.iso.datetime({ offset: true }),
  regionId: regionIdSchema,
  items: z.array(probeItemSchema).min(1).max(probeBatchSize),
});
export type ProbeBatchRequest = z.infer<typeof probeBatchRequestSchema>;

export const probeResponseSchema = observationSchema
  .omit({ id: true, checkRunId: true, monitorId: true, completedAt: true })
  .extend({ completedAt: z.iso.datetime({ offset: true }) })
  .superRefine((response, context) => {
    let finalHostname: string | null = null;
    if (response.finalUrl) {
      try {
        finalHostname = new URL(response.finalUrl).hostname.toLowerCase();
      } catch {
        // `finalUrl` was already checked by `httpUrlSchema`.
      }
    }
    if (response.endpointEvidence && finalHostname !== response.endpointEvidence.finalHostname) {
      context.addIssue({
        code: 'custom',
        path: ['endpointEvidence', 'finalHostname'],
        message: 'Endpoint evidence hostname must match the final URL',
      });
    }
    if (response.dnsDiagnostic && finalHostname !== response.dnsDiagnostic.finalHostname) {
      context.addIssue({
        code: 'custom',
        path: ['dnsDiagnostic', 'finalHostname'],
        message: 'DNS diagnostic hostname must match the final URL',
      });
    }
  });
export type ProbeResponse = z.infer<typeof probeResponseSchema>;

export const probeBatchResponseSchema = z.object({
  requestId: z.uuid(),
  regionId: regionIdSchema,
  results: z
    .array(
      z.object({
        checkRunId: z.uuid(),
        monitorId: z.uuid(),
        response: z.unknown(),
      }),
    )
    .max(probeBatchSize),
});
export type ProbeBatchResponse = z.infer<typeof probeBatchResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
