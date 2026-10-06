/**
 * Workers-native Stripe REST adapter using fetch + WebCrypto.
 *
 * Pinned API version: 2025-03-31.basil
 *
 * Official documentation & proven references:
 * - Stripe API Versioning: https://docs.stripe.com/api-versions
 * - Deprecate subscription current_period_start and current_period_end:
 *   https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
 * - Price object: https://docs.stripe.com/api/prices/object
 * - Subscription object: https://docs.stripe.com/api/subscriptions/object
 * - Checkout Sessions: https://docs.stripe.com/api/checkout/sessions/create
 * - Customer Portal: https://docs.stripe.com/api/customer_portal/sessions/create
 * - Webhooks signature verification: https://docs.stripe.com/webhooks
 */

export const STRIPE_API_VERSION = '2025-03-31.basil';

export const STRIPE_DOC_URLS = {
  apiVersions: 'https://docs.stripe.com/api-versions',
  periodDeprecation:
    'https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end',
  priceObject: 'https://docs.stripe.com/api/prices/object',
  subscriptionObject: 'https://docs.stripe.com/api/subscriptions/object',
  checkoutSessions: 'https://docs.stripe.com/api/checkout/sessions/create',
  portalSessions: 'https://docs.stripe.com/api/customer_portal/sessions/create',
  webhooks: 'https://docs.stripe.com/webhooks',
} as const;

export type StripeProviderMode = 'disabled' | 'mock' | 'stripe';

export type StripeEnvironment = 'production' | 'staging' | 'test' | 'development';

export const VALID_ENVIRONMENTS = new Set<string>(['production', 'staging', 'test', 'development']);

export type StripeSubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'canceled'
  | 'paused';

export const VALID_SUBSCRIPTION_STATUSES = new Set<StripeSubscriptionStatus>([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'canceled',
  'paused',
]);

export interface StripeCustomer {
  id: string;
  name: string | null;
  metadata: Record<string, string>;
  livemode: boolean;
}

export interface StripePrice {
  id: string;
  active: boolean;
  currency: string;
  unitAmount: number | null;
  interval: 'day' | 'week' | 'month' | 'year' | null;
  intervalCount: number | null;
  productId: string | null;
  productActive: boolean | null;
  metadata: Record<string, string>;
  billingScheme?: string | undefined;
  usageType?: string | undefined;
  livemode?: boolean | undefined;
}

export interface StripeSubscription {
  id: string;
  customerId: string;
  status: StripeSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  periodEnd: number | null;
  priceIds: string[];
  metadata: Record<string, string>;
  livemode: boolean;
  items?: { priceId: string; quantity: number | null }[] | undefined;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  clientReferenceId: string | null;
  metadata: Record<string, string>;
  paymentStatus?: string | undefined;
  status?: string | undefined;
  expiresAt?: number | undefined;
}

export interface StripePortalSession {
  id: string;
  url: string;
  customerId: string;
  returnUrl: string;
}

export interface StripeWebhookEvent<T = Record<string, unknown>> {
  id: string;
  type: string;
  livemode: boolean;
  account?: string | undefined;
  created: number;
  data: {
    object: T;
    previous_attributes?: Record<string, unknown> | undefined;
  };
}

export interface StripePortalConfiguration {
  active: boolean;
  updatesEnabled: boolean;
  cancellationAtPeriodEnd: boolean;
  prorationBehavior: string | null;
  allowedPriceIds: string[];
}

export interface CreateCustomerParams {
  workspaceId: string;
  idempotencyKey: string;
  name?: string | undefined;
  metadata?: Record<string, string> | undefined;
}

export interface CreateSubscriptionCheckoutParams {
  customerId: string;
  priceId: string;
  clientReferenceId: string;
  workspaceId: string;
  planId: string;
  revision: string | number;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  metadata?: Record<string, string> | undefined;
  expiresAt?: number | undefined;
}

export interface CreatePortalSessionParams {
  customerId: string;
  returnUrl: string;
  idempotencyKey: string;
  configurationId?: string | undefined;
}

export interface StripeProviderConfig {
  mode: StripeProviderMode;
  environment: StripeEnvironment;
  secretKey?: string | undefined;
  webhookSecret?: string | undefined;
  appOrigin: string;
  apiVersion?: string | undefined;
  allowlistedPriceIds?: string[] | undefined;
  allowedCheckoutDomains?: string[] | undefined;
  allowedPortalDomains?: string[] | undefined;
  expectedAccountId?: string | undefined;
  timeoutMs?: number | undefined;
  maxResponseSizeBytes?: number | undefined;
  maxWebhookSizeBytes?: number | undefined;
  webhookToleranceSeconds?: number | undefined;
  livemode?: boolean | undefined;
}

export interface StripeProviderDependencies {
  fetch?: typeof globalThis.fetch | undefined;
  /** Unix epoch timestamp in milliseconds. */
  nowMs?: (() => number) | undefined;
  /** @deprecated Provide nowMs in milliseconds */
  now?: (() => number) | undefined;
}

// Typed Errors

export class StripeProviderError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'STRIPE_PROVIDER_ERROR') {
    super(message);
    this.name = 'StripeProviderError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class StripeConfigurationError extends StripeProviderError {
  constructor(message: string) {
    super(message, 'STRIPE_CONFIGURATION_ERROR');
    this.name = 'StripeConfigurationError';
    Object.setPrototypeOf(this, StripeConfigurationError.prototype);
  }
}

export class StripeValidationError extends StripeProviderError {
  constructor(message: string) {
    super(message, 'STRIPE_VALIDATION_ERROR');
    this.name = 'StripeValidationError';
    Object.setPrototypeOf(this, StripeValidationError.prototype);
  }
}

export class StripeApiError extends StripeProviderError {
  public readonly status: number;
  public readonly stripeCode?: string | undefined;
  public readonly stripeType?: string | undefined;
  public readonly requestId?: string | undefined;

  constructor(params: {
    message: string;
    status: number;
    stripeCode?: string | undefined;
    stripeType?: string | undefined;
    requestId?: string | undefined;
  }) {
    super(params.message, 'STRIPE_API_ERROR');
    this.name = 'StripeApiError';
    this.status = params.status;
    this.stripeCode = params.stripeCode;
    this.stripeType = params.stripeType;
    this.requestId = params.requestId;
    Object.setPrototypeOf(this, StripeApiError.prototype);
  }
}

export class StripeTimeoutError extends StripeProviderError {
  constructor(message = 'Stripe API request timed out') {
    super(message, 'STRIPE_TIMEOUT_ERROR');
    this.name = 'StripeTimeoutError';
    Object.setPrototypeOf(this, StripeTimeoutError.prototype);
  }
}

export class StripeSignatureVerificationError extends StripeProviderError {
  constructor(message: string) {
    super(message, 'STRIPE_SIGNATURE_VERIFICATION_ERROR');
    this.name = 'StripeSignatureVerificationError';
    Object.setPrototypeOf(this, StripeSignatureVerificationError.prototype);
  }
}

// Provider Interface

export interface StripeProvider {
  readonly mode: StripeProviderMode;
  readonly environment: StripeEnvironment;
  readonly apiVersion: string;
  readonly isBillingReady: boolean;
  getCustomer(customerId: string): Promise<StripeCustomer | null>;
  createCustomer(params: CreateCustomerParams): Promise<StripeCustomer>;
  getPrice(priceId: string): Promise<StripePrice | null>;
  createSubscriptionCheckout(
    params: CreateSubscriptionCheckoutParams,
  ): Promise<StripeCheckoutSession>;
  getCheckout(sessionId: string): Promise<StripeCheckoutSession | null>;
  getSubscription(subscriptionId: string): Promise<StripeSubscription | null>;
  scheduleSubscriptionCancel(
    subscriptionId: string,
    idempotencyKey: string,
  ): Promise<StripeSubscription>;
  resumeSubscription(subscriptionId: string, idempotencyKey: string): Promise<StripeSubscription>;
  createPortalSession(params: CreatePortalSessionParams): Promise<StripePortalSession>;
  getPortalConfiguration(configurationId: string): Promise<StripePortalConfiguration>;
  verifyWebhook(
    rawBody: string,
    signatureHeader: string,
    toleranceSeconds?: number | undefined,
  ): Promise<StripeWebhookEvent>;
}

// Helpers & Guards

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProductionEnvironment(env: string): boolean {
  const normalized = env.trim().toLowerCase();
  return normalized === 'production' || normalized === 'prod';
}

function validateAppOrigin(origin: unknown, environment: StripeEnvironment): string {
  if (typeof origin !== 'string' || !origin.trim()) {
    throw new StripeConfigurationError('appOrigin must be a non-empty string');
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new StripeConfigurationError(`Invalid appOrigin URL: "${origin}"`);
  }

  if (url.username || url.password) {
    throw new StripeConfigurationError('Credentials in appOrigin are strictly forbidden');
  }

  if (url.protocol === 'https:') {
    return url.origin;
  }

  if (url.protocol === 'http:') {
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const isDevOrTest = environment === 'development' || environment === 'test';
    if (isLocalhost && isDevOrTest) {
      return url.origin;
    }
    throw new StripeConfigurationError(
      `HTTP appOrigin is only permitted for localhost in development or test environments; staging and production require HTTPS. Got environment "${environment}" with "${origin}"`,
    );
  }

  throw new StripeConfigurationError(
    `Disallowed appOrigin protocol: "${url.protocol}". Must be https: (or http: for localhost dev/test)`,
  );
}

function sanitizeUrl(urlStr: unknown, trustedOrigin: string): string {
  if (!urlStr || typeof urlStr !== 'string' || !urlStr.trim()) {
    throw new StripeValidationError('URL cannot be empty');
  }

  let resolved: URL;
  try {
    if (urlStr.startsWith('/')) {
      resolved = new URL(urlStr, trustedOrigin);
    } else {
      resolved = new URL(urlStr);
    }
  } catch {
    throw new StripeValidationError('Invalid URL structure');
  }

  if (resolved.username || resolved.password) {
    throw new StripeValidationError('Credentials in redirect URL are strictly forbidden');
  }

  if (resolved.origin !== trustedOrigin) {
    throw new StripeValidationError(
      `Untrusted redirect URL: origin "${resolved.origin}" does not match trusted appOrigin "${trustedOrigin}"`,
    );
  }

  const trustedProto = new URL(trustedOrigin).protocol;
  if (resolved.protocol !== trustedProto) {
    throw new StripeValidationError(
      `Redirect URL protocol "${resolved.protocol}" does not match trusted origin protocol "${trustedProto}"`,
    );
  }

  return resolved.toString();
}

function validateCheckoutUrl(
  urlStr: unknown,
  allowedDomains: readonly string[] = ['checkout.stripe.com'],
): string {
  if (typeof urlStr !== 'string' || !urlStr.trim()) {
    throw new StripeValidationError('Checkout session missing URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new StripeValidationError('Invalid checkout session URL structure');
  }
  if (parsed.protocol !== 'https:') {
    throw new StripeValidationError('Checkout URL must use https: protocol');
  }
  if (parsed.username || parsed.password) {
    throw new StripeValidationError('Checkout URL must not contain user credentials');
  }
  if (!allowedDomains.includes(parsed.hostname)) {
    throw new StripeValidationError(
      `Untrusted checkout URL domain "${parsed.hostname}". Allowed domains: ${allowedDomains.join(', ')}`,
    );
  }
  return parsed.toString();
}

function validatePortalUrl(
  urlStr: unknown,
  allowedDomains: readonly string[] = ['billing.stripe.com'],
): string {
  if (typeof urlStr !== 'string' || !urlStr.trim()) {
    throw new StripeValidationError('Portal session missing URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new StripeValidationError('Invalid portal session URL structure');
  }
  if (parsed.protocol !== 'https:') {
    throw new StripeValidationError('Portal URL must use https: protocol');
  }
  if (parsed.username || parsed.password) {
    throw new StripeValidationError('Portal URL must not contain user credentials');
  }
  if (!allowedDomains.includes(parsed.hostname)) {
    throw new StripeValidationError(
      `Untrusted portal URL domain "${parsed.hostname}". Allowed domains: ${allowedDomains.join(', ')}`,
    );
  }
  return parsed.toString();
}

function validateMockUrl(urlStr: string, trustedOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new StripeValidationError('Invalid mock URL structure');
  }
  if (parsed.origin !== trustedOrigin) {
    throw new StripeValidationError(
      `Mock URL origin "${parsed.origin}" does not match trusted appOrigin "${trustedOrigin}"`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new StripeValidationError('Mock URL must not contain credentials');
  }
  return parsed.toString();
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    const byteA = a[i] ?? 0;
    const byteB = b[i] ?? 0;
    mismatch |= byteA ^ byteB;
  }
  return mismatch === 0;
}

function encodeStripeFormData(data: Record<string, unknown>, prefix = ''): string[] {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      pairs.push(...encodeStripeFormData(value as Record<string, unknown>, fullKey));
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'object' && item !== null) {
          pairs.push(
            ...encodeStripeFormData(item as Record<string, unknown>, `${fullKey}[${index}]`),
          );
        } else {
          pairs.push(
            `${encodeURIComponent(`${fullKey}[${index}]`)}=${encodeURIComponent(String(item))}`,
          );
        }
      });
    } else {
      pairs.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return pairs;
}

async function raceDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => {
        onTimeout?.();
        reject(new StripeTimeoutError(`Stripe API request timed out after ${timeoutMs}ms`));
      },
      Math.max(0, timeoutMs),
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  deadlineTimestamp: number,
  overallTimeoutMs: number,
  controller: AbortController,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLen = parseInt(contentLength, 10);
    if (!Number.isNaN(parsedLen) && parsedLen > maxBytes) {
      controller.abort();
      if (response.body) {
        void response.body.cancel().catch(() => {});
      }
      throw new StripeValidationError(
        `Response payload exceeds maximum allowed size of ${maxBytes} bytes`,
      );
    }
  }

  if (!response.body) {
    const remainingMs = deadlineTimestamp - Date.now();
    if (remainingMs <= 0 || controller.signal.aborted) {
      controller.abort();
      throw new StripeTimeoutError(`Stripe API request timed out after ${overallTimeoutMs}ms`);
    }
    const text = await raceDeadline(response.text(), remainingMs, () => controller.abort());
    if (controller.signal.aborted) {
      throw new StripeTimeoutError(`Stripe API request timed out after ${overallTimeoutMs}ms`);
    }
    if (text.length > maxBytes) {
      throw new StripeValidationError(
        `Response payload exceeds maximum allowed size of ${maxBytes} bytes`,
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  let totalBytes = 0;
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const remainingMs = deadlineTimestamp - Date.now();
      if (remainingMs <= 0 || controller.signal.aborted) {
        controller.abort();
        void reader.cancel().catch(() => {});
        throw new StripeTimeoutError(`Stripe API request timed out after ${overallTimeoutMs}ms`);
      }

      const { done, value } = await raceDeadline(reader.read(), remainingMs, () => {
        controller.abort();
        void reader.cancel().catch(() => {});
      });

      if (controller.signal.aborted) {
        void reader.cancel().catch(() => {});
        throw new StripeTimeoutError(`Stripe API request timed out after ${overallTimeoutMs}ms`);
      }

      if (done) break;

      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          controller.abort();
          void reader.cancel().catch(() => {});
          throw new StripeValidationError(
            `Response payload exceeds maximum allowed size of ${maxBytes} bytes`,
          );
        }
        chunks.push(value);
      }
    }
  } catch (err: unknown) {
    controller.abort();
    void reader.cancel().catch(() => {});
    if (err instanceof StripeTimeoutError || err instanceof StripeValidationError) {
      throw err;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new StripeTimeoutError(`Stripe API request timed out after ${overallTimeoutMs}ms`);
    }
    throw new StripeProviderError('Failed to read response body from Stripe API');
  }

  if (controller.signal.aborted) {
    throw new StripeTimeoutError(`Stripe API request timed out after ${overallTimeoutMs}ms`);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function validateMetadata(meta: unknown): Record<string, string> {
  if (meta === undefined || meta === null) return {};
  if (!isRecord(meta)) {
    throw new StripeValidationError('metadata must be an object');
  }
  const keys = Object.keys(meta);
  if (keys.length > 50) {
    throw new StripeValidationError('metadata cannot exceed 50 key-value pairs');
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof k !== 'string' || !k || k.length > 40) {
      throw new StripeValidationError('metadata key must be non-empty string <= 40 chars');
    }
    if (typeof v !== 'string' || v.length > 500) {
      throw new StripeValidationError(`metadata value for key "${k}" must be string <= 500 chars`);
    }
    result[k] = v;
  }
  return result;
}

function validateCustomerId(customerId: unknown): asserts customerId is string {
  if (typeof customerId !== 'string' || !customerId.trim()) {
    throw new StripeValidationError('Customer ID must be a non-empty string');
  }
  if (!/^(?:cus_|mock_cus_)[A-Za-z0-9_]{1,100}$/.test(customerId)) {
    throw new StripeValidationError(`Invalid customer ID format: "${customerId}"`);
  }
}

function validateSubscriptionId(subscriptionId: unknown): asserts subscriptionId is string {
  if (typeof subscriptionId !== 'string' || !subscriptionId.trim()) {
    throw new StripeValidationError('Subscription ID must be a non-empty string');
  }
  if (!/^(?:sub_|mock_sub_)[A-Za-z0-9_]{1,100}$/.test(subscriptionId)) {
    throw new StripeValidationError(`Invalid subscription ID format: "${subscriptionId}"`);
  }
}

function validatePriceId(priceId: unknown): asserts priceId is string {
  if (typeof priceId !== 'string' || !priceId.trim()) {
    throw new StripeValidationError('Price ID must be a non-empty string');
  }
  if (!/^(?:price_|mock_price_)[A-Za-z0-9_]{1,100}$/.test(priceId)) {
    throw new StripeValidationError(`Invalid price ID format: "${priceId}"`);
  }
}

function validateSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new StripeValidationError('Session ID must be a non-empty string');
  }
  if (!/^(?:cs_|mock_cs_)[A-Za-z0-9_]{1,100}$/.test(sessionId)) {
    throw new StripeValidationError(`Invalid session ID format: "${sessionId}"`);
  }
}

function normalizePrice(price: unknown): StripePrice {
  if (!isRecord(price)) {
    throw new StripeValidationError('Invalid price response from Stripe: expected object');
  }

  validatePriceId(price.id);

  if (typeof price.active !== 'boolean') {
    throw new StripeValidationError('Price active field must be a boolean');
  }

  if (typeof price.currency !== 'string' || !/^[a-zA-Z]{3}$/.test(price.currency)) {
    throw new StripeValidationError('Price currency must be a 3-letter currency code');
  }

  let unitAmount: number | null = null;
  if (price.unit_amount !== null && price.unit_amount !== undefined) {
    if (
      typeof price.unit_amount !== 'number' ||
      !Number.isFinite(price.unit_amount) ||
      !Number.isSafeInteger(price.unit_amount) ||
      price.unit_amount < 0
    ) {
      throw new StripeValidationError(
        'Price unit_amount must be a non-negative finite integer or null',
      );
    }
    unitAmount = price.unit_amount;
  }

  let interval: 'day' | 'week' | 'month' | 'year' | null = null;
  let intervalCount: number | null = null;

  if (price.recurring !== null && price.recurring !== undefined) {
    if (!isRecord(price.recurring)) {
      throw new StripeValidationError('Price recurring field must be an object');
    }
    const validIntervals = new Set(['day', 'week', 'month', 'year']);
    if (
      typeof price.recurring.interval === 'string' &&
      validIntervals.has(price.recurring.interval)
    ) {
      interval = price.recurring.interval as 'day' | 'week' | 'month' | 'year';
    } else {
      throw new StripeValidationError('Invalid price recurring interval');
    }
    if (price.recurring.interval_count !== undefined && price.recurring.interval_count !== null) {
      if (
        typeof price.recurring.interval_count !== 'number' ||
        !Number.isSafeInteger(price.recurring.interval_count) ||
        price.recurring.interval_count < 1
      ) {
        throw new StripeValidationError(
          'Price recurring interval_count must be a positive integer',
        );
      }
      intervalCount = price.recurring.interval_count;
    }
  }

  let productId: string | null = null;
  let productActive: boolean | null = null;

  if (typeof price.product === 'string') {
    productId = price.product;
  } else if (isRecord(price.product)) {
    if (typeof price.product.id === 'string') {
      productId = price.product.id;
    }
    if (typeof price.product.active === 'boolean') {
      productActive = price.product.active;
    }
  }

  return {
    id: price.id,
    active: price.active,
    currency: price.currency.toLowerCase(),
    unitAmount,
    interval,
    intervalCount,
    productId,
    productActive,
    metadata: validateMetadata(price.metadata),
    billingScheme: typeof price.billing_scheme === 'string' ? price.billing_scheme : undefined,
    usageType:
      isRecord(price.recurring) && typeof price.recurring.usage_type === 'string'
        ? price.recurring.usage_type
        : undefined,
    livemode: typeof price.livemode === 'boolean' ? price.livemode : undefined,
  };
}

function normalizeSubscription(sub: unknown): StripeSubscription {
  if (!isRecord(sub)) {
    throw new StripeValidationError('Invalid subscription response from Stripe: expected object');
  }

  validateSubscriptionId(sub.id);

  if (
    typeof sub.status !== 'string' ||
    !VALID_SUBSCRIPTION_STATUSES.has(sub.status as StripeSubscriptionStatus)
  ) {
    throw new StripeValidationError(
      `Invalid or unrecognized subscription status: "${String(sub.status)}"`,
    );
  }

  let customerId: string | null = null;
  if (typeof sub.customer === 'string') {
    customerId = sub.customer;
  } else if (isRecord(sub.customer) && typeof sub.customer.id === 'string') {
    customerId = sub.customer.id;
  }
  if (!customerId) {
    throw new StripeValidationError('Subscription response missing customer ID');
  }
  validateCustomerId(customerId);

  if (typeof sub.cancel_at_period_end !== 'boolean') {
    throw new StripeValidationError('Subscription cancel_at_period_end must be a boolean');
  }

  if (typeof sub.livemode !== 'boolean') {
    throw new StripeValidationError('Subscription livemode must be a boolean');
  }

  // Support 2025-03-31.basil (items.data[].current_period_end) and pre-basil
  let periodEnd: number | null = null;
  if (isRecord(sub.items) && Array.isArray(sub.items.data) && sub.items.data.length > 0) {
    const firstItem = sub.items.data[0];
    if (isRecord(firstItem) && firstItem.current_period_end !== undefined) {
      if (
        typeof firstItem.current_period_end !== 'number' ||
        !Number.isSafeInteger(firstItem.current_period_end) ||
        firstItem.current_period_end <= 0
      ) {
        throw new StripeValidationError('Invalid subscription items current_period_end timestamp');
      }
      periodEnd = firstItem.current_period_end;
    }
  }

  if (
    periodEnd === null &&
    sub.current_period_end !== undefined &&
    sub.current_period_end !== null
  ) {
    if (
      typeof sub.current_period_end !== 'number' ||
      !Number.isSafeInteger(sub.current_period_end) ||
      sub.current_period_end <= 0
    ) {
      throw new StripeValidationError(
        'Invalid subscription top-level current_period_end timestamp',
      );
    }
    periodEnd = sub.current_period_end;
  }

  const priceIds: string[] = [];
  if (isRecord(sub.items) && Array.isArray(sub.items.data)) {
    for (const item of sub.items.data) {
      if (isRecord(item) && isRecord(item.price) && typeof item.price.id === 'string') {
        priceIds.push(item.price.id);
      }
    }
  }

  return {
    id: sub.id,
    customerId,
    status: sub.status as StripeSubscriptionStatus,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    periodEnd,
    priceIds,
    metadata: validateMetadata(sub.metadata),
    livemode: sub.livemode,
    items:
      isRecord(sub.items) && Array.isArray(sub.items.data)
        ? sub.items.data.map((item: unknown) => ({
            priceId:
              isRecord(item) && isRecord(item.price) && typeof item.price.id === 'string'
                ? item.price.id
                : '',
            quantity: isRecord(item) && typeof item.quantity === 'number' ? item.quantity : null,
          }))
        : [],
  };
}

// Factory

export function createStripeProvider(
  config: StripeProviderConfig,
  dependencies: StripeProviderDependencies = {},
): StripeProvider {
  const mode = config.mode;
  if (mode !== 'disabled' && mode !== 'mock' && mode !== 'stripe') {
    throw new StripeConfigurationError(`Invalid provider mode: "${String(mode)}"`);
  }

  const environment = config.environment;
  if (!VALID_ENVIRONMENTS.has(environment)) {
    throw new StripeConfigurationError(
      `Invalid environment: "${String(environment)}". Must be production, staging, test, or development.`,
    );
  }

  const trustedOrigin = validateAppOrigin(config.appOrigin, environment);
  const apiVersion = config.apiVersion ?? STRIPE_API_VERSION;
  const timeoutMs = config.timeoutMs ?? 15000;
  const maxResponseSizeBytes = config.maxResponseSizeBytes ?? 65536; // 64 KiB cap
  const maxWebhookSizeBytes = config.maxWebhookSizeBytes ?? 65536;
  const defaultWebhookTolerance = config.webhookToleranceSeconds ?? 300;
  const allowedCheckoutDomains = config.allowedCheckoutDomains ?? ['checkout.stripe.com'];
  const allowedPortalDomains = config.allowedPortalDomains ?? ['billing.stripe.com'];

  // Fail-closed environment and credential security
  if (mode === 'mock') {
    if (environment !== 'staging' && environment !== 'test' && environment !== 'development') {
      throw new StripeConfigurationError(
        'Mock Stripe mode is strictly rejected in production environment.',
      );
    }
  } else if (mode === 'stripe') {
    if (!config.secretKey || typeof config.secretKey !== 'string' || !config.secretKey.trim()) {
      throw new StripeConfigurationError(
        'Stripe mode requires a valid secretKey; automatic mock fallback is strictly forbidden.',
      );
    }
    const trimmedKey = config.secretKey.trim();
    if (!/^(?:sk_test_|sk_live_|rk_test_|rk_live_)[A-Za-z0-9_]{16,}$/.test(trimmedKey)) {
      throw new StripeConfigurationError(
        'Invalid Stripe secret key format. Must start with sk_test_, sk_live_, rk_test_, or rk_live_.',
      );
    }
    const keyIsLive = trimmedKey.startsWith('sk_live_') || trimmedKey.startsWith('rk_live_');
    if (typeof config.livemode === 'boolean' && config.livemode !== keyIsLive) {
      throw new StripeConfigurationError(
        `Configured livemode (${config.livemode}) contradicts secret key mode (${keyIsLive ? 'live' : 'test'})`,
      );
    }
    if (isProductionEnvironment(environment) && !keyIsLive) {
      throw new StripeConfigurationError('Cannot use test secret key in production environment');
    }

    if (config.webhookSecret !== undefined) {
      if (
        typeof config.webhookSecret !== 'string' ||
        !/^whsec_[A-Za-z0-9_+/=]{16,}$/.test(config.webhookSecret.trim())
      ) {
        throw new StripeConfigurationError(
          'Invalid webhookSecret format. Must start with whsec_ and be at least 22 characters.',
        );
      }
    }
  }

  const isBillingReady =
    mode === 'mock' ||
    (mode === 'stripe' &&
      typeof config.secretKey === 'string' &&
      config.secretKey.trim().length > 0 &&
      typeof config.webhookSecret === 'string' &&
      config.webhookSecret.trim().length > 0);

  const fetchFn = dependencies.fetch ?? globalThis.fetch;

  const getNowInSeconds = (): number => {
    if (dependencies.nowMs) {
      return Math.floor(dependencies.nowMs() / 1000);
    }
    if (dependencies.now) {
      return Math.floor(dependencies.now() / 1000);
    }
    return Math.floor(Date.now() / 1000);
  };

  const isLive = (): boolean => {
    if (typeof config.livemode === 'boolean') return config.livemode;
    if (config.secretKey) {
      return config.secretKey.startsWith('sk_live_') || config.secretKey.startsWith('rk_live_');
    }
    return false;
  };

  function ensureEnabled(): void {
    if (mode === 'disabled') {
      throw new StripeConfigurationError('Stripe provider is disabled');
    }
  }

  function validatePriceIdAllowlist(priceId: string): void {
    validatePriceId(priceId);
    if (
      !config.allowlistedPriceIds ||
      !Array.isArray(config.allowlistedPriceIds) ||
      config.allowlistedPriceIds.length === 0
    ) {
      throw new StripeConfigurationError(
        'allowlistedPriceIds configuration is required and must be non-empty for checkout',
      );
    }
    if (!config.allowlistedPriceIds.includes(priceId)) {
      throw new StripeValidationError(`Price ID "${priceId}" is not allowlisted`);
    }
  }

  // REST API request helper for mode === 'stripe'
  async function makeStripeRequest(
    method: 'GET' | 'POST',
    endpoint: string,
    bodyData?: Record<string, unknown>,
    idempotencyKey?: string | undefined,
  ): Promise<unknown> {
    const url = `https://api.stripe.com${endpoint}`;
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${config.secretKey}`);
    headers.set('Stripe-Version', apiVersion);

    if (method === 'POST') {
      if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
        throw new StripeValidationError('Idempotency key is required for mutating Stripe requests');
      }
      headers.set('Content-Type', 'application/x-www-form-urlencoded');
      headers.set('Idempotency-Key', idempotencyKey.trim());
    }

    const controller = new AbortController();
    const deadlineTimestamp = Date.now() + timeoutMs;
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let body: string | undefined;
    if (method === 'POST' && bodyData) {
      body = encodeStripeFormData(bodyData).join('&');
    }

    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
      redirect: 'error',
    };
    if (body !== undefined) {
      init.body = body;
    }

    let response: Response;
    try {
      const remainingMs = deadlineTimestamp - Date.now();
      if (remainingMs <= 0 || controller.signal.aborted) {
        controller.abort();
        throw new StripeTimeoutError(`Stripe API request timed out after ${timeoutMs}ms`);
      }
      response = await raceDeadline(fetchFn(url, init), remainingMs, () => controller.abort());
    } catch (err: unknown) {
      clearTimeout(timer);
      controller.abort();
      if (err instanceof StripeTimeoutError || err instanceof StripeValidationError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new StripeTimeoutError(`Stripe API request timed out after ${timeoutMs}ms`);
      }
      throw new StripeProviderError('Network error connecting to Stripe API');
    }

    // Bounded read covered by remaining deadline
    let rawText: string;
    try {
      rawText = await readBoundedText(
        response,
        maxResponseSizeBytes,
        deadlineTimestamp,
        timeoutMs,
        controller,
      );
    } finally {
      clearTimeout(timer);
    }

    if (controller.signal.aborted) {
      throw new StripeTimeoutError(`Stripe API request timed out after ${timeoutMs}ms`);
    }

    let json: unknown;
    try {
      json = rawText.length > 0 ? JSON.parse(rawText) : {};
    } catch {
      throw new StripeValidationError('Failed to parse JSON response from Stripe API');
    }

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }

      let stripeCode: string | undefined;
      let stripeType: string | undefined;
      if (isRecord(json) && isRecord(json.error)) {
        if (typeof json.error.code === 'string' && /^[a-z0-9_]{1,64}$/.test(json.error.code)) {
          stripeCode = json.error.code;
        }
        if (typeof json.error.type === 'string' && /^[a-z0-9_]{1,64}$/.test(json.error.type)) {
          stripeType = json.error.type;
        }
      }

      let requestId: string | undefined;
      const reqIdHeader = response.headers.get('request-id');
      if (reqIdHeader && /^req_[A-Za-z0-9]{1,64}$/.test(reqIdHeader)) {
        requestId = reqIdHeader;
      }

      const safeStatus =
        Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599
          ? response.status
          : 500;

      // Never raw network/upstream message in error: static safe message
      const safeMessage = `Stripe API request failed with status ${safeStatus}`;

      throw new StripeApiError({
        message: safeMessage,
        status: safeStatus,
        stripeCode,
        stripeType,
        requestId,
      });
    }

    return json;
  }

  return {
    get mode() {
      return mode;
    },
    get environment() {
      return environment;
    },
    get apiVersion() {
      return apiVersion;
    },
    get isBillingReady() {
      return isBillingReady;
    },

    async getCustomer(customerId: string): Promise<StripeCustomer | null> {
      ensureEnabled();
      validateCustomerId(customerId);

      if (mode === 'mock') {
        return {
          id: customerId,
          name: 'Mock Customer',
          metadata: {
            workspaceId: customerId.replace('mock_cus_', ''),
            mode: 'mock_not_real',
          },
          livemode: false,
        };
      }

      const res = await makeStripeRequest('GET', `/v1/customers/${encodeURIComponent(customerId)}`);
      if (!res) {
        return null;
      }
      if (!isRecord(res) || res.deleted === true) {
        return null;
      }

      if (typeof res.id !== 'string') {
        throw new StripeValidationError('Customer response missing id');
      }
      if (res.id !== customerId) {
        throw new StripeValidationError(
          `Customer ID mismatch: requested "${customerId}" but received "${res.id}"`,
        );
      }

      return {
        id: res.id,
        name: typeof res.name === 'string' ? res.name : null,
        metadata: validateMetadata(res.metadata),
        livemode: typeof res.livemode === 'boolean' ? res.livemode : false,
      };
    },

    async createCustomer(params: CreateCustomerParams): Promise<StripeCustomer> {
      ensureEnabled();
      if (
        !params.workspaceId ||
        typeof params.workspaceId !== 'string' ||
        !params.workspaceId.trim()
      ) {
        throw new StripeValidationError('Workspace ID is required to create a customer');
      }
      if (
        !params.idempotencyKey ||
        typeof params.idempotencyKey !== 'string' ||
        !params.idempotencyKey.trim()
      ) {
        throw new StripeValidationError(
          'Server-provided idempotencyKey is required to create a customer',
        );
      }

      const userMeta = validateMetadata(params.metadata);

      if (mode === 'mock') {
        return {
          id: `mock_cus_${params.workspaceId}`,
          name: params.name ?? 'Mock Customer',
          metadata: {
            ...userMeta,
            workspaceId: params.workspaceId,
            mode: 'mock_not_real',
          },
          livemode: false,
        };
      }

      // ATProto auth has no email: do NOT invent an email!
      const bodyData: Record<string, unknown> = {
        metadata: {
          ...userMeta,
          workspaceId: params.workspaceId,
        },
      };
      if (params.name && typeof params.name === 'string' && params.name.trim()) {
        bodyData.name = params.name.trim();
      }

      const res = await makeStripeRequest('POST', '/v1/customers', bodyData, params.idempotencyKey);
      if (!isRecord(res) || typeof res.id !== 'string') {
        throw new StripeValidationError('Invalid response for createCustomer');
      }

      return {
        id: res.id,
        name: typeof res.name === 'string' ? res.name : null,
        metadata: validateMetadata(res.metadata),
        livemode: typeof res.livemode === 'boolean' ? res.livemode : false,
      };
    },

    async getPrice(priceId: string): Promise<StripePrice | null> {
      ensureEnabled();
      validatePriceId(priceId);

      if (mode === 'mock') {
        if (config.allowlistedPriceIds && !config.allowlistedPriceIds.includes(priceId)) {
          throw new StripeValidationError(`Price ID "${priceId}" is not allowlisted`);
        }
        return {
          id: priceId,
          active: true,
          currency: 'usd',
          unitAmount: 2000,
          interval: 'month',
          intervalCount: 1,
          productId: 'mock_prod_uptime',
          productActive: true,
          metadata: { mode: 'mock_not_real' },
        };
      }

      const res = await makeStripeRequest(
        'GET',
        `/v1/prices/${encodeURIComponent(priceId)}?expand[]=product`,
      );
      if (!res) {
        return null;
      }
      const price = normalizePrice(res);
      if (price.id !== priceId) {
        throw new StripeValidationError(
          `Price ID mismatch: requested "${priceId}" but received "${price.id}"`,
        );
      }
      return price;
    },

    async createSubscriptionCheckout(
      params: CreateSubscriptionCheckoutParams,
    ): Promise<StripeCheckoutSession> {
      ensureEnabled();
      validatePriceIdAllowlist(params.priceId);
      validateCustomerId(params.customerId);

      if (mode === 'stripe') {
        if (
          !config.webhookSecret ||
          typeof config.webhookSecret !== 'string' ||
          !config.webhookSecret.trim()
        ) {
          throw new StripeConfigurationError(
            'Stripe checkout requires webhookSecret to be configured so fulfillment webhooks can be verified',
          );
        }
      }

      if (
        !params.workspaceId ||
        typeof params.workspaceId !== 'string' ||
        !params.workspaceId.trim()
      ) {
        throw new StripeValidationError('workspaceId is required');
      }
      if (!params.planId || typeof params.planId !== 'string' || !params.planId.trim()) {
        throw new StripeValidationError('planId is required');
      }
      if (!params.clientReferenceId || typeof params.clientReferenceId !== 'string') {
        throw new StripeValidationError('clientReferenceId is required');
      }
      if (params.clientReferenceId !== params.workspaceId) {
        throw new StripeValidationError('clientReferenceId must match workspaceId');
      }

      let revisionStr: string;
      if (typeof params.revision === 'number') {
        if (
          !Number.isFinite(params.revision) ||
          !Number.isSafeInteger(params.revision) ||
          params.revision < 0
        ) {
          throw new StripeValidationError('revision must be a finite non-negative integer');
        }
        revisionStr = String(params.revision);
      } else if (typeof params.revision === 'string') {
        const trimmed = params.revision.trim();
        if (!trimmed || !/^\d+$/.test(trimmed)) {
          throw new StripeValidationError(
            'revision string must be a non-empty representation of a non-negative integer',
          );
        }
        revisionStr = trimmed;
      } else {
        throw new StripeValidationError('revision must be a finite integer or integer string');
      }

      if (
        !params.idempotencyKey ||
        typeof params.idempotencyKey !== 'string' ||
        !params.idempotencyKey.trim()
      ) {
        throw new StripeValidationError('idempotencyKey is required');
      }

      const trustedSuccessUrl = sanitizeUrl(params.successUrl, trustedOrigin);
      const trustedCancelUrl = sanitizeUrl(params.cancelUrl, trustedOrigin);

      const userMeta = validateMetadata(params.metadata);

      if (mode === 'mock') {
        const sessionId = `mock_cs_${params.workspaceId}_${params.planId}`;
        const mockUrl = validateMockUrl(
          `${trustedOrigin}/mock-billing/checkout?session_id=${sessionId}&mode=mock_not_real&plan=${encodeURIComponent(params.planId)}&revision=${encodeURIComponent(revisionStr)}`,
          trustedOrigin,
        );
        return {
          id: sessionId,
          url: mockUrl,
          customerId: params.customerId,
          subscriptionId: `mock_sub_${params.workspaceId}_${params.planId}`,
          clientReferenceId: params.clientReferenceId,
          metadata: {
            ...userMeta,
            workspaceId: params.workspaceId,
            planId: params.planId,
            revision: revisionStr,
            mode: 'mock_not_real',
            payment: 'mock_not_real',
          },
          paymentStatus: 'unpaid',
        };
      }

      // Force server reserved metadata AFTER user metadata
      const bodyData: Record<string, unknown> = {
        customer: params.customerId,
        mode: 'subscription',
        'line_items[0][price]': params.priceId,
        'line_items[0][quantity]': 1,
        client_reference_id: params.clientReferenceId,
        subscription_data: {
          metadata: {
            workspaceId: params.workspaceId,
            planId: params.planId,
            revision: revisionStr,
            mode: 'stripe',
          },
        },
        metadata: {
          ...userMeta,
          workspaceId: params.workspaceId,
          planId: params.planId,
          revision: revisionStr,
          mode: 'stripe',
        },
        success_url: trustedSuccessUrl,
        cancel_url: trustedCancelUrl,
        expires_at: params.expiresAt,
      };

      const res = await makeStripeRequest(
        'POST',
        '/v1/checkout/sessions',
        bodyData,
        params.idempotencyKey,
      );
      if (!isRecord(res) || typeof res.id !== 'string') {
        throw new StripeValidationError('Invalid response for createSubscriptionCheckout');
      }

      validateSessionId(res.id);

      const checkoutUrl = validateCheckoutUrl(res.url, allowedCheckoutDomains);

      return {
        id: res.id,
        url: checkoutUrl,
        customerId:
          typeof res.customer === 'string'
            ? res.customer
            : isRecord(res.customer) && typeof res.customer.id === 'string'
              ? res.customer.id
              : null,
        subscriptionId:
          typeof res.subscription === 'string'
            ? res.subscription
            : isRecord(res.subscription) && typeof res.subscription.id === 'string'
              ? res.subscription.id
              : null,
        clientReferenceId:
          typeof res.client_reference_id === 'string' ? res.client_reference_id : null,
        metadata: validateMetadata(res.metadata),
        paymentStatus: typeof res.payment_status === 'string' ? res.payment_status : undefined,
        status: typeof res.status === 'string' ? res.status : undefined,
        expiresAt: typeof res.expires_at === 'number' ? res.expires_at : undefined,
      };
    },

    async getCheckout(sessionId: string): Promise<StripeCheckoutSession | null> {
      ensureEnabled();
      validateSessionId(sessionId);

      if (mode === 'mock') {
        return {
          id: sessionId,
          url: validateMockUrl(
            `${trustedOrigin}/mock-billing/checkout?session_id=${encodeURIComponent(sessionId)}&mode=mock_not_real`,
            trustedOrigin,
          ),
          customerId: 'mock_cus_default',
          subscriptionId: 'mock_sub_default',
          clientReferenceId: null,
          metadata: { mode: 'mock_not_real' },
          paymentStatus: 'unpaid',
        };
      }

      const res = await makeStripeRequest(
        'GET',
        `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (!res) {
        return null;
      }
      if (!isRecord(res) || typeof res.id !== 'string') {
        throw new StripeValidationError('Invalid response for getCheckout');
      }
      if (res.id !== sessionId) {
        throw new StripeValidationError(
          `Checkout session ID mismatch: requested "${sessionId}" but received "${res.id}"`,
        );
      }

      const checkoutUrl = res.url ? validateCheckoutUrl(res.url, allowedCheckoutDomains) : null;

      return {
        id: res.id,
        url: checkoutUrl,
        customerId:
          typeof res.customer === 'string'
            ? res.customer
            : isRecord(res.customer) && typeof res.customer.id === 'string'
              ? res.customer.id
              : null,
        subscriptionId:
          typeof res.subscription === 'string'
            ? res.subscription
            : isRecord(res.subscription) && typeof res.subscription.id === 'string'
              ? res.subscription.id
              : null,
        clientReferenceId:
          typeof res.client_reference_id === 'string' ? res.client_reference_id : null,
        metadata: validateMetadata(res.metadata),
        paymentStatus: typeof res.payment_status === 'string' ? res.payment_status : undefined,
        status: typeof res.status === 'string' ? res.status : undefined,
        expiresAt: typeof res.expires_at === 'number' ? res.expires_at : undefined,
      };
    },

    async getSubscription(subscriptionId: string): Promise<StripeSubscription | null> {
      ensureEnabled();
      validateSubscriptionId(subscriptionId);

      if (mode === 'mock') {
        return {
          id: subscriptionId,
          customerId: 'mock_cus_default',
          status: 'active',
          cancelAtPeriodEnd: false,
          periodEnd: getNowInSeconds() + 30 * 86400,
          priceIds: config.allowlistedPriceIds ?? ['mock_price_pro'],
          metadata: { mode: 'mock_not_real' },
          livemode: false,
        };
      }

      const res = await makeStripeRequest(
        'GET',
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      );
      if (!res) {
        return null;
      }
      const sub = normalizeSubscription(res);
      if (sub.id !== subscriptionId) {
        throw new StripeValidationError(
          `Subscription ID mismatch: requested "${subscriptionId}" but received "${sub.id}"`,
        );
      }
      return sub;
    },

    async scheduleSubscriptionCancel(
      subscriptionId: string,
      idempotencyKey: string,
    ): Promise<StripeSubscription> {
      ensureEnabled();
      validateSubscriptionId(subscriptionId);
      if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
        throw new StripeValidationError(
          'Stable idempotencyKey is required for scheduleSubscriptionCancel',
        );
      }

      if (mode === 'mock') {
        return {
          id: subscriptionId,
          customerId: 'mock_cus_default',
          status: 'active',
          cancelAtPeriodEnd: true,
          periodEnd: getNowInSeconds() + 30 * 86400,
          priceIds: config.allowlistedPriceIds ?? ['mock_price_pro'],
          metadata: { mode: 'mock_not_real' },
          livemode: false,
        };
      }

      const res = await makeStripeRequest(
        'POST',
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { cancel_at_period_end: true },
        idempotencyKey,
      );

      const sub = normalizeSubscription(res);
      if (sub.id !== subscriptionId) {
        throw new StripeValidationError(
          `Subscription ID mismatch: requested "${subscriptionId}" but received "${sub.id}"`,
        );
      }
      return sub;
    },

    async resumeSubscription(
      subscriptionId: string,
      idempotencyKey: string,
    ): Promise<StripeSubscription> {
      ensureEnabled();
      validateSubscriptionId(subscriptionId);
      if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
        throw new StripeValidationError('Stable idempotencyKey is required for resumeSubscription');
      }

      if (mode === 'mock') {
        return {
          id: subscriptionId,
          customerId: 'mock_cus_default',
          status: 'active',
          cancelAtPeriodEnd: false,
          periodEnd: getNowInSeconds() + 30 * 86400,
          priceIds: config.allowlistedPriceIds ?? ['mock_price_pro'],
          metadata: { mode: 'mock_not_real' },
          livemode: false,
        };
      }

      const res = await makeStripeRequest(
        'POST',
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { cancel_at_period_end: false },
        idempotencyKey,
      );

      const sub = normalizeSubscription(res);
      if (sub.id !== subscriptionId) {
        throw new StripeValidationError(
          `Subscription ID mismatch: requested "${subscriptionId}" but received "${sub.id}"`,
        );
      }
      return sub;
    },

    async getPortalConfiguration(configurationId: string): Promise<StripePortalConfiguration> {
      ensureEnabled();
      if (!/^bpc_[A-Za-z0-9_]+$/.test(configurationId))
        throw new StripeValidationError('Invalid Portal configuration ID');
      if (mode === 'mock')
        return {
          active: true,
          updatesEnabled: true,
          cancellationAtPeriodEnd: true,
          prorationBehavior: 'create_prorations',
          allowedPriceIds: config.allowlistedPriceIds ?? [],
        };
      const res = await makeStripeRequest(
        'GET',
        `/v1/billing_portal/configurations/${encodeURIComponent(configurationId)}`,
      );
      if (!isRecord(res) || res.id !== configurationId || !isRecord(res.features))
        throw new StripeValidationError('Invalid Portal configuration response');
      const update = isRecord(res.features.subscription_update)
        ? res.features.subscription_update
        : {};
      const cancel = isRecord(res.features.subscription_cancel)
        ? res.features.subscription_cancel
        : {};
      const products = Array.isArray(update.products) ? update.products : [];
      return {
        active: res.active === true,
        updatesEnabled:
          update.enabled === true &&
          Array.isArray(update.default_allowed_updates) &&
          update.default_allowed_updates.includes('price'),
        cancellationAtPeriodEnd: cancel.enabled === true && cancel.mode === 'at_period_end',
        prorationBehavior:
          typeof update.proration_behavior === 'string' ? update.proration_behavior : null,
        allowedPriceIds: products.flatMap((product: unknown) =>
          isRecord(product) && Array.isArray(product.prices)
            ? product.prices.filter((price: unknown): price is string => typeof price === 'string')
            : [],
        ),
      };
    },

    async createPortalSession(params: CreatePortalSessionParams): Promise<StripePortalSession> {
      ensureEnabled();
      validateCustomerId(params.customerId);
      if (
        !params.idempotencyKey ||
        typeof params.idempotencyKey !== 'string' ||
        !params.idempotencyKey.trim()
      ) {
        throw new StripeValidationError('idempotencyKey is required to create a portal session');
      }

      const trustedReturnUrl = sanitizeUrl(params.returnUrl, trustedOrigin);

      if (mode === 'mock') {
        const portalUrl = validateMockUrl(
          `${trustedOrigin}/mock-billing/portal?customer_id=${encodeURIComponent(params.customerId)}&mode=mock_not_real`,
          trustedOrigin,
        );
        return {
          id: `mock_portal_${params.customerId}`,
          url: portalUrl,
          customerId: params.customerId,
          returnUrl: trustedReturnUrl,
        };
      }

      const res = await makeStripeRequest(
        'POST',
        '/v1/billing_portal/sessions',
        {
          customer: params.customerId,
          return_url: trustedReturnUrl,
          configuration: params.configurationId,
        },
        params.idempotencyKey,
      );

      if (!isRecord(res) || typeof res.id !== 'string') {
        throw new StripeValidationError('Invalid response for createPortalSession');
      }

      const portalUrl = validatePortalUrl(res.url, allowedPortalDomains);

      return {
        id: res.id,
        url: portalUrl,
        customerId: typeof res.customer === 'string' ? res.customer : params.customerId,
        returnUrl: typeof res.return_url === 'string' ? res.return_url : trustedReturnUrl,
      };
    },

    async verifyWebhook(
      rawBody: string,
      signatureHeader: string,
      toleranceSeconds?: number | undefined,
    ): Promise<StripeWebhookEvent> {
      ensureEnabled();

      if (typeof rawBody !== 'string') {
        throw new StripeValidationError('Raw webhook body must be a string');
      }

      const encoder = new TextEncoder();
      const rawBytes = encoder.encode(rawBody);
      if (rawBytes.byteLength > maxWebhookSizeBytes) {
        throw new StripeValidationError(
          `Webhook payload exceeds maximum size limit (${rawBytes.byteLength} > ${maxWebhookSizeBytes} bytes)`,
        );
      }

      const secret = config.webhookSecret;
      if (!secret || typeof secret !== 'string' || !secret.trim()) {
        throw new StripeConfigurationError(
          'Webhook verification requires webhookSecret in configuration',
        );
      }

      if (!signatureHeader || typeof signatureHeader !== 'string' || !signatureHeader.trim()) {
        throw new StripeSignatureVerificationError('Missing or empty Stripe-Signature header');
      }

      if (signatureHeader.length > 2048) {
        throw new StripeSignatureVerificationError(
          'Stripe-Signature header exceeds maximum allowed length',
        );
      }

      let timestampStr: string | null = null;
      const v1Signatures: string[] = [];

      const parts = signatureHeader.split(',');
      for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) continue;
        const key = part.slice(0, eqIdx).trim();
        const value = part.slice(eqIdx + 1).trim();
        if (!key || !value) continue;

        if (key === 't') {
          if (timestampStr !== null && timestampStr !== value) {
            throw new StripeSignatureVerificationError(
              'Conflicting timestamps found in Stripe-Signature header',
            );
          }
          timestampStr = value;
        } else if (key === 'v1') {
          if (!/^[0-9a-fA-F]{64}$/.test(value)) {
            throw new StripeSignatureVerificationError(
              'Malformed v1 signature in Stripe-Signature header: must be exactly 64 hex characters',
            );
          }
          v1Signatures.push(value.toLowerCase());
        }
      }

      if (!timestampStr) {
        throw new StripeSignatureVerificationError('Stripe-Signature header missing timestamp "t"');
      }
      if (v1Signatures.length === 0) {
        throw new StripeSignatureVerificationError(
          'Stripe-Signature header missing valid "v1" signature',
        );
      }
      if (v1Signatures.length > 10) {
        throw new StripeSignatureVerificationError(
          'Too many v1 signatures in Stripe-Signature header',
        );
      }

      if (!/^\d{1,13}$/.test(timestampStr)) {
        throw new StripeSignatureVerificationError(
          'Malformed timestamp in Stripe-Signature header',
        );
      }

      const timestamp = parseInt(timestampStr, 10);
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
        throw new StripeSignatureVerificationError(
          'Invalid timestamp value in Stripe-Signature header',
        );
      }

      const effectiveTolerance = toleranceSeconds ?? defaultWebhookTolerance;
      if (
        typeof effectiveTolerance !== 'number' ||
        !Number.isFinite(effectiveTolerance) ||
        Number.isNaN(effectiveTolerance) ||
        effectiveTolerance <= 0 ||
        effectiveTolerance > 300
      ) {
        throw new StripeValidationError(
          'Invalid webhook toleranceSeconds: must be positive finite number <= 300',
        );
      }

      const now = getNowInSeconds();
      const diff = now - timestamp;
      if (Math.abs(diff) > effectiveTolerance) {
        throw new StripeSignatureVerificationError(
          `Webhook timestamp outside tolerance window: diff=${diff}s, tolerance=${effectiveTolerance}s`,
        );
      }

      // Exact raw payload used for HMAC signing: ${timestampStr}.${rawBody} (NO reserialization!)
      const signedPayload = `${timestampStr}.${rawBody}`;
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret.trim()),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
      const expectedBytes = new Uint8Array(signatureBuffer);

      let signatureMatched = false;
      for (const sigHex of v1Signatures) {
        const candidateBytes = hexToBytes(sigHex);
        if (candidateBytes && constantTimeEqual(expectedBytes, candidateBytes)) {
          signatureMatched = true;
          break;
        }
      }

      if (!signatureMatched) {
        throw new StripeSignatureVerificationError(
          'No matching v1 signature found in Stripe-Signature header',
        );
      }

      // Parse envelope ONLY AFTER signature verification
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        throw new StripeValidationError('Failed to parse verified webhook payload as JSON');
      }

      if (!isRecord(parsed)) {
        throw new StripeValidationError('Invalid webhook event envelope: expected JSON object');
      }

      if (
        typeof parsed.id !== 'string' ||
        !/^(?:evt_|mock_evt_)[A-Za-z0-9_]{1,100}$/.test(parsed.id)
      ) {
        throw new StripeValidationError('Invalid webhook event envelope: missing or invalid id');
      }

      if (typeof parsed.type !== 'string' || !/^[a-z0-9_.]+$/.test(parsed.type)) {
        throw new StripeValidationError('Invalid webhook event envelope: missing or invalid type');
      }

      if (typeof parsed.livemode !== 'boolean') {
        throw new StripeValidationError(
          'Invalid webhook event envelope: livemode must be a boolean',
        );
      }

      if (
        typeof parsed.created !== 'number' ||
        !Number.isSafeInteger(parsed.created) ||
        parsed.created <= 0
      ) {
        throw new StripeValidationError(
          'Invalid webhook event envelope: created must be a positive integer timestamp',
        );
      }

      if (!isRecord(parsed.data) || !isRecord(parsed.data.object)) {
        throw new StripeValidationError(
          'Invalid webhook event envelope: data.object must be an object',
        );
      }

      // Reject unexpected Connect event account or match config
      if (parsed.account !== undefined || config.expectedAccountId) {
        if (
          typeof parsed.account !== 'string' ||
          !config.expectedAccountId ||
          parsed.account !== config.expectedAccountId
        ) {
          throw new StripeValidationError(
            `Unexpected Stripe Connect account on webhook event: "${String(parsed.account)}"`,
          );
        }
      }

      const eventLivemode = parsed.livemode;
      const expectedLive = isLive();
      if (eventLivemode !== expectedLive) {
        throw new StripeValidationError(
          `Webhook event livemode (${eventLivemode}) does not match configured provider livemode (${expectedLive})`,
        );
      }

      return {
        id: parsed.id,
        type: parsed.type,
        livemode: eventLivemode,
        account: typeof parsed.account === 'string' ? parsed.account : undefined,
        created: parsed.created,
        data: {
          object: parsed.data.object,
          previous_attributes: isRecord(parsed.data.previous_attributes)
            ? parsed.data.previous_attributes
            : undefined,
        },
      };
    },
  };
}
