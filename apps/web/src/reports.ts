/**
 * Public report snapshot contract served from `VITE_REPORTS_BASE_URL`.
 *
 * The gateway resolves monitors independently and status pages/index from the
 * committed cohort. Responses preserve the fields the frontend consumes and add
 * freshness metadata:
 *
 *   schemaVersion      Snapshot schema identifier, currently "1".
 *   generatedAt        When the publisher generated the object (ISO-8601 UTC).
 *   latestObservationAt Latest included observation timestamp, or null.
 *   staleAfterSeconds  Publisher cadence plus probe/cache allowance; beyond
 *                      generatedAt + staleAfterSeconds the UI shows stale.
 *
 * Gateway paths relative to the configured base URL:
 *   public/monitors/{slug}.json        `MonitorReportSnapshot`
 *   public/status-pages/{slug}.json    `StatusPageReportSnapshot`
 *   public/status-pages.json           `StatusPageIndexSnapshot`
 */

import type {
  MonitorReportSnapshot as PublishedMonitorReportSnapshot,
  SnapshotFreshness as PublishedSnapshotFreshness,
  StatusPageIndexSnapshot as PublishedStatusPageIndexSnapshot,
  StatusPageReportSnapshot as PublishedStatusPageReportSnapshot,
  StatusPageReportSnapshotMonitor,
} from '@uptime/contracts';
import type { MonitorLatencyData, PublicMonitorDetailResponse, PublicStatusPage } from './api.js';
import * as apiModule from './api.js';

function workspaceSearch(): string {
  try {
    const helper = apiModule.publicWorkspaceSearch;
    return typeof helper === 'function' ? helper() : '';
  } catch {
    return '';
  }
}
import { frontendConfig } from './config.js';

export type SnapshotFreshness = Omit<
  PublishedSnapshotFreshness,
  'generatedAt' | 'staleAfterSeconds'
> & {
  generatedAt: string | null;
  staleAfterSeconds: number | null;
  generation?: string;
  sourceWatermark?: string;
};

type FrontendLatencyPayload = MonitorLatencyData['latency'];

export type MonitorReportSnapshot = Omit<
  PublishedMonitorReportSnapshot,
  keyof PublishedSnapshotFreshness | 'latency' | 'latencyByRange'
> & {
  latency: FrontendLatencyPayload;
  latencyByRange?: Partial<Record<'1h' | '24h' | '7d' | '30d', FrontendLatencyPayload>>;
} & SnapshotFreshness;

export type { StatusPageReportSnapshotMonitor };
export type StatusPageReportSnapshot = Omit<
  PublishedStatusPageReportSnapshot,
  keyof PublishedSnapshotFreshness
> &
  SnapshotFreshness;
export type StatusPageIndexSnapshot = Omit<
  PublishedStatusPageIndexSnapshot,
  keyof PublishedSnapshotFreshness
> &
  SnapshotFreshness;

/** Public reference: prefer the slug, fall back to the id for legacy URLs. */
export function reportReference(slug: string | null, id: string): string {
  return slug ?? id;
}

export function monitorReportUrl(
  reference: string,
  baseUrl: string | null = frontendConfig().reportsBaseUrl,
): string | null {
  if (!baseUrl) return null;
  return `${baseUrl}/public/monitors/${encodeURIComponent(reference)}.json${workspaceSearch()}`;
}

export function statusPageReportUrl(
  reference: string,
  baseUrl: string | null = frontendConfig().reportsBaseUrl,
): string | null {
  if (!baseUrl) return null;
  return `${baseUrl}/public/status-pages/${encodeURIComponent(reference)}.json${workspaceSearch()}`;
}

export function statusPageIndexUrl(
  baseUrl: string | null = frontendConfig().reportsBaseUrl,
): string | null {
  if (!baseUrl) return null;
  return `${baseUrl}/public/status-pages.json${workspaceSearch()}`;
}

export class SnapshotError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SnapshotError';
  }
}

async function fetchSnapshot<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'omit', cache: 'no-cache' });
  } catch {
    throw new SnapshotError('Could not reach the public report host', 0);
  }
  if (!response.ok) {
    // 404 means the page/monitor was removed or unpublished; surface it as a
    // distinct state so the UI can say so instead of a generic failure.
    throw new SnapshotError(
      response.status === 404 ? 'This public report is no longer published' : 'Report unavailable',
      response.status,
    );
  }
  return (await response.json()) as T;
}

export function loadMonitorReport(reference: string, baseUrl?: string | null) {
  const url = monitorReportUrl(reference, baseUrl ?? frontendConfig().reportsBaseUrl);
  if (!url) throw new SnapshotError('Public reports are not configured', 0);
  return fetchSnapshot<MonitorReportSnapshot>(url);
}

export function loadStatusPageReport(reference: string, baseUrl?: string | null) {
  const url = statusPageReportUrl(reference, baseUrl ?? frontendConfig().reportsBaseUrl);
  if (!url) throw new SnapshotError('Public reports are not configured', 0);
  return fetchSnapshot<StatusPageReportSnapshot>(url);
}

export function loadStatusPageIndex(baseUrl?: string | null) {
  const url = statusPageIndexUrl(baseUrl ?? frontendConfig().reportsBaseUrl);
  if (!url) throw new SnapshotError('Public reports are not configured', 0);
  return fetchSnapshot<StatusPageIndexSnapshot>(url);
}

export type FreshnessState = 'fresh' | 'stale' | 'unknown';

export interface FreshnessAssessment {
  state: FreshnessState;
  generatedAt: string | null;
  latestObservationAt: string | null;
  ageSeconds: number | null;
  staleAfterSeconds: number | null;
  /** Human-readable reason, safe to render. */
  detail: string;
}

/**
 * Decide whether a snapshot is fresh. A snapshot is stale when the wall clock
 * is beyond `generatedAt + staleAfterSeconds`, or when the publisher never
 * recorded a generation time. `unknown` means the snapshot carries no usable
 * freshness metadata (older publisher), so the UI must not claim liveness.
 */
export function assessFreshness(
  snapshot: Pick<SnapshotFreshness, 'generatedAt' | 'latestObservationAt' | 'staleAfterSeconds'>,
  now: Date = new Date(),
): FreshnessAssessment {
  const staleAfterSeconds =
    typeof snapshot.staleAfterSeconds === 'number' && snapshot.staleAfterSeconds > 0
      ? snapshot.staleAfterSeconds
      : null;
  const generatedAt = snapshot.generatedAt;
  if (!generatedAt) {
    return {
      state: 'unknown',
      generatedAt: null,
      latestObservationAt: snapshot.latestObservationAt ?? null,
      ageSeconds: null,
      staleAfterSeconds,
      detail: 'This report does not include freshness metadata.',
    };
  }
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedMs)) {
    return {
      state: 'unknown',
      generatedAt,
      latestObservationAt: snapshot.latestObservationAt ?? null,
      ageSeconds: null,
      staleAfterSeconds,
      detail: 'This report has an unreadable generation time.',
    };
  }
  const ageSeconds = Math.max(0, Math.round((now.getTime() - generatedMs) / 1_000));
  if (staleAfterSeconds === null) {
    return {
      state: 'unknown',
      generatedAt,
      latestObservationAt: snapshot.latestObservationAt ?? null,
      ageSeconds,
      staleAfterSeconds: null,
      detail: 'This report does not publish a freshness window.',
    };
  }
  if (ageSeconds > staleAfterSeconds) {
    return {
      state: 'stale',
      generatedAt,
      latestObservationAt: snapshot.latestObservationAt ?? null,
      ageSeconds,
      staleAfterSeconds,
      detail: `Last generated ${formatAge(ageSeconds)} ago; stale after ${formatAge(staleAfterSeconds)}.`,
    };
  }
  return {
    state: 'fresh',
    generatedAt,
    latestObservationAt: snapshot.latestObservationAt ?? null,
    ageSeconds,
    staleAfterSeconds,
    detail: `Generated ${formatAge(ageSeconds)} ago.`,
  };
}

export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown time';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Latency sampling/freshness metadata attached by the coordinator. These fields
 * are optional so snapshots from older publishers still load; `sampled` must be
 * treated as true only when explicitly set.
 */
export interface LatencySampling {
  /** True when points/percentiles cover only a bounded recent sample. */
  sampled: boolean;
  /** Raw observation row budget applied, when bounded. */
  sampleLimit: number | null;
  /** When the range payload was computed, when published. */
  computedAt: string | null;
}

export interface LatencySamplingAssessment extends LatencySampling {
  /** Age of `computedAt` at `now`, in seconds; null when unavailable. */
  computedAgeSeconds: number | null;
}

/**
 * Normalize the coordinator's `sampled`/`sampleLimit`/`computedAt` metadata so
 * the UI never presents a bounded sample as an exact whole-range statistic.
 */
export function assessLatencySampling(
  latency: Pick<MonitorLatencyData['latency'], 'sampled' | 'sampleLimit' | 'computedAt'>,
  now: Date = new Date(),
): LatencySamplingAssessment {
  const sampled = latency.sampled === true;
  const sampleLimit =
    typeof latency.sampleLimit === 'number' && Number.isFinite(latency.sampleLimit)
      ? latency.sampleLimit
      : null;
  const computedAt = typeof latency.computedAt === 'string' ? latency.computedAt : null;
  const computedMs = computedAt ? Date.parse(computedAt) : Number.NaN;
  const computedAgeSeconds = Number.isFinite(computedMs)
    ? Math.max(0, Math.round((now.getTime() - computedMs) / 1_000))
    : null;
  return { sampled, sampleLimit, computedAt, computedAgeSeconds };
}
/** Map a monitor snapshot onto the existing detail response shape. */
export function monitorSnapshotToDetail(
  snapshot: MonitorReportSnapshot,
  range?: string,
): PublicMonitorDetailResponse {
  if (!snapshot.summary || !snapshot.uptime || !snapshot.latency) {
    throw new SnapshotError(
      'Snapshot is missing the required summary, uptime or latency fields',
      0,
    );
  }
  const ranged =
    range && snapshot.latencyByRange
      ? (snapshot.latencyByRange[range as keyof typeof snapshot.latencyByRange] ?? snapshot.latency)
      : snapshot.latency;
  return {
    summary: snapshot.summary,
    uptime: snapshot.uptime,
    latency: ranged,
  };
}

/** Map a status-page snapshot onto the existing public status page shape. */
export function statusPageSnapshotToPage(snapshot: StatusPageReportSnapshot): PublicStatusPage {
  if (!snapshot.statusPage) {
    throw new SnapshotError('Snapshot is missing the required statusPage field', 0);
  }
  return snapshot.statusPage;
}
