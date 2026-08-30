import { z } from 'zod';
import { regionIds } from '@uptime/regions';

export { regionIds, type RegionId } from '@uptime/regions';

export { calculateTargetChecksPerDay } from './estimate.js';

export const regionIdSchema = z.enum(regionIds);

export const intervalSecondsValues = [60, 300, 900, 1800, 3600] as const;
export const intervalSecondsSchema = z.union(
  intervalSecondsValues.map((value) => z.literal(value)) as [
    z.ZodLiteral<60>,
    z.ZodLiteral<300>,
    z.ZodLiteral<900>,
    z.ZodLiteral<1800>,
    z.ZodLiteral<3600>,
  ],
);
export type IntervalSeconds = z.infer<typeof intervalSecondsSchema>;

export const timeoutMsSchema = z.number().int().min(1_000).max(30_000);
export const httpUrlSchema = z
  .url()
  .refine(
    (url) => ['http:', 'https:'].includes(new URL(url).protocol),
    'URL must use HTTP or HTTPS',
  );

export const regionSelectionSchema = z
  .array(regionIdSchema)
  .min(1)
  .max(regionIds.length)
  .refine((values) => new Set(values).size === values.length, 'Regions must be unique');

const monitorFieldsSchema = z.object({
  name: z.string().trim().min(1).max(120).nullable().optional(),
  url: httpUrlSchema,
  regionIds: regionSelectionSchema,
  intervalSeconds: intervalSecondsSchema,
  timeoutMs: timeoutMsSchema,
  enabled: z.boolean().default(true),
  dnsDiagnosticsEnabled: z.boolean().default(false),
  isPublic: z.boolean().default(false),
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
  id: z.uuid(),
  name: z.string().nullable(),
  url: httpUrlSchema,
  regionIds: regionSelectionSchema,
  intervalSeconds: intervalSecondsSchema,
  timeoutMs: timeoutMsSchema,
  enabled: z.boolean(),
  dnsDiagnosticsEnabled: z.boolean().default(false),
  isPublic: z.boolean().default(false),
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

/**
 * The intentionally narrow monitor result used by unauthenticated share links.
 * It excludes request-level evidence and diagnostic data, which remain admin-only.
 */
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

export const publicMonitorSchema = monitorSchema.omit({ dnsDiagnosticsEnabled: true });
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

export const probeRequestSchema = z.object({
  requestId: z.uuid(),
  checkRunId: z.uuid(),
  monitorId: z.uuid(),
  windowStartedAt: z.iso.datetime({ offset: true }),
  issuedAt: z.iso.datetime({ offset: true }),
  regionId: regionIdSchema,
  url: httpUrlSchema,
  timeoutMs: timeoutMsSchema,
  method: z.literal('GET'),
  maxRedirects: z.literal(5),
  maxBodyBytes: z.literal(65_536),
  dnsDiagnostic: dnsDiagnosticInstructionSchema.nullable().optional(),
});
export type ProbeRequest = z.infer<typeof probeRequestSchema>;

export const probeResponseSchema = observationSchema
  .omit({ id: true, checkRunId: true, monitorId: true, completedAt: true })
  .extend({ completedAt: z.iso.datetime({ offset: true }) })
  .superRefine((response, context) => {
    let finalHostname: string | null = null;
    if (response.finalUrl) {
      try {
        finalHostname = new URL(response.finalUrl).hostname.toLowerCase();
      } catch {
        // finalUrl has already been checked by httpUrlSchema; keep this guard local.
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

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
