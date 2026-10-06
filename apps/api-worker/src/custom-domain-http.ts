import {
  parseRegionsList,
  type CloudflareEnv,
  type RegionId,
} from '@uptime/cloudflare';
import {
  type Database,
  type RuntimePostgresCatalog,
  resolveRuntimeWorkspace,
} from '@uptime/cloudflare/postgres';
import type {
  SnapshotFreshness,
  StatusPageReportSnapshot,
  StatusPageReportSnapshotMonitor,
  UptimeDay,
} from '@uptime/contracts';

import {
  createCustomDomainProvider,
  CustomDomainProviderError,
  CustomHostnameValidationError,
  type CustomDomainProvider,
} from './custom-domain-provider.js';
import {
  CustomStatusDomainError,
  CustomStatusDomainService,
  type CustomStatusDomainActorContext,
  type CustomStatusDomainDTO,
  type CustomStatusDomainListResponse,
} from './custom-status-domains.js';

// ---------------------------------------------------------------------------
// Environment & Factory
// ---------------------------------------------------------------------------

export interface ApiWorkerCustomDomainEnv extends Partial<CloudflareEnv> {
  controlDb?: Database;
  catalog?: RuntimePostgresCatalog;
  CUSTOM_DOMAIN_MODE?: string;
  CUSTOM_DOMAIN_CNAME_TARGET?: string;
  CLOUDFLARE_SAAS_ZONE_ID?: string;
  CLOUDFLARE_SAAS_API_TOKEN?: string;
  ENVIRONMENT?: string;
  WEB_ORIGIN?: string;
  REGIONS_LIST?: string;
  [key: string]: unknown;
}

export interface CustomDomainServiceOptions {
  clock?: () => number;
  maxVerificationFreshnessMs?: number;
  reservedHostnames?: string[] | Set<string>;
  tenantDbResolver?: (workspaceId: string) => Promise<Database> | Database;
  effectiveEntitlementsReader?: (
    control: Database,
    workspaceId: string,
  ) => Promise<{ customDomains: number }> | { customDomains: number };
  configuredRegions?: readonly string[] | readonly RegionId[];
}

const ALLOWED_MOCK_ENVIRONMENTS = new Set(['test', 'development', 'staging']);

export function createCustomStatusDomainService(
  env: ApiWorkerCustomDomainEnv,
  options?: CustomDomainServiceOptions,
): CustomStatusDomainService {
  if (!env.controlDb) {
    throw new CustomStatusDomainError(
      'missing_control_db',
      'controlDb binding is required for CustomStatusDomainService',
      500,
    );
  }

  const rawMode = env.CUSTOM_DOMAIN_MODE ? env.CUSTOM_DOMAIN_MODE.trim().toLowerCase() : 'disabled';
  const setupReasons: string[] = [];
  let provider: CustomDomainProvider;

  const validModes = new Set(['disabled', 'mock', 'cloudflare']);
  const isUnknownMode = !validModes.has(rawMode);

  if (isUnknownMode) {
    setupReasons.push(`Invalid CUSTOM_DOMAIN_MODE configured: "${env.CUSTOM_DOMAIN_MODE}"`);
    provider = createCustomDomainProvider({ type: 'disabled' });
  } else if (rawMode === 'mock') {
    const currentEnv = env.ENVIRONMENT ? env.ENVIRONMENT.trim().toLowerCase() : '';
    if (!currentEnv || !ALLOWED_MOCK_ENVIRONMENTS.has(currentEnv)) {
      setupReasons.push('Mock custom domains are not permitted in this environment');
      provider = createCustomDomainProvider({ type: 'disabled' });
    } else {
      provider = createCustomDomainProvider({
        type: 'mock',
        environment: currentEnv,
      });
    }
  } else if (rawMode === 'cloudflare') {
    const cnameTarget = env.CUSTOM_DOMAIN_CNAME_TARGET?.trim();
    const zoneId = env.CLOUDFLARE_SAAS_ZONE_ID?.trim();
    const apiToken = env.CLOUDFLARE_SAAS_API_TOKEN?.trim();

    if (!cnameTarget) setupReasons.push('Missing CUSTOM_DOMAIN_CNAME_TARGET');
    if (!zoneId) setupReasons.push('Missing CLOUDFLARE_SAAS_ZONE_ID');
    if (!apiToken) setupReasons.push('Missing CLOUDFLARE_SAAS_API_TOKEN');

    if (setupReasons.length > 0) {
      provider = createCustomDomainProvider({ type: 'disabled' });
    } else {
      provider = createCustomDomainProvider({
        type: 'cloudflare',
        apiToken: apiToken!,
        zoneId: zoneId!,
        cnameTarget: cnameTarget!,
      });
    }
  } else {
    // disabled
    provider = createCustomDomainProvider({ type: 'disabled' });
  }

  // Derive reserved hostnames from WEB_ORIGIN and options
  const reserved = new Set<string>();
  if (options?.reservedHostnames) {
    for (const h of options.reservedHostnames) {
      reserved.add(h.toLowerCase());
    }
  }
  if (env.WEB_ORIGIN) {
    try {
      const parsed = new URL(env.WEB_ORIGIN);
      reserved.add(parsed.hostname.toLowerCase());
    } catch {
      // Ignored
    }
  }

  // Parse enabled regions using existing parseApiEnv semantics
  const enabledRegionIds = options?.configuredRegions ?? parseRegionsList(env.REGIONS_LIST);

  const tenantDbResolver =
    options?.tenantDbResolver ??
    (async (workspaceId: string) => {
      if (!env.catalog) {
        throw new CustomStatusDomainError(
          'missing_catalog',
          'catalog is required to resolve tenant database',
          500,
        );
      }
      const resolved = await resolveRuntimeWorkspace(env.controlDb!, env.catalog, workspaceId);
      return resolved.db;
    });

  return new CustomStatusDomainService({
    control: env.controlDb,
    ...(env.catalog ? { catalog: env.catalog } : {}),
    tenantDbResolver,
    ...(options?.effectiveEntitlementsReader !== undefined
      ? { effectiveEntitlementsReader: options.effectiveEntitlementsReader }
      : { configuredRegions: enabledRegionIds }),
    provider,
    reservedHostnames: reserved,
    setupReasons,
    ...(options?.clock !== undefined ? { clock: options.clock } : {}),
    ...(options?.maxVerificationFreshnessMs !== undefined
      ? { maxVerificationFreshnessMs: options.maxVerificationFreshnessMs }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Pure Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function errorResponse(code: string, message: string, status = 400): Response {
  return jsonResponse({ error: { code, message } }, status);
}

export async function readBoundedJson(
  request: Request,
  maxBytes = 16_384,
  timeoutMs = 5_000,
): Promise<unknown> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declaredLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(declaredLength) && declaredLength > maxBytes) {
      throw new CustomStatusDomainError('payload_too_large', 'Request payload too large', 413);
    }
  }

  if (!request.body) {
    throw new CustomStatusDomainError('invalid_json', 'Request body must not be empty', 400);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new CustomStatusDomainError('request_timeout', 'Request body read timed out', 408));
    }, timeoutMs);
  });

  try {
    const readStream = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            reader.cancel().catch(() => {});
            throw new CustomStatusDomainError(
              'payload_too_large',
              'Request payload too large',
              413,
            );
          }
          chunks.push(value);
        }
      }
    };

    await Promise.race([readStream(), timeoutPromise]);
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }

  if (totalBytes === 0) {
    throw new CustomStatusDomainError('invalid_json', 'Request body must not be empty', 400);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(merged);
  } catch {
    throw new CustomStatusDomainError('invalid_json', 'Request body must be valid UTF-8', 400);
  }

  if (!text.trim()) {
    throw new CustomStatusDomainError('invalid_json', 'Request body must not be empty', 400);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new CustomStatusDomainError('invalid_json', 'Malformed JSON in request body', 400);
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type DerivedFreshnessState = 'fresh' | 'stale' | 'unknown';

export function deriveSnapshotFreshness(
  snapshot: Pick<SnapshotFreshness, 'generatedAt' | 'staleAfterSeconds' | 'latestObservationAt'>,
  nowMs: number = Date.now(),
): DerivedFreshnessState {
  if (!snapshot.generatedAt || typeof snapshot.generatedAt !== 'string') {
    return 'unknown';
  }
  const generatedMs = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generatedMs)) {
    return 'unknown';
  }
  if (snapshot.latestObservationAt !== null && snapshot.latestObservationAt !== undefined) {
    const latestMs = Date.parse(snapshot.latestObservationAt);
    if (!Number.isFinite(latestMs)) {
      return 'unknown';
    }
  }
  if (typeof snapshot.staleAfterSeconds !== 'number' || snapshot.staleAfterSeconds <= 0) {
    return 'unknown';
  }

  const ageSeconds = (nowMs - generatedMs) / 1000;
  if (ageSeconds < -60 || ageSeconds > snapshot.staleAfterSeconds) {
    return 'stale';
  }
  return 'fresh';
}

// ---------------------------------------------------------------------------
// Management HTTP Handler
// ---------------------------------------------------------------------------

export interface CustomDomainManagementOptions {
  /**
   * Optional write-lease wrapper to serialize workspace mutations.
   * NOTE: Callers in production routers MUST supply this wrapper for all
   * mutating routes (POST, DELETE) to serialize concurrent operations across Worker instances.
   * It is optional here only to simplify standalone test harnesses.
   */
  withWriteLease?: (workspaceId: string, run: () => Promise<Response>) => Promise<Response>;
  service?: CustomStatusDomainService;
}

/**
 * Handle custom status domain authenticated management routes for the active workspace:
 * - GET    /api/workspace/custom-domains
 * - GET    /api/workspace/custom-domains/setup
 * - POST   /api/workspace/custom-domains
 * - POST   /api/workspace/custom-domains/:id/refresh
 * - DELETE /api/workspace/custom-domains/:id
 * - POST   /api/workspace/custom-domains/:id/simulate
 */
export async function handleCustomDomainManagement(
  request: Request,
  env: ApiWorkerCustomDomainEnv,
  actorContext: CustomStatusDomainActorContext,
  options?: CustomDomainManagementOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const service = options?.service ?? createCustomStatusDomainService(env);
  const basePath = '/api/workspace/custom-domains';

  if (!path.startsWith(basePath)) {
    return errorResponse('not_found', 'Route not found', 404);
  }

  const subpath = path.slice(basePath.length);

  try {
    // 1. GET /api/workspace/custom-domains/setup
    if (subpath === '/setup') {
      if (method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } });
      }
      const rawMode = env.CUSTOM_DOMAIN_MODE
        ? env.CUSTOM_DOMAIN_MODE.trim().toLowerCase()
        : 'disabled';
      const currentEnv = env.ENVIRONMENT ? env.ENVIRONMENT.trim().toLowerCase() : '';
      const isMock =
        rawMode === 'mock' && Boolean(currentEnv && ALLOWED_MOCK_ENVIRONMENTS.has(currentEnv));
      const isCloudflare = rawMode === 'cloudflare';
      const cnameTarget = env.CUSTOM_DOMAIN_CNAME_TARGET?.trim() ?? null;

      const ready =
        (isMock ||
          (isCloudflare &&
            Boolean(
              cnameTarget && env.CLOUDFLARE_SAAS_ZONE_ID && env.CLOUDFLARE_SAAS_API_TOKEN,
            ))) &&
        service.providerType !== 'disabled' &&
        service.setupReasons.length === 0;

      return jsonResponse({
        mode: service.providerType,
        ready,
        setupReasons: service.setupReasons,
        simulation: isMock,
        cnameTarget,
      });
    }

    // 2. GET /api/workspace/custom-domains (Paginated list)
    if (subpath === '' || subpath === '/') {
      if (method === 'GET') {
        const limitParam = url.searchParams.get('limit');
        const cursorParam = url.searchParams.get('cursor');
        let limit: number | undefined;
        if (limitParam !== null) {
          const parsed = parseInt(limitParam, 10);
          if (Number.isNaN(parsed) || parsed < 1) {
            return errorResponse('invalid_parameter', 'limit must be a positive integer', 400);
          }
          limit = Math.min(parsed, 1000);
        }
        const cursor = cursorParam !== null && cursorParam !== '' ? cursorParam : undefined;

        const listResult = await service.list(actorContext, {
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return jsonResponse(listResult);
      }

      // 3. POST /api/workspace/custom-domains (Create domain)
      if (method === 'POST') {
        const body = (await readBoundedJson(request)) as Record<string, unknown>;
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          return errorResponse('invalid_body', 'Request body must be a JSON object', 400);
        }

        const allowedKeys = new Set(['statusPageId', 'hostname']);
        const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
        if (unknownKeys.length > 0) {
          return errorResponse(
            'forbidden_fields',
            `Unknown or forbidden fields in request body: ${unknownKeys.join(', ')}`,
            400,
          );
        }

        const statusPageId = body.statusPageId;
        const hostname = body.hostname;

        if (typeof statusPageId !== 'string' || !statusPageId.trim()) {
          return errorResponse(
            'invalid_body',
            'Field "statusPageId" is required and must be a string',
            400,
          );
        }
        if (typeof hostname !== 'string' || !hostname.trim()) {
          return errorResponse(
            'invalid_body',
            'Field "hostname" is required and must be a string',
            400,
          );
        }

        const action = async () => {
          const created = await service.create(actorContext, {
            statusPageId: statusPageId.trim(),
            hostname: hostname.trim(),
          });
          return jsonResponse(created, 201);
        };

        return options?.withWriteLease
          ? options.withWriteLease(actorContext.workspaceId, action)
          : action();
      }

      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    }

    // Match /:id/... subroutes
    const parts = subpath.slice(1).split('/');
    let claimId: string;
    try {
      claimId = decodeURIComponent(parts[0] ?? '');
    } catch {
      return errorResponse('invalid_parameter', 'Malformed percent-encoding', 400);
    }
    const action = parts[1] ?? '';

    if (!claimId) {
      return errorResponse('not_found', 'Missing domain claim ID', 404);
    }

    // 4. POST /api/workspace/custom-domains/:id/refresh
    if (action === 'refresh') {
      if (method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
      }

      const runRefresh = async () => {
        const refreshed = await service.refresh(actorContext, claimId);
        return jsonResponse(refreshed, 200);
      };

      return options?.withWriteLease
        ? options.withWriteLease(actorContext.workspaceId, runRefresh)
        : runRefresh();
    }

    // 5. POST /api/workspace/custom-domains/:id/simulate
    if (action === 'simulate') {
      if (method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
      }

      if (env.ENVIRONMENT === 'production') {
        return errorResponse('forbidden', 'Simulation is not permitted in production', 403);
      }

      const body = (await readBoundedJson(request)) as Record<string, unknown>;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return errorResponse('invalid_body', 'Request body must be a JSON object', 400);
      }

      const allowedSimulateKeys = new Set(['targetStatus', 'status']);
      const unknownSimKeys = Object.keys(body).filter((k) => !allowedSimulateKeys.has(k));
      if (unknownSimKeys.length > 0) {
        return errorResponse(
          'forbidden_fields',
          `Unknown or forbidden fields in simulate body: ${unknownSimKeys.join(', ')}`,
          400,
        );
      }

      const rawStatus =
        typeof body.targetStatus === 'string'
          ? body.targetStatus
          : typeof body.status === 'string'
            ? body.status
            : null;

      if (!rawStatus) {
        return errorResponse(
          'invalid_body',
          'Field "targetStatus" or "status" is required and must be a string',
          400,
        );
      }

      let simulatedStatus: 'ready' | 'pending_validation' | 'failed';
      if (rawStatus === 'ready' || rawStatus === 'active') {
        simulatedStatus = 'ready';
      } else if (rawStatus === 'pending_validation' || rawStatus === 'pending') {
        simulatedStatus = 'pending_validation';
      } else if (rawStatus === 'failed') {
        simulatedStatus = 'failed';
      } else {
        return errorResponse(
          'invalid_target_status',
          'Status must be one of: ready, active, pending_validation, pending, failed',
          400,
        );
      }

      const runSimulate = async () => {
        const simulated = await service.simulate(actorContext, claimId, simulatedStatus);
        return jsonResponse(simulated, 200);
      };

      return options?.withWriteLease
        ? options.withWriteLease(actorContext.workspaceId, runSimulate)
        : runSimulate();
    }

    // 6. DELETE /api/workspace/custom-domains/:id
    if (parts.length === 1 && method === 'DELETE') {
      const runDelete = async () => {
        const deletedResult = await service.remove(actorContext, claimId);
        return jsonResponse(deletedResult, 200);
      };

      return options?.withWriteLease
        ? options.withWriteLease(actorContext.workspaceId, runDelete)
        : runDelete();
    }

    return errorResponse('not_found', 'Route not found', 404);
  } catch (err: unknown) {
    if (err instanceof URIError) {
      return errorResponse('invalid_parameter', 'Malformed percent-encoding', 400);
    }
    if (err instanceof CustomStatusDomainError) {
      return errorResponse(err.code, err.message, err.statusCode);
    }
    if (err instanceof CustomDomainProviderError) {
      return errorResponse(err.code, err.message, err.status ?? 502);
    }
    if (err instanceof CustomHostnameValidationError) {
      return errorResponse(err.code, err.message, 400);
    }
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return errorResponse('internal_error', message, 500);
  }
}

// ---------------------------------------------------------------------------
// Public HTTP Handler
// ---------------------------------------------------------------------------

export interface ResolvedCustomDomainTarget {
  workspaceId: string;
  statusPageId: string;
  publicSlug: string;
  claimId: string;
}

export type SnapshotLoader = (target: {
  workspaceId: string;
  statusPageId: string;
  publicSlug: string;
}) => Promise<StatusPageReportSnapshot | null>;

export interface CustomDomainPublicOptions {
  service?: CustomStatusDomainService;
  clock?: () => number;
}

export interface PublicCustomStatusSnapshotDto {
  schemaVersion: string;
  generatedAt: string;
  latestObservationAt: string | null;
  staleAfterSeconds: number;
  freshness: DerivedFreshnessState;
  statusPage: {
    id: string;
    title: string;
    publicSlug: string | null;
    groups: Array<{
      id: string;
      title: string;
      width: 'full' | 'half';
      showBadges: boolean;
      monitors: Array<{
        id: string;
        name: string | null;
        publicSlug: string | null;
        status: 'up' | 'down' | 'unknown';
        uptimePercentage: number | null;
        recoveryStatus: 'up' | 'down' | 'recovering' | null;
        configuredRegionCount: number;
        affectedRegionIds: RegionId[];
        days: UptimeDay[];
      }>;
    }>;
  };
}

/**
 * Handle public custom status requests on the main API Worker host.
 * Strictly matches ONLY /api/public/custom-status/:hostname and :hostname/snapshot.
 * Root "/" and "/status.json" on customer vanity domains are handled by the dedicated gateway.
 */
export async function handleCustomDomainPublic(
  request: Request,
  env: ApiWorkerCustomDomainEnv,
  loadSnapshot: SnapshotLoader,
  options?: CustomDomainPublicOptions,
): Promise<Response> {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'cache-control': 'no-store' },
    });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  const publicPrefix = '/api/public/custom-status/';
  if (!path.startsWith(publicPrefix)) {
    return notFoundResponse(method, false);
  }

  const rest = path.slice(publicPrefix.length);
  const slashIdx = rest.indexOf('/');
  let rawHostname: string;
  let isSnapshot = false;

  if (slashIdx === -1) {
    rawHostname = rest;
  } else {
    rawHostname = rest.slice(0, slashIdx);
    const sub = rest.slice(slashIdx);
    if (sub === '/snapshot' || sub === '/status.json') {
      isSnapshot = true;
    } else {
      return notFoundResponse(method, false);
    }
  }

  let hostname: string;
  try {
    hostname = decodeURIComponent(rawHostname);
  } catch {
    return errorResponse('invalid_parameter', 'Malformed percent-encoding', 400);
  }

  if (!hostname || !hostname.trim()) {
    return notFoundResponse(method, isSnapshot);
  }

  const service =
    options?.service ??
    createCustomStatusDomainService(env, {
      ...(options?.clock !== undefined ? { clock: options.clock } : {}),
    });

  const target = await service.resolvePublicHost(hostname);
  if (!target) {
    return notFoundResponse(method, isSnapshot);
  }

  const snapshot = await loadSnapshot(target);
  if (!snapshot) {
    return notFoundResponse(method, isSnapshot);
  }

  // Validate snapshot belongs to resolved target to avoid wrong cached page
  if (
    !snapshot.statusPage ||
    snapshot.statusPage.id !== target.statusPageId ||
    snapshot.statusPage.publicSlug !== target.publicSlug
  ) {
    return notFoundResponse(method, isSnapshot);
  }

  const nowMs = options?.clock ? options.clock() : Date.now();
  const freshness = deriveSnapshotFreshness(snapshot, nowMs);

  if (isSnapshot) {
    // Safe allowlist of actual contract fields; URLs, query secrets, and private credentials strictly excluded
    const minimalDto: PublicCustomStatusSnapshotDto = {
      schemaVersion: snapshot.schemaVersion,
      generatedAt: snapshot.generatedAt,
      latestObservationAt: snapshot.latestObservationAt,
      staleAfterSeconds: snapshot.staleAfterSeconds,
      freshness,
      statusPage: {
        id: snapshot.statusPage.id,
        title: snapshot.statusPage.title,
        publicSlug: snapshot.statusPage.publicSlug,
        groups: snapshot.statusPage.groups.map((g) => ({
          id: g.id,
          title: g.title,
          width: g.width,
          showBadges: g.showBadges,
          monitors: g.monitors.map((m) => ({
            id: m.id,
            name: m.name,
            publicSlug: m.publicSlug,
            status: m.status,
            uptimePercentage: m.uptimePercentage,
            recoveryStatus: m.recoveryStatus,
            configuredRegionCount: m.configuredRegionCount,
            affectedRegionIds: m.affectedRegionIds,
            days: m.days,
          })),
        })),
      },
    };

    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };

    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }

    return new Response(JSON.stringify(minimalDto), {
      status: 200,
      headers,
    });
  }

  // Render HTML status page
  const html = renderStatusPageHtml(snapshot, freshness);
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; frame-ancestors 'none';",
  };

  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }

  return new Response(html, {
    status: 200,
    headers,
  });
}

function notFoundResponse(method: string, isJson: boolean): Response {
  if (isJson) {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    return new Response(
      method === 'HEAD'
        ? null
        : JSON.stringify({ error: { code: 'not_found', message: 'Status page not found' } }),
      { status: 404, headers },
    );
  }
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  return new Response(
    method === 'HEAD'
      ? null
      : '<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>404 Not Found</h1></body></html>',
    { status: 404, headers },
  );
}

function renderStatusPageHtml(
  snapshot: StatusPageReportSnapshot,
  freshness: DerivedFreshnessState,
): string {
  const title = escapeHtml(snapshot.statusPage.title || 'Status Page');
  const isStaleOrUnknown = freshness === 'stale' || freshness === 'unknown';

  let generatedAtString = 'Unknown';
  if (snapshot.generatedAt) {
    const parsed = Date.parse(snapshot.generatedAt);
    if (Number.isFinite(parsed)) {
      generatedAtString = new Date(parsed).toUTCString();
    }
  }
  const generatedAt = escapeHtml(generatedAtString);

  const groupsHtml = snapshot.statusPage.groups
    .map((group) => {
      const groupTitle = escapeHtml(group.title || 'Monitors');
      const monitorsHtml = group.monitors
        .map((monitor) => {
          const monitorName = escapeHtml(monitor.name || 'Unnamed');

          // When snapshot is stale or unknown, displayed monitor status is forced to unknown
          const isUp =
            !isStaleOrUnknown && monitor.status === 'up' && monitor.recoveryStatus !== 'recovering';
          const isRecovering = !isStaleOrUnknown && monitor.recoveryStatus === 'recovering';
          const isDown = !isStaleOrUnknown && monitor.status === 'down';

          let badgeColor = '#6b7280';
          let statusText = 'Unknown';

          if (isRecovering) {
            badgeColor = '#f59e0b';
            statusText = 'Recovering';
          } else if (isUp) {
            badgeColor = '#10b981';
            statusText = 'Operational';
          } else if (isDown) {
            badgeColor = '#ef4444';
            statusText = 'Downtime';
          }

          // Historical uptime clearly labelled, no fabricated latency
          let uptimeText = '';
          if (
            typeof monitor.uptimePercentage === 'number' &&
            Number.isFinite(monitor.uptimePercentage)
          ) {
            const formatted = `${monitor.uptimePercentage.toFixed(2)}%`;
            uptimeText = isStaleOrUnknown
              ? `Historical Uptime: ${formatted}`
              : `Uptime: ${formatted}`;
          }

          return `
            <div class=\"monitor-row\">
              <div class=\"monitor-name\">
                <span class=\"status-indicator\" style=\"background-color: ${badgeColor};\"></span>
                <span>${monitorName}</span>
              </div>
              <div class=\"monitor-metrics\">
                ${uptimeText ? `<span class=\"metric\">${escapeHtml(uptimeText)}</span>` : ''}
                <span class=\"badge\" style=\"background-color: ${badgeColor};\">${escapeHtml(statusText)}</span>
              </div>
            </div>`;
        })
        .join('\n');

      return `
        <div class=\"group-card\">
          <h2>${groupTitle}</h2>
          <div class=\"monitors-list\">${monitorsHtml}</div>
        </div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">
  <title>${title}</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 2rem 1rem;
    }
    .container { max-width: 800px; margin: 0 auto; }
    header { margin-bottom: 2rem; }
    h1 { font-size: 1.875rem; font-weight: 700; }
    .stale-banner {
      background-color: #78350f;
      color: #fef3c7;
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      margin-bottom: 1.5rem;
      font-size: 0.875rem;
    }
    .group-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.25rem;
      margin-bottom: 1.5rem;
    }
    .group-card h2 {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--text);
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.5rem;
    }
    .monitor-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .monitor-row:last-child { border-bottom: none; }
    .monitor-name {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-weight: 500;
    }
    .status-indicator {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
    }
    .monitor-metrics {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .metric {
      font-size: 0.875rem;
      color: var(--text-muted);
    }
    .badge {
      font-size: 0.75rem;
      font-weight: 600;
      color: #fff;
      padding: 0.25rem 0.625rem;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.025em;
    }
    footer {
      text-align: center;
      color: var(--text-muted);
      font-size: 0.75rem;
      margin-top: 3rem;
    }
  </style>
</head>
<body>
  <div class=\"container\">
    <header>
      <h1>${title}</h1>
    </header>
    ${isStaleOrUnknown ? `<div class=\"stale-banner\">⚠️ Status data is unverified or outdated (freshness: ${escapeHtml(freshness)})</div>` : ''}
    <main>${groupsHtml}</main>
    <footer>
      <p>Last updated: ${generatedAt}</p>
    </footer>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Reconciliation Scheduled Handler
// ---------------------------------------------------------------------------

export async function reconcileCustomStatusDomains(
  env: ApiWorkerCustomDomainEnv,
  options?: { limit?: number; service?: CustomStatusDomainService },
): Promise<{ reconciled: number; errors: number }> {
  try {
    const service = options?.service ?? createCustomStatusDomainService(env);
    const limit = Math.min(Math.max(options?.limit ?? 10, 1), 10);
    return await service.reconcileDue({ limit });
  } catch {
    return { reconciled: 0, errors: 1 };
  }
}
