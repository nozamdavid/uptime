import type {
  ApiError,
  Badge,
  BadgeCreate,
  DnsDiagnosticResult,
  LatencyPayload,
  MonitorBulkFrequencyUpdate,
  MonitorBulkBadgeUpdate,
  MonitorCreate,
  MonitorSummary,
  NotificationService,
  NotificationServiceCreate,
  NotificationServiceUpdate,
  NotificationHistoryResponse,
  Observation,
  PublicMonitorSummary,
  StatusPageReportSnapshot,
  MonitorUptimeData,
  StatusPageSave,
} from '@uptime/contracts';
import type { RegionId } from '@uptime/regions';
import type { RegionDefinition } from '@uptime/regions';
import { frontendConfig } from './config.js';

export type {
  AggregateLatencyPoint,
  AggregateLatencyStats,
  LatencyPoint,
  LatencyStats,
  MonitorUptimeData,
  UptimeDay,
} from '@uptime/contracts';

export interface MonitorLatencyData {
  latency: Omit<LatencyPayload, 'aggregatePoints' | 'aggregateStats'> &
    Partial<Pick<LatencyPayload, 'aggregatePoints' | 'aggregateStats'>>;
}

export interface MonitorDetailResponse extends MonitorLatencyData {
  summary: MonitorSummary;
  uptime: MonitorUptimeData;
}

export interface PublicMonitorDetailResponse extends MonitorLatencyData {
  summary: PublicMonitorSummary;
  uptime: MonitorUptimeData;
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

export interface StatusPageSummary {
  id: string;
  title: string;
  publicSlug: string | null;
  monitorCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface StatusPageDetail extends StatusPageSummary {
  groups: Array<{
    id: string;
    title: string;
    position: number;
    width: 'full' | 'half';
    showBadges: boolean;
    monitors: Array<{
      id: string;
      name: string | null;
      url: string;
      publicSlug: string | null;
      position: number;
      badge?: Badge | null;
    }>;
  }>;
}
export type PublicStatusPage = StatusPageReportSnapshot['statusPage'];

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

/** Absolute request URL. `VITE_API_BASE_URL` already includes the `/api` suffix. */
export function apiUrl(path: string): string {
  return `${frontendConfig().apiBaseUrl}${path}`;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  credentials: RequestCredentials = 'include',
): Promise<T> {
  const headers =
    init?.headers !== undefined || init?.body !== undefined ? new Headers(init.headers) : undefined;
  if (init?.body !== undefined && headers && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials,
    ...(headers ? { headers } : {}),
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
  return request<T>(path, undefined, 'omit');
}

function sendJson<T>(path: string, method: string, input: unknown) {
  return request<T>(path, { method, body: JSON.stringify(input) });
}

async function monitorDetail<TSummary>(path: string, range: string, isPublic = false) {
  const get = <T>(url: string) => (isPublic ? publicRequest<T>(url) : request<T>(url));
  const [monitor, latency, uptime] = await Promise.all([
    get<{ summary: TSummary }>(path),
    get<MonitorLatencyData['latency']>(`${path}/latency?range=${range}`),
    get<{ uptime: MonitorUptimeData }>(`${path}/uptime`),
  ]);
  return { summary: monitor.summary, latency, uptime: uptime.uptime };
}

export const api = {
  session: () => request<{ admin: { email: string } }>('/auth/session'),
  signIn: (password: string) =>
    sendJson<{ admin: { email: string } }>('/auth/login', 'POST', { password }),
  signOut: () => request<void>('/auth/logout', { method: 'POST' }),
  regions: () => request<{ regions: RegionDefinition[] }>('/regions'),
  monitors: () => request<{ monitors: MonitorSummary[] }>('/monitors'),
  badges: () => request<{ badges: Badge[] }>('/badges'),
  createBadge: (input: BadgeCreate) =>
    sendJson<{ badge: Badge }>('/badges', 'POST', input).then((result) => result.badge),
  monitor: (id: string, range: string): Promise<MonitorDetailResponse> =>
    monitorDetail<MonitorSummary>(`/monitors/${id}`, range),
  publicMonitor: (id: string, range: string): Promise<PublicMonitorDetailResponse> =>
    monitorDetail<PublicMonitorSummary>(`/monitors/public/${id}`, range, true),
  createMonitor: (input: MonitorCreate) =>
    sendJson<{ summary: MonitorSummary }>('/monitors', 'POST', input),
  updateMonitor: (id: string, input: Partial<MonitorCreate>) =>
    sendJson<{ summary: MonitorSummary }>(`/monitors/${id}`, 'PATCH', input),
  updateMonitorFrequencies: (input: MonitorBulkFrequencyUpdate) =>
    sendJson<{ updatedCount: number }>('/monitors/bulk-frequency', 'PATCH', input),
  updateMonitorBadges: (input: MonitorBulkBadgeUpdate) =>
    sendJson<{ updatedCount: number }>('/monitors/bulk-badge', 'PATCH', input),
  deleteMonitor: (id: string) => request<void>(`/monitors/${id}`, { method: 'DELETE' }),
  deleteMonitorHistory: (id: string) =>
    request<void>(`/monitors/${id}/history`, { method: 'DELETE' }),
  notificationServices: () =>
    request<{ services: NotificationService[] }>('/notification-services'),
  createNotificationService: (input: NotificationServiceCreate) =>
    sendJson<{ service: NotificationService }>('/notification-services', 'POST', input),
  updateNotificationService: (id: string, input: NotificationServiceUpdate) =>
    sendJson<{ service: NotificationService }>(`/notification-services/${id}`, 'PATCH', input),
  deleteNotificationService: (id: string) =>
    request<void>(`/notification-services/${id}`, { method: 'DELETE' }),
  testNotificationService: (id: string) =>
    request<{ success: true }>(`/notification-services/${id}/test`, { method: 'POST' }),
  notificationHistory: (id: string, cursor?: string): Promise<NotificationHistoryResponse> => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    const query = params.size ? `?${params.toString()}` : '';
    return request<NotificationHistoryResponse>(`/notification-services/${id}/history${query}`);
  },
  globalNotificationHistory: (cursor?: string): Promise<NotificationHistoryResponse> => {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    const query = params.size ? `?${params.toString()}` : '';
    return request<NotificationHistoryResponse>(`/notification-history${query}`);
  },
  statusPages: () => request<{ statusPages: StatusPageSummary[] }>('/status-pages'),
  statusPage: (id: string) =>
    request<{ statusPage: StatusPageDetail }>(`/status-pages/${id}`).then(
      (result) => result.statusPage,
    ),
  createStatusPage: (input: StatusPageSave) =>
    sendJson<{ statusPage: StatusPageDetail }>('/status-pages', 'POST', input).then(
      (result) => result.statusPage,
    ),
  updateStatusPage: (id: string, input: StatusPageSave) =>
    sendJson<{ statusPage: StatusPageDetail }>(`/status-pages/${id}`, 'PUT', input).then(
      (result) => result.statusPage,
    ),
  deleteStatusPage: (id: string) => request<void>(`/status-pages/${id}`, { method: 'DELETE' }),
  publicStatusPage: (id: string) =>
    publicRequest<{ statusPage: PublicStatusPage }>(`/status-pages/public/${id}`).then(
      (result) => result.statusPage,
    ),
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
