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
  MonitorMetrics,
  MonitorMetricsResponse,
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
    Partial<Pick<LatencyPayload, 'aggregatePoints' | 'aggregateStats'>> & {
      points?: LatencyPayload['aggregatePoints'];
    };
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
  fontFamily: import('@uptime/contracts').StatusPageFontFamily;
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
export interface TierEntitlements {
  monitors: number;
  regions: number;
  allowedRegionIds: RegionId[];
  seats: number;
  statusPages: number;
  notificationDestinations: number;
  customDomains: number;
  intervalSeconds: 300;
  rawRetentionHours: 24;
  dailyRetentionDays: 90;
}

export interface PlanPrice {
  amount: number;
  currency: 'usd' | 'eur';
  interval: 'month';
}

export interface PlanDefinition {
  id: string;
  revision: number;
  name: string;
  description: string;
  price: PlanPrice;
  entitlements: TierEntitlements;
  features: string[];
  active: boolean;
  published: boolean;
  preview: boolean;
}

export interface PublicProductCatalog {
  revision: number;
  preview: boolean;
  billingMode: 'disabled' | 'mock' | 'stripe';
  plans: PlanDefinition[];
  capabilities: {
    checkout: boolean;
    customDomains: string;
    notificationProviders: string[];
  };
}

export interface ProductCatalog {
  revision: number;
  preview: boolean;
  billingMode: 'disabled' | 'mock' | 'stripe';
  plans: PlanDefinition[];
  stripePriceIds?: Record<string, string>;
}

export interface EffectiveTierOverrides {
  monitors: number;
  regions: number;
  allowedRegionIds: RegionId[];
}

export interface WorkspaceEntitlementsUsage {
  monitors: number;
  statusPages: number;
  notificationServices: number;
  enabledMonitors?: number;
  notificationDestinations?: number;
  members?: number;
  pendingInvites?: number;
  seats?: number;
}

export interface WorkspaceEntitlementsResponse {
  tierId: string | null;
  revision: number | null;
  generation: number | null;
  legacyExempt: boolean;
  entitlements: TierEntitlements | null;
  overrides: EffectiveTierOverrides | null;
  usage: WorkspaceEntitlementsUsage;
  downgrade: {
    overLimit: boolean;
    overLimitResources?: string[];
    pausedMonitorCount: number;
    pausedMonitors: Array<{ id: string; reason: string }>;
  } | null;
}

// --- Billing Types ---
export interface WorkspaceBillingSubscription {
  status: string;
  tierId: string | null;
  revision: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  graceUntil: number | null;
  pendingReconciliation: boolean;
  activationError: string | null;
  plan: PlanDefinition | null;
}

export interface WorkspaceBillingResponse {
  mode: 'disabled' | 'mock' | 'stripe';
  ready: boolean;
  setupReasons: string[];
  simulation: boolean;
  legacyExempt: boolean;
  subscription: WorkspaceBillingSubscription | null;
  effectivePlan: { tierId: string; revision: number };
  actions: {
    checkout: boolean;
    portal: boolean;
    cancel: boolean;
    resume: boolean;
    changePlan: boolean;
  };
  managementUrl: string | null;
  policy: {
    proration: string;
    trials: boolean;
    automaticOverageCharges: boolean;
    cancellation: string;
  };
  mockSession: null | {
    sessionId: string;
    nonce: string;
    expiresAt: number;
    tierId: string;
    revision: number;
    plan: PlanDefinition | null;
    simulation: boolean;
  };
}

export interface WorkspaceBillingCheckoutResponse {
  mode: 'mock' | 'stripe';
  simulation: boolean;
  url: string;
  sessionId: string;
  expiresAt: number;
  tierId: string;
  revision: number;
  nonce?: string;
  plan: PlanDefinition;
}

export interface WorkspaceBillingPortalResponse {
  mode: 'mock' | 'stripe';
  simulation: boolean;
  url: string;
}

// --- Custom Domains Types ---
export type CustomStatusDomainStatus =
  'creating' | 'pending' | 'active' | 'deleting' | 'delete_failed' | 'deleted';

export interface CustomHostnameCnameInstruction {
  type: 'CNAME';
  name: string;
  target: string;
  purpose: 'traffic_routing';
}

export type CustomHostnameValidationRecord =
  | {
      type: 'TXT';
      name: string;
      value: string;
      purpose: 'hostname_ownership' | 'ssl_validation';
    }
  | {
      type: 'CNAME';
      name: string;
      target: string;
      purpose: 'ssl_validation';
    }
  | {
      type: 'HTTP';
      url: string;
      body: string;
      purpose: 'ssl_validation';
    };

export interface CustomStatusDomainDTO {
  id: string;
  workspaceId: string;
  statusPageId: string;
  hostname: string;
  providerMode: string;
  status: CustomStatusDomainStatus;
  isEligible: boolean;
  simulationReady: boolean;
  eligibilityReason: string | null;
  errorCode: string | null;
  verifiedAt: string | null;
  recheckDueAt: string | null;
  cnameInstruction: CustomHostnameCnameInstruction | null;
  validationRecords: CustomHostnameValidationRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomStatusDomainListResponse {
  domains: CustomStatusDomainDTO[];
  quota: number;
  totalActive: number;
  hasMore: boolean;
  nextCursor?: string;
  mode: string;
  ready: boolean;
  setupReasons: string[];
  simulation: boolean;
}

export interface CustomStatusDomainSetupResponse {
  mode: string;
  ready: boolean;
  setupReasons: string[];
  simulation: boolean;
  cnameTarget: string | null;
}

export function isValidBillingRedirect(targetUrl: string, expectedOrigin: string): boolean {
  try {
    const parsed = new URL(targetUrl, expectedOrigin);
    if (parsed.origin === expectedOrigin) {
      return true;
    }
    if (parsed.protocol === 'https:') {
      const host = parsed.hostname.toLowerCase();
      if (host === 'checkout.stripe.com' || host === 'billing.stripe.com') {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function formatPlanCents(
  amount: number,
  currency: 'usd' | 'eur' = 'usd',
  interval = 'month',
): string {
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount / 100);
  return interval ? `${formatted} / ${interval}` : formatted;
}

export function deriveTierFeatures(e: TierEntitlements): string[] {
  return [
    `${e.monitors} monitors`,
    `${e.regions} regions per monitor`,
    `${e.seats} workspace seats`,
    `${e.statusPages} status pages`,
    `${e.notificationDestinations} notification destinations`,
    `${e.customDomains} custom status domains (preview)`,
    'Five-minute checks',
    '24-hour detailed history',
    '90-day daily uptime',
    'Telegram and Discord',
  ];
}

export interface ProductLimits {
  monitors: number;
  regions: number;
  allowedRegionIds: RegionId[];
  intervalSeconds: number;
  statusPages: number;
  notificationServices: number;
  rawRetentionDays: number;
  dailyRetentionDays: number;
}
export interface ProductUsage {
  monitors: number;
  statusPages: number;
  notificationServices: number;
}
export interface ProductBudget {
  ceilingUsd: number;
  baseUsd?: number | null;
  forecastUsd?: number | null;
  externalMonthlyCostUsd?: number | null;
  observedAt?: string | null;
  admissionOpen?: boolean;
  billingWindow?: string;
  coverage?: string;
}
export interface PauseRecord {
  scope: string;
  paused: boolean;
  reason: string;
  actor: string;
  changedAt: string;
}
export interface SchedulingState {
  paused: boolean;
  manual: PauseRecord[];
  automatic: PauseRecord | null;
  inFlightMayComplete: true;
  resumeConditions: string[];
}
export interface CapacityGrant {
  monitors: number;
  regionalTasks: number;
}
export interface EffectiveCaps {
  monitorClaimsPerMinute: number;
  regionalTasksPerMinute: number;
  monitorsPerPeriod: number;
  regionalTasksPerPeriod: number;
}
export interface UtilizationRatios {
  monitorClaims: number;
  regionalTasks: number;
}
export interface CapacityFleet {
  dispatchesPerMinute: number;
  configuredWorkspaces: number;
  safe: boolean;
}
export interface Capacity {
  safe: boolean;
  intervalSeconds: number;
  headroomPercent: number;
  grant: CapacityGrant;
  actual: CapacityGrant | null;
  effectiveCaps: EffectiveCaps;
  utilization: UtilizationRatios;
  actualUtilization: UtilizationRatios | null;
  fleet: CapacityFleet;
  warnings: string[];
}
export interface WorkspaceTelemetry {
  lastSuccessfulTickAt: string | null;
  oldestOverdueCheckAt: string | null;
  regionalProbes: Record<string, unknown> | null;
  reports: {
    lastSuccessfulAt: string | null;
    oldestSuccessfulAt?: string | null;
    stale: boolean | null;
    failedCount?: number;
    truncated?: boolean;
  };
  notificationFailures: {
    count: number;
    truncated: boolean;
  };
  targetIncidents?: {
    downCount: number;
    truncated: boolean;
  };
}
export interface WorkspaceHealth {
  workspaceId: string;
  source: 'hosted' | 'legacy_import' | 'staging_import' | null;
  scheduling: SchedulingState;
  schedulingEnforcement?: {
    observedAt: string | null;
    confirmed: boolean;
  };
  telemetry: WorkspaceTelemetry | null;
  error: string | null;
}
export interface DispatchHealth {
  oldestPendingAt: string | null;
  pendingAgeSeconds: number | null;
  failedCount: number;
  truncated: boolean;
  deadLetterCount: null;
}
export interface OperatorHealthResponse {
  generatedAt: string;
  scheduling: SchedulingState;
  budget: ProductBudget;
  dispatch: DispatchHealth;
  workspaces: WorkspaceHealth[];
  nextCursor: string | null;
}
export interface OperatorWorkspace {
  id: string;
  name: string;
  ownerDid: string;
  ownerHandle: string;
  state: string;
  monitorCount: number;
  limits: (ProductLimits & { capacity?: Capacity }) | null;
  rowsRead: number | null;
  rowsWritten: number | null;
  storageBytes: number | null;
  lastSeenAt: string | null;
}
export type ImportedWorkspaceKind = 'staging_import' | 'legacy_import';

export function isImportedWorkspaceKind(value: unknown): value is ImportedWorkspaceKind {
  return value === 'staging_import' || value === 'legacy_import';
}

export interface OperatorSlot {
  bindingName: string;
  databaseId: string;
  status: 'available' | 'assigned' | 'deleting' | 'quarantined';
  admissionEnabled: boolean;
  workspaceId: string | null;
  ownerHandle: string | null;
  kind?: ImportedWorkspaceKind;
}
export interface OperatorSlots {
  maxWorkspaces: number;
  configuredSlots: number;
  assignedSlots: number;
  availableSlots: number;
  heldSlots: number;
  quarantinedSlots: number;
  slots: OperatorSlot[];
}
export interface InterestSignup {
  did: string;
  handle: string;
  createdAt: string;
  updatedAt: string;
}
export interface OperatorInterest {
  total: number;
  signups: InterestSignup[];
}
export interface WorkspaceSummary {
  id: string;
  name: string;
  state: string;
  role: 'owner' | 'maintainer' | 'viewer';
}
export interface ProductSession {
  user?: { did: string; handle: string };
  role?: 'owner' | 'maintainer' | 'viewer';
  workspace?: {
    id: string;
    name: string;
    plan: 'free';
    kind?: ImportedWorkspaceKind;
    state: 'active' | 'waiting_for_capacity' | 'suspended' | 'deleting' | 'deleted' | string;
  };
  isOperator?: boolean;
  limits?: ProductLimits | null;
  usage?: ProductUsage;
  budget?: ProductBudget;
  workspaces?: WorkspaceSummary[];
  admin?: { email: string };
}
export interface WorkspaceMember {
  did: string;
  handle: string;
  role: 'owner' | 'maintainer' | 'viewer';
}
export interface WorkspaceInvitation {
  id: string;
  workspaceId?: string;
  inviteeDid: string;
  role: 'maintainer' | 'viewer';
  createdAt?: string;
  expiresAt?: string;
  status?: 'pending' | 'expired';
}
export interface WorkspaceTarget {
  id: string;
  origin: string;
  verifiedAt: string | null;
  token?: string;
  verificationUrl?: string;
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

/** Returns the workspace selected for private calls, if a session has one. */
export function productWorkspaceId(current?: ProductSession | null): string | undefined {
  if (current?.workspace?.id) return current.workspace.id;
  if (typeof window === 'undefined') return undefined;
  return window.sessionStorage.getItem('uptime.workspaceId') ?? undefined;
}

/** Query string to append to public links and report requests. */
export function publicWorkspaceSearch(
  search = typeof window === 'undefined' ? '' : window.location.search,
  current?: ProductSession | null,
): string {
  const params = new URLSearchParams(search);
  const workspace = params.get('workspace') ?? productWorkspaceId(current);
  return workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
}

function appendPublicWorkspace(path: string): string {
  const workspace = publicWorkspaceSearch();
  if (!workspace || path.includes('workspace=')) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${workspace.slice(1)}`;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  credentials: RequestCredentials = 'include',
): Promise<T> {
  const headers =
    init?.headers !== undefined || init?.body !== undefined ? new Headers(init.headers) : undefined;
  const workspace = credentials === 'omit' ? undefined : productWorkspaceId();
  const requestHeaders = headers ?? (workspace ? new Headers() : undefined);
  if (workspace && requestHeaders && !requestHeaders.has('x-uptime-workspace')) {
    requestHeaders.set('x-uptime-workspace', workspace);
  }
  if (init?.body !== undefined && requestHeaders && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json');
  }
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials,
    ...(requestHeaders ? { headers: requestHeaders } : {}),
  });
  if (!response.ok) {
    if (
      response.status === 401 &&
      credentials !== 'omit' &&
      !path.startsWith('/auth/') &&
      typeof window !== 'undefined'
    )
      window.dispatchEvent(new Event('uptime:session-expired'));
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
  return request<T>(appendPublicWorkspace(path), undefined, 'omit');
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
  session: () => request<ProductSession>('/auth/session'),
  startAtProto: (handle: string, returnTo?: string) =>
    sendJson<{ authorizationUrl: string }>('/auth/atproto/start', 'POST', {
      handle,
      ...(returnTo ? { returnTo } : {}),
    }),
  interestSession: () => request<{ signup: InterestSignup | null }>('/interest/session'),
  signIn: (password: string) =>
    sendJson<{ admin: { email: string } }>('/auth/login', 'POST', { password }),
  signOut: () => request<void>('/auth/logout', { method: 'POST' }),
  publicPlans: () => publicRequest<PublicProductCatalog>('/plans'),
  operatorPlans: () => request<ProductCatalog>('/operator/plans'),
  saveOperatorPlans: (expectedRevision: number, reason: string, catalog: ProductCatalog) =>
    sendJson<ProductCatalog>('/operator/plans', 'PUT', { expectedRevision, reason, catalog }),
  workspaceEntitlements: () => request<WorkspaceEntitlementsResponse>('/workspace/entitlements'),
  usage: () =>
    request<{ usage: ProductUsage; limits: ProductLimits | null; budget: ProductBudget }>(
      '/workspace/usage',
    ),
  workspaceMembers: () =>
    request<{ members: WorkspaceMember[]; invitations: WorkspaceInvitation[] }>(
      '/workspace/members',
    ),
  inviteWorkspaceMember: (did: string, role: 'maintainer' | 'viewer') =>
    sendJson<{ invitation: WorkspaceInvitation }>('/workspace/invitations', 'POST', { did, role }),
  acceptWorkspaceInvitation: (id: string) =>
    sendJson<{ workspaceId: string }>(
      `/workspace/invitations/${encodeURIComponent(id)}/accept`,
      'POST',
      {},
    ),
  revokeWorkspaceInvitation: (id: string) =>
    request<{ revoked: true; id: string }>(`/workspace/invitations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  resendWorkspaceInvitation: (id: string) =>
    sendJson<{ invitation: WorkspaceInvitation }>(
      `/workspace/invitations/${encodeURIComponent(id)}/resend`,
      'POST',
      {},
    ),
  removeWorkspaceMember: (did: string) =>
    request<void>(`/workspace/members/${encodeURIComponent(did)}`, { method: 'DELETE' }),
  exportWorkspace: () => request<unknown>('/workspace/export'),
  deleteWorkspace: () => request<{ status?: string }>('/workspace', { method: 'DELETE' }),
  workspaceTargets: () => request<{ targets: WorkspaceTarget[] }>('/workspace/targets'),
  createWorkspaceTarget: (origin: string) =>
    sendJson<{ id: string; origin: string; token: string; verificationUrl: string }>(
      '/workspace/targets',
      'POST',
      { origin },
    ),
  verifyWorkspaceTarget: (id: string) =>
    sendJson<{ target: WorkspaceTarget }>(
      `/workspace/targets/${encodeURIComponent(id)}/verify`,
      'POST',
      {},
    ),
  operatorWorkspaces: () =>
    request<{
      workspaces: OperatorWorkspace[];
      availableRegions: RegionDefinition[];
      budget: ProductBudget;
    }>('/operator/workspaces'),
  operatorHealth: (after?: string, limit = 5) => {
    const params = new URLSearchParams();
    if (after) params.set('after', after);
    params.set('limit', String(limit));
    return request<OperatorHealthResponse>(`/operator/health?${params.toString()}`);
  },
  operatorScheduling: (paused: boolean, reason: string) =>
    sendJson<{ scheduling: SchedulingState }>('/operator/scheduling', 'POST', { paused, reason }),
  operatorWorkspaceScheduling: (id: string, paused: boolean, reason: string) =>
    sendJson<{ scheduling: SchedulingState }>(
      `/operator/workspaces/${encodeURIComponent(id)}/scheduling`,
      'POST',
      { paused, reason },
    ),
  operatorWorkspaceLimitsPreview: (
    id: string,
    input: { monitors: number; regions: number; allowedRegionIds: RegionId[] },
  ) =>
    sendJson<{ capacity: Capacity }>(
      `/operator/workspaces/${encodeURIComponent(id)}/limits/preview`,
      'POST',
      input,
    ),
  updateOperatorWorkspaceLimits: (
    id: string,
    input: { monitors: number; regions: number; allowedRegionIds: RegionId[] },
  ) =>
    sendJson<{ limits: ProductLimits }>(
      `/operator/workspaces/${encodeURIComponent(id)}/limits`,
      'PATCH',
      input,
    ),
  operatorSlots: () => request<OperatorSlots>('/operator/slots'),
  operatorInterest: () => request<OperatorInterest>('/operator/interest'),
  updateOperatorSlots: (maxWorkspaces: number) =>
    sendJson<OperatorSlots>('/operator/slots', 'PATCH', { maxWorkspaces }),
  setSlotAdmission: (bindingName: string, enabled: boolean) =>
    sendJson<OperatorSlots>(
      `/operator/slots/${encodeURIComponent(bindingName)}/admission`,
      'POST',
      { enabled },
    ),
  assignOperatorSlot: (bindingName: string, ownerDid: string) =>
    sendJson<{ workspaceId: string; state: string; bindingName: string }>(
      '/operator/slots/assignment',
      'POST',
      {
        bindingName,
        ownerDid,
      },
    ),
  updateOperatorControls: (input: { admissionOpen: boolean; externalMonthlyCostUsd: number }) =>
    sendJson<{ budget: ProductBudget }>('/operator/controls', 'PATCH', input),
  setWorkspaceState: (id: string, state: 'active' | 'suspended', reason: string) =>
    sendJson<{ workspace: OperatorWorkspace }>(`/operator/workspaces/${id}/state`, 'POST', {
      state,
      reason,
    }),
  regions: () => request<{ regions: RegionDefinition[] }>('/regions'),
  monitors: () => request<{ monitors: MonitorSummary[] }>('/monitors'),
  monitorMetrics: async (): Promise<Record<string, MonitorMetrics>> =>
    (await request<MonitorMetricsResponse>('/monitors/metrics?range=24h')).metrics,
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
  publicStatusPage: (id: string) =>
    publicRequest<{ statusPage: PublicStatusPage }>(`/status-pages/public/${id}`).then(
      (result) => result.statusPage,
    ),
  createStatusPage: (input: StatusPageSave) =>
    sendJson<{ statusPage: StatusPageDetail }>('/status-pages', 'POST', input).then(
      (result) => result.statusPage,
    ),
  statusPage: (id: string) =>
    request<{ statusPage: StatusPageDetail }>(`/status-pages/${id}`).then(
      (result) => result.statusPage,
    ),
  updateStatusPage: (id: string, input: StatusPageSave) =>
    sendJson<{ statusPage: StatusPageDetail }>(`/status-pages/${id}`, 'PUT', input).then(
      (result) => result.statusPage,
    ),
  deleteStatusPage: (id: string) => request<void>(`/status-pages/${id}`, { method: 'DELETE' }),
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

  // --- Billing ---
  workspaceBilling: (): Promise<WorkspaceBillingResponse> =>
    request<WorkspaceBillingResponse>('/workspace/billing'),
  startBillingCheckout: (
    tierId: string,
    revision: number,
  ): Promise<WorkspaceBillingCheckoutResponse> =>
    sendJson<WorkspaceBillingCheckoutResponse>('/workspace/billing/checkout', 'POST', {
      tierId,
      revision,
    }),
  createBillingPortal: (): Promise<WorkspaceBillingPortalResponse> =>
    sendJson<WorkspaceBillingPortalResponse>('/workspace/billing/portal', 'POST', {}),
  cancelBillingSubscription: (): Promise<WorkspaceBillingResponse> =>
    sendJson<WorkspaceBillingResponse>('/workspace/billing/cancel', 'POST', {}),
  resumeBillingSubscription: (): Promise<WorkspaceBillingResponse> =>
    sendJson<WorkspaceBillingResponse>('/workspace/billing/resume', 'POST', {}),
  confirmMockBilling: (
    sessionId: string,
    nonce: string,
    outcome: 'purchase' | 'cancel' | 'payment_failed' = 'purchase',
  ): Promise<WorkspaceBillingResponse> =>
    sendJson<WorkspaceBillingResponse>('/workspace/billing/mock/confirm', 'POST', {
      sessionId,
      nonce,
      outcome,
    }),
  cancelMockBilling: (sessionId: string, nonce: string): Promise<WorkspaceBillingResponse> =>
    sendJson<WorkspaceBillingResponse>('/workspace/billing/mock/cancel', 'POST', {
      sessionId,
      nonce,
    }),
  simulateMockPaymentFailed: (): Promise<WorkspaceBillingResponse> =>
    sendJson<WorkspaceBillingResponse>('/workspace/billing/mock/payment-failed', 'POST', {}),
  changeMockBillingPlan: (tierId: string, revision: number): Promise<WorkspaceBillingResponse> =>
    sendJson<WorkspaceBillingResponse>('/workspace/billing/mock/change-plan', 'POST', {
      tierId,
      revision,
    }),

  // --- Custom Domains ---
  customDomains: (params?: {
    limit?: number;
    cursor?: string;
  }): Promise<CustomStatusDomainListResponse> => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.cursor) query.set('cursor', params.cursor);
    const qs = query.toString();
    return request<CustomStatusDomainListResponse>(
      `/workspace/custom-domains${qs ? `?${qs}` : ''}`,
    );
  },
  customDomainsSetup: (): Promise<CustomStatusDomainSetupResponse> =>
    request<CustomStatusDomainSetupResponse>('/workspace/custom-domains/setup'),
  createCustomDomain: (input: {
    statusPageId: string;
    hostname: string;
  }): Promise<CustomStatusDomainDTO> =>
    sendJson<CustomStatusDomainDTO>('/workspace/custom-domains', 'POST', input),
  refreshCustomDomain: (id: string): Promise<CustomStatusDomainDTO> =>
    sendJson<CustomStatusDomainDTO>(
      `/workspace/custom-domains/${encodeURIComponent(id)}/refresh`,
      'POST',
      {},
    ),
  simulateCustomDomain: (
    id: string,
    targetStatus: 'ready' | 'pending_validation' | 'failed',
  ): Promise<CustomStatusDomainDTO> =>
    sendJson<CustomStatusDomainDTO>(
      `/workspace/custom-domains/${encodeURIComponent(id)}/simulate`,
      'POST',
      { targetStatus },
    ),
  deleteCustomDomain: (id: string): Promise<{ id: string; deleted: boolean }> =>
    request<{ id: string; deleted: boolean }>(
      `/workspace/custom-domains/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
};
