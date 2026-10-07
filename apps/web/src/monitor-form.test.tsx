// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createTestRoot } from './testing/react-root.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IntervalSeconds } from '@uptime/contracts';
import { regionById, regionIds } from '@uptime/regions';

document.body.innerHTML = '<div id="root"></div>';
(window as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
const { DeleteHistoryDialog, MonitorForm } = await import('./monitor-form.js');
const { ProductSessionContext } = await import('./product-shell.js');

function render(
  regionSelection: readonly (typeof regionIds)[number][] = regionIds,
  intervalSeconds: IntervalSeconds = 60,
) {
  return renderToStaticMarkup(
    createElement(MonitorForm, {
      monitor: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'All regions',
        url: 'https://status.example.test/health',
        regionIds: [...regionSelection],
        intervalSeconds,
        timeoutMs: 10_000,
        enabled: true,
        dnsDiagnosticsEnabled: true,
        isPublic: false,
      },
      onCancel: () => undefined,
      onSaved: () => undefined,
    }),
  );
}

describe('nine-region monitor form', () => {
  it('applies hosted free notification and check policy', () => {
    const html = renderToStaticMarkup(
      createElement(
        ProductSessionContext.Provider,
        {
          value: {
            user: { did: 'did:plc:test', handle: 'test.bsky.social' },
            workspace: { id: 'workspace-1', name: 'Test', plan: 'free', state: 'active' },
            role: 'owner',
            usage: { monitors: 1, statusPages: 0, notificationServices: 0 },
            limits: {
              monitors: 3,
              regions: 2,
              allowedRegionIds: ['us-east', 'us-west', 'eu-west'],
              intervalSeconds: 300,
              statusPages: 1,
              notificationServices: 3,
              rawRetentionDays: 1,
              dailyRetentionDays: 30,
            },
          },
        },
        createElement(MonitorForm, {
          monitor: {
            id: 'monitor-1',
            name: 'Test',
            url: 'https://status.example.test/health',
            regionIds: ['us-east'],
            intervalSeconds: 60,
            timeoutMs: 10_000,
            enabled: true,
            dnsDiagnosticsEnabled: true,
            isPublic: false,
          },
          onCancel: () => undefined,
          onSaved: () => undefined,
        }),
      ),
    );
    expect(html).toContain('Check frequency');
    expect(html).toContain('value="2"');
    expect(html).toContain('value="1"');
    expect(html).toContain(
      'Shared workspace quota: 1 of 3 saved monitors. Up to 2 regions per monitor.',
    );
    expect(html).not.toContain('Public sharing is unavailable on the Free plan.');
    expect(html).toContain('The Free plan fixes check frequency at every 5 minutes.');
    expect(html).not.toContain('Verify this origin before monitoring it.');
  });

  it('preserves imported staging monitor settings instead of applying free limits', () => {
    const html = renderToStaticMarkup(
      createElement(
        ProductSessionContext.Provider,
        {
          value: {
            user: { did: 'did:plc:imported', handle: 'imported.test' },
            workspace: {
              id: 'workspace-imported',
              name: 'Imported staging',
              plan: 'free',
              kind: 'staging_import',
              state: 'active',
            },
            role: 'owner',
          },
        },
        createElement(MonitorForm, {
          monitor: {
            id: 'monitor-imported',
            name: 'Imported monitor',
            url: 'https://status.example.test/health',
            regionIds: ['us-east', 'eu-west', 'asia', 'asia-east'],
            intervalSeconds: 60,
            timeoutMs: 20_000,
            enabled: true,
            dnsDiagnosticsEnabled: true,
            isPublic: false,
          },
          onCancel: () => undefined,
          onSaved: () => undefined,
        }),
      ),
    );
    expect(html).toContain('Every 1 min');
    expect(html).toContain('value="20"');
    expect(html).toContain('4 selected regions');
    expect(html).not.toContain('Verify this origin before monitoring it.');
  });

  it('preserves production legacy monitor settings instead of applying free limits', () => {
    const html = renderToStaticMarkup(
      createElement(
        ProductSessionContext.Provider,
        {
          value: {
            user: { did: 'did:plc:legacy', handle: 'legacy.test' },
            workspace: {
              id: 'workspace-legacy',
              name: 'Imported production',
              plan: 'free',
              kind: 'legacy_import',
              state: 'active',
            },
            role: 'owner',
            usage: { monitors: 107, statusPages: 1, notificationServices: 2 },
            limits: null,
          },
        },
        createElement(MonitorForm, {
          monitor: {
            id: 'monitor-legacy',
            name: 'Legacy monitor',
            url: 'https://legacy.example.test/health',
            regionIds: ['us-east', 'eu-west', 'asia', 'asia-east'],
            intervalSeconds: 60,
            timeoutMs: 20_000,
            enabled: true,
            dnsDiagnosticsEnabled: true,
            isPublic: false,
          },
          onCancel: () => undefined,
          onSaved: () => undefined,
        }),
      ),
    );
    expect(html).toContain('Every 1 min');
    expect(html).toContain('value="20"');
    expect(html).toContain('4 selected regions');
    expect(html).not.toContain('Shared workspace quota:');
    expect(html).not.toContain('Monitor limit reached');
  });

  it('requires an exact typed confirmation before deleting history', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: vi.fn(),
    });
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(
        createElement(DeleteHistoryDialog, {
          name: 'All regions',
          onCancel: () => undefined,
          onConfirm,
        }),
      );
    });

    const input = container.querySelector<HTMLInputElement>('input')!;
    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Delete history',
    )!;
    expect(deleteButton.disabled).toBe(true);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'All regions',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(deleteButton.disabled).toBe(false);
    await act(async () => {
      deleteButton
        .closest('form')
        ?.dispatchEvent(
          new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: deleteButton }),
        );
      await Promise.resolve();
    });
    expect(onConfirm).toHaveBeenCalledOnce();

    await cleanup();
  });

  it('filters options to the regions enabled by the API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const payload = url.endsWith('/api/regions')
          ? { regions: [regionById['asia-east'], regionById['asia-south']] }
          : url.endsWith('/api/badges')
            ? { badges: [] }
            : url.endsWith('/api/workspace/usage')
              ? {
                  usage: { monitors: 0, statusPages: 0, notificationServices: 0 },
                  limits: {
                    monitors: 3,
                    regions: 1,
                    allowedRegionIds: ['asia-east', 'asia-south'],
                    intervalSeconds: 300,
                    statusPages: 1,
                    notificationServices: 3,
                    rawRetentionDays: 1,
                    dailyRetentionDays: 30,
                  },
                  budget: { baseUsd: 5, ceilingUsd: 20 },
                }
              : { services: [] };
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(
        createElement(MonitorForm, {
          onCancel: () => undefined,
          onSaved: () => undefined,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Asia East (Tokyo)');
    expect(container.textContent).toContain('Asia South (Mumbai)');
    expect(container.textContent).not.toContain('US East (N. Virginia)');
    expect(container.querySelectorAll('.region-groups .region-option')).toHaveLength(2);

    await cleanup();
    vi.unstubAllGlobals();
  });

  it('lets an owner replace a selected region removed from the deployment', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const payload = url.endsWith('/api/regions')
        ? { regions: [regionById['us-east']] }
        : url.endsWith('/api/workspace/usage')
          ? {
              usage: { monitors: 1, statusPages: 0, notificationServices: 0 },
              limits: {
                monitors: 3,
                regions: 1,
                allowedRegionIds: ['us-east'],
                intervalSeconds: 300,
                statusPages: 1,
                notificationServices: 3,
                rawRetentionDays: 1,
                dailyRetentionDays: 30,
              },
              budget: { baseUsd: 5, ceilingUsd: 20 },
            }
          : url.endsWith('/api/badges')
            ? { badges: [] }
            : url.endsWith('/api/notification-services')
              ? { services: [] }
              : { summary: { monitor: { id: 'monitor-stale' } } };
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(
        createElement(
          ProductSessionContext.Provider,
          {
            value: {
              user: { did: 'did:plc:test', handle: 'test.bsky.social' },
              role: 'owner',
              workspace: { id: 'workspace-1', name: 'Test', plan: 'free', state: 'active' },
              usage: { monitors: 1, statusPages: 0, notificationServices: 0 },
              limits: {
                monitors: 3,
                regions: 1,
                allowedRegionIds: ['us-east'],
                intervalSeconds: 300,
                statusPages: 1,
                notificationServices: 3,
                rawRetentionDays: 1,
                dailyRetentionDays: 30,
              },
            },
          },
          createElement(MonitorForm, {
            monitor: {
              id: 'monitor-stale',
              name: 'Stale selection',
              url: 'https://status.example.test/health',
              regionIds: ['eu-west'],
              intervalSeconds: 300,
              timeoutMs: 10_000,
              enabled: true,
              dnsDiagnosticsEnabled: false,
              isPublic: false,
            },
            onCancel: () => undefined,
            onSaved,
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const options = [
      ...container.querySelectorAll<HTMLInputElement>('.region-groups .region-option input'),
    ];
    const staleRegion = options.find((input) => input.value === 'eu-west')!;
    const replacementRegion = options.find((input) => input.value === 'us-east')!;
    expect(staleRegion.checked).toBe(true);
    expect(container.textContent).toContain('unavailable for this workspace');
    expect(container.textContent).toContain('The saved monitor stays unchanged until then.');

    await act(async () => staleRegion.click());
    await act(async () => replacementRegion.click());
    await act(async () => {
      container
        .querySelector('.monitor-form')!
        .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const updateRequest = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith('/api/monitors/monitor-stale'),
    );
    expect(updateRequest).toBeDefined();
    expect(JSON.parse(String(updateRequest?.[1]?.body))).toMatchObject({ regionIds: ['us-east'] });
    expect(onSaved).toHaveBeenCalledOnce();

    await cleanup();
    vi.unstubAllGlobals();
  });

  it('uses the hosted workspace region policy and per-monitor region limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const payload = url.endsWith('/api/regions')
          ? { regions: [regionById['asia-east'], regionById['asia-south']] }
          : url.endsWith('/api/badges')
            ? { badges: [] }
            : url.endsWith('/api/workspace/usage')
              ? {
                  usage: { monitors: 0, statusPages: 0, notificationServices: 0 },
                  limits: {
                    monitors: 3,
                    regions: 1,
                    allowedRegionIds: ['asia-east', 'asia-south'],
                    intervalSeconds: 300,
                    statusPages: 1,
                    notificationServices: 3,
                    rawRetentionDays: 1,
                    dailyRetentionDays: 30,
                  },
                  budget: { baseUsd: 5, ceilingUsd: 20 },
                }
              : { services: [] };
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(
        createElement(
          ProductSessionContext.Provider,
          {
            value: {
              user: { did: 'did:plc:test', handle: 'test.bsky.social' },
              role: 'owner',
              workspace: { id: 'workspace-1', name: 'Test', plan: 'free', state: 'active' },
              usage: { monitors: 0, statusPages: 0, notificationServices: 0 },
              limits: {
                monitors: 3,
                regions: 1,
                allowedRegionIds: ['asia-east', 'asia-south'],
                intervalSeconds: 300,
                statusPages: 1,
                notificationServices: 3,
                rawRetentionDays: 1,
                dailyRetentionDays: 30,
              },
            },
          },
          createElement(MonitorForm, {
            onCancel: () => undefined,
            onSaved: () => undefined,
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const options = [
      ...container.querySelectorAll<HTMLInputElement>('.region-groups .region-option input'),
    ];
    expect(container.textContent).toContain('Up to 1 region per monitor.');
    expect(container.querySelectorAll('.region-groups .region-option')).toHaveLength(2);
    expect(options.find((input) => input.checked)?.value).toBe('asia-east');
    expect(options.find((input) => input.value === 'asia-south')?.disabled).toBe(true);

    await cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps all four operator-granted regions available to a hosted workspace', async () => {
    const grantedRegions = [
      regionById['us-east'],
      regionById['us-west'],
      regionById['canada-central'],
      regionById['eu-west'],
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const payload = url.endsWith('/api/regions')
          ? { regions: grantedRegions }
          : url.endsWith('/api/badges')
            ? { badges: [] }
            : url.endsWith('/api/workspace/usage')
              ? {
                  usage: { monitors: 0, statusPages: 0, notificationServices: 0 },
                  limits: {
                    monitors: 3,
                    regions: 4,
                    allowedRegionIds: grantedRegions.map((region) => region.id),
                    intervalSeconds: 300,
                    statusPages: 1,
                    notificationServices: 3,
                    rawRetentionDays: 1,
                    dailyRetentionDays: 30,
                  },
                  budget: { baseUsd: 5, ceilingUsd: 20 },
                }
              : { services: [] };
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(
        createElement(
          ProductSessionContext.Provider,
          {
            value: {
              user: { did: 'did:plc:test', handle: 'test.bsky.social' },
              role: 'owner',
              workspace: { id: 'workspace-1', name: 'Test', plan: 'free', state: 'active' },
              usage: { monitors: 0, statusPages: 0, notificationServices: 0 },
              limits: {
                monitors: 3,
                regions: 4,
                allowedRegionIds: grantedRegions.map((region) => region.id),
                intervalSeconds: 300,
                statusPages: 1,
                notificationServices: 3,
                rawRetentionDays: 1,
                dailyRetentionDays: 30,
              },
            },
          },
          createElement(MonitorForm, { onCancel: () => undefined, onSaved: () => undefined }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const options = [
      ...container.querySelectorAll<HTMLInputElement>('.region-groups .region-option input'),
    ];
    expect(options.map((option) => option.value)).toEqual(
      grantedRegions.map((region) => region.id),
    );
    expect(options[3]?.disabled).toBe(false);
    expect(container.textContent).toContain('Up to 4 regions per monitor.');

    await cleanup();
    vi.unstubAllGlobals();
  });

  it('blocks new monitors when workspace usage fails to load and offers retry', async () => {
    let usageAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/workspace/usage')) {
          usageAttempts += 1;
          if (usageAttempts === 1) return Promise.reject(new Error('network down'));
          return Promise.resolve(
            new Response(
              JSON.stringify({
                usage: { monitors: 1, statusPages: 0, notificationServices: 0 },
                limits: {
                  monitors: 3,
                  regions: 1,
                  allowedRegionIds: ['eu-west'],
                  intervalSeconds: 300,
                  statusPages: 1,
                  notificationServices: 3,
                  rawRetentionDays: 1,
                  dailyRetentionDays: 30,
                },
                budget: { baseUsd: 5, ceilingUsd: 20 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        const payload = url.endsWith('/api/regions')
          ? { regions: [regionById['eu-west']] }
          : url.endsWith('/api/badges')
            ? { badges: [] }
            : { services: [] };
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(
        createElement(
          ProductSessionContext.Provider,
          {
            value: {
              user: { did: 'did:plc:test', handle: 'test.bsky.social' },
              role: 'owner',
              workspace: { id: 'workspace-1', name: 'Test', plan: 'free', state: 'active' },
            },
          },
          createElement(MonitorForm, { onCancel: () => undefined, onSaved: () => undefined }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('network down');
    const urlInput = container.querySelector<HTMLInputElement>('input[inputmode="url"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      urlInput,
      'https://public-site.example.test/health',
    );
    await act(async () => {
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Save monitor'),
    )!;
    expect(saveButton.disabled).toBe(true);
    const retryButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Retry loading workspace limits',
    )!;
    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(usageAttempts).toBe(2);
    expect(container.textContent).toContain('Shared workspace quota: 1 of 3 saved monitors.');
    expect(container.textContent).not.toContain('network down');
    expect(saveButton.disabled).toBe(false);
    expect(
      [...container.querySelectorAll<HTMLInputElement>('.region-groups .region-option input')].map(
        (input) => input.value,
      ),
    ).toEqual(['eu-west']);

    await cleanup();
    vi.unstubAllGlobals();
  });

  it('blocks adding a monitor at the workspace-specific saved monitor quota', () => {
    const html = renderToStaticMarkup(
      createElement(
        ProductSessionContext.Provider,
        {
          value: {
            user: { did: 'did:plc:test', handle: 'test.bsky.social' },
            role: 'owner',
            workspace: { id: 'workspace-1', name: 'Test', plan: 'free', state: 'active' },
            usage: { monitors: 7, statusPages: 0, notificationServices: 0 },
            limits: {
              monitors: 7,
              regions: 1,
              allowedRegionIds: ['us-east'],
              intervalSeconds: 300,
              statusPages: 1,
              notificationServices: 3,
              rawRetentionDays: 1,
              dailyRetentionDays: 30,
            },
          },
        },
        createElement(MonitorForm, {
          onCancel: () => undefined,
          onSaved: () => undefined,
        }),
      ),
    );
    expect(html).toContain('7 of 7 saved monitors');
    expect(html).toContain('This workspace has reached its 7-monitor limit.');
    expect(html).toContain('Monitor limit reached');
    expect(html).toContain('disabled');
  });

  it('blocks creating a monitor when the operator sets the quota to zero', () => {
    const html = renderToStaticMarkup(
      createElement(
        ProductSessionContext.Provider,
        {
          value: {
            user: { did: 'did:plc:test', handle: 'test.bsky.social' },
            role: 'owner',
            workspace: { id: 'workspace-1', name: 'Test', plan: 'free', state: 'active' },
            usage: { monitors: 0, statusPages: 0, notificationServices: 0 },
            limits: {
              monitors: 0,
              regions: 1,
              allowedRegionIds: ['us-east'],
              intervalSeconds: 300,
              statusPages: 1,
              notificationServices: 3,
              rawRetentionDays: 1,
              dailyRetentionDays: 30,
            },
          },
        },
        createElement(MonitorForm, { onCancel: () => undefined, onSaved: () => undefined }),
      ),
    );
    expect(html).toContain('0 of 0 saved monitors');
    expect(html).toContain('This workspace has reached its 0-monitor limit.');
    expect(html).toContain('Monitor limit reached');
  });

  it('submits public sharing on a hosted free monitor without hostname ownership proof', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const payload = url.endsWith('/api/regions')
        ? { regions: [regionById['us-east']] }
        : url.endsWith('/api/badges')
          ? { badges: [] }
          : url.endsWith('/api/workspace/usage')
            ? {
                usage: { monitors: 0, statusPages: 0, notificationServices: 0 },
                limits: {
                  monitors: 3,
                  regions: 1,
                  allowedRegionIds: ['us-east'],
                  intervalSeconds: 300,
                  statusPages: 1,
                  notificationServices: 3,
                  rawRetentionDays: 1,
                  dailyRetentionDays: 30,
                },
                budget: { baseUsd: 5, ceilingUsd: 20 },
              }
            : url.endsWith('/api/notification-services')
              ? { services: [] }
              : { summary: { id: 'monitor-created' } };
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    const { container, root, cleanup } = createTestRoot();
    await act(async () => {
      root.render(
        createElement(
          ProductSessionContext.Provider,
          {
            value: {
              user: { did: 'did:plc:test', handle: 'test.bsky.social' },
              role: 'owner',
              workspace: { id: 'workspace-1', name: 'Test', plan: 'free', state: 'active' },
              usage: { monitors: 0, statusPages: 0, notificationServices: 0 },
              limits: {
                monitors: 3,
                regions: 1,
                allowedRegionIds: ['us-east'],
                intervalSeconds: 300,
                statusPages: 1,
                notificationServices: 3,
                rawRetentionDays: 1,
                dailyRetentionDays: 30,
              },
            },
          },
          createElement(MonitorForm, {
            onCancel: () => undefined,
            onSaved,
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const urlInput = container.querySelector<HTMLInputElement>('input[inputmode="url"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      urlInput,
      'https://public-site.example.test/health',
    );
    await act(async () => {
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const sharingCheckbox = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].find((input) => input.parentElement?.textContent?.includes('Share this monitor publicly'))!;
    expect(sharingCheckbox.disabled).toBe(false);
    await act(async () => {
      sharingCheckbox.click();
    });
    expect(sharingCheckbox.checked).toBe(true);
    await act(async () => {
      container
        .querySelector('.monitor-form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const createRequest = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith('/api/monitors'),
    );
    expect(createRequest).toBeDefined();
    expect(JSON.parse(String(createRequest?.[1]?.body))).toMatchObject({
      url: 'https://public-site.example.test/health',
      regionIds: ['us-east'],
      isPublic: true,
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('Verify this origin');
    await cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the three canonical continent groups and all nine options in registry order', () => {
    const markup = render();
    expect(markup).toContain('North America');
    expect(markup).toContain('Europe');
    expect(markup).toContain('Asia');
    expect(markup.match(/type="checkbox"/g) ?? []).toHaveLength(12);
    expect(markup).toContain('Notifications');
    expect(markup).toContain('Failed checks before outage');
    expect(markup).toContain('Healthy checks before recovery');
    expect(markup).toContain('Repeat notifications while down');
    expect(markup).toContain(
      'A round with missing results and no reported failure breaks either streak.',
    );
    expect(markup).toContain('Share this monitor publicly');
    expect(markup).toContain('Public URL slug');
    expect(markup).toContain('/monitors/public/');
    expect(markup).toContain('Exact requests and DNS diagnostics remain private.');
    expect(markup).toContain('Monitor history');
    expect(markup).toContain('Delete all history');
    expect(markup).not.toContain('Delete all monitor history?');
    expect(markup).toContain('HTTPS is used when no scheme is provided.');
    expect(markup).toContain('type="range"');
    expect(markup).toContain('max="23"');
    expect(markup).toContain('Every 1 min');
    expect(markup.indexOf('US East (N. Virginia)')).toBeLessThan(
      markup.indexOf('US West (Oregon)'),
    );
    expect(markup.indexOf('Europe West (Ireland)')).toBeLessThan(
      markup.indexOf('Europe North (Stockholm)'),
    );
    expect(markup.indexOf('Asia Southeast (Singapore)')).toBeLessThan(
      markup.indexOf('Asia East (Tokyo)'),
    );
  });

  it('accounts for all selected regions in check and DNS estimates', () => {
    const markup = render();
    expect(markup).toContain('12,960');
    expect(markup).toContain('9 selected regions');
    expect(markup).toContain('At most 9 regional snapshots per day');
    expect(markup).toContain('up to 3 resolver queries per snapshot');
  });

  it('rounds fractional expected daily checks to a whole number', () => {
    const markup = render(['us-east'], 420);
    expect(markup).toContain('<strong class="tnum">206</strong>');
    expect(markup).not.toMatch(/205[.,]714/);
  });

  it('positions frequency labels at their matching non-linear slider ticks', () => {
    const markup = render();
    expect(markup).toContain('class="frequency-slider__mark" style="left:60.86956521739131%"');
    expect(markup).toContain('class="frequency-slider__mark" style="left:73.91304347826086%"');
    expect(markup).toContain('class="frequency-slider__mark" style="left:86.95652173913044%"');
  });

  it('preserves selected services when the notification service list cannot load', async () => {
    const { container, root, cleanup } = createTestRoot();
    const selectedServiceId = '20000000-0000-4000-8000-000000000001';
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        return url.endsWith('/api/regions')
          ? Promise.resolve(
              new Response(JSON.stringify({ regions: [regionById['us-east']] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            )
          : Promise.reject(new Error('Network unavailable'));
      }),
    );
    await act(async () => {
      root.render(
        createElement(MonitorForm, {
          monitor: {
            id: '00000000-0000-4000-8000-000000000001',
            url: 'https://status.example.test/health',
            regionIds: ['us-east'],
            intervalSeconds: 300,
            timeoutMs: 10_000,
            enabled: true,
            dnsDiagnosticsEnabled: false,
            isPublic: false,
            notificationServiceIds: [selectedServiceId],
            outageThreshold: 3,
            recoveryThreshold: 2,
            repeatNotificationMinutes: null,
          },
          onCancel: () => undefined,
          onSaved: () => undefined,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Existing selections are preserved.');
    expect(container.textContent).toContain('Unavailable notification service');
    expect(container.textContent).toContain(selectedServiceId);
    const unavailableCheckbox = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].find((input) => input.parentElement?.textContent?.includes(selectedServiceId));
    expect(unavailableCheckbox?.checked).toBe(true);

    await cleanup();
  });

  it('updates the displayed frequency as the slider crosses from 15 to 20 minutes', async () => {
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(
        createElement(MonitorForm, {
          monitor: {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Slider monitor',
            url: 'https://status.example.test/health',
            regionIds: ['us-east'],
            intervalSeconds: 900,
            timeoutMs: 10_000,
            enabled: true,
            dnsDiagnosticsEnabled: false,
            isPublic: false,
          },
          onCancel: () => undefined,
          onSaved: () => undefined,
        }),
      );
    });

    const slider = container.querySelector<HTMLInputElement>('#check-frequency')!;
    expect(container.querySelector('.frequency-field__value')?.textContent).toBe('Every 15 min');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, '15');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('.frequency-field__value')?.textContent).toBe('Every 20 min');
    expect(slider.getAttribute('aria-valuetext')).toBe('20 minutes');

    await cleanup();
  });
});
