import { describe, expect, it, vi } from 'vitest';

import {
  createStripeProvider,
  STRIPE_API_VERSION,
  STRIPE_DOC_URLS,
  StripeApiError,
  StripeConfigurationError,
  StripeProviderError,
  StripeSignatureVerificationError,
  StripeTimeoutError,
  StripeValidationError,
  type StripeSubscriptionStatus,
} from './stripe-provider.js';

// Helper to compute test signature using WebCrypto HMAC-SHA256
async function generateTestSignature(
  secret: string,
  timestamp: number | string,
  body: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('StripeProvider', () => {
  const defaultAppOrigin = 'https://uptime.example.com';
  const testSecretKey = 'sk_test_mock_1234567890abcdef';
  const testWebhookSecret = 'whsec_test_secret_abcdef123456';
  const defaultPriceId = 'price_team_monthly_123';
  const fixedNow = 1700000000;
  const fixedNowMs = fixedNow * 1000;

  describe('configuration, modes, and fail-closed security', () => {
    it('fails closed in stripe mode when secretKey is missing (no automatic mock fallback)', () => {
      expect(() =>
        createStripeProvider({
          mode: 'stripe',
          environment: 'staging',
          appOrigin: defaultAppOrigin,
        }),
      ).toThrow(StripeConfigurationError);

      expect(() =>
        createStripeProvider({
          mode: 'stripe',
          environment: 'development',
          appOrigin: defaultAppOrigin,
          secretKey: '   ',
        }),
      ).toThrow(
        'Stripe mode requires a valid secretKey; automatic mock fallback is strictly forbidden',
      );
    });

    it('strictly rejects mock mode in production environment', () => {
      expect(() =>
        createStripeProvider({
          mode: 'mock',
          environment: 'production',
          appOrigin: defaultAppOrigin,
        }),
      ).toThrow(StripeConfigurationError);

      expect(() =>
        createStripeProvider({
          mode: 'mock',
          environment: 'prod' as any,
          appOrigin: defaultAppOrigin,
        }),
      ).toThrow(StripeConfigurationError);
    });

    it('rejects invalid or unknown environment names', () => {
      expect(() =>
        createStripeProvider({
          mode: 'mock',
          environment: 'staging_wrong' as any,
          appOrigin: defaultAppOrigin,
        }),
      ).toThrow('Invalid environment');

      expect(() =>
        createStripeProvider({
          mode: 'invalid_mode' as any,
          environment: 'staging',
          appOrigin: defaultAppOrigin,
        }),
      ).toThrow('Invalid provider mode');
    });

    it('validates secret key shape (sk_test, sk_live, rk_test, rk_live)', () => {
      expect(() =>
        createStripeProvider({
          mode: 'stripe',
          environment: 'staging',
          secretKey: 'not_a_stripe_key',
          appOrigin: defaultAppOrigin,
        }),
      ).toThrow('Invalid Stripe secret key format');

      expect(() =>
        createStripeProvider({
          mode: 'stripe',
          environment: 'staging',
          secretKey: 'pk_test_1234567890abcdef', // publishable key passed as secret
          appOrigin: defaultAppOrigin,
        }),
      ).toThrow('Invalid Stripe secret key format');
    });

    it('strictly forbids using test secret keys in production environment', () => {
      expect(() =>
        createStripeProvider({
          mode: 'stripe',
          environment: 'production',
          secretKey: 'sk_test_1234567890abcdef',
          appOrigin: defaultAppOrigin,
        }),
      ).toThrow('Cannot use test secret key in production environment');
    });

    it('strictly forbids contradicting livemode configuration', () => {
      expect(() =>
        createStripeProvider({
          mode: 'stripe',
          environment: 'staging',
          secretKey: 'sk_test_1234567890abcdef',
          livemode: true, // conflicts with sk_test_
          appOrigin: defaultAppOrigin,
        }),
      ).toThrow('contradicts secret key mode');
    });

    it('accepts mock mode in staging, test, and development environments', () => {
      for (const env of ['staging', 'test', 'development'] as const) {
        const provider = createStripeProvider({
          mode: 'mock',
          environment: env,
          appOrigin: defaultAppOrigin,
        });
        expect(provider.mode).toBe('mock');
        expect(provider.environment).toBe(env);
        expect(provider.isBillingReady).toBe(true);
      }
    });

    it('requires HTTPS for appOrigin in staging and production, allowing HTTP only for localhost dev/test', () => {
      // HTTP in staging is rejected
      expect(() =>
        createStripeProvider({
          mode: 'mock',
          environment: 'staging',
          appOrigin: 'http://uptime.example.com',
        }),
      ).toThrow('staging and production require HTTPS');

      // HTTP in localhost development is permitted
      const devProvider = createStripeProvider({
        mode: 'mock',
        environment: 'development',
        appOrigin: 'http://localhost:3000',
      });
      expect(devProvider.mode).toBe('mock');

      // Credentials in appOrigin are strictly forbidden
      expect(() =>
        createStripeProvider({
          mode: 'mock',
          environment: 'development',
          appOrigin: 'https://user:pass@uptime.example.com',
        }),
      ).toThrow('Credentials in appOrigin are strictly forbidden');
    });

    it('rejects invalid or unsafe appOrigin URLs', () => {
      expect(() =>
        createStripeProvider({
          mode: 'mock',
          environment: 'development',
          appOrigin: 'javascript:alert(1)',
        }),
      ).toThrow(StripeConfigurationError);

      expect(() =>
        createStripeProvider({
          mode: 'mock',
          environment: 'development',
          appOrigin: 'not-a-valid-url',
        }),
      ).toThrow(StripeConfigurationError);
    });

    it('fails all operations when mode is disabled', async () => {
      const provider = createStripeProvider({
        mode: 'disabled',
        environment: 'staging',
        appOrigin: defaultAppOrigin,
      });

      expect(provider.isBillingReady).toBe(false);
      await expect(provider.getCustomer('cus_123')).rejects.toThrow('Stripe provider is disabled');
      await expect(
        provider.createCustomer({ workspaceId: 'ws_1', idempotencyKey: 'idemp_1' }),
      ).rejects.toThrow('Stripe provider is disabled');
      await expect(provider.getPrice('price_123')).rejects.toThrow('Stripe provider is disabled');
      await expect(
        provider.createSubscriptionCheckout({
          customerId: 'cus_123',
          priceId: 'price_123',
          clientReferenceId: 'ws_1',
          workspaceId: 'ws_1',
          planId: 'plan_pro',
          revision: 1,
          successUrl: '/success',
          cancelUrl: '/cancel',
          idempotencyKey: 'idemp_1',
        }),
      ).rejects.toThrow('Stripe provider is disabled');
    });
  });

  describe('REST API requests, idempotency, and metadata', () => {
    it('creates customer with server-provided idempotency key and workspace metadata without inventing email', async () => {
      let capturedRequest: { url: string; method: string; headers: Headers; body: string } | null =
        null;

      const fakeFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        capturedRequest = {
          url,
          method: init.method!,
          headers: new Headers(init.headers),
          body: init.body as string,
        };
        return new Response(
          JSON.stringify({
            id: 'cus_test_created_123',
            name: 'Workspace Team',
            metadata: {
              workspaceId: 'ws_sample_789',
              tier: 'starter',
            },
            livemode: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      const customer = await provider.createCustomer({
        workspaceId: 'ws_sample_789',
        idempotencyKey: 'srv_idemp_key_999',
        name: 'Workspace Team',
        metadata: { tier: 'starter' },
      });

      expect(customer.id).toBe('cus_test_created_123');
      expect(customer.metadata.workspaceId).toBe('ws_sample_789');
      expect(customer.metadata.tier).toBe('starter');

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.url).toBe('https://api.stripe.com/v1/customers');
      expect(capturedRequest!.method).toBe('POST');
      expect(capturedRequest!.headers.get('Authorization')).toBe(`Bearer ${testSecretKey}`);
      expect(capturedRequest!.headers.get('Stripe-Version')).toBe(STRIPE_API_VERSION);
      expect(capturedRequest!.headers.get('Idempotency-Key')).toBe('srv_idemp_key_999');

      // Verify email was NOT sent and not invented
      const parsedBody = new URLSearchParams(capturedRequest!.body);
      expect(parsedBody.has('email')).toBe(false);
      expect(parsedBody.get('metadata[workspaceId]')).toBe('ws_sample_789');
      expect(parsedBody.get('name')).toBe('Workspace Team');
    });

    it('requires non-empty idempotencyKey on all mutating requests and rejects empty or missing', async () => {
      const provider = createStripeProvider({
        mode: 'stripe',
        environment: 'staging',
        secretKey: testSecretKey,
        webhookSecret: testWebhookSecret,
        appOrigin: defaultAppOrigin,
        allowlistedPriceIds: [defaultPriceId],
      });

      await expect(
        provider.createCustomer({
          workspaceId: 'ws_1',
          idempotencyKey: '   ',
        }),
      ).rejects.toThrow(StripeValidationError);

      await expect(provider.scheduleSubscriptionCancel('sub_123', '')).rejects.toThrow(
        StripeValidationError,
      );

      await expect(provider.resumeSubscription('sub_123', '   ')).rejects.toThrow(
        StripeValidationError,
      );
    });

    it('creates subscription checkout with redirect: error, allowlisted price, and subscription_data.metadata', async () => {
      let capturedBody: string | null = null;
      let capturedHeaders: Headers | null = null;
      let capturedRedirect: RequestRedirect | undefined = undefined;

      const fakeFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = init.body as string;
        capturedHeaders = new Headers(init.headers);
        capturedRedirect = init.redirect;
        return new Response(
          JSON.stringify({
            id: 'cs_test_session_123',
            url: 'https://checkout.stripe.com/c/pay/cs_test_session_123',
            customer: 'cus_existing_456',
            subscription: 'sub_new_789',
            client_reference_id: 'ws_ref_001',
            metadata: {
              workspaceId: 'ws_ref_001',
              planId: 'plan_team_monthly',
              revision: '3',
            },
            payment_status: 'unpaid',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
          allowlistedPriceIds: ['price_team_monthly_123', 'price_team_yearly_456'],
        },
        { fetch: fakeFetch },
      );

      const session = await provider.createSubscriptionCheckout({
        customerId: 'cus_existing_456',
        priceId: 'price_team_monthly_123',
        clientReferenceId: 'ws_ref_001',
        workspaceId: 'ws_ref_001',
        planId: 'plan_team_monthly',
        revision: 3,
        successUrl: '/billing/success?session_id={CHECKOUT_SESSION_ID}',
        cancelUrl: 'https://uptime.example.com/billing/cancel',
        idempotencyKey: 'idemp_checkout_001',
      });

      expect(session.id).toBe('cs_test_session_123');
      expect(session.url).toBe('https://checkout.stripe.com/c/pay/cs_test_session_123');
      expect(session.clientReferenceId).toBe('ws_ref_001');
      expect(capturedRedirect).toBe('error');

      expect(capturedHeaders!.get('Idempotency-Key')).toBe('idemp_checkout_001');
      expect(capturedHeaders!.get('Stripe-Version')).toBe(STRIPE_API_VERSION);

      const params = new URLSearchParams(capturedBody!);
      expect(params.get('customer')).toBe('cus_existing_456');
      expect(params.get('mode')).toBe('subscription');
      expect(params.get('line_items[0][price]')).toBe('price_team_monthly_123');
      expect(params.get('client_reference_id')).toBe('ws_ref_001');
      expect(params.get('subscription_data[metadata][workspaceId]')).toBe('ws_ref_001');
      expect(params.get('subscription_data[metadata][planId]')).toBe('plan_team_monthly');
      expect(params.get('subscription_data[metadata][revision]')).toBe('3');
      expect(params.get('success_url')).toBe(
        'https://uptime.example.com/billing/success?session_id={CHECKOUT_SESSION_ID}',
      );
      expect(params.get('cancel_url')).toBe('https://uptime.example.com/billing/cancel');
    });

    it('enforces server reserved metadata workspaceId/planId/revision AFTER arbitrary metadata', async () => {
      let capturedBody: string | null = null;

      const fakeFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = init.body as string;
        return new Response(
          JSON.stringify({
            id: 'cs_test_session_override',
            url: 'https://checkout.stripe.com/c/pay/cs_override',
            customer: 'cus_existing_456',
            subscription: 'sub_new_789',
            client_reference_id: 'ws_legit',
            metadata: {
              workspaceId: 'ws_legit',
              planId: 'plan_legit',
              revision: '5',
              extraCustom: 'value',
            },
            payment_status: 'unpaid',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
          allowlistedPriceIds: ['price_team_monthly_123'],
        },
        { fetch: fakeFetch },
      );

      // Caller attempts to spoof workspaceId and planId via arbitrary metadata
      await provider.createSubscriptionCheckout({
        customerId: 'cus_existing_456',
        priceId: 'price_team_monthly_123',
        clientReferenceId: 'ws_legit',
        workspaceId: 'ws_legit',
        planId: 'plan_legit',
        revision: 5,
        successUrl: '/success',
        cancelUrl: '/cancel',
        idempotencyKey: 'idemp_sec_1',
        metadata: {
          workspaceId: 'attacker_fake_workspace',
          planId: 'attacker_free_plan',
          extraCustom: 'value',
        },
      });

      const params = new URLSearchParams(capturedBody!);
      // Reserved keys must not be overridden by user metadata
      expect(params.get('metadata[workspaceId]')).toBe('ws_legit');
      expect(params.get('metadata[planId]')).toBe('plan_legit');
      expect(params.get('metadata[revision]')).toBe('5');
      expect(params.get('metadata[extraCustom]')).toBe('value');
    });

    it('strictly enforces clientReferenceId to match workspaceId', async () => {
      const provider = createStripeProvider({
        mode: 'stripe',
        environment: 'staging',
        secretKey: testSecretKey,
        webhookSecret: testWebhookSecret,
        appOrigin: defaultAppOrigin,
        allowlistedPriceIds: ['price_team_monthly_123'],
      });

      await expect(
        provider.createSubscriptionCheckout({
          customerId: 'cus_123',
          priceId: 'price_team_monthly_123',
          clientReferenceId: 'mismatched_ws_id',
          workspaceId: 'genuine_ws_id',
          planId: 'plan_pro',
          revision: 1,
          successUrl: '/success',
          cancelUrl: '/cancel',
          idempotencyKey: 'idemp_1',
        }),
      ).rejects.toThrow('clientReferenceId must match workspaceId');
    });

    it('rejects invalid or non-finite revision values', async () => {
      const provider = createStripeProvider({
        mode: 'stripe',
        environment: 'staging',
        secretKey: testSecretKey,
        webhookSecret: testWebhookSecret,
        appOrigin: defaultAppOrigin,
        allowlistedPriceIds: ['price_team_monthly_123'],
      });

      await expect(
        provider.createSubscriptionCheckout({
          customerId: 'cus_123',
          priceId: 'price_team_monthly_123',
          clientReferenceId: 'ws_1',
          workspaceId: 'ws_1',
          planId: 'plan_pro',
          revision: NaN,
          successUrl: '/success',
          cancelUrl: '/cancel',
          idempotencyKey: 'idemp_1',
        }),
      ).rejects.toThrow(StripeValidationError);

      await expect(
        provider.createSubscriptionCheckout({
          customerId: 'cus_123',
          priceId: 'price_team_monthly_123',
          clientReferenceId: 'ws_1',
          workspaceId: 'ws_1',
          planId: 'plan_pro',
          revision: '',
          successUrl: '/success',
          cancelUrl: '/cancel',
          idempotencyKey: 'idemp_1',
        }),
      ).rejects.toThrow(StripeValidationError);
    });

    it('fails closed when allowlistedPriceIds is missing or empty in checkout', async () => {
      const providerNoAllowlist = createStripeProvider({
        mode: 'stripe',
        environment: 'staging',
        secretKey: testSecretKey,
        webhookSecret: testWebhookSecret,
        appOrigin: defaultAppOrigin,
      });

      await expect(
        providerNoAllowlist.createSubscriptionCheckout({
          customerId: 'cus_123',
          priceId: 'price_team_monthly_123',
          clientReferenceId: 'ws_1',
          workspaceId: 'ws_1',
          planId: 'plan_pro',
          revision: 1,
          successUrl: '/success',
          cancelUrl: '/cancel',
          idempotencyKey: 'idemp_1',
        }),
      ).rejects.toThrow(StripeConfigurationError);
    });

    it('fails closed when webhookSecret is missing during checkout', async () => {
      const providerNoWebhookSecret = createStripeProvider({
        mode: 'stripe',
        environment: 'staging',
        secretKey: testSecretKey,
        appOrigin: defaultAppOrigin,
        allowlistedPriceIds: ['price_team_monthly_123'],
      });

      await expect(
        providerNoWebhookSecret.createSubscriptionCheckout({
          customerId: 'cus_123',
          priceId: 'price_team_monthly_123',
          clientReferenceId: 'ws_1',
          workspaceId: 'ws_1',
          planId: 'plan_pro',
          revision: 1,
          successUrl: '/success',
          cancelUrl: '/cancel',
          idempotencyKey: 'idemp_1',
        }),
      ).rejects.toThrow('Stripe checkout requires webhookSecret');
    });

    it('validates returned checkout URL and rejects untrusted or HTTP domains', async () => {
      const fakeFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'cs_test_evil',
            url: 'https://attacker.evil.com/phish',
            customer: 'cus_123',
            subscription: 'sub_123',
            client_reference_id: 'ws_1',
            metadata: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
          allowlistedPriceIds: ['price_team_monthly_123'],
        },
        { fetch: fakeFetch },
      );

      await expect(
        provider.createSubscriptionCheckout({
          customerId: 'cus_123',
          priceId: 'price_team_monthly_123',
          clientReferenceId: 'ws_1',
          workspaceId: 'ws_1',
          planId: 'plan_pro',
          revision: 1,
          successUrl: '/success',
          cancelUrl: '/cancel',
          idempotencyKey: 'idemp_1',
        }),
      ).rejects.toThrow('Untrusted checkout URL domain');
    });

    it('enforces exact identity matching on getCustomer, getPrice, getSubscription, getCheckout', async () => {
      const fakeFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/customers/')) {
          return new Response(JSON.stringify({ id: 'cus_different_identity', name: 'Other' }), {
            status: 200,
          });
        }
        if (url.includes('/prices/')) {
          return new Response(
            JSON.stringify({ id: 'price_different', active: true, currency: 'usd' }),
            { status: 200 },
          );
        }
        if (url.includes('/subscriptions/')) {
          return new Response(
            JSON.stringify({
              id: 'sub_different',
              customer: 'cus_123',
              status: 'active',
              cancel_at_period_end: false,
              livemode: false,
            }),
            { status: 200 },
          );
        }
        if (url.includes('/checkout/sessions/')) {
          return new Response(
            JSON.stringify({ id: 'cs_different', url: 'https://checkout.stripe.com/pay' }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 404 });
      });

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      await expect(provider.getCustomer('cus_requested')).rejects.toThrow('Customer ID mismatch');
      await expect(provider.getPrice('price_requested')).rejects.toThrow('Price ID mismatch');
      await expect(provider.getSubscription('sub_requested')).rejects.toThrow(
        'Subscription ID mismatch',
      );
      await expect(provider.getCheckout('cs_requested')).rejects.toThrow(
        'Checkout session ID mismatch',
      );
    });

    it('rejects untrusted redirect URLs that do not match appOrigin', async () => {
      const provider = createStripeProvider({
        mode: 'stripe',
        environment: 'staging',
        secretKey: testSecretKey,
        webhookSecret: testWebhookSecret,
        appOrigin: defaultAppOrigin,
        allowlistedPriceIds: ['price_team_monthly_123'],
      });

      // External open redirect
      await expect(
        provider.createSubscriptionCheckout({
          customerId: 'cus_123',
          priceId: 'price_team_monthly_123',
          clientReferenceId: 'ws_1',
          workspaceId: 'ws_1',
          planId: 'plan_pro',
          revision: 1,
          successUrl: 'https://attacker.evil.com/phish',
          cancelUrl: '/cancel',
          idempotencyKey: 'idemp_1',
        }),
      ).rejects.toThrow('Untrusted redirect URL');

      // Credentials in redirect URL
      await expect(
        provider.createSubscriptionCheckout({
          customerId: 'cus_123',
          priceId: 'price_team_monthly_123',
          clientReferenceId: 'ws_1',
          workspaceId: 'ws_1',
          planId: 'plan_pro',
          revision: 1,
          successUrl: 'https://user:pass@uptime.example.com/billing',
          cancelUrl: '/cancel',
          idempotencyKey: 'idemp_1',
        }),
      ).rejects.toThrow('Credentials in redirect URL are strictly forbidden');

      // Javascript protocol injection
      await expect(
        provider.createPortalSession({
          customerId: 'cus_123',
          returnUrl: 'javascript:alert(1)',
          idempotencyKey: 'idemp_2',
        }),
      ).rejects.toThrow(StripeValidationError);
    });
  });

  describe('API response normalization and period end handling across versions', () => {
    it('normalizes periodEnd from items.data[0].current_period_end under Stripe 2025-03-31.basil', async () => {
      const fakeFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'sub_basil_001',
            customer: 'cus_client_1',
            status: 'active',
            cancel_at_period_end: false,
            items: {
              data: [
                {
                  id: 'si_123',
                  current_period_start: 1743465600,
                  current_period_end: 1746057600,
                  price: { id: 'price_team_monthly_123' },
                },
              ],
            },
            metadata: { workspaceId: 'ws_001' },
            livemode: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      const sub = await provider.getSubscription('sub_basil_001');
      expect(sub).not.toBeNull();
      expect(sub!.id).toBe('sub_basil_001');
      expect(sub!.status).toBe('active');
      expect(sub!.cancelAtPeriodEnd).toBe(false);
      expect(sub!.periodEnd).toBe(1746057600);
      expect(sub!.priceIds).toEqual(['price_team_monthly_123']);
      expect(sub!.metadata.workspaceId).toBe('ws_001');
    });

    it('normalizes periodEnd from top-level current_period_end under pre-basil / Acacia schemas', async () => {
      const fakeFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'sub_acacia_002',
            customer: 'cus_client_2',
            status: 'trialing',
            cancel_at_period_end: true,
            current_period_start: 1700000000,
            current_period_end: 1702592000,
            items: {
              data: [
                {
                  id: 'si_999',
                  price: { id: 'price_trial_999' },
                },
              ],
            },
            metadata: { workspaceId: 'ws_002' },
            livemode: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      const sub = await provider.getSubscription('sub_acacia_002');
      expect(sub).not.toBeNull();
      expect(sub!.id).toBe('sub_acacia_002');
      expect(sub!.status).toBe('trialing');
      expect(sub!.cancelAtPeriodEnd).toBe(true);
      expect(sub!.periodEnd).toBe(1702592000);
    });

    it('rejects invalid or non-integer periodEnd values', async () => {
      const fakeFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'sub_bad_period',
            customer: 'cus_client_2',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: -500, // invalid negative timestamp
            livemode: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      await expect(provider.getSubscription('sub_bad_period')).rejects.toThrow(
        'Invalid subscription top-level current_period_end timestamp',
      );
    });

    it('rejects non-boolean price active status (prevents Boolean("false") coercion)', async () => {
      const fakeFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'price_coercion_test',
            active: 'false', // string, should NOT coerce to true
            currency: 'usd',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      await expect(provider.getPrice('price_coercion_test')).rejects.toThrow(
        'Price active field must be a boolean',
      );
    });

    it('explicitly supports all 8 subscription statuses', async () => {
      const statuses: StripeSubscriptionStatus[] = [
        'active',
        'trialing',
        'past_due',
        'unpaid',
        'incomplete',
        'incomplete_expired',
        'canceled',
        'paused',
      ];

      for (const status of statuses) {
        const fakeFetch = vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              id: `sub_${status}`,
              customer: 'cus_1',
              status,
              cancel_at_period_end: false,
              livemode: false,
              items: { data: [{ price: { id: 'price_1' }, current_period_end: 1700000000 }] },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );

        const provider = createStripeProvider(
          {
            mode: 'stripe',
            environment: 'staging',
            secretKey: testSecretKey,
            webhookSecret: testWebhookSecret,
            appOrigin: defaultAppOrigin,
          },
          { fetch: fakeFetch },
        );

        const sub = await provider.getSubscription(`sub_${status}`);
        expect(sub!.status).toBe(status);
      }
    });

    it('rejects invalid or unknown subscription status', async () => {
      const fakeFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'sub_unknown',
            customer: 'cus_1',
            status: 'bogus_invoice_paid_state',
            cancel_at_period_end: false,
            livemode: false,
            items: { data: [] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      await expect(provider.getSubscription('sub_unknown')).rejects.toThrow(
        'Invalid or unrecognized subscription status',
      );
    });

    it('retrieves price details including currency, recurring interval, and product active status', async () => {
      const fakeFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'price_expanded_1',
            active: true,
            currency: 'USD',
            unit_amount: 4900,
            recurring: {
              interval: 'month',
              interval_count: 1,
            },
            product: {
              id: 'prod_uptime_pro',
              active: true,
            },
            metadata: { tier: 'pro' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      const price = await provider.getPrice('price_expanded_1');
      expect(price).not.toBeNull();
      expect(price!.id).toBe('price_expanded_1');
      expect(price!.currency).toBe('usd');
      expect(price!.unitAmount).toBe(4900);
      expect(price!.interval).toBe('month');
      expect(price!.intervalCount).toBe(1);
      expect(price!.productId).toBe('prod_uptime_pro');
      expect(price!.productActive).toBe(true);
      expect(price!.metadata.tier).toBe('pro');
    });
  });

  describe('cancellation and resumption schedule', () => {
    it('schedules cancellation at period end using idempotency key', async () => {
      let capturedBody: string | null = null;
      let capturedHeader: string | null = null;

      const fakeFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = init.body as string;
        capturedHeader = new Headers(init.headers).get('Idempotency-Key');
        return new Response(
          JSON.stringify({
            id: 'sub_to_cancel',
            customer: 'cus_1',
            status: 'active',
            cancel_at_period_end: true,
            livemode: false,
            items: { data: [{ current_period_end: 1800000000 }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      const sub = await provider.scheduleSubscriptionCancel('sub_to_cancel', 'idemp_cancel_1');
      expect(sub.cancelAtPeriodEnd).toBe(true);
      expect(capturedBody).toBe('cancel_at_period_end=true');
      expect(capturedHeader).toBe('idemp_cancel_1');
    });

    it('resumes subscription scheduled for cancellation', async () => {
      let capturedBody: string | null = null;

      const fakeFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = init.body as string;
        return new Response(
          JSON.stringify({
            id: 'sub_to_resume',
            customer: 'cus_1',
            status: 'active',
            cancel_at_period_end: false,
            livemode: false,
            items: { data: [{ current_period_end: 1800000000 }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      const sub = await provider.resumeSubscription('sub_to_resume', 'idemp_resume_1');
      expect(sub.cancelAtPeriodEnd).toBe(false);
      expect(capturedBody).toBe('cancel_at_period_end=false');
    });
  });

  describe('portal session creation', () => {
    it('creates portal session with validated return URL and idempotency header', async () => {
      let capturedBody: string | null = null;
      let capturedHeader: string | null = null;

      const fakeFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = init.body as string;
        capturedHeader = new Headers(init.headers).get('Idempotency-Key');
        return new Response(
          JSON.stringify({
            id: 'pts_test_123',
            url: 'https://billing.stripe.com/p/session/pts_test_123',
            customer: 'cus_123',
            return_url: 'https://uptime.example.com/settings/billing',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      const session = await provider.createPortalSession({
        customerId: 'cus_123',
        returnUrl: '/settings/billing',
        idempotencyKey: 'idemp_portal_1',
      });

      expect(session.id).toBe('pts_test_123');
      expect(session.url).toBe('https://billing.stripe.com/p/session/pts_test_123');
      expect(session.returnUrl).toBe('https://uptime.example.com/settings/billing');

      const params = new URLSearchParams(capturedBody!);
      expect(params.get('customer')).toBe('cus_123');
      expect(params.get('return_url')).toBe('https://uptime.example.com/settings/billing');
      expect(capturedHeader).toBe('idemp_portal_1');
    });
  });

  describe('error redaction, timeouts, and bounded reads', () => {
    it('uses static safe error messages and validated status/stripeCode/requestId without leaking upstream text', async () => {
      const fakeFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              type: 'card_error',
              code: 'card_declined',
              message: `Payment failed for sk_test_secret1234567890 with card number=4242424242424242 cvc=123`,
            },
          }),
          { status: 402, headers: { 'Content-Type': 'application/json', 'request-id': 'req_xyz' } },
        ),
      );

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      try {
        await provider.getCustomer('cus_declined');
        expect.unreachable('Should have thrown StripeApiError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(StripeApiError);
        const apiErr = err as StripeApiError;
        expect(apiErr.status).toBe(402);
        expect(apiErr.stripeCode).toBe('card_declined');
        expect(apiErr.requestId).toBe('req_xyz');
        // Raw upstream message must NEVER be echoed
        expect(apiErr.message).toBe('Stripe API request failed with status 402');
        expect(apiErr.message).not.toContain('sk_test_secret1234567890');
        expect(apiErr.message).not.toContain('4242424242424242');
      }
    });

    it('returns static safe error message on network failure without raw upstream error strings', async () => {
      const fakeFetch = vi
        .fn()
        .mockRejectedValue(new Error('Connection reset by peer at 1.2.3.4:443'));

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      await expect(provider.getCustomer('cus_network_fail')).rejects.toThrow(
        'Network error connecting to Stripe API',
      );
    });

    it('enforces request timeouts and raises StripeTimeoutError', async () => {
      const fakeFetch = vi.fn().mockImplementation(
        async (_url: string, init: RequestInit) =>
          new Promise((_, reject) => {
            const signal = init.signal!;
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
          timeoutMs: 15,
        },
        { fetch: fakeFetch },
      );

      await expect(provider.getCustomer('cus_slow')).rejects.toThrow(StripeTimeoutError);
    });

    it('regression: times out when response body reader stalls indefinitely', async () => {
      const stalledStream = new ReadableStream({
        pull() {
          // Never enqueue or close
          return new Promise(() => {});
        },
      });

      const fakeFetch = vi.fn().mockResolvedValue(
        new Response(stalledStream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
          timeoutMs: 30, // fast timeout
        },
        { fetch: fakeFetch },
      );

      await expect(provider.getCustomer('cus_stall')).rejects.toThrow(StripeTimeoutError);
    });

    it('regression: does not block when reader.cancel stalls', async () => {
      const streamWithStalledCancel = new ReadableStream({
        start(controller) {
          // Send oversized chunk to trigger early cancel
          controller.enqueue(new Uint8Array(100 * 1024)); // 100 KiB > 64 KiB cap
        },
        cancel() {
          // Simulate hanging reader.cancel()
          return new Promise(() => {});
        },
      });

      const fakeFetch = vi.fn().mockResolvedValue(
        new Response(streamWithStalledCancel, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
          timeoutMs: 50,
        },
        { fetch: fakeFetch },
      );

      // Must reject immediately without waiting on stalled cancel()
      await expect(provider.getCustomer('cus_stall_cancel')).rejects.toThrow(StripeValidationError);
    });

    it('rejects oversized responses via Content-Length early check and streaming', async () => {
      const hugeLength = 2 * 1024 * 1024; // 2 MB
      const fakeFetch = vi.fn().mockResolvedValue(
        new Response('small', {
          status: 200,
          headers: { 'Content-Length': String(hugeLength) },
        }),
      );

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { fetch: fakeFetch },
      );

      await expect(provider.getCustomer('cus_huge')).rejects.toThrow(StripeValidationError);
    });
  });

  describe('raw webhook signature verification and envelope parsing', () => {
    const testPayload = JSON.stringify({
      id: 'evt_test_123',
      type: 'customer.subscription.updated',
      livemode: false,
      created: fixedNow - 10,
      data: {
        object: {
          id: 'sub_123',
          customer: 'cus_123',
          status: 'active',
        },
      },
    });

    it('verifies valid signature with exact payload (no restringify) and parses event envelope', async () => {
      const sig = await generateTestSignature(testWebhookSecret, fixedNow, testPayload);
      const header = `t=${fixedNow},v1=${sig}`;

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { nowMs: () => fixedNowMs },
      );

      const event = await provider.verifyWebhook(testPayload, header);
      expect(event.id).toBe('evt_test_123');
      expect(event.type).toBe('customer.subscription.updated');
      expect(event.livemode).toBe(false);
      expect((event.data.object as any).id).toBe('sub_123');
    });

    it('supports multiple v1 signatures for smooth key rotation', async () => {
      const oldSecretSig = '0000000000000000000000000000000000000000000000000000000000000000';
      const validSig = await generateTestSignature(testWebhookSecret, fixedNow, testPayload);
      const multiHeader = `t=${fixedNow},v1=${oldSecretSig},v1=${validSig}`;

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { nowMs: () => fixedNowMs },
      );

      const event = await provider.verifyWebhook(testPayload, multiHeader);
      expect(event.id).toBe('evt_test_123');
    });

    it('rejects duplicate conflicting timestamps in signature header', async () => {
      const sig = await generateTestSignature(testWebhookSecret, fixedNow, testPayload);
      const header = `t=${fixedNow},t=${fixedNow + 100},v1=${sig}`;

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { nowMs: () => fixedNowMs },
      );

      await expect(provider.verifyWebhook(testPayload, header)).rejects.toThrow(
        'Conflicting timestamps found in Stripe-Signature header',
      );
    });

    it('rejects tampered payloads', async () => {
      const sig = await generateTestSignature(testWebhookSecret, fixedNow, testPayload);
      const header = `t=${fixedNow},v1=${sig}`;
      const tamperedPayload = testPayload.replace('sub_123', 'sub_attacker');

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { nowMs: () => fixedNowMs },
      );

      await expect(provider.verifyWebhook(tamperedPayload, header)).rejects.toThrow(
        StripeSignatureVerificationError,
      );
    });

    it('rejects expired timestamps exceeding tolerance window (replay protection)', async () => {
      const expiredTimestamp = fixedNow - 305;
      const sig = await generateTestSignature(testWebhookSecret, expiredTimestamp, testPayload);
      const header = `t=${expiredTimestamp},v1=${sig}`;

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
          webhookToleranceSeconds: 300,
        },
        { nowMs: () => fixedNowMs },
      );

      await expect(provider.verifyWebhook(testPayload, header)).rejects.toThrow(
        'Webhook timestamp outside tolerance window',
      );
    });

    it('rejects future timestamps exceeding tolerance window', async () => {
      const futureTimestamp = fixedNow + 305;
      const sig = await generateTestSignature(testWebhookSecret, futureTimestamp, testPayload);
      const header = `t=${futureTimestamp},v1=${sig}`;

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { nowMs: () => fixedNowMs },
      );

      await expect(provider.verifyWebhook(testPayload, header)).rejects.toThrow(
        'Webhook timestamp outside tolerance window',
      );
    });

    it('validates tolerance parameter and rejects NaN, negative, or excessive tolerance values', async () => {
      const sig = await generateTestSignature(testWebhookSecret, fixedNow, testPayload);
      const header = `t=${fixedNow},v1=${sig}`;

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { nowMs: () => fixedNowMs },
      );

      await expect(provider.verifyWebhook(testPayload, header, NaN)).rejects.toThrow(
        'Invalid webhook toleranceSeconds',
      );
      await expect(provider.verifyWebhook(testPayload, header, -10)).rejects.toThrow(
        'Invalid webhook toleranceSeconds',
      );
      await expect(provider.verifyWebhook(testPayload, header, 600)).rejects.toThrow(
        'Invalid webhook toleranceSeconds',
      );
    });

    it('rejects oversized webhook payloads and signature headers', async () => {
      const oversizedPayload = 'x'.repeat(70000); // default limit is 65536 bytes
      const provider = createStripeProvider({
        mode: 'stripe',
        environment: 'staging',
        secretKey: testSecretKey,
        webhookSecret: testWebhookSecret,
        appOrigin: defaultAppOrigin,
      });

      await expect(provider.verifyWebhook(oversizedPayload, 't=123,v1=abc')).rejects.toThrow(
        StripeValidationError,
      );

      const hugeHeader = 't=123,v1=' + 'a'.repeat(2500);
      await expect(provider.verifyWebhook(testPayload, hugeHeader)).rejects.toThrow(
        'Stripe-Signature header exceeds maximum allowed length',
      );
    });

    it('rejects malformed signature headers and non-64-hex v1 signatures', async () => {
      const provider = createStripeProvider({
        mode: 'stripe',
        environment: 'staging',
        secretKey: testSecretKey,
        webhookSecret: testWebhookSecret,
        appOrigin: defaultAppOrigin,
      });

      const validDummyHex = 'a'.repeat(64);
      await expect(provider.verifyWebhook(testPayload, '')).rejects.toThrow('Missing or empty');
      await expect(provider.verifyWebhook(testPayload, `v1=${validDummyHex}`)).rejects.toThrow(
        'missing timestamp "t"',
      );
      await expect(provider.verifyWebhook(testPayload, 't=12345')).rejects.toThrow(
        'missing valid "v1" signature',
      );
      await expect(
        provider.verifyWebhook(testPayload, `t=not-a-number,v1=${validDummyHex}`),
      ).rejects.toThrow('Malformed timestamp');
      await expect(
        provider.verifyWebhook(testPayload, 't=12345,v1=short_signature'),
      ).rejects.toThrow('must be exactly 64 hex characters');
    });

    it('rejects unexpected Connect event account', async () => {
      const connectPayload = JSON.stringify({
        id: 'evt_connect_123',
        type: 'customer.subscription.updated',
        livemode: false,
        created: fixedNow - 10,
        account: 'acct_untrusted_vendor_999',
        data: { object: { id: 'sub_123' } },
      });

      const sig = await generateTestSignature(testWebhookSecret, fixedNow, connectPayload);
      const header = `t=${fixedNow},v1=${sig}`;

      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: testSecretKey,
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { nowMs: () => fixedNowMs },
      );

      await expect(provider.verifyWebhook(connectPayload, header)).rejects.toThrow(
        'Unexpected Stripe Connect account on webhook event',
      );
    });

    it('rejects livemode mismatch between configured mode and webhook event', async () => {
      const livePayload = JSON.stringify({
        id: 'evt_live_123',
        type: 'customer.subscription.updated',
        livemode: true, // LIVE event
        created: fixedNow - 10,
        data: { object: { id: 'sub_123' } },
      });

      const sig = await generateTestSignature(testWebhookSecret, fixedNow, livePayload);
      const header = `t=${fixedNow},v1=${sig}`;

      // Configured in TEST mode (sk_test_...)
      const provider = createStripeProvider(
        {
          mode: 'stripe',
          environment: 'staging',
          secretKey: 'sk_test_key_1234567890abcdef',
          webhookSecret: testWebhookSecret,
          appOrigin: defaultAppOrigin,
        },
        { nowMs: () => fixedNowMs },
      );

      await expect(provider.verifyWebhook(livePayload, header)).rejects.toThrow(
        'Webhook event livemode (true) does not match configured provider livemode (false)',
      );
    });
  });

  describe('deterministic mock adapter mode', () => {
    it('returns local controlled paths and mock_not_real labels with no live API calls and no payment grant assumption', async () => {
      const mockFetch = vi.fn();
      const provider = createStripeProvider(
        {
          mode: 'mock',
          environment: 'staging',
          appOrigin: defaultAppOrigin,
          allowlistedPriceIds: ['price_mock_team'],
        },
        { fetch: mockFetch },
      );

      // Customer
      const customer = await provider.createCustomer({
        workspaceId: 'ws_mock_99',
        idempotencyKey: 'mock_idemp_1',
      });
      expect(customer.id).toBe('mock_cus_ws_mock_99');
      expect(customer.metadata.mode).toBe('mock_not_real');

      // Price
      const price = await provider.getPrice('price_mock_team');
      expect(price!.id).toBe('price_mock_team');
      expect(price!.active).toBe(true);
      expect(price!.metadata.mode).toBe('mock_not_real');

      // Checkout Session
      const checkout = await provider.createSubscriptionCheckout({
        customerId: customer.id,
        priceId: 'price_mock_team',
        clientReferenceId: 'ws_mock_99',
        workspaceId: 'ws_mock_99',
        planId: 'team',
        revision: 1,
        successUrl: '/success',
        cancelUrl: '/cancel',
        idempotencyKey: 'idemp_mock_checkout',
      });
      expect(checkout.url).toContain('/mock-billing/checkout');
      expect(checkout.url).toContain('mode=mock_not_real');
      expect(checkout.metadata.mode).toBe('mock_not_real');
      expect(checkout.metadata.payment).toBe('mock_not_real');
      expect(checkout.paymentStatus).toBe('unpaid');

      // getCheckout returns unpaid without granting payment
      const retrievedCheckout = await provider.getCheckout(checkout.id);
      expect(retrievedCheckout!.paymentStatus).toBe('unpaid');
      expect(retrievedCheckout!.metadata.mode).toBe('mock_not_real');

      // Portal Session
      const portal = await provider.createPortalSession({
        customerId: customer.id,
        returnUrl: '/settings/billing',
        idempotencyKey: 'idemp_mock_portal',
      });
      expect(portal.url).toContain('/mock-billing/portal');
      expect(portal.url).toContain('mode=mock_not_real');

      // Subscription and schedule cancel/resume
      const sub = await provider.getSubscription('mock_sub_123');
      expect(sub!.status).toBe('active');
      expect(sub!.metadata.mode).toBe('mock_not_real');

      const canceledSub = await provider.scheduleSubscriptionCancel(
        'mock_sub_123',
        'idemp_cancel_mock',
      );
      expect(canceledSub.cancelAtPeriodEnd).toBe(true);

      const resumedSub = await provider.resumeSubscription('mock_sub_123', 'idemp_resume_mock');
      expect(resumedSub.cancelAtPeriodEnd).toBe(false);

      // Verify zero external network calls occurred
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('enforces price allowlists in mock mode as well', async () => {
      const provider = createStripeProvider({
        mode: 'mock',
        environment: 'staging',
        appOrigin: defaultAppOrigin,
        allowlistedPriceIds: ['price_only_allowed'],
      });

      await expect(
        provider.createSubscriptionCheckout({
          customerId: 'mock_cus_123',
          priceId: 'price_not_allowed',
          clientReferenceId: 'ws_1',
          workspaceId: 'ws_1',
          planId: 'pro',
          revision: 1,
          successUrl: '/success',
          cancelUrl: '/cancel',
          idempotencyKey: 'idemp_1',
        }),
      ).rejects.toThrow('Price ID "price_not_allowed" is not allowlisted');
    });
  });

  describe('official documentation URLs verification', () => {
    it('exports proven Stripe API documentation reference URLs', () => {
      expect(STRIPE_DOC_URLS.apiVersions).toBe('https://docs.stripe.com/api-versions');
      expect(STRIPE_DOC_URLS.periodDeprecation).toBe(
        'https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end',
      );
      expect(STRIPE_DOC_URLS.priceObject).toBe('https://docs.stripe.com/api/prices/object');
      expect(STRIPE_DOC_URLS.subscriptionObject).toBe(
        'https://docs.stripe.com/api/subscriptions/object',
      );
      expect(STRIPE_DOC_URLS.checkoutSessions).toBe(
        'https://docs.stripe.com/api/checkout/sessions/create',
      );
      expect(STRIPE_DOC_URLS.portalSessions).toBe(
        'https://docs.stripe.com/api/customer_portal/sessions/create',
      );
      expect(STRIPE_DOC_URLS.webhooks).toBe('https://docs.stripe.com/webhooks');
    });
  });
});
