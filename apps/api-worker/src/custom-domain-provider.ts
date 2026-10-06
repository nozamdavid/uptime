/**
 * Custom Domain Provider for Status Pages.
 *
 * Implements pure hostname validation and Cloudflare for SaaS custom hostname adapter.
 */

// ---------------------------------------------------------------------------
// Hostname Validation Errors and Types
// ---------------------------------------------------------------------------

export class CustomHostnameValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CustomHostnameValidationError';
  }
}

export class CustomDomainProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number | undefined,
  ) {
    super(message);
    this.name = 'CustomDomainProviderError';
  }
}

export interface NormalizeCustomStatusHostnameOptions {
  /** Optional custom list or set of reserved hostnames or domains to block */
  reservedHostnames?: string[] | Set<string> | undefined;
  /** Optional internal app domains where subdomains should be blocked */
  internalAppDomains?: string[] | Set<string> | undefined;
}

const FORBIDDEN_TLDS = new Set([
  'local',
  'internal',
  'localhost',
  'test',
  'example',
  'invalid',
  'lan',
  'home',
  'corp',
  'localdomain',
  'onion',
  'arpa',
]);

const MAX_RESPONSE_BYTES = 64 * 1024; // 64 KiB
const ALLOWED_MOCK_ENVIRONMENTS = new Set(['staging', 'test', 'development']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates and normalizes custom status hostnames into canonical ASCII lowercase (Punycode for IDN).
 * Host validation is generic; caller passes application-specific reserved names via options.
 */
export function normalizeCustomStatusHostname(
  input: string,
  options?: NormalizeCustomStatusHostnameOptions,
): string {
  if (typeof input !== 'string') {
    throw new CustomHostnameValidationError('invalid_input', 'Hostname must be a string');
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new CustomHostnameValidationError('empty_hostname', 'Hostname cannot be empty');
  }

  // Bound input length before demanding work (DNS limit 253 chars, 254 with single trailing dot)
  if (trimmed.length > 254) {
    throw new CustomHostnameValidationError(
      'hostname_too_long',
      'Hostname must not exceed 253 characters',
    );
  }

  // Dot checks: leading and multiple consecutive dots are rejected
  if (trimmed.startsWith('.')) {
    throw new CustomHostnameValidationError(
      'invalid_dns_label',
      'Hostname must not start with a dot',
    );
  }
  if (trimmed.endsWith('..') || trimmed.includes('..')) {
    throw new CustomHostnameValidationError(
      'invalid_dns_label',
      'Consecutive dots are not permitted',
    );
  }

  // Normalize a single trailing dot to canonical
  const withoutTrailingDot = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  if (!withoutTrailingDot) {
    throw new CustomHostnameValidationError('empty_hostname', 'Hostname cannot be empty');
  }
  if (withoutTrailingDot.length > 253) {
    throw new CustomHostnameValidationError(
      'hostname_too_long',
      'Hostname must not exceed 253 characters',
    );
  }

  // Scheme checks
  if (withoutTrailingDot.includes('://') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(withoutTrailingDot)) {
    throw new CustomHostnameValidationError(
      'invalid_scheme',
      'Hostname must not include a URL scheme',
    );
  }

  // Path, query, fragment, credentials, ports checks
  if (withoutTrailingDot.includes('/') || withoutTrailingDot.includes('\\')) {
    throw new CustomHostnameValidationError('path_not_allowed', 'Hostname must not include a path');
  }
  if (withoutTrailingDot.includes('?')) {
    throw new CustomHostnameValidationError(
      'query_not_allowed',
      'Hostname must not include a query string',
    );
  }
  if (withoutTrailingDot.includes('#')) {
    throw new CustomHostnameValidationError(
      'fragment_not_allowed',
      'Hostname must not include a URL fragment',
    );
  }
  if (withoutTrailingDot.includes('@')) {
    throw new CustomHostnameValidationError(
      'credentials_not_allowed',
      'Hostname must not include credentials',
    );
  }
  if (withoutTrailingDot.includes(':')) {
    throw new CustomHostnameValidationError(
      'port_not_allowed',
      'Hostname must not include a port or colon',
    );
  }

  // Wildcards
  if (withoutTrailingDot.includes('*')) {
    throw new CustomHostnameValidationError(
      'wildcard_not_allowed',
      'Wildcards are not permitted in custom hostnames',
    );
  }

  // Whitespace and control characters
  if (/\s/.test(withoutTrailingDot) || /[\u0000-\u001f\u007f-\u009f]/.test(withoutTrailingDot)) {
    throw new CustomHostnameValidationError(
      'invalid_characters',
      'Hostname must not contain whitespace or control characters',
    );
  }

  // Ambiguous Unicode dots
  if (/[\u3002\uFF0E\uFF61\u2024]/.test(withoutTrailingDot)) {
    throw new CustomHostnameValidationError(
      'ambiguous_dot',
      'Ambiguous Unicode dot characters are not permitted',
    );
  }

  // Parse through WHATWG URL parser to canonicalize IDN to Punycode ASCII
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(`http://${withoutTrailingDot}`);
  } catch {
    throw new CustomHostnameValidationError('invalid_hostname', 'Hostname failed URL parsing');
  }

  // Ensure URL parser did not silently discard any path, query, hash, port, or userinfo
  if (
    parsedUrl.pathname !== '/' ||
    parsedUrl.search !== '' ||
    parsedUrl.hash !== '' ||
    parsedUrl.port !== '' ||
    parsedUrl.username !== '' ||
    parsedUrl.password !== ''
  ) {
    throw new CustomHostnameValidationError(
      'invalid_hostname',
      'Hostname contains silently discarded URL path or components',
    );
  }

  const asciiHost = parsedUrl.hostname.toLowerCase();

  // IP address checks (both IPv4 and IPv6)
  if (asciiHost.includes(':') || asciiHost.startsWith('[') || asciiHost.endsWith(']')) {
    throw new CustomHostnameValidationError(
      'ip_address_not_allowed',
      'IPv6 addresses are not allowed',
    );
  }
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(asciiHost)) {
    throw new CustomHostnameValidationError(
      'ip_address_not_allowed',
      'IPv4 addresses are not allowed',
    );
  }
  if (asciiHost.split('.').every((part) => /^\d+$/.test(part))) {
    throw new CustomHostnameValidationError(
      'ip_address_not_allowed',
      'IP addresses are not allowed',
    );
  }

  // Label structure
  const labels = asciiHost.split('.');
  if (labels.length < 2) {
    throw new CustomHostnameValidationError(
      'single_label_not_allowed',
      'Custom hostname must have at least two domain labels (e.g. status.example.com)',
    );
  }

  // Forbidden local / internal TLDs
  const tld = labels[labels.length - 1];
  if (!tld || FORBIDDEN_TLDS.has(tld)) {
    throw new CustomHostnameValidationError(
      'local_domain_not_allowed',
      `.${tld ?? ''} domains are not permitted as custom status hostnames`,
    );
  }

  for (const label of labels) {
    if (!label || label.length === 0) {
      throw new CustomHostnameValidationError('invalid_dns_label', 'Domain label cannot be empty');
    }
    if (label.length > 63) {
      throw new CustomHostnameValidationError(
        'label_too_long',
        'Domain label must not exceed 63 characters',
      );
    }
    if (label.startsWith('-') || label.endsWith('-')) {
      throw new CustomHostnameValidationError(
        'invalid_dns_label',
        'Domain label must not start or end with a hyphen',
      );
    }
    if (!/^[a-z0-9-]+$/.test(label)) {
      throw new CustomHostnameValidationError(
        'invalid_dns_label',
        `Domain label contains invalid characters: ${label}`,
      );
    }
    // Incomplete Punycode label check (e.g. "xn--" without encoded characters)
    if (label.startsWith('xn--') && label.length <= 4) {
      throw new CustomHostnameValidationError('invalid_punycode', 'Incomplete punycode label');
    }
  }

  // TLD validation
  if (/^\d+$/.test(tld)) {
    throw new CustomHostnameValidationError(
      'invalid_dns_label',
      'Top-level domain cannot be all-numeric',
    );
  }
  if (tld.length < 2) {
    throw new CustomHostnameValidationError(
      'invalid_dns_label',
      'Top-level domain must be at least 2 characters',
    );
  }

  // Caller-provided reserved hostnames & internal app domain checks
  const reservedSet = new Set<string>();
  if (options?.reservedHostnames) {
    for (const item of options.reservedHostnames) {
      const trimmedItem = item.toLowerCase().trim();
      if (trimmedItem) reservedSet.add(trimmedItem);
    }
  }
  if (options?.internalAppDomains) {
    for (const item of options.internalAppDomains) {
      const trimmedItem = item.toLowerCase().trim();
      if (trimmedItem) reservedSet.add(trimmedItem);
    }
  }

  for (const reserved of reservedSet) {
    if (asciiHost === reserved) {
      throw new CustomHostnameValidationError(
        'reserved_hostname',
        `Hostname ${asciiHost} is reserved for internal app use`,
      );
    }
    if (asciiHost.endsWith(`.${reserved}`)) {
      throw new CustomHostnameValidationError(
        'reserved_hostname',
        `Hostname ${asciiHost} is a subdomain of reserved domain ${reserved}`,
      );
    }
  }

  return asciiHost;
}

// ---------------------------------------------------------------------------
// Provider Types & Validation Records
// ---------------------------------------------------------------------------

export type CustomHostnameNormalizedStatus =
  'pending_validation' | 'ready' | 'blocked' | 'deleted' | 'error';

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

export interface CustomHostnameCnameInstruction {
  type: 'CNAME';
  name: string;
  target: string;
  purpose: 'traffic_routing';
}

export interface CustomHostnameDetails {
  providerId: string;
  hostname: string;
  status: CustomHostnameNormalizedStatus;
  rawHostnameStatus?: string | undefined;
  rawSslStatus?: string | undefined;
  cnameInstruction: CustomHostnameCnameInstruction;
  validationRecords: CustomHostnameValidationRecord[];
  ownershipVerification?:
    | {
        type: string;
        name: string;
        value: string;
      }
    | undefined;
  createdAt?: string | undefined;
  simulation?: boolean | undefined;
}

export interface CreateCustomHostnameOptions {
  hostname: string;
  existingProviderId?: string | undefined;
  reservedHostnames?: string[] | Set<string> | undefined;
}

export interface GetCustomHostnameOptions {
  providerId: string;
  expectedHostname?: string | undefined;
}

export interface DeleteCustomHostnameOptions {
  providerId: string;
  expectedHostname?: string | undefined;
}

export interface LookupCustomHostnameOptions {
  hostname: string;
  reservedHostnames?: string[] | Set<string> | undefined;
}

export interface CustomDomainProviderCapabilities {
  purgeCacheByHostname: boolean;
}

export interface CustomDomainProvider {
  readonly type: 'disabled' | 'mock' | 'cloudflare';
  readonly capabilities: CustomDomainProviderCapabilities;

  createCustomHostname(options: CreateCustomHostnameOptions): Promise<CustomHostnameDetails>;
  getCustomHostname(options: GetCustomHostnameOptions): Promise<CustomHostnameDetails>;
  deleteCustomHostname(options: DeleteCustomHostnameOptions): Promise<{
    providerId: string;
    deleted: boolean;
    alreadyDeleted?: boolean | undefined;
  }>;
  lookupCustomHostname(options: LookupCustomHostnameOptions): Promise<CustomHostnameDetails | null>;
  purgeCacheByHostname?(hostname: string): Promise<{ purged: boolean }>;

  /** Test/mock helper for simulating status transitions without DNS or routing */
  simulateStatus?(providerId: string, status: CustomHostnameNormalizedStatus): void;
}

export interface DisabledCustomDomainProviderConfig {
  type?: 'disabled' | undefined;
  mode?: 'disabled' | undefined;
}

export interface MockCustomDomainProviderConfig {
  type?: 'mock' | undefined;
  mode?: 'mock' | undefined;
  /** Must explicitly be non-production allowlisted ('staging', 'test', 'development') */
  environment: string;
  cnameTarget?: string | undefined;
}

export interface CloudflareCustomDomainProviderConfig {
  type?: 'cloudflare' | undefined;
  mode?: 'cloudflare' | undefined;
  zoneId: string;
  apiToken: string;
  cnameTarget: string;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  enableCachePurge?: boolean | undefined;
}

export type CustomDomainProviderConfig =
  | DisabledCustomDomainProviderConfig
  | MockCustomDomainProviderConfig
  | CloudflareCustomDomainProviderConfig;

export interface CustomDomainProviderDependencies {
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeStatus(
  rawHostnameStatus?: string,
  rawSslStatus?: string,
): CustomHostnameNormalizedStatus {
  const h = (rawHostnameStatus || '').toLowerCase();
  const s = (rawSslStatus || '').toLowerCase();

  if (h === 'blocked' || s === 'blocked') return 'blocked';
  if (h === 'deleted' || s === 'deleted') return 'deleted';
  if (h === 'error' || s === 'error' || h === 'failed' || s === 'failed') return 'error';

  // Both hostname ownership (status: active) AND SSL certificate (ssl.status: active)
  // must be strictly active before public status traffic is considered 'ready'.
  // Do not treat 'active_re-deploying' as ready until proven official active_re-deploying meaning.
  const isHostnameActive = h === 'active';
  const isSslActive = s === 'active';

  if (isHostnameActive && isSslActive) {
    return 'ready';
  }

  return 'pending_validation';
}

function parseValidationRecords(
  ownershipVerification: unknown,
  ssl: unknown,
): CustomHostnameValidationRecord[] {
  const records: CustomHostnameValidationRecord[] = [];

  if (
    isRecord(ownershipVerification) &&
    typeof ownershipVerification.name === 'string' &&
    typeof ownershipVerification.value === 'string'
  ) {
    records.push({
      type: 'TXT',
      name: ownershipVerification.name,
      value: ownershipVerification.value,
      purpose: 'hostname_ownership',
    });
  }

  if (isRecord(ssl) && Array.isArray(ssl.validation_records)) {
    for (const item of ssl.validation_records) {
      if (!isRecord(item)) continue;

      if (typeof item.txt_name === 'string' && typeof item.txt_value === 'string') {
        records.push({
          type: 'TXT',
          name: item.txt_name,
          value: item.txt_value,
          purpose: 'ssl_validation',
        });
      } else if (typeof item.cname === 'string' && typeof item.cname_target === 'string') {
        records.push({
          type: 'CNAME',
          name: item.cname,
          target: item.cname_target,
          purpose: 'ssl_validation',
        });
      } else if (typeof item.http_url === 'string' && typeof item.http_body === 'string') {
        records.push({
          type: 'HTTP',
          url: item.http_url,
          body: item.http_body,
          purpose: 'ssl_validation',
        });
      }
    }
  }

  return records;
}

async function readBoundedStream(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new CustomDomainProviderError(
        'response_too_large',
        'Cloudflare API response exceeded maximum allowed size',
      );
    }
    return text;
  }

  if (signal.aborted) {
    throw new CustomDomainProviderError(
      'request_timeout',
      'Request to Cloudflare API timed out',
      408,
    );
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let totalBytes = 0;
  let result = '';

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(
        new CustomDomainProviderError(
          'request_timeout',
          'Request to Cloudflare API timed out',
          408,
        ),
      );
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(
          new CustomDomainProviderError(
            'request_timeout',
            'Request to Cloudflare API timed out',
            408,
          ),
        );
      },
      { once: true },
    );
  });

  try {
    while (true) {
      if (signal.aborted) {
        throw new CustomDomainProviderError(
          'request_timeout',
          'Request to Cloudflare API timed out',
          408,
        );
      }
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (signal.aborted) {
        throw new CustomDomainProviderError(
          'request_timeout',
          'Request to Cloudflare API timed out',
          408,
        );
      }
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          void reader.cancel().catch(() => {});
          throw new CustomDomainProviderError(
            'response_too_large',
            'Cloudflare API response exceeded maximum allowed size',
          );
        }
        result += decoder.decode(value, { stream: true });
      }
    }
    result += decoder.decode();
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Ignored
    }
  }
}

// ---------------------------------------------------------------------------
// Provider Implementations
// ---------------------------------------------------------------------------

class DisabledCustomDomainProvider implements CustomDomainProvider {
  readonly type = 'disabled' as const;
  readonly capabilities: CustomDomainProviderCapabilities = {
    purgeCacheByHostname: false,
  };

  async createCustomHostname(): Promise<never> {
    throw new CustomDomainProviderError('provider_disabled', 'Custom domain provider is disabled');
  }

  async getCustomHostname(): Promise<never> {
    throw new CustomDomainProviderError('provider_disabled', 'Custom domain provider is disabled');
  }

  async deleteCustomHostname(): Promise<never> {
    throw new CustomDomainProviderError('provider_disabled', 'Custom domain provider is disabled');
  }

  async lookupCustomHostname(): Promise<never> {
    throw new CustomDomainProviderError('provider_disabled', 'Custom domain provider is disabled');
  }
}

/**
 * Mock provider holds in-memory state suitable for ephemeral tests and simulation.
 * In serverless worker environments, state is not shared across isolates; callers persist
 * or inject shared records as needed.
 */
class MockCustomDomainProvider implements CustomDomainProvider {
  readonly type = 'mock' as const;
  readonly capabilities: CustomDomainProviderCapabilities = {
    purgeCacheByHostname: true,
  };

  private readonly records = new Map<string, CustomHostnameDetails>();
  private readonly hostnameToId = new Map<string, string>();
  private readonly cnameTarget: string;
  private readonly now: () => number;
  private idCounter = 1;

  constructor(cnameTarget: string, now?: (() => number) | undefined) {
    this.cnameTarget = cnameTarget;
    this.now = now ?? Date.now;
  }

  async createCustomHostname(options: CreateCustomHostnameOptions): Promise<CustomHostnameDetails> {
    const canonical = normalizeCustomStatusHostname(options.hostname, {
      reservedHostnames: options.reservedHostnames,
    });

    const existingId = this.hostnameToId.get(canonical);
    if (existingId) {
      if (options.existingProviderId && options.existingProviderId === existingId) {
        return structuredClone(this.records.get(existingId)!);
      }
      throw new CustomDomainProviderError(
        'hostname_already_exists',
        `Hostname ${canonical} is already claimed by another entity`,
        409,
      );
    }

    const providerId = `mock-ch-${this.idCounter++}-${Math.random().toString(36).slice(2, 8)}`;
    const ownershipRecord = {
      type: 'txt',
      name: `_cf-custom-hostname.${canonical}`,
      value: `mock-ownership-token-${providerId.slice(0, 12)}`,
    };

    const details: CustomHostnameDetails = {
      providerId,
      hostname: canonical,
      status: 'pending_validation',
      rawHostnameStatus: 'pending',
      rawSslStatus: 'pending_validation',
      cnameInstruction: {
        type: 'CNAME',
        name: canonical,
        target: this.cnameTarget,
        purpose: 'traffic_routing',
      },
      ownershipVerification: ownershipRecord,
      validationRecords: [
        {
          type: 'TXT',
          name: ownershipRecord.name,
          value: ownershipRecord.value,
          purpose: 'hostname_ownership',
        },
        {
          type: 'TXT',
          name: `_acme-challenge.${canonical}`,
          value: `mock-dcv-token-${providerId.slice(0, 12)}`,
          purpose: 'ssl_validation',
        },
      ],
      createdAt: new Date(this.now()).toISOString(),
      simulation: true,
    };

    this.records.set(providerId, details);
    this.hostnameToId.set(canonical, providerId);

    return structuredClone(details);
  }

  async getCustomHostname(options: GetCustomHostnameOptions): Promise<CustomHostnameDetails> {
    const details = this.records.get(options.providerId);
    if (!details) {
      throw new CustomDomainProviderError(
        'hostname_not_found',
        `Mock custom hostname ${options.providerId} not found`,
        404,
      );
    }
    if (options.expectedHostname) {
      const canonicalExpected = normalizeCustomStatusHostname(options.expectedHostname);
      if (details.hostname !== canonicalExpected) {
        throw new CustomDomainProviderError(
          'hostname_mismatch',
          `Expected hostname ${canonicalExpected} but found ${details.hostname}`,
          400,
        );
      }
    }
    return structuredClone(details);
  }

  async deleteCustomHostname(options: DeleteCustomHostnameOptions): Promise<{
    providerId: string;
    deleted: boolean;
    alreadyDeleted?: boolean | undefined;
  }> {
    if (!options.providerId || typeof options.providerId !== 'string') {
      throw new CustomDomainProviderError('invalid_provider_id', 'Provider ID is required');
    }

    const details = this.records.get(options.providerId);
    if (!details) {
      return {
        providerId: options.providerId,
        deleted: true,
        alreadyDeleted: true,
      };
    }

    if (options.expectedHostname) {
      const canonicalExpected = normalizeCustomStatusHostname(options.expectedHostname);
      if (details.hostname !== canonicalExpected) {
        throw new CustomDomainProviderError(
          'hostname_mismatch',
          `Cannot delete: custom hostname does not match expected hostname`,
          400,
        );
      }
    }

    this.records.delete(options.providerId);
    this.hostnameToId.delete(details.hostname);
    return {
      providerId: options.providerId,
      deleted: true,
      alreadyDeleted: false,
    };
  }

  async lookupCustomHostname(
    options: LookupCustomHostnameOptions,
  ): Promise<CustomHostnameDetails | null> {
    const canonical = normalizeCustomStatusHostname(options.hostname, {
      reservedHostnames: options.reservedHostnames,
    });
    const id = this.hostnameToId.get(canonical);
    if (!id) return null;
    const details = this.records.get(id);
    return details ? structuredClone(details) : null;
  }

  async purgeCacheByHostname(_hostname: string): Promise<{ purged: boolean }> {
    return { purged: true };
  }

  simulateStatus(providerId: string, status: CustomHostnameNormalizedStatus): void {
    const record = this.records.get(providerId);
    if (!record) {
      throw new CustomDomainProviderError(
        'hostname_not_found',
        `Provider ID ${providerId} not found`,
        404,
      );
    }
    record.status = status;
    if (status === 'ready') {
      record.rawHostnameStatus = 'active';
      record.rawSslStatus = 'active';
    } else if (status === 'blocked') {
      record.rawHostnameStatus = 'blocked';
    } else if (status === 'error') {
      record.rawHostnameStatus = 'error';
      record.rawSslStatus = 'error';
    } else if (status === 'pending_validation') {
      record.rawHostnameStatus = 'pending';
      record.rawSslStatus = 'pending_validation';
    }
  }
}

class CloudflareCustomDomainProvider implements CustomDomainProvider {
  readonly type = 'cloudflare' as const;
  readonly capabilities: CustomDomainProviderCapabilities;

  private readonly zoneId: string;
  private readonly apiToken: string;
  private readonly cnameTarget: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    config: CloudflareCustomDomainProviderConfig,
    dependencies?: CustomDomainProviderDependencies | undefined,
  ) {
    this.zoneId = config.zoneId;
    this.apiToken = config.apiToken;
    this.cnameTarget = config.cnameTarget;

    const CLOUDFLARE_OFFICIAL_BASE_URL = 'https://api.cloudflare.com/client/v4';
    if (config.baseUrl !== undefined) {
      const normalizedBase = config.baseUrl.replace(/\/+$/, '');
      if (normalizedBase !== CLOUDFLARE_OFFICIAL_BASE_URL) {
        throw new CustomDomainProviderError(
          'invalid_base_url',
          `Cloudflare API base URL must be ${CLOUDFLARE_OFFICIAL_BASE_URL}`,
        );
      }
      this.baseUrl = CLOUDFLARE_OFFICIAL_BASE_URL;
    } else {
      this.baseUrl = CLOUDFLARE_OFFICIAL_BASE_URL;
    }

    this.timeoutMs = config.timeoutMs ?? 10000;
    this.fetchFn = dependencies?.fetch ?? globalThis.fetch;
    this.capabilities = {
      purgeCacheByHostname: Boolean(config.enableCachePurge),
    };
  }

  private async request(
    path: string,
    options: {
      method: string;
      body?: unknown;
    },
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      const fetchInit: RequestInit = {
        method: options.method,
        headers,
        signal: controller.signal,
        redirect: 'error',
      };
      if (options.body !== undefined) {
        fetchInit.body = JSON.stringify(options.body);
      }

      let response: Response;
      try {
        response = await this.fetchFn(url, fetchInit);
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          throw new CustomDomainProviderError(
            'request_timeout',
            'Request to Cloudflare API timed out',
            408,
          );
        }
        throw new CustomDomainProviderError(
          'network_error',
          'Network error communicating with Cloudflare API',
        );
      }

      // Bounded stream read up to MAX_RESPONSE_BYTES (64 KiB)
      const rawText = await readBoundedStream(response, MAX_RESPONSE_BYTES, controller.signal);

      let data: unknown = null;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new CustomDomainProviderError(
          'provider_http_error',
          'Cloudflare API returned unreadable or malformed response',
          response.status,
        );
      }

      if (!isRecord(data)) {
        throw new CustomDomainProviderError(
          'provider_http_error',
          'Cloudflare API returned non-object response',
          response.status,
        );
      }

      if (!response.ok || data.success === false) {
        const firstError =
          Array.isArray(data.errors) && isRecord(data.errors[0]) ? data.errors[0] : undefined;
        const errorCode = typeof firstError?.code === 'number' ? firstError.code : undefined;

        if (response.status === 404 || errorCode === 1406) {
          throw new CustomDomainProviderError(
            'hostname_not_found',
            'Custom hostname was not found',
            404,
          );
        }
        if (response.status === 409 || errorCode === 1401) {
          throw new CustomDomainProviderError(
            'hostname_already_exists',
            'Custom hostname already exists',
            409,
          );
        }
        if (response.status === 401 || response.status === 403) {
          throw new CustomDomainProviderError(
            'authentication_failed',
            'Cloudflare authentication failed',
            response.status,
          );
        }
        if (response.status === 429) {
          throw new CustomDomainProviderError(
            'rate_limited',
            'Cloudflare API rate limit exceeded',
            429,
          );
        }

        throw new CustomDomainProviderError(
          'provider_error',
          'Cloudflare API request failed',
          response.status,
        );
      }

      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  private mapResultToDetails(
    result: unknown,
    expectations?: {
      expectedProviderId?: string | undefined;
      expectedHostname?: string | undefined;
    },
  ): CustomHostnameDetails {
    if (!isRecord(result)) {
      throw new CustomDomainProviderError(
        'invalid_provider_response',
        'Provider response missing or invalid result object',
      );
    }

    if (typeof result.id !== 'string' || !result.id.trim()) {
      throw new CustomDomainProviderError(
        'invalid_provider_response',
        'Provider response missing required id string',
      );
    }
    const providerId = result.id.trim();

    if (expectations?.expectedProviderId && providerId !== expectations.expectedProviderId) {
      throw new CustomDomainProviderError(
        'provider_id_mismatch',
        'Provider returned unexpected provider ID',
      );
    }

    if (typeof result.hostname !== 'string' || !result.hostname.trim()) {
      throw new CustomDomainProviderError(
        'invalid_provider_response',
        'Provider response missing required hostname string',
      );
    }

    let canonicalHost: string;
    try {
      canonicalHost = normalizeCustomStatusHostname(result.hostname);
    } catch {
      throw new CustomDomainProviderError(
        'invalid_provider_response',
        'Provider response contained invalid hostname format',
      );
    }

    if (expectations?.expectedHostname && canonicalHost !== expectations.expectedHostname) {
      throw new CustomDomainProviderError(
        'hostname_mismatch',
        'Provider returned custom hostname that does not match expected hostname',
        400,
      );
    }

    const rawHostnameStatus = typeof result.status === 'string' ? result.status : undefined;
    const sslObj = isRecord(result.ssl) ? result.ssl : undefined;
    const rawSslStatus = sslObj && typeof sslObj.status === 'string' ? sslObj.status : undefined;
    const status = normalizeStatus(rawHostnameStatus, rawSslStatus);
    const validationRecords = parseValidationRecords(result.ownership_verification, sslObj);

    const details: CustomHostnameDetails = {
      providerId,
      hostname: canonicalHost,
      status,
      rawHostnameStatus,
      rawSslStatus,
      cnameInstruction: {
        type: 'CNAME',
        name: canonicalHost,
        target: this.cnameTarget,
        purpose: 'traffic_routing',
      },
      validationRecords,
      createdAt: typeof result.created_at === 'string' ? result.created_at : undefined,
    };

    if (
      isRecord(result.ownership_verification) &&
      typeof result.ownership_verification.name === 'string' &&
      typeof result.ownership_verification.value === 'string'
    ) {
      details.ownershipVerification = {
        type:
          typeof result.ownership_verification.type === 'string'
            ? result.ownership_verification.type
            : 'txt',
        name: result.ownership_verification.name,
        value: result.ownership_verification.value,
      };
    }

    return details;
  }

  async createCustomHostname(options: CreateCustomHostnameOptions): Promise<CustomHostnameDetails> {
    const canonical = normalizeCustomStatusHostname(options.hostname, {
      reservedHostnames: options.reservedHostnames,
    });

    // Anti-adoption security check:
    const existing = await this.lookupCustomHostname({ hostname: canonical });
    if (existing) {
      if (options.existingProviderId && options.existingProviderId === existing.providerId) {
        return existing;
      }
      throw new CustomDomainProviderError(
        'hostname_already_exists',
        `Hostname ${canonical} already exists with provider ID ${existing.providerId} and cannot be adopted`,
        409,
      );
    }

    const payload = {
      hostname: canonical,
      ssl: {
        method: 'txt',
        type: 'dv',
        settings: {
          min_tls_version: '1.2',
          http2: 'on',
        },
      },
    };

    const response = await this.request(`/zones/${this.zoneId}/custom_hostnames`, {
      method: 'POST',
      body: payload,
    });

    if (!isRecord(response) || !response.result) {
      throw new CustomDomainProviderError(
        'invalid_provider_response',
        'Cloudflare API response missing or invalid result',
      );
    }

    return this.mapResultToDetails(response.result, { expectedHostname: canonical });
  }

  async getCustomHostname(options: GetCustomHostnameOptions): Promise<CustomHostnameDetails> {
    if (!options.providerId || typeof options.providerId !== 'string') {
      throw new CustomDomainProviderError('invalid_provider_id', 'Provider ID is required');
    }

    const canonicalExpected = options.expectedHostname
      ? normalizeCustomStatusHostname(options.expectedHostname)
      : undefined;

    const response = await this.request(
      `/zones/${this.zoneId}/custom_hostnames/${encodeURIComponent(options.providerId)}`,
      { method: 'GET' },
    );

    if (!isRecord(response) || !response.result) {
      throw new CustomDomainProviderError(
        'invalid_provider_response',
        'Cloudflare API response missing or invalid result',
      );
    }

    return this.mapResultToDetails(response.result, {
      expectedProviderId: options.providerId,
      expectedHostname: canonicalExpected,
    });
  }

  async deleteCustomHostname(options: DeleteCustomHostnameOptions): Promise<{
    providerId: string;
    deleted: boolean;
    alreadyDeleted?: boolean | undefined;
  }> {
    if (!options.providerId || typeof options.providerId !== 'string') {
      throw new CustomDomainProviderError('invalid_provider_id', 'Provider ID is required');
    }

    // Verify ownership match before DELETE if expectedHostname is provided
    if (options.expectedHostname) {
      const canonicalExpected = normalizeCustomStatusHostname(options.expectedHostname);
      try {
        await this.getCustomHostname({
          providerId: options.providerId,
          expectedHostname: canonicalExpected,
        });
      } catch (err: unknown) {
        if (err instanceof CustomDomainProviderError && err.code === 'hostname_not_found') {
          return {
            providerId: options.providerId,
            deleted: true,
            alreadyDeleted: true,
          };
        }
        // Verification failed (mismatch, auth, network, 500) -> fail closed without deleting
        throw err;
      }
    }

    try {
      await this.request(
        `/zones/${this.zoneId}/custom_hostnames/${encodeURIComponent(options.providerId)}`,
        { method: 'DELETE' },
      );
      return {
        providerId: options.providerId,
        deleted: true,
        alreadyDeleted: false,
      };
    } catch (err: unknown) {
      if (err instanceof CustomDomainProviderError && err.code === 'hostname_not_found') {
        // Idempotent 404 deletion
        return {
          providerId: options.providerId,
          deleted: true,
          alreadyDeleted: true,
        };
      }
      throw err;
    }
  }

  async lookupCustomHostname(
    options: LookupCustomHostnameOptions,
  ): Promise<CustomHostnameDetails | null> {
    const canonical = normalizeCustomStatusHostname(options.hostname, {
      reservedHostnames: options.reservedHostnames,
    });

    const response = await this.request(
      `/zones/${this.zoneId}/custom_hostnames?hostname=${encodeURIComponent(canonical)}`,
      { method: 'GET' },
    );

    if (!isRecord(response) || !Array.isArray(response.result) || response.result.length === 0) {
      return null;
    }

    // Must never return result[0] if exact match is absent!
    const match = response.result.find((item: unknown) => {
      if (!isRecord(item) || typeof item.hostname !== 'string') return false;
      try {
        return normalizeCustomStatusHostname(item.hostname) === canonical;
      } catch {
        return false;
      }
    });

    if (!match) return null;

    return this.mapResultToDetails(match, { expectedHostname: canonical });
  }

  async purgeCacheByHostname(hostname: string): Promise<{ purged: boolean }> {
    if (!this.capabilities.purgeCacheByHostname) {
      throw new CustomDomainProviderError(
        'purge_not_supported',
        'Purge cache by hostname is not enabled or supported on this plan',
      );
    }

    const canonical = normalizeCustomStatusHostname(hostname);
    await this.request(`/zones/${this.zoneId}/purge_cache`, {
      method: 'POST',
      body: {
        hosts: [canonical],
      },
    });

    return { purged: true };
  }
}

// ---------------------------------------------------------------------------
// Provider Factory
// ---------------------------------------------------------------------------

export function createCustomDomainProvider(
  config: CustomDomainProviderConfig,
  dependencies?: CustomDomainProviderDependencies | undefined,
): CustomDomainProvider {
  // Reject conflicting configuration
  if (config.type !== undefined && config.mode !== undefined && config.type !== config.mode) {
    throw new CustomDomainProviderError(
      'ambiguous_configuration',
      'Conflicting provider type and mode specified in configuration',
    );
  }

  const mode = config.type ?? config.mode;

  if (mode === 'disabled') {
    return new DisabledCustomDomainProvider();
  }

  if (mode === 'mock') {
    const mockConfig = config as MockCustomDomainProviderConfig;
    const env = (mockConfig.environment ?? '').toLowerCase().trim();
    if (!ALLOWED_MOCK_ENVIRONMENTS.has(env)) {
      throw new CustomDomainProviderError(
        'invalid_mock_environment',
        'Mock custom domain provider is only permitted in staging, test, or development environments',
      );
    }

    const cnameTarget = mockConfig.cnameTarget || 'status-mock.uptime.example.com';
    const canonicalCname = normalizeCustomStatusHostname(cnameTarget);
    return new MockCustomDomainProvider(canonicalCname, dependencies?.now);
  }

  if (mode === 'cloudflare') {
    const cfConfig = config as CloudflareCustomDomainProviderConfig;

    if (!cfConfig.zoneId || typeof cfConfig.zoneId !== 'string' || !cfConfig.zoneId.trim()) {
      throw new CustomDomainProviderError(
        'missing_zone_id',
        'Cloudflare custom domain provider requires zoneId (fail closed)',
      );
    }
    const trimmedZoneId = cfConfig.zoneId.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedZoneId)) {
      throw new CustomDomainProviderError(
        'invalid_zone_id',
        'Cloudflare zoneId must contain only alphanumeric characters, dashes, or underscores',
      );
    }

    if (!cfConfig.apiToken || typeof cfConfig.apiToken !== 'string' || !cfConfig.apiToken.trim()) {
      throw new CustomDomainProviderError(
        'missing_api_token',
        'Cloudflare custom domain provider requires apiToken (fail closed)',
      );
    }
    if (
      !cfConfig.cnameTarget ||
      typeof cfConfig.cnameTarget !== 'string' ||
      !cfConfig.cnameTarget.trim()
    ) {
      throw new CustomDomainProviderError(
        'missing_cname_target',
        'Cloudflare custom domain provider requires cnameTarget (fail closed)',
      );
    }

    // Generic DNS hostname validation for trusted CNAME target
    const canonicalCname = normalizeCustomStatusHostname(cfConfig.cnameTarget);

    return new CloudflareCustomDomainProvider(
      {
        ...cfConfig,
        zoneId: trimmedZoneId,
        cnameTarget: canonicalCname,
      },
      dependencies,
    );
  }

  throw new CustomDomainProviderError(
    'invalid_provider_mode',
    `Unknown or unconfigured provider mode: ${String(mode)}`,
  );
}
