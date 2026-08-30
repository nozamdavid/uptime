import type {
  ApiError,
  DnsDiagnosticResult,
  Monitor,
  MonitorCreate,
  MonitorSummary,
  Observation,
  PublicMonitorSummary,
} from '@uptime/contracts';
import type { RegionId } from '@uptime/regions';

export interface LatencyPoint {
  observedAt: string;
  regionId: RegionId;
  responseMs: number | null;
  success: boolean;
}
export interface LatencyStats {
  regionId: LatencyPoint['regionId'];
  sampleCount: number;
  successCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface MonitorLatencyData {
  latency: { points: LatencyPoint[]; stats: LatencyStats[] };
}

export interface MonitorDetailResponse extends MonitorLatencyData {
  summary: MonitorSummary;
}

export interface PublicMonitorDetailResponse extends MonitorLatencyData {
  summary: PublicMonitorSummary;
}

export interface ObservationPage {
  items: Observation[];
  nextCursor: string | null;
}

export interface DnsDiagnosticRecord {
  id: string;
  monitorId: string;
  checkRunId: string | null;
  observationId: string | null;
  regionId: RegionId;
  kind: 'dns_candidates';
  windowStartedAt: string;
  lifecycle: 'pending' | 'complete' | 'unavailable';
  finalHostname: string | null;
  result: DnsDiagnosticResult | null;
  failureCode: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface DnsDiagnosticPage {
  items: DnsDiagnosticRecord[];
  nextCursor: string | null;
}

export class RequestError extends Error {
  readonly fieldErrors: Record<string, string[]> | undefined;
  constructor(
    message: string,
    readonly status: number,
    error?: ApiError,
  ) {
    super(message);
    this.fieldErrors = error?.error.fieldErrors;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => undefined)) as ApiError | undefined;
    throw new RequestError(
      error?.error.message ?? `Request failed (${response.status})`,
      response.status,
      error,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function publicRequest<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'omit' });
  if (!response.ok) {
    const error = (await response.json().catch(() => undefined)) as ApiError | undefined;
    throw new RequestError(
      error?.error.message ?? `Request failed (${response.status})`,
      response.status,
      error,
    );
  }
  return (await response.json()) as T;
}

export const api = {
  session: () => request<{ admin: { email: string } }>('/auth/session'),
  signIn: (password: string) =>
    request<{ admin: { email: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  signOut: () => request<void>('/auth/logout', { method: 'POST' }),
  monitors: () => request<{ monitors: MonitorSummary[] }>('/monitors'),
  monitor: async (id: string, range: string): Promise<MonitorDetailResponse> => {
    const [monitor, latency] = await Promise.all([
      request<{ summary: MonitorSummary }>(`/monitors/${id}`),
      request<{ points: LatencyPoint[]; stats: LatencyStats[] }>(
        `/monitors/${id}/latency?range=${range}`,
      ),
    ]);
    return { summary: monitor.summary, latency };
  },
  publicMonitor: async (id: string, range: string): Promise<PublicMonitorDetailResponse> => {
    const [monitor, latency] = await Promise.all([
      publicRequest<{ summary: PublicMonitorSummary }>(`/monitors/public/${id}`),
      publicRequest<{ points: LatencyPoint[]; stats: LatencyStats[] }>(
        `/monitors/public/${id}/latency?range=${range}`,
      ),
    ]);
    return { summary: monitor.summary, latency };
  },
  createMonitor: (input: MonitorCreate) =>
    request<{ summary: MonitorSummary }>('/monitors', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateMonitor: (id: string, input: Partial<MonitorCreate>) =>
    request<{ summary: MonitorSummary }>(`/monitors/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteMonitor: (id: string) => request<void>(`/monitors/${id}`, { method: 'DELETE' }),
  observations: (id: string, range: string, cursor?: string) =>
    request<{ observations: Observation[]; nextCursor: string | null }>(
      `/monitors/${id}/observations?range=${range}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ).then((result) => ({ items: result.observations, nextCursor: result.nextCursor })),
  dnsDiagnostics: (
    id: string,
    range: '7d' | '30d',
    regionId?: RegionId,
    cursor?: string,
  ): Promise<DnsDiagnosticPage> => {
    const params = new URLSearchParams({ range });
    if (regionId) params.set('regionId', regionId);
    if (cursor) params.set('cursor', cursor);
    return request<{ diagnostics: DnsDiagnosticRecord[]; nextCursor: string | null }>(
      `/monitors/${id}/dns-diagnostics?${params.toString()}`,
    ).then((result) => ({ items: result.diagnostics, nextCursor: result.nextCursor }));
  },
};
