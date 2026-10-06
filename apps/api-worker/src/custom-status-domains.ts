import { type RegionId, resolveEffectiveEntitlements } from '@uptime/cloudflare';
import {
  isPostgresUniqueViolation,
  type Database,
  type RuntimePostgresCatalog,
  pgAll,
  pgFirst,
  pgRun,
} from '@uptime/cloudflare/postgres';
import { randomUUID } from 'node:crypto';

import {
  CustomDomainProviderError,
  CustomHostnameValidationError,
  normalizeCustomStatusHostname,
  type CustomDomainProvider,
  type CustomHostnameCnameInstruction,
  type CustomHostnameNormalizedStatus,
  type CustomHostnameValidationRecord,
} from './custom-domain-provider.js';

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

export type CustomStatusDomainStatus =
  | 'creating'
  | 'pending'
  | 'active'
  | 'deleting'
  | 'delete_failed'
  | 'deleted';

export type CustomStatusDomainErrorCode =
  | 'provider_error'
  | 'provider_disabled'
  | 'operator_reconciliation_needed'
  | 'provider_delete_failed'
  | 'quota_exceeded'
  | 'hostname_conflict'
  | 'status_page_not_found'
  | 'status_page_not_public'
  | 'verification_failed'
  | 'verification_expired'
  | 'concurrent_modification'
  | 'imported_workspace_not_supported';

export interface CustomStatusDomainActorContext {
  workspaceId: string;
  actorDid: string;
  role: 'owner' | 'member' | 'viewer';
}

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
  nextCursor?: string | undefined;
  mode: string;
  ready: boolean;
  setupReasons: string[];
  simulation: boolean;
}

export interface CustomStatusDomainServiceDependencies {
  control: Database;
  tenantDbResolver: (workspaceId: string) => Promise<Database> | Database;
  effectiveEntitlementsReader?: (
    control: Database,
    workspaceId: string,
  ) => Promise<{ customDomains: number }> | { customDomains: number };
  configuredRegions?: readonly string[] | readonly RegionId[];
  provider: CustomDomainProvider;
  reservedHostnames?: string[] | Set<string>;
  clock?: () => number;
  maxVerificationFreshnessMs?: number;
  setupReasons?: string[];
  catalog?: RuntimePostgresCatalog | undefined;
}

interface CustomStatusDomainRow {
  id: string;
  workspace_id: string;
  status_page_id: string;
  hostname: string;
  revision: number;
  provider_id: string | null;
  provider_mode: string;
  status: CustomStatusDomainStatus;
  error_code: string | null;
  details_json: string;
  verified_at: string | null;
  recheck_due_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// Custom Status Domain Error
// ---------------------------------------------------------------------------

export class CustomStatusDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'CustomStatusDomainError';
  }
}

// ---------------------------------------------------------------------------
// Constants and Pure Helpers
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_VERIFICATION_FRESHNESS_MS = 24 * 60 * 60 * 1000; // 24 hours
const RECHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const RETRY_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000; // 60 seconds tolerance for future timestamps

function randomId(): string {
  return randomUUID();
}

function validateQuota(quota: unknown): number {
  if (typeof quota !== 'number' || !Number.isFinite(quota) || !Number.isInteger(quota)) {
    return 0;
  }
  return Math.min(Math.max(quota, 0), 1000);
}

export function evaluateDomainEligibility(params: {
  status: string;
  providerMode: string;
  verifiedAt: string | null;
  quotaRank: number;
  quota: number;
  now: number;
  maxVerificationFreshnessMs: number;
  isPagePublic: boolean;
}): { isEligible: boolean; simulationReady: boolean; eligibilityReason: string | null } {
  const isMock = params.providerMode === 'mock';
  const isActive = params.status === 'active';
  const withinQuota = params.quotaRank < params.quota;
  const simulationReady = isMock && isActive;

  if (isMock) {
    return {
      isEligible: false,
      simulationReady,
      eligibilityReason: simulationReady ? 'mock_simulation_ready' : 'mock_pending_simulation',
    };
  }

  if (!isActive) {
    return {
      isEligible: false,
      simulationReady: false,
      eligibilityReason: `domain_${params.status}`,
    };
  }

  if (!withinQuota) {
    return {
      isEligible: false,
      simulationReady: false,
      eligibilityReason: 'quota_exceeded',
    };
  }

  if (!params.isPagePublic) {
    return {
      isEligible: false,
      simulationReady: false,
      eligibilityReason: 'status_page_not_public',
    };
  }

  if (!params.verifiedAt) {
    return {
      isEligible: false,
      simulationReady: false,
      eligibilityReason: 'unverified',
    };
  }

  const verifiedTime = new Date(params.verifiedAt).getTime();
  if (Number.isNaN(verifiedTime)) {
    return {
      isEligible: false,
      simulationReady: false,
      eligibilityReason: 'invalid_verification_timestamp',
    };
  }

  if (verifiedTime > params.now + CLOCK_SKEW_TOLERANCE_MS) {
    return {
      isEligible: false,
      simulationReady: false,
      eligibilityReason: 'verification_future_timestamp',
    };
  }

  const age = params.now - verifiedTime;
  if (age > params.maxVerificationFreshnessMs) {
    return {
      isEligible: false,
      simulationReady: false,
      eligibilityReason: 'verification_expired',
    };
  }

  return { isEligible: true, simulationReady: false, eligibilityReason: null };
}

async function checkStatusPagePublic(
  tenantDb: Database,
  statusPageId: string,
): Promise<{ exists: boolean; isPublic: boolean; publicSlug: string | null }> {
  const page = await pgFirst<{ id: string; public_slug: string | null }>(
    tenantDb,
    `SELECT id, public_slug FROM ${tenantDb.table('status_pages')} WHERE id = $1`,
    [statusPageId],
  );
  if (!page) {
    return { exists: false, isPublic: false, publicSlug: null };
  }
  const isPublic = Boolean(page.public_slug && page.public_slug.trim().length >= 3);
  return { exists: true, isPublic, publicSlug: page.public_slug ?? null };
}

// ---------------------------------------------------------------------------
// Service Implementation
// ---------------------------------------------------------------------------

export class CustomStatusDomainService {
  private readonly control: Database;
  private readonly tenantDbResolver: (workspaceId: string) => Promise<Database> | Database;
  private readonly effectiveEntitlementsReader: (
    control: Database,
    workspaceId: string,
  ) => Promise<{ customDomains: number }> | { customDomains: number };
  private readonly provider: CustomDomainProvider;
  private readonly reservedHostnames?: string[] | Set<string> | undefined;
  private readonly now: () => number;
  private readonly maxVerificationFreshnessMs: number;
  private readonly catalog?: RuntimePostgresCatalog | undefined;
  readonly setupReasons: string[];

  constructor(dependencies: CustomStatusDomainServiceDependencies) {
    this.control = dependencies.control;
    this.tenantDbResolver = dependencies.tenantDbResolver;
    this.provider = dependencies.provider;
    this.reservedHostnames = dependencies.reservedHostnames;
    this.catalog = dependencies.catalog;
    this.now = dependencies.clock ?? Date.now;
    this.setupReasons =
      dependencies.setupReasons ??
      (dependencies.provider.type === 'disabled' ? ['provider_disabled'] : []);

    if (dependencies.effectiveEntitlementsReader) {
      this.effectiveEntitlementsReader = dependencies.effectiveEntitlementsReader;
    } else if (dependencies.configuredRegions) {
      const regions = dependencies.configuredRegions as readonly RegionId[];
      this.effectiveEntitlementsReader = async (control, workspaceId) => {
        const effective = await resolveEffectiveEntitlements(control, workspaceId, regions);
        return { customDomains: effective.entitlements.customDomains };
      };
    } else {
      throw new CustomStatusDomainError(
        'invalid_configuration',
        'CustomStatusDomainService requires either effectiveEntitlementsReader or configuredRegions',
        500,
      );
    }

    const freshness =
      dependencies.maxVerificationFreshnessMs ?? DEFAULT_MAX_VERIFICATION_FRESHNESS_MS;
    if (typeof freshness !== 'number' || !Number.isFinite(freshness) || freshness <= 0) {
      throw new CustomStatusDomainError(
        'invalid_configuration',
        'maxVerificationFreshnessMs must be a finite positive number',
        500,
      );
    }
    this.maxVerificationFreshnessMs = freshness;
  }

  get providerType(): string {
    return this.provider.type;
  }

  get isReady(): boolean {
    return this.provider.type !== 'disabled' && this.setupReasons.length === 0;
  }

  private async assertWorkspaceAccess(
    actorContext: CustomStatusDomainActorContext,
    requiredRole: 'owner' | 'member',
  ): Promise<void> {
    const ws = await pgFirst<{ id: string; state: string }>(
      this.control,
      `SELECT id, state FROM ${this.control.table('workspaces')} WHERE id = $1`,
      [actorContext.workspaceId],
    );
    if (!ws || ws.state === 'deleted') {
      throw new CustomStatusDomainError('workspace_not_found', 'Workspace not found', 404);
    }

    const user = await pgFirst<{ did: string; state: string }>(
      this.control,
      `SELECT did, state FROM ${this.control.table('users')} WHERE did = $1`,
      [actorContext.actorDid],
    );
    if (!user || user.state !== 'active') {
      throw new CustomStatusDomainError('forbidden', 'Active user required', 403);
    }

    const membership = await pgFirst<{ role: string }>(
      this.control,
      `SELECT role FROM ${this.control.table('memberships')} WHERE workspace_id = $1 AND did = $2`,
      [actorContext.workspaceId, actorContext.actorDid],
    );
    if (!membership) {
      throw new CustomStatusDomainError('forbidden', 'Workspace membership required', 403);
    }

    if (requiredRole === 'owner' && membership.role !== 'owner') {
      throw new CustomStatusDomainError(
        'forbidden',
        'Only workspace owners can manage custom domains',
        403,
      );
    }
  }

  private async checkImportedWorkspace(workspaceId: string): Promise<boolean> {
    try {
      const reg = await pgFirst<{ source_database_id: string }>(
        this.control,
        `SELECT source_database_id FROM ${this.control.table('postgres_tenant_registry')} WHERE workspace_id = $1 AND status = 'assigned'`,
        [workspaceId],
      );
      if (reg) {
        if (
          reg.source_database_id === '3900c94a-82a0-4422-a5f8-1a56b781cea7' ||
          reg.source_database_id === '17c009df-5b56-44cc-9776-73e0f1775b0f'
        ) {
          return true;
        }
        if (this.catalog) {
          const entry = this.catalog.sources.find(
            (c) => c.sourceDatabaseId === reg.source_database_id,
          );
          if (
            entry &&
            (entry.profile === 'legacy-staging' ||
              entry.profile === 'legacy-production' ||
              entry.identityTable === 'staging_workspace_identity' ||
              entry.identityTable === 'production_workspace_identity')
          ) {
            return true;
          }
        }
      }
    } catch {
      // Table may not exist in scope
    }

    try {
      const slot = await pgFirst<{ binding_name: string; database_id: string }>(
        this.control,
        `SELECT binding_name, database_id FROM ${this.control.table('tenant_slots')} WHERE workspace_id = $1 AND status = 'assigned'`,
        [workspaceId],
      );
      if (
        slot &&
        (slot.database_id === '3900c94a-82a0-4422-a5f8-1a56b781cea7' ||
          slot.database_id === '17c009df-5b56-44cc-9776-73e0f1775b0f' ||
          slot.binding_name === 'DB_IMPORTED_TENANT_STAGING' ||
          slot.binding_name === 'DB_IMPORTED_TENANT_PRODUCTION' ||
          slot.binding_name.includes('IMPORTED'))
      ) {
        return true;
      }
    } catch {
      // Table may not exist in scope
    }

    return false;
  }

  private async assertSupportedWorkspace(workspaceId: string): Promise<void> {
    const isImported = await this.checkImportedWorkspace(workspaceId);
    if (isImported) {
      throw new CustomStatusDomainError(
        'imported_workspace_not_supported',
        'Custom domains are not supported on imported workspaces',
        400,
      );
    }
  }

  /**
   * List custom status domains for a workspace with deterministic quota cutoff and pagination.
   */
  async list(
    actorContext: CustomStatusDomainActorContext,
    options?: { limit?: number; cursor?: string },
  ): Promise<CustomStatusDomainListResponse> {
    await this.assertWorkspaceAccess(actorContext, 'member');

    const entitlements = await this.effectiveEntitlementsReader(
      this.control,
      actorContext.workspaceId,
    );
    const quota = validateQuota(entitlements.customDomains);

    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 1000);
    const cursor = options?.cursor;

    let rows: CustomStatusDomainRow[];
    if (cursor) {
      const cursorRow = await pgFirst<{ created_at: string; id: string }>(
        this.control,
        `SELECT created_at, id FROM ${this.control.table('custom_status_domains')} WHERE id = $1 AND workspace_id = $2`,
        [cursor, actorContext.workspaceId],
      );
      if (cursorRow) {
        rows = await pgAll<CustomStatusDomainRow>(
          this.control,
          `SELECT * FROM ${this.control.table('custom_status_domains')}
           WHERE workspace_id = $1 AND deleted_at IS NULL
             AND (created_at > $2 OR (created_at = $2 AND id > $3))
           ORDER BY created_at ASC, id ASC
           LIMIT $4`,
          [actorContext.workspaceId, cursorRow.created_at, cursorRow.id, limit + 1],
        );
      } else {
        rows = await pgAll<CustomStatusDomainRow>(
          this.control,
          `SELECT * FROM ${this.control.table('custom_status_domains')}
           WHERE workspace_id = $1 AND deleted_at IS NULL
           ORDER BY created_at ASC, id ASC
           LIMIT $2`,
          [actorContext.workspaceId, limit + 1],
        );
      }
    } else {
      rows = await pgAll<CustomStatusDomainRow>(
        this.control,
        `SELECT * FROM ${this.control.table('custom_status_domains')}
         WHERE workspace_id = $1 AND deleted_at IS NULL
         ORDER BY created_at ASC, id ASC
         LIMIT $2`,
        [actorContext.workspaceId, limit + 1],
      );
    }

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1]?.id : undefined;

    const totalActiveRow = await pgFirst<{ count: number }>(
      this.control,
      `SELECT count(*)::int AS count FROM ${this.control.table('custom_status_domains')} WHERE workspace_id = $1 AND status = 'active' AND deleted_at IS NULL`,
      [actorContext.workspaceId],
    );
    const totalActive = totalActiveRow?.count ?? 0;

    const tenantDb = await this.tenantDbResolver(actorContext.workspaceId);

    const dtos: CustomStatusDomainDTO[] = await Promise.all(
      pageRows.map(async (row) => {
        let details: Record<string, unknown> = {};
        try {
          details = row.details_json ? JSON.parse(row.details_json) : {};
        } catch {
          // Ignored
        }

        const cnameInstruction =
          (details.cnameInstruction as CustomHostnameCnameInstruction) ?? null;
        const validationRecords =
          (details.validationRecords as CustomHostnameValidationRecord[]) ?? [];

        const pageCheck = await checkStatusPagePublic(tenantDb, row.status_page_id);

        let quotaRank = 0;
        if (row.status === 'active') {
          const rankRow = await pgFirst<{ rank_count: number }>(
            this.control,
            `SELECT count(*)::int AS rank_count
             FROM ${this.control.table('custom_status_domains')}
             WHERE workspace_id = $1 AND status = 'active' AND deleted_at IS NULL
               AND (created_at < $2 OR (created_at = $2 AND id < $3))`,
            [actorContext.workspaceId, row.created_at, row.id],
          );
          quotaRank = rankRow?.rank_count ?? 0;
        } else {
          quotaRank = 999999;
        }

        const eligibility = evaluateDomainEligibility({
          status: row.status,
          providerMode: row.provider_mode,
          verifiedAt: row.verified_at,
          quotaRank,
          quota,
          now: this.now(),
          maxVerificationFreshnessMs: this.maxVerificationFreshnessMs,
          isPagePublic: pageCheck.isPublic,
        });

        return {
          id: row.id,
          workspaceId: row.workspace_id,
          statusPageId: row.status_page_id,
          hostname: row.hostname,
          providerMode: row.provider_mode,
          status: row.status,
          isEligible: eligibility.isEligible,
          simulationReady: eligibility.simulationReady,
          eligibilityReason: eligibility.eligibilityReason,
          errorCode: row.error_code,
          verifiedAt: row.verified_at,
          recheckDueAt: row.recheck_due_at,
          cnameInstruction,
          validationRecords,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
    );

    const mode = this.provider.type;
    const ready = mode !== 'disabled' && this.setupReasons.length === 0;
    const simulation = mode === 'mock';

    return {
      domains: dtos,
      quota,
      totalActive,
      hasMore,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      mode,
      ready,
      setupReasons: this.setupReasons,
      simulation,
    };
  }

  /**
   * Create and register a custom status domain claim.
   * Atomically reserves quota and unique constraints in a transaction locking workspace FOR NO KEY UPDATE.
   */
  async create(
    actorContext: CustomStatusDomainActorContext,
    options: {
      statusPageId: string;
      hostname: string;
    },
  ): Promise<CustomStatusDomainDTO> {
    await this.assertWorkspaceAccess(actorContext, 'owner');

    let canonicalHostname: string;
    try {
      canonicalHostname = normalizeCustomStatusHostname(options.hostname, {
        reservedHostnames: this.reservedHostnames,
      });
    } catch (err: unknown) {
      if (err instanceof CustomHostnameValidationError) {
        throw new CustomStatusDomainError(err.code, err.message, 400);
      }
      if (err instanceof CustomDomainProviderError) {
        throw new CustomStatusDomainError(err.code, err.message, err.status ?? 400);
      }
      throw err;
    }

    await this.assertSupportedWorkspace(actorContext.workspaceId);

    const tenantDb = await this.tenantDbResolver(actorContext.workspaceId);
    const pageCheck = await checkStatusPagePublic(tenantDb, options.statusPageId);
    if (!pageCheck.exists) {
      throw new CustomStatusDomainError('status_page_not_found', 'Status page not found', 404);
    }
    if (!pageCheck.isPublic) {
      throw new CustomStatusDomainError(
        'status_page_not_public',
        'Status page must be published with a public slug to attach a custom domain',
        400,
      );
    }

    const existingPageClaim = await pgFirst<CustomStatusDomainRow>(
      this.control,
      `SELECT * FROM ${this.control.table('custom_status_domains')} WHERE workspace_id = $1 AND status_page_id = $2 AND deleted_at IS NULL`,
      [actorContext.workspaceId, options.statusPageId],
    );

    if (existingPageClaim) {
      if (existingPageClaim.hostname === canonicalHostname) {
        let details: Record<string, unknown> = {};
        try {
          details = existingPageClaim.details_json
            ? JSON.parse(existingPageClaim.details_json)
            : {};
        } catch {
          // Ignored
        }
        const cnameInstruction =
          (details.cnameInstruction as CustomHostnameCnameInstruction) ?? null;
        const validationRecords =
          (details.validationRecords as CustomHostnameValidationRecord[]) ?? [];

        const entitlements = await this.effectiveEntitlementsReader(
          this.control,
          actorContext.workspaceId,
        );
        const quota = validateQuota(entitlements.customDomains);
        const rankRow = await pgFirst<{ rank_count: number }>(
          this.control,
          `SELECT count(*)::int AS rank_count
           FROM ${this.control.table('custom_status_domains')}
           WHERE workspace_id = $1 AND status = 'active' AND deleted_at IS NULL
             AND (created_at < $2 OR (created_at = $2 AND id < $3))`,
          [
            actorContext.workspaceId,
            existingPageClaim.created_at,
            existingPageClaim.id,
          ],
        );

        const eligibility = evaluateDomainEligibility({
          status: existingPageClaim.status,
          providerMode: existingPageClaim.provider_mode,
          verifiedAt: existingPageClaim.verified_at,
          quotaRank: rankRow?.rank_count ?? 0,
          quota,
          now: this.now(),
          maxVerificationFreshnessMs: this.maxVerificationFreshnessMs,
          isPagePublic: true,
        });

        return {
          id: existingPageClaim.id,
          workspaceId: existingPageClaim.workspace_id,
          statusPageId: existingPageClaim.status_page_id,
          hostname: existingPageClaim.hostname,
          providerMode: existingPageClaim.provider_mode,
          status: existingPageClaim.status,
          isEligible: eligibility.isEligible,
          simulationReady: eligibility.simulationReady,
          eligibilityReason: eligibility.eligibilityReason,
          errorCode: existingPageClaim.error_code,
          verifiedAt: existingPageClaim.verified_at,
          recheckDueAt: existingPageClaim.recheck_due_at,
          cnameInstruction,
          validationRecords,
          createdAt: existingPageClaim.created_at,
          updatedAt: existingPageClaim.updated_at,
        };
      }
      throw new CustomStatusDomainError(
        'page_already_has_domain',
        'This status page already has a custom domain assigned',
        409,
      );
    }

    const existingHostClaim = await pgFirst<{ id: string; workspace_id: string }>(
      this.control,
      `SELECT id, workspace_id FROM ${this.control.table('custom_status_domains')} WHERE hostname = $1 AND deleted_at IS NULL`,
      [canonicalHostname],
    );

    if (existingHostClaim) {
      throw new CustomStatusDomainError(
        'hostname_already_claimed',
        existingHostClaim.workspace_id === actorContext.workspaceId
          ? 'Hostname is already registered in this workspace'
          : 'Hostname is already claimed by another workspace',
        409,
      );
    }

    const entitlements = await this.effectiveEntitlementsReader(
      this.control,
      actorContext.workspaceId,
    );
    const quota = validateQuota(entitlements.customDomains);
    if (quota <= 0) {
      throw new CustomStatusDomainError(
        'quota_exceeded',
        'Custom domains are not available on your current plan',
        403,
      );
    }

    const claimId = `csd_${randomId()}`;
    const nowIso = new Date(this.now()).toISOString();

    // Atomic reservation before network: lock workspaces FOR NO KEY UPDATE, check quota, insert reservation & audit
    try {
      await this.control.transaction(async (tx) => {
        const ws = await pgFirst<{ id: string }>(
          tx,
          `SELECT id FROM ${tx.table('workspaces')} WHERE id = $1 FOR NO KEY UPDATE`,
          [actorContext.workspaceId],
        );
        if (!ws) {
          throw new CustomStatusDomainError('workspace_not_found', 'Workspace not found', 404);
        }

        const countRow = await pgFirst<{ count: number }>(
          tx,
          `SELECT count(*)::int AS count FROM ${tx.table('custom_status_domains')} WHERE workspace_id = $1 AND deleted_at IS NULL`,
          [actorContext.workspaceId],
        );
        const activeCount = countRow?.count ?? 0;
        if (activeCount >= quota) {
          throw new CustomStatusDomainError(
            'quota_exceeded',
            'Custom domain quota exceeded for workspace tier',
            403,
          );
        }

        await pgRun(
          tx,
          `INSERT INTO ${tx.table('custom_status_domains')} (
            id, workspace_id, status_page_id, hostname, revision,
            provider_id, provider_mode, status, error_code, details_json,
            verified_at, recheck_due_at, created_at, updated_at, deleted_at
          ) VALUES (
            $1, $2, $3, $4, 1,
            NULL, $5, 'creating', NULL, '{}',
            NULL, NULL, $6, $6, NULL
          )`,
          [
            claimId,
            actorContext.workspaceId,
            options.statusPageId,
            canonicalHostname,
            this.provider.type,
            nowIso,
          ],
        );

        await pgRun(
          tx,
          `INSERT INTO ${tx.table('workspace_events')} (id, workspace_id, event, actor_did, created_at, details)
           VALUES ($1, $2, 'custom_domain.created', $3, $4, $5)`,
          [
            randomId(),
            actorContext.workspaceId,
            actorContext.actorDid,
            nowIso,
            JSON.stringify({
              claimId,
              hostname: canonicalHostname,
              statusPageId: options.statusPageId,
            }),
          ],
        );
      });
    } catch (err: unknown) {
      if (err instanceof CustomStatusDomainError) {
        throw err;
      }
      if (isPostgresUniqueViolation(err)) {
        const message = err instanceof Error ? err.message : String(err);
        const constraint = (err as { constraint?: string }).constraint ?? '';
        if (constraint.includes('hostname') || message.includes('hostname')) {
          throw new CustomStatusDomainError(
            'hostname_already_claimed',
            'Hostname is already claimed by another workspace',
            409,
          );
        }
        if (
          constraint.includes('page') ||
          constraint.includes('status_page') ||
          message.includes('status_page')
        ) {
          throw new CustomStatusDomainError(
            'page_already_has_domain',
            'This status page already has a custom domain assigned',
            409,
          );
        }
        throw new CustomStatusDomainError(
          'hostname_conflict',
          'A conflicting custom domain claim exists',
          409,
        );
      }
      throw err;
    }

    // Call provider network (outside transaction)
    let providerDetails: {
      providerId: string;
      status: CustomHostnameNormalizedStatus;
      cnameInstruction: CustomHostnameCnameInstruction | null;
      validationRecords: CustomHostnameValidationRecord[];
    };

    try {
      const created = await this.provider.createCustomHostname({
        hostname: canonicalHostname,
      });
      providerDetails = {
        providerId: created.providerId,
        status: created.status,
        cnameInstruction: created.cnameInstruction,
        validationRecords: created.validationRecords,
      };
    } catch (err: unknown) {
      // Remote call failed, clean up reservation row
      await pgRun(
        this.control,
        `DELETE FROM ${this.control.table('custom_status_domains')} WHERE id = $1 AND status = $2`,
        [claimId, 'creating'],
      );
      if (err instanceof CustomDomainProviderError) {
        throw new CustomStatusDomainError(err.code, err.message, err.status ?? 502);
      }
      throw new CustomStatusDomainError(
        'provider_error',
        err instanceof Error ? err.message : 'Upstream provider creation failed',
        502,
      );
    }

    const nextStatus: CustomStatusDomainStatus =
      providerDetails.status === 'ready' ? 'active' : 'pending';
    const verifiedAt = nextStatus === 'active' ? nowIso : null;
    const recheckDueAt =
      nextStatus === 'active'
        ? new Date(this.now() + RECHECK_INTERVAL_MS).toISOString()
        : new Date(this.now() + RETRY_BACKOFF_MS).toISOString();

    const detailsJson = JSON.stringify({
      cnameInstruction: providerDetails.cnameInstruction,
      validationRecords: providerDetails.validationRecords,
    });
    const updatedIso = new Date(this.now()).toISOString();

    // Finalize claim with provider_id via CAS
    const updateResult = await pgRun(
      this.control,
      `UPDATE ${this.control.table('custom_status_domains')}
       SET provider_id = $1, status = $2, details_json = $3, verified_at = $4, recheck_due_at = $5, updated_at = $6, revision = revision + 1
       WHERE id = $7 AND revision = 1 AND status = 'creating' AND deleted_at IS NULL`,
      [
        providerDetails.providerId,
        nextStatus,
        detailsJson,
        verifiedAt,
        recheckDueAt,
        updatedIso,
        claimId,
      ],
    );

    if (updateResult.rowCount === 0) {
      // Concurrency race: claim row was modified (e.g. remove() marked it deleting)
      // Retain provider_id for tombstone cleanup so remote resource is not orphaned
      await pgRun(
        this.control,
        `UPDATE ${this.control.table('custom_status_domains')}
         SET provider_id = $1, updated_at = $2
         WHERE id = $3 AND provider_id IS NULL`,
        [providerDetails.providerId, updatedIso, claimId],
      );
      throw new CustomStatusDomainError(
        'concurrent_modification',
        'Custom domain claim was modified concurrently during creation',
        409,
      );
    }

    const rankRow = await pgFirst<{ rank_count: number }>(
      this.control,
      `SELECT count(*)::int AS rank_count
       FROM ${this.control.table('custom_status_domains')}
       WHERE workspace_id = $1 AND status = 'active' AND deleted_at IS NULL
         AND (created_at < $2 OR (created_at = $2 AND id < $3))`,
      [actorContext.workspaceId, nowIso, claimId],
    );

    const eligibility = evaluateDomainEligibility({
      status: nextStatus,
      providerMode: this.provider.type,
      verifiedAt,
      quotaRank: rankRow?.rank_count ?? 0,
      quota,
      now: this.now(),
      maxVerificationFreshnessMs: this.maxVerificationFreshnessMs,
      isPagePublic: true,
    });

    return {
      id: claimId,
      workspaceId: actorContext.workspaceId,
      statusPageId: options.statusPageId,
      hostname: canonicalHostname,
      providerMode: this.provider.type,
      status: nextStatus,
      isEligible: eligibility.isEligible,
      simulationReady: eligibility.simulationReady,
      eligibilityReason: eligibility.eligibilityReason,
      errorCode: null,
      verifiedAt,
      recheckDueAt,
      cnameInstruction: providerDetails.cnameInstruction,
      validationRecords: providerDetails.validationRecords,
      createdAt: nowIso,
      updatedAt: updatedIso,
    };
  }

  /**
   * Refresh validation status from upstream provider.
   */
  async refresh(
    actorContext: CustomStatusDomainActorContext,
    claimId: string,
  ): Promise<CustomStatusDomainDTO> {
    await this.assertWorkspaceAccess(actorContext, 'owner');

    const claim = await pgFirst<CustomStatusDomainRow>(
      this.control,
      `SELECT * FROM ${this.control.table('custom_status_domains')} WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [claimId, actorContext.workspaceId],
    );

    if (!claim) {
      throw new CustomStatusDomainError('not_found', 'Custom domain claim not found', 404);
    }

    if (claim.status !== 'pending' && claim.status !== 'active') {
      throw new CustomStatusDomainError(
        'invalid_state',
        `Cannot refresh custom domain in ${claim.status} state`,
        400,
      );
    }

    if (claim.provider_mode !== this.provider.type) {
      throw new CustomStatusDomainError(
        'provider_mode_mismatch',
        `Provider mode mismatch: claim is in ${claim.provider_mode} mode but configured provider is ${this.provider.type}`,
        409,
      );
    }

    if (this.provider.type === 'disabled') {
      throw new CustomStatusDomainError(
        'provider_disabled',
        'Custom domain provider is disabled',
        503,
      );
    }

    let nextStatus: CustomStatusDomainStatus = claim.status;
    let verifiedAt: string | null = claim.verified_at;
    let recheckDueAt: string | null = claim.recheck_due_at;
    let errorCode: string | null = claim.error_code;
    let cnameInstruction: CustomHostnameCnameInstruction | null = null;
    let validationRecords: CustomHostnameValidationRecord[] = [];

    if (this.provider.type === 'mock') {
      // Mock refresh reads durable state directly from CONTROL
      let storedDetails: Record<string, unknown> = {};
      try {
        storedDetails = claim.details_json ? JSON.parse(claim.details_json) : {};
      } catch {
        // Ignored
      }
      cnameInstruction = (storedDetails.cnameInstruction as CustomHostnameCnameInstruction) ?? null;
      validationRecords =
        (storedDetails.validationRecords as CustomHostnameValidationRecord[]) ?? [];
      nextStatus = claim.status;
      verifiedAt = claim.verified_at;
      recheckDueAt =
        nextStatus === 'active'
          ? new Date(this.now() + RECHECK_INTERVAL_MS).toISOString()
          : new Date(this.now() + RETRY_BACKOFF_MS).toISOString();
    } else {
      if (!claim.provider_id) {
        throw new CustomStatusDomainError(
          'missing_provider_id',
          'Domain claim has no provider ID; cannot query upstream provider',
          400,
        );
      }

      try {
        const remote = await this.provider.getCustomHostname({
          providerId: claim.provider_id,
          expectedHostname: claim.hostname,
        });
        cnameInstruction = remote.cnameInstruction;
        validationRecords = remote.validationRecords;

        if (remote.status === 'ready') {
          nextStatus = 'active';
          verifiedAt = new Date(this.now()).toISOString();
          recheckDueAt = new Date(this.now() + RECHECK_INTERVAL_MS).toISOString();
          errorCode = null;
        } else {
          nextStatus = 'pending';
          recheckDueAt = new Date(this.now() + RETRY_BACKOFF_MS).toISOString();
        }
      } catch (err: unknown) {
        if (err instanceof CustomDomainProviderError) {
          throw new CustomStatusDomainError(err.code, err.message, err.status ?? 502);
        }
        throw new CustomStatusDomainError(
          'provider_error',
          err instanceof Error ? err.message : 'Upstream provider query failed',
          502,
        );
      }
    }

    const detailsJson = JSON.stringify({ cnameInstruction, validationRecords });
    const nowIso = new Date(this.now()).toISOString();

    await this.control.transaction(async (tx) => {
      const updateResult = await pgRun(
        tx,
        `UPDATE ${tx.table('custom_status_domains')}
         SET status = $1, details_json = $2, error_code = $3, verified_at = $4, recheck_due_at = $5, updated_at = $6, revision = revision + 1
         WHERE id = $7 AND revision = $8 AND deleted_at IS NULL AND status IN ('pending', 'active')`,
        [
          nextStatus,
          detailsJson,
          errorCode,
          verifiedAt,
          recheckDueAt,
          nowIso,
          claim.id,
          claim.revision,
        ],
      );

      if (updateResult.rowCount === 0) {
        throw new CustomStatusDomainError(
          'concurrent_modification',
          'Custom domain claim was modified concurrently during refresh',
          409,
        );
      }

      await pgRun(
        tx,
        `INSERT INTO ${tx.table('workspace_events')} (id, workspace_id, event, actor_did, created_at, details)
         VALUES ($1, $2, 'custom_domain.refreshed', $3, $4, $5)`,
        [
          randomId(),
          actorContext.workspaceId,
          actorContext.actorDid,
          nowIso,
          JSON.stringify({
            claimId: claim.id,
            hostname: claim.hostname,
            status: nextStatus,
          }),
        ],
      );
    });

    const tenantDb = await this.tenantDbResolver(actorContext.workspaceId);
    const pageCheck = await checkStatusPagePublic(tenantDb, claim.status_page_id);

    const entitlements = await this.effectiveEntitlementsReader(
      this.control,
      actorContext.workspaceId,
    );
    const quota = validateQuota(entitlements.customDomains);
    const rankRow = await pgFirst<{ rank_count: number }>(
      this.control,
      `SELECT count(*)::int AS rank_count
       FROM ${this.control.table('custom_status_domains')}
       WHERE workspace_id = $1 AND status = 'active' AND deleted_at IS NULL
         AND (created_at < $2 OR (created_at = $2 AND id < $3))`,
      [actorContext.workspaceId, claim.created_at, claim.id],
    );

    const eligibility = evaluateDomainEligibility({
      status: nextStatus,
      providerMode: claim.provider_mode,
      verifiedAt,
      quotaRank: rankRow?.rank_count ?? 0,
      quota,
      now: this.now(),
      maxVerificationFreshnessMs: this.maxVerificationFreshnessMs,
      isPagePublic: pageCheck.isPublic,
    });

    return {
      id: claim.id,
      workspaceId: claim.workspace_id,
      statusPageId: claim.status_page_id,
      hostname: claim.hostname,
      providerMode: claim.provider_mode,
      status: nextStatus,
      isEligible: eligibility.isEligible,
      simulationReady: eligibility.simulationReady,
      eligibilityReason: eligibility.eligibilityReason,
      errorCode,
      verifiedAt,
      recheckDueAt,
      cnameInstruction,
      validationRecords,
      createdAt: claim.created_at,
      updatedAt: nowIso,
    };
  }

  /**
   * Remove a custom status domain.
   * Two-phase removal: conditional tombstone, remote delete, confirmed release in transaction with audit.
   */
  async remove(
    actorContext: CustomStatusDomainActorContext,
    claimId: string,
  ): Promise<{ id: string; deleted: boolean }> {
    await this.assertWorkspaceAccess(actorContext, 'owner');

    const claim = await pgFirst<CustomStatusDomainRow>(
      this.control,
      `SELECT * FROM ${this.control.table('custom_status_domains')} WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [claimId, actorContext.workspaceId],
    );

    if (!claim) {
      throw new CustomStatusDomainError('not_found', 'Custom domain claim not found', 404);
    }

    const nowIso = new Date(this.now()).toISOString();

    if (this.provider.type === 'disabled') {
      await pgRun(
        this.control,
        `UPDATE ${this.control.table('custom_status_domains')}
         SET status = 'delete_failed', error_code = 'provider_disabled', revision = revision + 1, updated_at = $1
         WHERE id = $2 AND revision = $3 AND deleted_at IS NULL`,
        [nowIso, claim.id, claim.revision],
      );
      throw new CustomStatusDomainError(
        'provider_disabled',
        'Custom domain provider is disabled; cannot safely release host without confirmed remote deletion',
        409,
      );
    }

    if (claim.provider_mode !== this.provider.type) {
      throw new CustomStatusDomainError(
        'provider_mode_mismatch',
        `Provider mode mismatch: claim is in ${claim.provider_mode} mode but configured provider is ${this.provider.type}`,
        409,
      );
    }

    if (!claim.provider_id) {
      await pgRun(
        this.control,
        `UPDATE ${this.control.table('custom_status_domains')}
         SET status = 'delete_failed', error_code = 'operator_reconciliation_needed', revision = revision + 1, updated_at = $1
         WHERE id = $2 AND revision = $3 AND deleted_at IS NULL`,
        [nowIso, claim.id, claim.revision],
      );
      throw new CustomStatusDomainError(
        'operator_reconciliation_needed',
        'Claim creation unconfirmed; operator reconciliation required before releasing hostname',
        409,
      );
    }

    // Phase 1: Local conditional tombstone
    const tombstoneResult = await pgRun(
      this.control,
      `UPDATE ${this.control.table('custom_status_domains')}
       SET status = 'deleting', revision = revision + 1, updated_at = $1
       WHERE id = $2 AND revision = $3 AND deleted_at IS NULL AND status IN ('pending', 'active', 'delete_failed')`,
      [nowIso, claim.id, claim.revision],
    );

    if (tombstoneResult.rowCount === 0) {
      throw new CustomStatusDomainError(
        'concurrent_modification',
        'Custom domain claim was modified concurrently',
        409,
      );
    }

    const currentRevision = claim.revision + 1;

    // Phase 2: Upstream provider delete (outside transaction)
    try {
      await this.provider.deleteCustomHostname({
        providerId: claim.provider_id,
        expectedHostname: claim.hostname,
      });
    } catch (err: unknown) {
      await pgRun(
        this.control,
        `UPDATE ${this.control.table('custom_status_domains')}
         SET status = 'delete_failed', error_code = 'provider_delete_failed', revision = revision + 1, updated_at = $1
         WHERE id = $2 AND revision = $3 AND deleted_at IS NULL`,
        [new Date(this.now()).toISOString(), claim.id, currentRevision],
      );
      if (err instanceof CustomDomainProviderError) {
        throw new CustomStatusDomainError(
          err.code,
          `Failed to remove custom hostname from upstream provider: ${err.message}`,
          err.status ?? 502,
        );
      }
      throw new CustomStatusDomainError(
        'provider_error',
        'Failed to remove custom hostname from upstream provider',
        502,
      );
    }

    // Phase 3: Confirmed cleanup releases hostname in atomic transaction with audit
    const releasedIso = new Date(this.now()).toISOString();
    await this.control.transaction(async (tx) => {
      const updateResult = await pgRun(
        tx,
        `UPDATE ${tx.table('custom_status_domains')}
         SET status = 'deleted', deleted_at = $1, updated_at = $2, revision = revision + 1
         WHERE id = $3 AND revision = $4 AND deleted_at IS NULL`,
        [releasedIso, releasedIso, claim.id, currentRevision],
      );

      if (updateResult.rowCount === 0) {
        throw new CustomStatusDomainError(
          'concurrent_modification',
          'Custom domain claim was modified concurrently during deletion release',
          409,
        );
      }

      await pgRun(
        tx,
        `INSERT INTO ${tx.table('workspace_events')} (id, workspace_id, event, actor_did, created_at, details)
         VALUES ($1, $2, 'custom_domain.removed', $3, $4, $5)`,
        [
          randomId(),
          actorContext.workspaceId,
          actorContext.actorDid,
          releasedIso,
          JSON.stringify({ claimId: claim.id, hostname: claim.hostname }),
        ],
      );
    });

    return { id: claim.id, deleted: true };
  }

  /**
   * Simulate verification lifecycle for test / mock development environments.
   * Updates state durably in CONTROL without depending on ephemeral in-memory state.
   */
  async simulate(
    actorContext: CustomStatusDomainActorContext,
    claimId: string,
    simulatedStatus: 'ready' | 'pending_validation' | 'failed',
  ): Promise<CustomStatusDomainDTO> {
    await this.assertWorkspaceAccess(actorContext, 'owner');

    const claim = await pgFirst<CustomStatusDomainRow>(
      this.control,
      `SELECT * FROM ${this.control.table('custom_status_domains')} WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [claimId, actorContext.workspaceId],
    );

    if (!claim) {
      throw new CustomStatusDomainError('not_found', 'Custom domain claim not found', 404);
    }

    if (claim.status !== 'pending' && claim.status !== 'active') {
      throw new CustomStatusDomainError(
        'invalid_state',
        `Cannot simulate custom domain in ${claim.status} state`,
        400,
      );
    }

    if (claim.provider_mode !== 'mock' || this.provider.type !== 'mock') {
      throw new CustomStatusDomainError(
        'simulation_not_supported',
        'Simulation is only available when both domain claim and service provider are in mock mode',
        400,
      );
    }

    const nextStatus: CustomStatusDomainStatus = simulatedStatus === 'ready' ? 'active' : 'pending';
    const nowIso = new Date(this.now()).toISOString();
    const verifiedAt = simulatedStatus === 'ready' ? nowIso : null;
    const recheckDueAt =
      nextStatus === 'active'
        ? new Date(this.now() + RECHECK_INTERVAL_MS).toISOString()
        : new Date(this.now() + RETRY_BACKOFF_MS).toISOString();
    const errorCode = simulatedStatus === 'failed' ? 'simulation_verification_failed' : null;

    let details: Record<string, unknown> = {};
    try {
      details = claim.details_json ? JSON.parse(claim.details_json) : {};
    } catch {
      // Ignored
    }

    const cnameInstruction = (details.cnameInstruction as CustomHostnameCnameInstruction) ?? null;
    const validationRecords = (details.validationRecords as CustomHostnameValidationRecord[]) ?? [];
    const detailsJson = JSON.stringify({ cnameInstruction, validationRecords });

    await this.control.transaction(async (tx) => {
      const updateResult = await pgRun(
        tx,
        `UPDATE ${tx.table('custom_status_domains')}
         SET status = $1, details_json = $2, error_code = $3, verified_at = $4, recheck_due_at = $5, updated_at = $6, revision = revision + 1
         WHERE id = $7 AND revision = $8 AND deleted_at IS NULL AND status IN ('pending', 'active')`,
        [
          nextStatus,
          detailsJson,
          errorCode,
          verifiedAt,
          recheckDueAt,
          nowIso,
          claim.id,
          claim.revision,
        ],
      );

      if (updateResult.rowCount === 0) {
        throw new CustomStatusDomainError(
          'concurrent_modification',
          'Custom domain claim was modified concurrently during simulation',
          409,
        );
      }

      await pgRun(
        tx,
        `INSERT INTO ${tx.table('workspace_events')} (id, workspace_id, event, actor_did, created_at, details)
         VALUES ($1, $2, 'custom_domain.simulated', $3, $4, $5)`,
        [
          randomId(),
          actorContext.workspaceId,
          actorContext.actorDid,
          nowIso,
          JSON.stringify({ claimId: claim.id, hostname: claim.hostname, simulatedStatus }),
        ],
      );
    });

    const tenantDb = await this.tenantDbResolver(actorContext.workspaceId);
    const pageCheck = await checkStatusPagePublic(tenantDb, claim.status_page_id);

    const entitlements = await this.effectiveEntitlementsReader(
      this.control,
      actorContext.workspaceId,
    );
    const quota = validateQuota(entitlements.customDomains);
    const rankRow = await pgFirst<{ rank_count: number }>(
      this.control,
      `SELECT count(*)::int AS rank_count
       FROM ${this.control.table('custom_status_domains')}
       WHERE workspace_id = $1 AND status = 'active' AND deleted_at IS NULL
         AND (created_at < $2 OR (created_at = $2 AND id < $3))`,
      [actorContext.workspaceId, claim.created_at, claim.id],
    );

    const eligibility = evaluateDomainEligibility({
      status: nextStatus,
      providerMode: 'mock',
      verifiedAt,
      quotaRank: rankRow?.rank_count ?? 0,
      quota,
      now: this.now(),
      maxVerificationFreshnessMs: this.maxVerificationFreshnessMs,
      isPagePublic: pageCheck.isPublic,
    });

    return {
      id: claim.id,
      workspaceId: claim.workspace_id,
      statusPageId: claim.status_page_id,
      hostname: claim.hostname,
      providerMode: 'mock',
      status: nextStatus,
      isEligible: eligibility.isEligible,
      simulationReady: eligibility.simulationReady,
      eligibilityReason: eligibility.eligibilityReason,
      errorCode,
      verifiedAt,
      recheckDueAt,
      cnameInstruction,
      validationRecords,
      createdAt: claim.created_at,
      updatedAt: nowIso,
    };
  }

  /**
   * Reconcile due status domains across the system.
   * Privileged scheduled background method without actor role spoofing.
   */
  async reconcileDue(options?: {
    limit?: number;
    provider?: CustomDomainProvider;
  }): Promise<{ reconciled: number; errors: number }> {
    const limit = Math.min(Math.max(options?.limit ?? 10, 1), 10);
    const activeProvider = options?.provider ?? this.provider;
    const nowIso = new Date(this.now()).toISOString();

    const claims = await pgAll<CustomStatusDomainRow>(
      this.control,
      `SELECT * FROM ${this.control.table('custom_status_domains')}
       WHERE deleted_at IS NULL
         AND status IN ('pending', 'active')
         AND recheck_due_at IS NOT NULL
         AND recheck_due_at <= $1
       ORDER BY recheck_due_at ASC
       LIMIT $2`,
      [nowIso, limit],
    );

    let reconciled = 0;
    let errors = 0;

    for (const claim of claims) {
      if (claim.provider_mode !== activeProvider.type || activeProvider.type === 'disabled') {
        errors++;
        const nextBackoffIso = new Date(this.now() + RETRY_BACKOFF_MS).toISOString();
        await pgRun(
          this.control,
          `UPDATE ${this.control.table('custom_status_domains')}
           SET error_code = 'provider_mode_mismatch', recheck_due_at = $1, updated_at = $2, revision = revision + 1
           WHERE id = $3 AND revision = $4 AND deleted_at IS NULL`,
          [nextBackoffIso, nowIso, claim.id, claim.revision],
        );
        continue;
      }

      if (!claim.provider_id) {
        errors++;
        const nextBackoffIso = new Date(this.now() + RETRY_BACKOFF_MS).toISOString();
        await pgRun(
          this.control,
          `UPDATE ${this.control.table('custom_status_domains')}
           SET error_code = 'missing_provider_id', recheck_due_at = $1, updated_at = $2, revision = revision + 1
           WHERE id = $3 AND revision = $4 AND deleted_at IS NULL`,
          [nextBackoffIso, nowIso, claim.id, claim.revision],
        );
        continue;
      }

      try {
        if (activeProvider.type === 'mock') {
          const nextRecheckDueAt =
            claim.status === 'active'
              ? new Date(this.now() + RECHECK_INTERVAL_MS).toISOString()
              : new Date(this.now() + RETRY_BACKOFF_MS).toISOString();

          await pgRun(
            this.control,
            `UPDATE ${this.control.table('custom_status_domains')}
             SET recheck_due_at = $1, updated_at = $2, revision = revision + 1
             WHERE id = $3 AND revision = $4 AND deleted_at IS NULL`,
            [nextRecheckDueAt, nowIso, claim.id, claim.revision],
          );
          reconciled++;
        } else {
          const remote = await activeProvider.getCustomHostname({
            providerId: claim.provider_id,
            expectedHostname: claim.hostname,
          });

          const nextStatus: CustomStatusDomainStatus =
            remote.status === 'ready' ? 'active' : 'pending';
          const verifiedAt = remote.status === 'ready' ? nowIso : null;
          const nextRecheckDueAt =
            nextStatus === 'active'
              ? new Date(this.now() + RECHECK_INTERVAL_MS).toISOString()
              : new Date(this.now() + RETRY_BACKOFF_MS).toISOString();

          const detailsJson = JSON.stringify({
            cnameInstruction: remote.cnameInstruction,
            validationRecords: remote.validationRecords,
          });

          await pgRun(
            this.control,
            `UPDATE ${this.control.table('custom_status_domains')}
             SET status = $1, details_json = $2, error_code = NULL, verified_at = $3, recheck_due_at = $4, updated_at = $5, revision = revision + 1
             WHERE id = $6 AND revision = $7 AND deleted_at IS NULL`,
            [
              nextStatus,
              detailsJson,
              verifiedAt,
              nextRecheckDueAt,
              nowIso,
              claim.id,
              claim.revision,
            ],
          );
          reconciled++;
        }
      } catch {
        errors++;
        const nextBackoffIso = new Date(this.now() + RETRY_BACKOFF_MS).toISOString();
        await pgRun(
          this.control,
          `UPDATE ${this.control.table('custom_status_domains')}
           SET error_code = 'provider_reconcile_failed', recheck_due_at = $1, updated_at = $2, revision = revision + 1
           WHERE id = $3 AND revision = $4 AND deleted_at IS NULL`,
          [nextBackoffIso, nowIso, claim.id, claim.revision],
        );
      }
    }

    return { reconciled, errors };
  }

  /**
   * Resolve public status page host to tenant status page route.
   * Fail closed if claim is missing, provider is mock or disabled,
   * verification is expired, workspace is not active, workspace is imported,
   * or quota is exceeded.
   */
  async resolvePublicHost(hostname: string): Promise<{
    workspaceId: string;
    statusPageId: string;
    publicSlug: string;
    claimId: string;
  } | null> {
    let canonicalHostname: string;
    try {
      canonicalHostname = normalizeCustomStatusHostname(hostname, {
        reservedHostnames: this.reservedHostnames,
      });
    } catch {
      return null;
    }

    const claim = await pgFirst<CustomStatusDomainRow>(
      this.control,
      `SELECT * FROM ${this.control.table('custom_status_domains')}
       WHERE hostname = $1 AND status = 'active' AND deleted_at IS NULL`,
      [canonicalHostname],
    );

    if (!claim) {
      return null;
    }

    // Mock and disabled claims NEVER resolve to public routing traffic
    if (claim.provider_mode === 'mock' || claim.provider_mode === 'disabled') {
      return null;
    }

    // Configured provider must not be disabled and must match claim mode
    if (this.provider.type === 'disabled' || claim.provider_mode !== this.provider.type) {
      return null;
    }

    // Freshness check with clock skew protection
    if (!claim.verified_at) {
      return null;
    }

    const verifiedTime = new Date(claim.verified_at).getTime();
    if (Number.isNaN(verifiedTime)) {
      return null;
    }

    const now = this.now();
    if (verifiedTime > now + CLOCK_SKEW_TOLERANCE_MS) {
      // Future timestamp beyond clock skew: fail closed
      return null;
    }

    const age = now - verifiedTime;
    if (age > this.maxVerificationFreshnessMs) {
      // Expired verification: fail closed
      return null;
    }

    // Workspace state check
    const ws = await pgFirst<{ id: string; state: string }>(
      this.control,
      `SELECT id, state FROM ${this.control.table('workspaces')} WHERE id = $1 AND state = 'active'`,
      [claim.workspace_id],
    );
    if (!ws) {
      return null;
    }

    // Explicit imported workspace check
    if (await this.checkImportedWorkspace(claim.workspace_id)) {
      return null;
    }

    // Entitlement & quota check with bounded rank
    const entitlements = await this.effectiveEntitlementsReader(this.control, claim.workspace_id);
    const quota = validateQuota(entitlements.customDomains);
    if (quota <= 0) {
      return null;
    }

    const rankRow = await pgFirst<{ rank_count: number }>(
      this.control,
      `SELECT count(*)::int AS rank_count
       FROM ${this.control.table('custom_status_domains')}
       WHERE workspace_id = $1 AND status = 'active' AND deleted_at IS NULL
         AND (created_at < $2 OR (created_at = $2 AND id < $3))`,
      [claim.workspace_id, claim.created_at, claim.id],
    );

    const rank = rankRow?.rank_count ?? 0;
    if (rank >= quota) {
      return null;
    }

    // Tenant status page check
    const tenantDb = await this.tenantDbResolver(claim.workspace_id);
    const pageCheck = await checkStatusPagePublic(tenantDb, claim.status_page_id);
    if (!pageCheck.exists || !pageCheck.isPublic || !pageCheck.publicSlug) {
      return null;
    }

    return {
      workspaceId: claim.workspace_id,
      statusPageId: claim.status_page_id,
      publicSlug: pageCheck.publicSlug,
      claimId: claim.id,
    };
  }
}
