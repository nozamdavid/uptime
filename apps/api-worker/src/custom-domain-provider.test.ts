import { describe, expect, it } from 'vitest';

import {
  createCustomDomainProvider,
  CustomDomainProviderError,
  CustomHostnameValidationError,
  normalizeCustomStatusHostname,
} from './custom-domain-provider.js';

describe('normalizeCustomStatusHostname', () => {
  it('normalizes valid ASCII hostnames to lowercase', () => {
    expect(normalizeCustomStatusHostname('status.example.com')).toBe('status.example.com');
    expect(normalizeCustomStatusHostname('STATUS.EXAMPLE.COM')).toBe('status.example.com');
    expect(normalizeCustomStatusHostname('Status.Page.Acme-Corp.com')).toBe(
      'status.page.acme-corp.com',
    );
    expect(normalizeCustomStatusHostname('  status.example.com  ')).toBe('status.example.com');
  });

  it('normalizes a single trailing dot to canonical', () => {
    expect(normalizeCustomStatusHostname('status.example.com.')).toBe('status.example.com');
    expect(normalizeCustomStatusHostname('example.com.')).toBe('example.com');
  });

  it('rejects multiple trailing dots or consecutive dots', () => {
    expect(() => normalizeCustomStatusHostname('status.example.com..')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status..example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('.status.example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('.')).toThrow(CustomHostnameValidationError);
    expect(() => normalizeCustomStatusHostname('..')).toThrow(CustomHostnameValidationError);
  });

  it('bounds input length before demanding heavy work', () => {
    const tooLong = `${'a'.repeat(255)}.com`;
    expect(() => normalizeCustomStatusHostname(tooLong)).toThrow(CustomHostnameValidationError);
  });

  it('normalizes internationalized domain names (IDN) to Punycode', () => {
    expect(normalizeCustomStatusHostname('münchen.de')).toBe('xn--mnchen-3ya.de');
    expect(normalizeCustomStatusHostname('MÜNCHEN.DE')).toBe('xn--mnchen-3ya.de');
    expect(normalizeCustomStatusHostname('status.café.com')).toBe('status.xn--caf-dma.com');
  });

  it('supports max label and hostname lengths', () => {
    const label63 = 'a'.repeat(63);
    expect(normalizeCustomStatusHostname(`${label63}.example.com`)).toBe(`${label63}.example.com`);

    const longHost = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.com`;
    expect(longHost.length).toBeLessThanOrEqual(253);
    expect(normalizeCustomStatusHostname(longHost)).toBe(longHost);
  });

  it('rejects empty or whitespace-only input', () => {
    expect(() => normalizeCustomStatusHostname('')).toThrow(CustomHostnameValidationError);
    expect(() => normalizeCustomStatusHostname('   ')).toThrow(CustomHostnameValidationError);
    // @ts-expect-error test invalid types
    expect(() => normalizeCustomStatusHostname(null)).toThrow(CustomHostnameValidationError);
  });

  it('rejects URL schemes', () => {
    expect(() => normalizeCustomStatusHostname('http://status.example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('https://status.example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('ftp://status.example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('ws://status.example.com')).toThrow(
      CustomHostnameValidationError,
    );
  });

  it('rejects URL paths, queries, and fragments without silent truncation', () => {
    expect(() => normalizeCustomStatusHostname('status.example.com/')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.example.com/status')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.example.com\\path')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.example.com?query=1')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.example.com#fragment')).toThrow(
      CustomHostnameValidationError,
    );
  });

  it('rejects user credentials and ports', () => {
    expect(() => normalizeCustomStatusHostname('admin@status.example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('user:pass@status.example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.example.com:443')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.example.com:8080')).toThrow(
      CustomHostnameValidationError,
    );
  });

  it('rejects wildcards', () => {
    expect(() => normalizeCustomStatusHostname('*.example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.*.com')).toThrow(
      CustomHostnameValidationError,
    );
  });

  it('rejects IP addresses of both IPv4 and IPv6 families', () => {
    expect(() => normalizeCustomStatusHostname('127.0.0.1')).toThrow(CustomHostnameValidationError);
    expect(() => normalizeCustomStatusHostname('10.0.0.1')).toThrow(CustomHostnameValidationError);
    expect(() => normalizeCustomStatusHostname('192.168.1.1')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('8.8.8.8')).toThrow(CustomHostnameValidationError);
    expect(() => normalizeCustomStatusHostname('0.0.0.0')).toThrow(CustomHostnameValidationError);
    expect(() => normalizeCustomStatusHostname('1.2.3.4')).toThrow(CustomHostnameValidationError);

    expect(() => normalizeCustomStatusHostname('::1')).toThrow(CustomHostnameValidationError);
    expect(() => normalizeCustomStatusHostname('[::1]')).toThrow(CustomHostnameValidationError);
    expect(() => normalizeCustomStatusHostname('fe80::1')).toThrow(CustomHostnameValidationError);
    expect(() => normalizeCustomStatusHostname('[2001:db8::1]')).toThrow(
      CustomHostnameValidationError,
    );
  });

  it('rejects single-label hosts and internal/local TLDs', () => {
    expect(() => normalizeCustomStatusHostname('localhost')).toThrow(CustomHostnameValidationError);
    expect(() => normalizeCustomStatusHostname('status')).toThrow(CustomHostnameValidationError);
    expect(() => normalizeCustomStatusHostname('app')).toThrow(CustomHostnameValidationError);

    expect(() => normalizeCustomStatusHostname('status.local')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.internal')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.localhost')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.test')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.example')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.invalid')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.lan')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.home')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.corp')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status.onion')).toThrow(
      CustomHostnameValidationError,
    );
  });

  it('rejects invalid DNS labels', () => {
    expect(() => normalizeCustomStatusHostname('-status.example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status-.example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status_page.example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status page.example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname(`${'a'.repeat(64)}.example.com`)).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname(`${'a'.repeat(250)}.com`)).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('example.123')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('example.c')).toThrow(CustomHostnameValidationError);
  });

  it('rejects ambiguous unicode dot characters', () => {
    expect(() => normalizeCustomStatusHostname('status\u3002example.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status\uFF0Eexample.com')).toThrow(
      CustomHostnameValidationError,
    );
    expect(() => normalizeCustomStatusHostname('status\uFF61example.com')).toThrow(
      CustomHostnameValidationError,
    );
  });

  it('rejects incomplete punycode label', () => {
    expect(() => normalizeCustomStatusHostname('xn--.com')).toThrow(CustomHostnameValidationError);
    expect(() => normalizeCustomStatusHostname('xn--.de')).toThrow(CustomHostnameValidationError);
  });

  it('does not blanket-block domains absent caller policy and enforces caller reserved names', () => {
    // Absent caller policy, status.noz.am is not blanket-blocked
    expect(normalizeCustomStatusHostname('status.noz.am')).toBe('status.noz.am');

    // When caller supplies reserved hostnames, policy is enforced
    expect(() =>
      normalizeCustomStatusHostname('noz.am', {
        reservedHostnames: ['noz.am'],
      }),
    ).toThrow(CustomHostnameValidationError);
    expect(() =>
      normalizeCustomStatusHostname('status.noz.am', {
        reservedHostnames: ['noz.am'],
      }),
    ).toThrow(CustomHostnameValidationError);

    // Custom reserved hostnames option
    expect(() =>
      normalizeCustomStatusHostname('status.customcorp.com', {
        reservedHostnames: ['customcorp.com'],
      }),
    ).toThrow(CustomHostnameValidationError);
  });
});

describe('createCustomDomainProvider', () => {
  describe('disabled provider', () => {
    it('fails closed on all operations when disabled', async () => {
      const provider = createCustomDomainProvider({ type: 'disabled' });
      expect(provider.type).toBe('disabled');
      expect(provider.capabilities.purgeCacheByHostname).toBe(false);

      await expect(
        provider.createCustomHostname({ hostname: 'status.example.com' }),
      ).rejects.toThrow('Custom domain provider is disabled');
      await expect(provider.getCustomHostname({ providerId: 'ch-1' })).rejects.toThrow(
        'Custom domain provider is disabled',
      );
      await expect(provider.deleteCustomHostname({ providerId: 'ch-1' })).rejects.toThrow(
        'Custom domain provider is disabled',
      );
      await expect(
        provider.lookupCustomHostname({ hostname: 'status.example.com' }),
      ).rejects.toThrow('Custom domain provider is disabled');
    });
  });

  describe('configuration validation', () => {
    it('rejects ambiguous conflicting type and mode configuration', () => {
      expect(() =>
        createCustomDomainProvider({
          type: 'disabled',
          mode: 'mock',
        } as any),
      ).toThrow('Conflicting provider type and mode specified in configuration');
    });

    it('rejects unconfigured or unknown provider mode', () => {
      expect(() => createCustomDomainProvider({} as any)).toThrow(
        'Unknown or unconfigured provider mode',
      );
    });
  });

  describe('mock provider', () => {
    it('fails closed when attempting to use mock in non-allowlisted environment', () => {
      expect(() =>
        createCustomDomainProvider({
          type: 'mock',
          environment: 'production',
        }),
      ).toThrow(
        'Mock custom domain provider is only permitted in staging, test, or development environments',
      );

      expect(() =>
        createCustomDomainProvider({
          type: 'mock',
          environment: 'prod',
        }),
      ).toThrow(
        'Mock custom domain provider is only permitted in staging, test, or development environments',
      );

      expect(() =>
        createCustomDomainProvider({
          type: 'mock',
          environment: 'unknown-env',
        }),
      ).toThrow(
        'Mock custom domain provider is only permitted in staging, test, or development environments',
      );

      expect(() =>
        createCustomDomainProvider({
          type: 'mock',
          environment: '',
        }),
      ).toThrow(
        'Mock custom domain provider is only permitted in staging, test, or development environments',
      );
    });

    it('returns clones so external mutation cannot prematurely set ready status', async () => {
      const provider = createCustomDomainProvider({
        type: 'mock',
        environment: 'test',
      });

      const created = await provider.createCustomHostname({
        hostname: 'status.immutable.com',
      });
      expect(created.status).toBe('pending_validation');

      // Attempt to mutate external object
      (created as any).status = 'ready';

      // Internal mock state must remain untouched
      const fetched = await provider.getCustomHostname({
        providerId: created.providerId,
      });
      expect(fetched.status).toBe('pending_validation');
    });

    it('provides simulation details and pending states without DNS guesses', async () => {
      const provider = createCustomDomainProvider({
        type: 'mock',
        environment: 'staging',
        cnameTarget: 'status-staging.uptime.noz.am',
      });
      expect(provider.type).toBe('mock');

      const created = await provider.createCustomHostname({
        hostname: 'STATUS.Customer.COM',
      });
      expect(created.hostname).toBe('status.customer.com');
      expect(created.providerId).toMatch(/^mock-ch-/);
      expect(created.status).toBe('pending_validation');
      expect(created.rawHostnameStatus).toBe('pending');
      expect(created.rawSslStatus).toBe('pending_validation');
      expect(created.simulation).toBe(true);
      expect(created.cnameInstruction).toEqual({
        type: 'CNAME',
        name: 'status.customer.com',
        target: 'status-staging.uptime.noz.am',
        purpose: 'traffic_routing',
      });
      expect(created.validationRecords).toHaveLength(2);

      // Get created custom hostname
      const fetched = await provider.getCustomHostname({
        providerId: created.providerId,
        expectedHostname: 'status.customer.com',
      });
      expect(fetched.hostname).toBe('status.customer.com');
      expect(fetched.status).toBe('pending_validation');

      // Reject expectedHostname mismatch
      await expect(
        provider.getCustomHostname({
          providerId: created.providerId,
          expectedHostname: 'different.customer.com',
        }),
      ).rejects.toThrow('Expected hostname different.customer.com but found status.customer.com');

      // Test simulateStatus without any public DNS or network routing
      provider.simulateStatus?.(created.providerId, 'ready');
      const updated = await provider.getCustomHostname({
        providerId: created.providerId,
      });
      expect(updated.status).toBe('ready');
      expect(updated.rawHostnameStatus).toBe('active');
      expect(updated.rawSslStatus).toBe('active');

      // Lookup by hostname
      const lookedUp = await provider.lookupCustomHostname({
        hostname: 'status.customer.com',
      });
      expect(lookedUp?.providerId).toBe(created.providerId);

      // Delete with expectedHostname mismatch must be rejected
      await expect(
        provider.deleteCustomHostname({
          providerId: created.providerId,
          expectedHostname: 'wrong.customer.com',
        }),
      ).rejects.toThrow('Cannot delete: custom hostname does not match expected hostname');

      // Deletion with matching expectedHostname is idempotent
      const del1 = await provider.deleteCustomHostname({
        providerId: created.providerId,
        expectedHostname: 'status.customer.com',
      });
      expect(del1).toEqual({
        providerId: created.providerId,
        deleted: true,
        alreadyDeleted: false,
      });

      const del2 = await provider.deleteCustomHostname({
        providerId: created.providerId,
        expectedHostname: 'status.customer.com',
      });
      expect(del2).toEqual({
        providerId: created.providerId,
        deleted: true,
        alreadyDeleted: true,
      });
    });

    it('enforces anti-adoption in mock provider', async () => {
      const provider = createCustomDomainProvider({
        type: 'mock',
        environment: 'test',
      });

      const item1 = await provider.createCustomHostname({
        hostname: 'status.corp.com',
      });

      // Another creation attempt without existingProviderId must throw conflict
      await expect(provider.createCustomHostname({ hostname: 'status.corp.com' })).rejects.toThrow(
        'Hostname status.corp.com is already claimed',
      );

      // Matching existingProviderId succeeds
      const item2 = await provider.createCustomHostname({
        hostname: 'status.corp.com',
        existingProviderId: item1.providerId,
      });
      expect(item2.providerId).toBe(item1.providerId);
    });
  });

  describe('cloudflare provider', () => {
    it('fails closed when configuration is missing or invalid', () => {
      expect(() =>
        createCustomDomainProvider({
          type: 'cloudflare',
          zoneId: '',
          apiToken: 'secret',
          cnameTarget: 'status.uptime.example.com',
        }),
      ).toThrow('Cloudflare custom domain provider requires zoneId (fail closed)');

      // Rejects arbitrary slashes in zoneId
      expect(() =>
        createCustomDomainProvider({
          type: 'cloudflare',
          zoneId: 'zone/with/slashes',
          apiToken: 'secret',
          cnameTarget: 'status.uptime.example.com',
        }),
      ).toThrow('Cloudflare zoneId must contain only alphanumeric characters');

      expect(() =>
        createCustomDomainProvider({
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: '',
          cnameTarget: 'status.uptime.example.com',
        }),
      ).toThrow('Cloudflare custom domain provider requires apiToken (fail closed)');

      expect(() =>
        createCustomDomainProvider({
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'secret',
          cnameTarget: '',
        }),
      ).toThrow('Cloudflare custom domain provider requires cnameTarget (fail closed)');

      // Non-official or arbitrary base URLs rejected to prevent sending credentials to arbitrary URLs
      expect(() =>
        createCustomDomainProvider({
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'secret',
          cnameTarget: 'status.uptime.example.com',
          baseUrl: 'http://insecure.api.cloudflare.com',
        }),
      ).toThrow('Cloudflare API base URL must be https://api.cloudflare.com/client/v4');

      expect(() =>
        createCustomDomainProvider({
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'secret',
          cnameTarget: 'status.uptime.example.com',
          baseUrl: 'https://evil.cloudflare.com',
        }),
      ).toThrow('Cloudflare API base URL must be https://api.cloudflare.com/client/v4');

      // Allows valid trusted service CNAME target like status.uptime.noz.am
      const validProvider = createCustomDomainProvider({
        type: 'cloudflare',
        zoneId: 'test-zone',
        apiToken: 'secret',
        cnameTarget: 'status.uptime.noz.am',
      });
      expect(validProvider.type).toBe('cloudflare');
    });

    it('creates a custom hostname and validates exact requested hostname', async () => {
      const fakeFetch: typeof fetch = async (url, init) => {
        const urlStr = String(url);
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer test-cf-token',
          Accept: 'application/json',
        });
        expect(init?.redirect).toBe('error');

        if (urlStr.includes('/custom_hostnames?hostname=')) {
          return new Response(JSON.stringify({ success: true, result: [] }), {
            status: 200,
          });
        }

        if (urlStr.includes('/custom_hostnames') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                id: 'cf-ch-12345',
                hostname: 'status.tenant.com',
                status: 'pending',
                ownership_verification: {
                  type: 'txt',
                  name: '_cf-custom-hostname.status.tenant.com',
                  value: 'ownership-token-xyz',
                },
                ssl: {
                  id: 'ssl-123',
                  type: 'dv',
                  method: 'txt',
                  status: 'pending_validation',
                  validation_records: [
                    {
                      txt_name: '_acme-challenge.status.tenant.com',
                      txt_value: 'dcv-token-xyz',
                    },
                  ],
                },
                created_at: '2026-10-05T00:00:00Z',
              },
            }),
            { status: 201 },
          );
        }

        throw new Error(`Unexpected call: ${urlStr}`);
      };

      const provider = createCustomDomainProvider(
        {
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'test-cf-token',
          cnameTarget: 'status-ingress.uptime.example.com',
        },
        { fetch: fakeFetch },
      );

      const created = await provider.createCustomHostname({
        hostname: 'STATUS.Tenant.COM',
      });

      expect(created.providerId).toBe('cf-ch-12345');
      expect(created.hostname).toBe('status.tenant.com');
      expect(created.status).toBe('pending_validation');
    });

    it('rejects provider response when created hostname does not match requested', async () => {
      const fakeFetch: typeof fetch = async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/custom_hostnames?hostname=')) {
          return new Response(JSON.stringify({ success: true, result: [] }), {
            status: 200,
          });
        }
        if (urlStr.includes('/custom_hostnames') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                id: 'cf-ch-mismatch',
                hostname: 'different.host.com',
                status: 'pending',
              },
            }),
            { status: 201 },
          );
        }
        throw new Error(`Unexpected call: ${urlStr}`);
      };

      const provider = createCustomDomainProvider(
        {
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'token',
          cnameTarget: 'status-ingress.example.com',
        },
        { fetch: fakeFetch },
      );

      await expect(
        provider.createCustomHostname({ hostname: 'status.requested.com' }),
      ).rejects.toThrow('Provider returned custom hostname that does not match expected hostname');
    });

    it('validates provider ID and expected hostname on get', async () => {
      const fakeFetch: typeof fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/custom_hostnames/cf-ch-1')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                id: 'cf-ch-different-id',
                hostname: 'status.example.com',
                status: 'active',
              },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected: ${urlStr}`);
      };

      const provider = createCustomDomainProvider(
        {
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'token',
          cnameTarget: 'status.example.com',
        },
        { fetch: fakeFetch },
      );

      await expect(provider.getCustomHostname({ providerId: 'cf-ch-1' })).rejects.toThrow(
        'Provider returned unexpected provider ID',
      );
    });

    it('lookup never returns result[0] when exact match is absent', async () => {
      const fakeFetch: typeof fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/custom_hostnames?hostname=')) {
          // Upstream returns records for completely different domains
          return new Response(
            JSON.stringify({
              success: true,
              result: [
                {
                  id: 'cf-ch-unrelated',
                  hostname: 'other.domain.com',
                  status: 'active',
                },
              ],
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected: ${urlStr}`);
      };

      const provider = createCustomDomainProvider(
        {
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'token',
          cnameTarget: 'status.example.com',
        },
        { fetch: fakeFetch },
      );

      const result = await provider.lookupCustomHostname({
        hostname: 'status.target.com',
      });
      expect(result).toBeNull();
    });

    it('verifies ownership before delete when expectedHostname is supplied', async () => {
      let deleteIssued = false;
      const fakeFetch: typeof fetch = async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/custom_hostnames/cf-ch-10') && init?.method === 'GET') {
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                id: 'cf-ch-10',
                hostname: 'status.actual.com',
                status: 'active',
              },
            }),
            { status: 200 },
          );
        }
        if (urlStr.includes('/custom_hostnames/cf-ch-10') && init?.method === 'DELETE') {
          deleteIssued = true;
          return new Response(JSON.stringify({ success: true, result: { id: 'cf-ch-10' } }), {
            status: 200,
          });
        }
        throw new Error(`Unexpected: ${urlStr}`);
      };

      const provider = createCustomDomainProvider(
        {
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'token',
          cnameTarget: 'status.example.com',
        },
        { fetch: fakeFetch },
      );

      // Attempt delete with mismatching expectedHostname
      await expect(
        provider.deleteCustomHostname({
          providerId: 'cf-ch-10',
          expectedHostname: 'different.hostname.com',
        }),
      ).rejects.toThrow('Provider returned custom hostname that does not match expected hostname');
      expect(deleteIssued).toBe(false);

      // Delete with matching expectedHostname succeeds
      const res = await provider.deleteCustomHostname({
        providerId: 'cf-ch-10',
        expectedHostname: 'status.actual.com',
      });
      expect(res.deleted).toBe(true);
      expect(deleteIssued).toBe(true);
    });

    it('delete with expectedHostname treats GET 404 as idempotent success without issuing DELETE', async () => {
      let deleteIssued = false;
      const fakeFetch: typeof fetch = async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/custom_hostnames/cf-ch-404') && init?.method === 'GET') {
          return new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 1406, message: 'Custom hostname does not exist' }],
            }),
            { status: 404 },
          );
        }
        if (init?.method === 'DELETE') {
          deleteIssued = true;
          return new Response('', { status: 200 });
        }
        throw new Error(`Unexpected: ${urlStr}`);
      };

      const provider = createCustomDomainProvider(
        {
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'token',
          cnameTarget: 'status.example.com',
        },
        { fetch: fakeFetch },
      );

      const res = await provider.deleteCustomHostname({
        providerId: 'cf-ch-404',
        expectedHostname: 'status.example.com',
      });
      expect(res).toEqual({
        providerId: 'cf-ch-404',
        deleted: true,
        alreadyDeleted: true,
      });
      expect(deleteIssued).toBe(false);
    });

    it('delete fails closed if verification provider fails with 500 error', async () => {
      let deleteIssued = false;
      const fakeFetch: typeof fetch = async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/custom_hostnames/cf-ch-500') && init?.method === 'GET') {
          return new Response(JSON.stringify({ success: false, errors: [{ code: 9999 }] }), {
            status: 500,
          });
        }
        if (init?.method === 'DELETE') {
          deleteIssued = true;
          return new Response('', { status: 200 });
        }
        throw new Error(`Unexpected: ${urlStr}`);
      };

      const provider = createCustomDomainProvider(
        {
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'token',
          cnameTarget: 'status.example.com',
        },
        { fetch: fakeFetch },
      );

      await expect(
        provider.deleteCustomHostname({
          providerId: 'cf-ch-500',
          expectedHostname: 'status.example.com',
        }),
      ).rejects.toThrow('Cloudflare API request failed');
      expect(deleteIssued).toBe(false);
    });

    it('requires both hostname status active AND ssl status active to yield ready', async () => {
      let currentHostnameStatus = 'pending';
      let currentSslStatus = 'pending_validation';

      const fakeFetch: typeof fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/custom_hostnames/cf-ch-999')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                id: 'cf-ch-999',
                hostname: 'status.example.com',
                status: currentHostnameStatus,
                ssl: {
                  status: currentSslStatus,
                  validation_records: [],
                },
              },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected call: ${urlStr}`);
      };

      const provider = createCustomDomainProvider(
        {
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'test-token',
          cnameTarget: 'status-ingress.uptime.example.com',
        },
        { fetch: fakeFetch },
      );

      // 1. Pending + Pending -> pending_validation
      const res1 = await provider.getCustomHostname({
        providerId: 'cf-ch-999',
      });
      expect(res1.status).toBe('pending_validation');

      // 2. Active hostname + Pending SSL -> pending_validation
      currentHostnameStatus = 'active';
      currentSslStatus = 'pending_validation';
      const res2 = await provider.getCustomHostname({
        providerId: 'cf-ch-999',
      });
      expect(res2.status).toBe('pending_validation');

      // 3. Pending hostname + Active SSL -> pending_validation
      currentHostnameStatus = 'pending';
      currentSslStatus = 'active';
      const res3 = await provider.getCustomHostname({
        providerId: 'cf-ch-999',
      });
      expect(res3.status).toBe('pending_validation');

      // 4. Active hostname + Active SSL -> ready
      currentHostnameStatus = 'active';
      currentSslStatus = 'active';
      const res4 = await provider.getCustomHostname({
        providerId: 'cf-ch-999',
      });
      expect(res4.status).toBe('ready');

      // 5. Active_re-deploying hostname + Active SSL -> pending_validation (only exact active + ssl active is ready)
      currentHostnameStatus = 'active_re-deploying';
      currentSslStatus = 'active';
      const res5 = await provider.getCustomHostname({
        providerId: 'cf-ch-999',
      });
      expect(res5.status).toBe('pending_validation');

      // 6. Blocked -> blocked
      currentHostnameStatus = 'blocked';
      const res6 = await provider.getCustomHostname({
        providerId: 'cf-ch-999',
      });
      expect(res6.status).toBe('blocked');

      // 7. Unexpected bad status -> pending_validation (fail-closed)
      currentHostnameStatus = 'unknown_future_status';
      currentSslStatus = 'unknown';
      const res7 = await provider.getCustomHostname({
        providerId: 'cf-ch-999',
      });
      expect(res7.status).toBe('pending_validation');
    });

    it('bounds stream reads and aborts oversized responses exceeding 64 KiB', async () => {
      const fakeFetch: typeof fetch = async () => {
        // Stream returning chunks totaling > 64 KiB
        const chunk = new Uint8Array(20 * 1024); // 20 KiB
        let sent = 0;
        const stream = new ReadableStream({
          pull(controller) {
            if (sent < 4) {
              controller.enqueue(chunk);
              sent++;
            } else {
              controller.close();
            }
          },
        });
        return new Response(stream, { status: 200 });
      };

      const provider = createCustomDomainProvider(
        {
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'token',
          cnameTarget: 'status.example.com',
        },
        { fetch: fakeFetch },
      );

      await expect(provider.getCustomHostname({ providerId: 'ch-oversized' })).rejects.toThrow(
        'Cloudflare API response exceeded maximum allowed size',
      );
    });

    it('handles stalled stream with request timeout deadline', async () => {
      const fakeFetch: typeof fetch = async () => {
        // Stalled stream that never delivers data
        const stream = new ReadableStream({
          pull() {
            // Intentionally stall
          },
        });
        return new Response(stream, { status: 200 });
      };

      const provider = createCustomDomainProvider(
        {
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'token',
          cnameTarget: 'status.example.com',
          timeoutMs: 30,
        },
        { fetch: fakeFetch },
      );

      await expect(provider.getCustomHostname({ providerId: 'ch-stalled' })).rejects.toThrow(
        'Request to Cloudflare API timed out',
      );
    });

    it('never leaks hostile upstream tokens or raw error text in error messages', async () => {
      const hostileSecretToken = 'cf-secret-token-super-private-12345';
      const fakeFetch: typeof fetch = async () => {
        // Hostile 502 returning HTML with token in body and error message
        const html = `<html><body>Internal error with upstream token ${hostileSecretToken} and stack trace</body></html>`;
        return new Response(html, {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        });
      };

      const provider = createCustomDomainProvider(
        {
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: hostileSecretToken,
          cnameTarget: 'status-ingress.uptime.example.com',
        },
        { fetch: fakeFetch },
      );

      try {
        await provider.getCustomHostname({ providerId: 'ch-hostile' });
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(CustomDomainProviderError);
        const error = err as CustomDomainProviderError;
        expect(error.code).toBe('provider_http_error');
        // Error message must be static and safe, containing no token and no upstream HTML
        expect(error.message).toBe('Cloudflare API returned unreadable or malformed response');
        expect(error.message).not.toContain(hostileSecretToken);
        expect(error.message).not.toContain('Internal error');
        expect(error.message).not.toContain('<html>');
      }
    });

    it('handles cache purge capability flag and execution', async () => {
      let purgedHost: string | null = null;
      const fakeFetch: typeof fetch = async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/purge_cache') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          purgedHost = body.hosts[0];
          return new Response(JSON.stringify({ success: true, result: { id: 'purge-1' } }), {
            status: 200,
          });
        }
        throw new Error(`Unexpected: ${urlStr}`);
      };

      const providerWithPurge = createCustomDomainProvider(
        {
          type: 'cloudflare',
          zoneId: 'test-zone',
          apiToken: 'token',
          cnameTarget: 'status.uptime.example.com',
          enableCachePurge: true,
        },
        { fetch: fakeFetch },
      );
      expect(providerWithPurge.capabilities.purgeCacheByHostname).toBe(true);
      const res = await providerWithPurge.purgeCacheByHostname!('STATUS.example.com');
      expect(res.purged).toBe(true);
      expect(purgedHost).toBe('status.example.com');
    });
  });
});
