import {
  dnsDiagnosticResultSchema,
  probeBatchResponseSchema,
  probeBatchSize,
  probeResponseSchema,
  type DnsDiagnosticResult,
  type ProbeItem,
  type ProbeResponse,
} from '@uptime/contracts';
import type { RegionId } from '@uptime/regions';
import type { DueRound } from '@uptime/cloudflare';

import { signProbeRequestBody, type SignedProbeRequest } from './signing.js';
import type { CoordinatorConfig } from './env.js';

export const dnsDiagnosticDeadlineMs = 2_000;

export type DiagnosticDisposition =
  { kind: 'missing' } | { kind: 'invalid' } | { kind: 'complete'; result: DnsDiagnosticResult };

export interface ParsedProbeResponse {
  observation: ProbeResponse;
  diagnostic: DiagnosticDisposition;
}

export interface ReservedDiagnostic {
  id: string;
  regionId: RegionId;
  windowStartedAt: string;
}

export interface ProbeTask {
  readonly round: DueRound;
  readonly regionId: RegionId;
  readonly reserved: ReservedDiagnostic | undefined;
  readonly item: ProbeItem;
}

export interface RegionalProbeBatch {
  readonly regionId: RegionId;
  readonly tasks: ProbeTask[];
}

/** Resolve a logical region from its canonical Worker name and the shared domain suffix. */
export function probeEndpointFor(config: CoordinatorConfig, regionId: RegionId): string {
  const workerName = `${config.probeWorkerNamePrefix ?? 'uptime-probe-'}${regionId}`;
  return `https://${workerName}.${config.workersUrlDomain}`;
}

export function buildProbeItem(
  round: DueRound,
  reserved: ReservedDiagnostic | undefined,
): ProbeItem {
  return {
    checkRunId: round.id,
    monitorId: round.monitorId,
    windowStartedAt: round.windowStartedAt,
    url: round.monitorUrl,
    timeoutMs: round.timeoutMs,
    method: 'GET',
    maxRedirects: 5,
    maxBodyBytes: 65_536,
    ...(reserved
      ? {
          dnsDiagnostic: {
            diagnosticId: reserved.id,
            windowStartedAt: reserved.windowStartedAt,
            deadlineMs: dnsDiagnosticDeadlineMs,
          },
        }
      : {}),
  };
}

export function probeTaskKey(task: ProbeTask): string {
  return `${task.item.checkRunId}:${task.item.monitorId}`;
}

export function probeResultKey(result: { checkRunId: string; monitorId: string }): string {
  return `${result.checkRunId}:${result.monitorId}`;
}

/** Group tasks by region and split each region into the probe's bounded batch size. */
export function regionalProbeBatches(tasks: readonly ProbeTask[]): RegionalProbeBatch[] {
  const byRegion = new Map<RegionId, ProbeTask[]>();
  for (const task of tasks) {
    const regional = byRegion.get(task.regionId) ?? [];
    regional.push(task);
    byRegion.set(task.regionId, regional);
  }
  const batches: RegionalProbeBatch[] = [];
  for (const [regionId, regional] of byRegion) {
    for (let index = 0; index < regional.length; index += probeBatchSize) {
      batches.push({ regionId, tasks: regional.slice(index, index + probeBatchSize) });
    }
  }
  return batches;
}

export function signBatchRequest(
  config: CoordinatorConfig,
  batch: RegionalProbeBatch,
  now: Date,
): Promise<SignedProbeRequest> {
  return signProbeRequestBody(
    (requestId, issuedAt) => ({
      requestId,
      issuedAt,
      regionId: batch.regionId,
      items: batch.tasks.map((task) => task.item),
    }),
    config.probeSigningSecret,
    now,
  );
}

/** Parse optional diagnostics without turning diagnostic failures into target outages. */
export function parseProbeResponseDetails(payload: unknown): ParsedProbeResponse {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const core = probeResponseSchema.parse({
      ...record,
      endpointEvidence: Object.hasOwn(record, 'endpointEvidence') ? record.endpointEvidence : null,
      dnsDiagnostic: null,
    });
    if (!Object.hasOwn(record, 'dnsDiagnostic') || record.dnsDiagnostic === null) {
      return { observation: core, diagnostic: { kind: 'missing' } };
    }
    const diagnostic = dnsDiagnosticResultSchema.safeParse(record.dnsDiagnostic);
    if (!diagnostic.success) return { observation: core, diagnostic: { kind: 'invalid' } };
    const combined = probeResponseSchema.safeParse({ ...record, dnsDiagnostic: diagnostic.data });
    if (!combined.success) return { observation: core, diagnostic: { kind: 'invalid' } };
    return { observation: core, diagnostic: { kind: 'complete', result: diagnostic.data } };
  }
  return { observation: probeResponseSchema.parse(payload), diagnostic: { kind: 'missing' } };
}

/** Accept responses from Workers that predate endpoint evidence. */
export function parseProbeResponse(payload: unknown): ProbeResponse {
  return parseProbeResponseDetails(payload).observation;
}

export interface ParsedBatch {
  readonly envelope: ReturnType<typeof probeBatchResponseSchema.parse>;
  readonly diagnostics: Map<string, ParsedProbeResponse>;
}

/**
 * Validate a batch response and key each result by `<checkRunId>:<monitorId>`.
 * Rejects mismatched identity, unexpected results, and duplicates.
 */
export function parseProbeBatchResponse(
  payload: unknown,
  batch: RegionalProbeBatch,
  expectedRequestId: string,
): ParsedBatch {
  const envelope = probeBatchResponseSchema.parse(payload);
  if (envelope.requestId !== expectedRequestId || envelope.regionId !== batch.regionId) {
    throw new Error('Probe batch returned a mismatched identity');
  }
  const expectedKeys = new Set(batch.tasks.map(probeTaskKey));
  const results = new Map<string, ParsedProbeResponse>();
  for (const result of envelope.results) {
    const key = probeResultKey(result);
    if (!expectedKeys.has(key) || results.has(key)) {
      throw new Error('Probe batch returned an unexpected or duplicate result');
    }
    const parsed = parseProbeResponseDetails(result.response);
    if (parsed.observation.regionId !== batch.regionId) {
      throw new Error('Probe returned a mismatched region');
    }
    results.set(key, parsed);
  }
  return { envelope, diagnostics: results };
}
