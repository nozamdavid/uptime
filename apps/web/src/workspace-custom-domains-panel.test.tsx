// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestRoot } from './testing/react-root.js';

const apiMock = vi.hoisted(() => ({
  customDomains: vi.fn(),
  customDomainsSetup: vi.fn(),
  statusPages: vi.fn(),
  createCustomDomain: vi.fn(),
  refreshCustomDomain: vi.fn(),
  simulateCustomDomain: vi.fn(),
  deleteCustomDomain: vi.fn(),
}));

vi.mock('./api.js', async () => {
  const actual = await vi.importActual<typeof import('./api.js')>('./api.js');
  return {
    ...actual,
    api: {
      ...actual.api,
      customDomains: apiMock.customDomains,
      customDomainsSetup: apiMock.customDomainsSetup,
      statusPages: apiMock.statusPages,
      createCustomDomain: apiMock.createCustomDomain,
      refreshCustomDomain: apiMock.refreshCustomDomain,
      simulateCustomDomain: apiMock.simulateCustomDomain,
      deleteCustomDomain: apiMock.deleteCustomDomain,
    },
  };
});

const { WorkspaceCustomDomainsPanel, isValidHostnameInput, formatUtcIso, formatEligibilityReason } =
  await import('./workspace-custom-domains-panel.js');

const mockStatusPages = [
  {
    id: 'sp_1',
    workspaceId: 'ws_1',
    title: 'Public Status',
    publicSlug: 'my-service',
    monitorCount: 3,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
];

const mockDomainDTO = {
  id: 'domain_1',
  workspaceId: 'ws_1',
  statusPageId: 'sp_1',
  hostname: 'status.example.com',
  providerMode: 'mock',
  status: 'active' as const,
  isEligible: false,
  simulationReady: true,
  eligibilityReason: 'mock_simulation_ready',
  errorCode: null,
  verifiedAt: '2025-01-01T12:00:00.000Z',
  recheckDueAt: '2025-01-08T12:00:00.000Z',
  cnameInstruction: {
    type: 'CNAME' as const,
    name: 'status.example.com',
    target: 'custom.uptime.test',
    purpose: 'traffic_routing' as const,
  },
  validationRecords: [
    {
      type: 'TXT' as const,
      name: '_uptime-challenge.status.example.com',
      value: 'uptime-token-123',
      purpose: 'hostname_ownership' as const,
    },
  ],
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T12:00:00.000Z',
};

const mockListResponse = {
  domains: [mockDomainDTO],
  quota: 3,
  totalActive: 1,
  hasMore: false,
  nextCursor: undefined,
  mode: 'mock',
  ready: true,
  setupReasons: [],
  simulation: true,
};

const mockSetupResponse = {
  mode: 'mock',
  ready: true,
  setupReasons: [],
  simulation: true,
  cnameTarget: 'custom.uptime.test',
};

describe('WorkspaceCustomDomainsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.customDomains.mockResolvedValue(mockListResponse);
    apiMock.customDomainsSetup.mockResolvedValue(mockSetupResponse);
    apiMock.statusPages.mockResolvedValue({ statusPages: mockStatusPages });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Hostname validation helper', () => {
    it('validates correct FQDNs', () => {
      expect(isValidHostnameInput('status.example.com').valid).toBe(true);
      expect(isValidHostnameInput('sub.domain.co.uk').valid).toBe(true);
      expect(isValidHostnameInput('uptime123.net').valid).toBe(true);
    });

    it('rejects empty input, protocols, paths, and bad characters', () => {
      expect(isValidHostnameInput('').valid).toBe(false);
      expect(isValidHostnameInput('   ').valid).toBe(false);
      expect(isValidHostnameInput('https://status.example.com').valid).toBe(false);
      expect(isValidHostnameInput('status.example.com/status').valid).toBe(false);
      expect(isValidHostnameInput('invalid_char.com').valid).toBe(false);
      expect(isValidHostnameInput('localhost').valid).toBe(false);
    });
  });

  describe('formatUtcIso helper', () => {
    it('formats ISO strings safely', () => {
      expect(formatUtcIso(null)).toBe('—');
      expect(formatUtcIso(undefined)).toBe('—');
      expect(formatUtcIso('2025-01-01T12:00:00.000Z')).toContain('2025');
    });
  });

  describe('formatEligibilityReason helper', () => {
    it('translates eligibility reason codes to user-facing messages', () => {
      expect(formatEligibilityReason('quota_exceeded')).toContain(
        'Workspace exceeds custom domain quota',
      );
      expect(formatEligibilityReason('status_page_not_public')).toContain(
        'Target status page is not published as public',
      );
      expect(formatEligibilityReason('unverified')).toContain('Domain DNS ownership is unverified');
      expect(formatEligibilityReason('verification_expired')).toContain(
        'Domain verification has expired',
      );
    });
  });

  describe('Domain rendering and permissions', () => {
    it('renders simulation badge, quota allowance, and domain details for owner', async () => {
      const view = createTestRoot();
      await act(async () => {
        view.root.render(createElement(WorkspaceCustomDomainsPanel, { canManage: true }));
        await Promise.resolve();
      });

      const text = view.container.textContent ?? '';
      expect(text).toContain('Custom status domains');
      expect(text).toContain('Staging simulation');
      expect(text).toContain('1 / 3 custom domains used · 2 remaining');
      expect(text).toContain('status.example.com');
      expect(text).toContain('ACTIVE');
      expect(text).toContain('Attached to status page ID: sp_1');
      expect(text).toContain('Add Custom Status Domain');

      await view.cleanup();
    });

    it('renders read-only notice for non-owners and hides create/delete buttons', async () => {
      const view = createTestRoot();
      await act(async () => {
        view.root.render(createElement(WorkspaceCustomDomainsPanel, { canManage: false }));
        await Promise.resolve();
      });

      const text = view.container.textContent ?? '';
      expect(text).toContain(
        'Only workspace owners can configure or modify custom status domains.',
      );
      expect(text).not.toContain('Add Custom Status Domain');
      expect(text).not.toContain('Delete Domain');
      expect(text).not.toContain('Recheck Status');

      await view.cleanup();
    });

    it('renders nothing when importedWorkspace is true', async () => {
      const view = createTestRoot();
      await act(async () => {
        view.root.render(
          createElement(WorkspaceCustomDomainsPanel, { canManage: true, importedWorkspace: true }),
        );
        await Promise.resolve();
      });

      expect(view.container.innerHTML).toBe('');

      await view.cleanup();
    });

    it('displays upgrade notice when quota is 0', async () => {
      apiMock.customDomains.mockResolvedValue({
        ...mockListResponse,
        domains: [],
        quota: 0,
        totalActive: 0,
      });

      const view = createTestRoot();
      await act(async () => {
        view.root.render(createElement(WorkspaceCustomDomainsPanel, { canManage: true }));
        await Promise.resolve();
      });

      expect(view.container.textContent).toContain(
        'Custom domains are unavailable on the current plan.',
      );
      expect(view.container.textContent).toContain('Upgrade your subscription');
      expect(view.container.querySelector('form')).toBeNull();

      await view.cleanup();
    });

    it('displays paused badge and eligibility reason when domain is ineligible in live mode', async () => {
      const liveIneligibleDomain = {
        ...mockDomainDTO,
        providerMode: 'cloudflare',
        isEligible: false,
        simulationReady: false,
        eligibilityReason: 'quota_exceeded',
      };

      apiMock.customDomains.mockResolvedValue({
        ...mockListResponse,
        mode: 'cloudflare',
        simulation: false,
        domains: [liveIneligibleDomain],
      });
      apiMock.customDomainsSetup.mockResolvedValue({
        ...mockSetupResponse,
        mode: 'cloudflare',
        simulation: false,
      });

      const view = createTestRoot();
      await act(async () => {
        view.root.render(createElement(WorkspaceCustomDomainsPanel, { canManage: true }));
        await Promise.resolve();
      });

      const text = view.container.textContent ?? '';
      expect(text).toContain('PAUSED / INELIGIBLE');
      expect(text).toContain('Public routing paused: Workspace exceeds custom domain quota.');

      await view.cleanup();
    });
  });

  describe('Domain creation', () => {
    it('creates custom domain after validation passes and reloads data', async () => {
      apiMock.createCustomDomain.mockResolvedValue({
        ...mockDomainDTO,
        id: 'domain_2',
        hostname: 'status2.example.com',
      });

      const view = createTestRoot();
      await act(async () => {
        view.root.render(createElement(WorkspaceCustomDomainsPanel, { canManage: true }));
        await Promise.resolve();
      });

      const input = view.container.querySelector<HTMLInputElement>(
        'input[placeholder="status.example.com"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          'status2.example.com',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const form = view.container.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });

      expect(apiMock.createCustomDomain).toHaveBeenCalledWith({
        hostname: 'status2.example.com',
        statusPageId: 'sp_1',
      });

      expect(view.container.textContent).toContain(
        'Custom domain status2.example.com added successfully.',
      );

      await view.cleanup();
    });

    it('rejects invalid hostname synchronously before calling API', async () => {
      const view = createTestRoot();
      await act(async () => {
        view.root.render(createElement(WorkspaceCustomDomainsPanel, { canManage: true }));
        await Promise.resolve();
      });

      const input = view.container.querySelector<HTMLInputElement>(
        'input[placeholder="status.example.com"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          'https://bad-url.com',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const form = view.container.querySelector('form')!;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });

      expect(apiMock.createCustomDomain).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain('Enter only the domain name');

      await view.cleanup();
    });

    it('synchronously guards against double-click domain creation', async () => {
      let resolveCreate: (value: any) => void;
      const createPromise = new Promise((resolve) => {
        resolveCreate = resolve;
      });
      apiMock.createCustomDomain.mockReturnValue(createPromise);

      const view = createTestRoot();
      await act(async () => {
        view.root.render(createElement(WorkspaceCustomDomainsPanel, { canManage: true }));
        await Promise.resolve();
      });

      const input = view.container.querySelector<HTMLInputElement>(
        'input[placeholder="status.example.com"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          'app.company.org',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const form = view.container.querySelector('form')!;

      // Trigger two submits synchronously
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });

      expect(apiMock.createCustomDomain).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveCreate!({
          ...mockDomainDTO,
          hostname: 'app.company.org',
        });
        await Promise.resolve();
      });

      await view.cleanup();
    });
  });

  describe('Simulation controls', () => {
    it('simulates ready, pending, and failed states for staging domain', async () => {
      apiMock.simulateCustomDomain.mockResolvedValue({
        ...mockDomainDTO,
        status: 'delete_failed',
      });

      const view = createTestRoot();
      await act(async () => {
        view.root.render(createElement(WorkspaceCustomDomainsPanel, { canManage: true }));
        await Promise.resolve();
      });

      const failedBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Failed'),
      );
      expect(failedBtn).toBeDefined();

      await act(async () => {
        failedBtn!.click();
        await Promise.resolve();
      });

      expect(apiMock.simulateCustomDomain).toHaveBeenCalledWith('domain_1', 'failed');

      await view.cleanup();
    });
  });

  describe('Domain deletion', () => {
    it('requires confirmation before deleting and handles delete_failed retry', async () => {
      apiMock.deleteCustomDomain.mockResolvedValue({ id: 'domain_1', deleted: true });

      const view = createTestRoot();
      await act(async () => {
        view.root.render(createElement(WorkspaceCustomDomainsPanel, { canManage: true }));
        await Promise.resolve();
      });

      const deleteBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Delete Domain'),
      );
      expect(deleteBtn).toBeDefined();

      // First click opens confirmation
      await act(async () => {
        deleteBtn!.click();
      });

      const confirmBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Confirm Delete'),
      );
      expect(confirmBtn).toBeDefined();

      // Second click executes deletion
      await act(async () => {
        confirmBtn!.click();
        await Promise.resolve();
      });

      expect(apiMock.deleteCustomDomain).toHaveBeenCalledWith('domain_1');

      await view.cleanup();
    });
  });

  describe('Pagination', () => {
    it('loads more domains and deduplicates when cursor is provided', async () => {
      apiMock.customDomains.mockResolvedValueOnce({
        ...mockListResponse,
        hasMore: true,
        nextCursor: 'cursor_page_2',
      });

      const domainPage2 = {
        ...mockDomainDTO,
        id: 'domain_page_2',
        hostname: 'second.example.com',
      };

      apiMock.customDomains.mockResolvedValueOnce({
        domains: [domainPage2],
        quota: 3,
        totalActive: 2,
        hasMore: false,
        nextCursor: undefined,
        mode: 'mock',
        ready: true,
        setupReasons: [],
        simulation: true,
      });

      const view = createTestRoot();
      await act(async () => {
        view.root.render(createElement(WorkspaceCustomDomainsPanel, { canManage: true }));
        await Promise.resolve();
      });

      const loadMoreBtn = Array.from(view.container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Load more domains'),
      );
      expect(loadMoreBtn).toBeDefined();

      await act(async () => {
        loadMoreBtn!.click();
        await Promise.resolve();
      });

      expect(apiMock.customDomains).toHaveBeenCalledWith({ cursor: 'cursor_page_2' });
      expect(view.container.textContent).toContain('second.example.com');

      await view.cleanup();
    });
  });
});
