// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestRoot } from './testing/react-root.js';

const apiMock = vi.hoisted(() => ({
  operatorHealth: vi.fn(),
  operatorScheduling: vi.fn(),
  operatorWorkspaceScheduling: vi.fn(),
}));

vi.mock('./api.js', () => ({
  api: apiMock,
}));

const { OperatorHealthPanel } = await import('./operator-health-panel.js');

describe('OperatorHealthPanel', () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  const baseHealth = {
    generatedAt: '2026-10-04T12:00:00.000Z',
    scheduling: {
      paused: false,
      manual: [],
      automatic: null,
      inFlightMayComplete: true as const,
      resumeConditions: [],
    },
    budget: { forecastUsd: 12.5, ceilingUsd: 20.0 },
    dispatch: {
      oldestPendingAt: '2026-10-04T11:59:30.000Z',
      pendingAgeSeconds: 30,
      failedCount: 2,
      truncated: false,
      deadLetterCount: null, // Honest null: not measured / unsupported
    },
    workspaces: [
      {
        workspaceId: 'ws-1',
        source: 'hosted' as const,
        error: null,
        scheduling: {
          paused: false,
          manual: [],
          automatic: null,
          inFlightMayComplete: true as const,
          resumeConditions: [],
        },
        telemetry: {
          lastSuccessfulTickAt: '2026-10-04T12:00:00.000Z',
          oldestOverdueCheckAt: null,
          reports: {
            lastSuccessfulAt: '2026-10-04T11:59:00.000Z',
            stale: false,
          },
          notificationFailures: {
            count: 0,
            truncated: false,
          },
          targetIncidents: {
            downCount: 1,
            truncated: false,
          },
          regionalProbes: {
            'us-east': { attempts: 120, failures: 0, p95Ms: 45 },
          },
        },
      },
    ],
    nextCursor: 'cursor-page-2',
  };

  it('renders health metrics with honest null for dead letters and probe transport attempts', async () => {
    apiMock.operatorHealth.mockResolvedValue(baseHealth);

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(OperatorHealthPanel, {
          knownWorkspaces: [
            {
              id: 'ws-1',
              name: 'Workspace Alpha',
              ownerDid: 'did:plc:test',
              ownerHandle: 'alpha.test',
              state: 'active',
              monitorCount: 5,
              limits: null,
              rowsRead: 0,
              rowsWritten: 0,
              storageBytes: 0,
              lastSeenAt: null,
            },
          ],
        }),
      );
      await Promise.resolve();
    });

    expect(apiMock.operatorHealth).toHaveBeenCalledWith(undefined, 5);
    expect(view.container.textContent).toContain('Operator Fleet Health');
    expect(view.container.textContent).toContain('Workspace Alpha');
    // Dispatch pending age
    expect(view.container.textContent).toContain('30s');
    // Honest null for dead letters
    expect(view.container.textContent).toContain('Dead Letter Count');
    // Probe transport label - describes transport attempts, not website uptime
    expect(view.container.textContent).toContain(
      'Regional Probes (Last transport attempts, not target website uptime)',
    );
    // Target down incidents
    expect(view.container.textContent).toContain('Target Incidents: 1 down');

    await view.cleanup();
  });

  it.each([null, undefined])(
    'shows an unavailable budget forecast without a zero-cost fallback (%s)',
    async (forecastUsd) => {
      apiMock.operatorHealth.mockResolvedValue({
        ...baseHealth,
        budget: { forecastUsd, ceilingUsd: 20 },
      });
      const view = createTestRoot();
      await act(async () => {
        view.root.render(createElement(OperatorHealthPanel));
        await Promise.resolve();
      });
      const budget = view.container.querySelector('.operator-dispatch-stat')!;
      expect(budget.textContent).toContain('Unknown / unavailable');
      expect(budget.textContent).not.toContain('$0.00');
      expect(budget.textContent).toContain('Ceiling: $20.00');
      await view.cleanup();
    },
  );

  it('paginates workspaces with keyset after / nextCursor', async () => {
    apiMock.operatorHealth.mockResolvedValueOnce(baseHealth).mockResolvedValueOnce({
      ...baseHealth,
      workspaces: [
        {
          workspaceId: 'ws-2',
          source: 'hosted' as const,
          error: null,
          scheduling: {
            paused: false,
            manual: [],
            automatic: null,
            inFlightMayComplete: true as const,
            resumeConditions: [],
          },
          telemetry: null,
        },
      ],
      nextCursor: null,
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorHealthPanel));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('ws-1');
    const nextButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Next 5'),
    )!;
    expect(nextButton.disabled).toBe(false);

    await act(async () => {
      nextButton.click();
      await Promise.resolve();
    });

    expect(apiMock.operatorHealth).toHaveBeenCalledWith('cursor-page-2', 5);
    expect(view.container.textContent).toContain('ws-2');
    expect(view.container.textContent).not.toContain('ws-1');

    // Previous button should now navigate back
    const prevButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Previous 5'),
    )!;
    expect(prevButton.disabled).toBe(false);

    await act(async () => {
      prevButton.click();
      await Promise.resolve();
    });

    expect(apiMock.operatorHealth).toHaveBeenCalledWith(undefined, 5);

    await view.cleanup();
  });

  it('renders paused alert banner with reasons and in-flight dispatch note when fleet paused', async () => {
    const pausedHealth = {
      ...baseHealth,
      scheduling: {
        paused: true,
        manual: [
          {
            scope: 'fleet',
            paused: true,
            actor: 'did:plc:operator',
            reason: 'Emergency database maintenance',
            changedAt: '2026-10-04T11:00:00.000Z',
          },
        ],
        automatic: {
          scope: 'fleet',
          paused: true,
          actor: 'system',
          reason: 'Global budget ceiling exceeded',
          changedAt: '2026-10-04T10:30:00.000Z',
        },
        inFlightMayComplete: true as const,
        resumeConditions: ['Operator manual resume', 'Budget reset or ceiling increased'],
      },
    };
    apiMock.operatorHealth.mockResolvedValue(pausedHealth);

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorHealthPanel));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Monitoring Paused');
    expect(view.container.textContent).toContain('Emergency database maintenance');
    expect(view.container.textContent).toContain('Global budget ceiling exceeded');
    expect(view.container.textContent).toContain('In-flight checks may complete');
    expect(view.container.textContent).toContain('Budget reset or ceiling increased');

    await view.cleanup();
  });

  it('requires 1..500 char reason for fleet pause modal dialog', async () => {
    apiMock.operatorHealth.mockResolvedValue(baseHealth);
    apiMock.operatorScheduling.mockResolvedValue({
      scheduling: {
        paused: true,
        manual: [
          {
            scope: 'fleet',
            paused: true,
            actor: 'did:plc:operator',
            reason: 'Routine load check',
            changedAt: '2026-10-04T12:05:00.000Z',
          },
        ],
        automatic: null,
        inFlightMayComplete: true as const,
        resumeConditions: [],
      },
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorHealthPanel));
      await Promise.resolve();
    });

    const pauseButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.includes('Pause fleet scheduling'),
    )!;

    await act(async () => {
      pauseButton.click();
    });

    // Modal dialog is open
    expect(view.container.textContent).toContain('Pause Fleet Scheduling');
    expect(view.container.textContent).toContain(
      'In-flight checks may complete while cleanup continues',
    );

    const form = view.container.querySelector('form')!;
    const confirmButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;

    // Initially disabled because reason is empty
    expect(confirmButton.disabled).toBe(true);

    const textarea = form.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Routine load check',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(confirmButton.disabled).toBe(false);

    await act(async () => {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMock.operatorScheduling).toHaveBeenCalledWith(true, 'Routine load check');

    await view.cleanup();
  });

  it('displays unconfirmed heartbeat warning for legacy import distinct from pause effective', async () => {
    const unconfirmedHealth = {
      ...baseHealth,
      workspaces: [
        {
          workspaceId: 'ws-legacy-1',
          source: 'legacy_import' as const,
          error: null,
          scheduling: {
            paused: true,
            manual: [
              {
                scope: 'ws-legacy-1',
                paused: true,
                actor: 'did:plc:operator',
                reason: 'Tenant migration',
                changedAt: '2026-10-04T10:00:00.000Z',
              },
            ],
            automatic: null,
            inFlightMayComplete: true as const,
            resumeConditions: [],
          },
          schedulingEnforcement: {
            observedAt: '2026-10-04T09:00:00.000Z',
            confirmed: false, // Stale (> 180s)
          },
          telemetry: null,
        },
      ],
    };
    apiMock.operatorHealth.mockResolvedValue(unconfirmedHealth);

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorHealthPanel));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Legacy Heartbeat Missing / Stale (>180s)');
    expect(view.container.textContent).toContain(
      'Pause is requested, but legacy coordinator enforcement is unconfirmed due to missing/stale heartbeat.',
    );

    await view.cleanup();
  });

  it('renders reader failure distinctly when source is null and error is present', async () => {
    const readerFailureHealth = {
      ...baseHealth,
      workspaces: [
        {
          workspaceId: 'ws-failed-d1',
          source: null,
          error: 'Remote D1 binding failed to respond within timeout',
          scheduling: {
            paused: false,
            manual: [],
            automatic: null,
            inFlightMayComplete: true as const,
            resumeConditions: [],
          },
          telemetry: null,
        },
      ],
    };
    apiMock.operatorHealth.mockResolvedValue(readerFailureHealth);

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorHealthPanel));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain(
      'Reader failure: Remote D1 binding failed to respond within timeout',
    );

    await view.cleanup();
  });

  it('handles fleet-only, budget-only, and workspace pause overlap; allows workspace pause while fleet paused', async () => {
    const fleetAndBudgetPaused = {
      ...baseHealth,
      scheduling: {
        paused: true,
        manual: [
          {
            scope: 'fleet',
            paused: true,
            actor: 'did:plc:operator',
            reason: 'Fleet maintenance',
            changedAt: '2026-10-04T10:00:00.000Z',
          },
        ],
        automatic: {
          scope: 'fleet',
          paused: true,
          actor: 'system',
          reason: 'Budget threshold',
          changedAt: '2026-10-04T09:00:00.000Z',
        },
        inFlightMayComplete: true as const,
        resumeConditions: ['Operator manual resume', 'Budget reset'],
      },
      workspaces: [
        {
          workspaceId: 'ws-1',
          source: 'hosted' as const,
          error: null,
          scheduling: {
            paused: true, // effectively paused due to fleet/budget
            manual: [
              {
                scope: 'fleet',
                paused: true,
                actor: 'did:plc:operator',
                reason: 'Fleet maintenance',
                changedAt: '2026-10-04T10:00:00.000Z',
              },
            ],
            automatic: {
              scope: 'fleet',
              paused: true,
              actor: 'system',
              reason: 'Budget threshold',
              changedAt: '2026-10-04T09:00:00.000Z',
            },
            inFlightMayComplete: true as const,
            resumeConditions: ['Operator resume'],
          },
          telemetry: null,
        },
      ],
    };
    apiMock.operatorHealth.mockResolvedValue(fleetAndBudgetPaused);
    apiMock.operatorWorkspaceScheduling.mockResolvedValue({
      scheduling: {
        paused: true,
        manual: [
          {
            scope: 'ws-1',
            paused: true,
            actor: 'did:plc:operator',
            reason: 'Workspace specific pause',
            changedAt: '2026-10-04T12:00:00.000Z',
          },
        ],
        automatic: null,
        inFlightMayComplete: true as const,
        resumeConditions: ['Workspace resume'],
      },
    });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorHealthPanel));
      await Promise.resolve();
    });

    // Fleet button offers Resume fleet scheduling
    expect(view.container.textContent).toContain('Resume fleet scheduling');

    // Workspace button offers "Pause scheduling" because ws-1 itself has no manual pause!
    const wsButtons = [
      ...view.container.querySelectorAll<HTMLButtonElement>(
        '.operator-workspace-health-card button',
      ),
    ];
    const wsPauseButton = wsButtons.find((b) => b.textContent?.includes('Pause scheduling'));
    expect(wsPauseButton).toBeDefined();

    // Click pause workspace
    await act(async () => {
      wsPauseButton!.click();
    });

    // Dialog opens to pause workspace
    expect(view.container.textContent).toContain('Pause Workspace Scheduling: ws-1');
    const form = view.container.querySelector('form')!;
    const textarea = form.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Workspace specific pause',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMock.operatorWorkspaceScheduling).toHaveBeenCalledWith(
      'ws-1',
      true,
      'Workspace specific pause',
    );

    await view.cleanup();
  });

  it('shows legacy heartbeat badge ONLY for imported workspaces, honest hosted scheduling status for hosted', async () => {
    const mixedWorkspacesHealth = {
      ...baseHealth,
      workspaces: [
        {
          workspaceId: 'ws-hosted',
          source: 'hosted' as const,
          error: null,
          scheduling: {
            paused: false,
            manual: [],
            automatic: null,
            inFlightMayComplete: true as const,
            resumeConditions: [],
          },
          schedulingEnforcement: {
            observedAt: null,
            confirmed: true,
          },
          telemetry: null,
        },
        {
          workspaceId: 'ws-legacy',
          source: 'legacy_import' as const,
          error: null,
          scheduling: {
            paused: false,
            manual: [],
            automatic: null,
            inFlightMayComplete: true as const,
            resumeConditions: [],
          },
          schedulingEnforcement: {
            observedAt: '2026-10-04T12:00:00.000Z',
            confirmed: true,
          },
          telemetry: null,
        },
      ],
    };
    apiMock.operatorHealth.mockResolvedValue(mixedWorkspacesHealth);

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorHealthPanel));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Hosted Scheduling Active');
    expect(view.container.textContent).toContain('Legacy Heartbeat Confirmed');

    await view.cleanup();
  });

  it('does not claim legacy pause effective when heartbeat unconfirmed and displays pause reasons', async () => {
    const unconfirmedPauseHealth = {
      ...baseHealth,
      workspaces: [
        {
          workspaceId: 'ws-legacy-paused',
          source: 'legacy_import' as const,
          error: null,
          scheduling: {
            paused: true,
            manual: [
              {
                scope: 'ws-legacy-paused',
                paused: true,
                actor: 'did:plc:admin',
                reason: 'Database migration in progress',
                changedAt: '2026-10-04T11:00:00.000Z',
              },
            ],
            automatic: null,
            inFlightMayComplete: true as const,
            resumeConditions: ['Migration finished'],
          },
          schedulingEnforcement: {
            observedAt: '2026-10-04T08:00:00.000Z',
            confirmed: false,
          },
          telemetry: null,
        },
      ],
    };
    apiMock.operatorHealth.mockResolvedValue(unconfirmedPauseHealth);

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorHealthPanel));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain(
      'Scheduling Pause Requested (Heartbeat Unconfirmed)',
    );
    expect(view.container.textContent).not.toContain('Scheduling Paused');
    expect(view.container.textContent).toContain('Database migration in progress');
    expect(view.container.textContent).toContain('Migration finished');

    await view.cleanup();
  });

  it('preserves unknown report freshness when stale is null and renders oldest/failures', async () => {
    const telemetryHealth = {
      ...baseHealth,
      workspaces: [
        {
          workspaceId: 'ws-telemetry-test',
          source: 'hosted' as const,
          error: null,
          scheduling: {
            paused: false,
            manual: [],
            automatic: null,
            inFlightMayComplete: true as const,
            resumeConditions: [],
          },
          telemetry: {
            lastSuccessfulTickAt: '2026-10-04T12:00:00.000Z',
            oldestOverdueCheckAt: null,
            reports: {
              lastSuccessfulAt: '2026-10-04T11:30:00.000Z',
              oldestSuccessfulAt: '2026-10-04T09:00:00.000Z',
              stale: null, // Honest unknown
              failedCount: 4,
              truncated: true,
            },
            notificationFailures: {
              count: 0,
              truncated: false,
            },
            regionalProbes: null, // Unknown/not measured
          },
        },
      ],
    };
    apiMock.operatorHealth.mockResolvedValue(telemetryHealth);

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorHealthPanel));
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('(Unknown)');
    expect(view.container.textContent).not.toContain('(Fresh)');
    expect(view.container.textContent).toContain('Oldest:');
    expect(view.container.textContent).toContain('Failures: 4+ (truncated)');
    expect(view.container.textContent).toContain(
      'Regional probe telemetry: Unknown / not measured yet.',
    );

    await view.cleanup();
  });

  it('renders regional probes as compact labeled rows without raw json dump', async () => {
    const probeHealth = {
      ...baseHealth,
      workspaces: [
        {
          workspaceId: 'ws-probes',
          source: 'hosted' as const,
          error: null,
          scheduling: {
            paused: false,
            manual: [],
            automatic: null,
            inFlightMayComplete: true as const,
            resumeConditions: [],
          },
          telemetry: {
            lastSuccessfulTickAt: '2026-10-04T12:00:00.000Z',
            oldestOverdueCheckAt: null,
            reports: {
              lastSuccessfulAt: null,
              stale: null,
            },
            notificationFailures: { count: 0, truncated: false },
            regionalProbes: {
              'eu-west': { attempts: 50, failures: 2, missingResults: 1 },
            },
          },
        },
      ],
    };
    apiMock.operatorHealth.mockResolvedValue(probeHealth);

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorHealthPanel));
      await Promise.resolve();
    });

    expect(view.container.querySelector('pre')).toBeNull();
    expect(view.container.textContent).toContain('Transport Attempts');
    expect(view.container.textContent).toContain('Failures');
    expect(view.container.textContent).toContain('Missing Results');
    expect(view.container.textContent).toContain('eu-west');
    expect(view.container.textContent).toContain('50');
    expect(view.container.textContent).toContain('2');
    expect(view.container.textContent).toContain('1');

    await view.cleanup();
  });

  it('discards stale health responses and displays mutation refresh failures visibly', async () => {
    let resolveFirst!: (val: any) => void;
    let resolveSecond!: (val: any) => void;

    apiMock.operatorHealth
      .mockReturnValueOnce(new Promise((res) => (resolveFirst = res)))
      .mockReturnValueOnce(new Promise((res) => (resolveSecond = res)));

    const view = createTestRoot();
    await act(async () => {
      view.root.render(createElement(OperatorHealthPanel));
    });

    // Trigger second refresh
    const refreshButton = view.container.querySelector<HTMLButtonElement>('button')!;
    await act(async () => {
      refreshButton.click();
    });

    // Resolve second request first with newer data
    const newerHealth = {
      ...baseHealth,
      workspaces: [
        {
          workspaceId: 'ws-newer',
          source: 'hosted' as const,
          error: null,
          scheduling: {
            paused: false,
            manual: [],
            automatic: null,
            inFlightMayComplete: true as const,
            resumeConditions: [],
          },
          telemetry: null,
        },
      ],
    };
    await act(async () => {
      resolveSecond(newerHealth);
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('ws-newer');

    // Resolve first (stale) request
    await act(async () => {
      resolveFirst(baseHealth);
      await Promise.resolve();
    });

    // Must NOT overwrite with stale ws-1
    expect(view.container.textContent).toContain('ws-newer');
    expect(view.container.textContent).not.toContain('ws-1');

    // Now test mutation refresh failure visible
    apiMock.operatorScheduling.mockResolvedValue({
      scheduling: {
        paused: true,
        manual: [
          {
            scope: 'fleet',
            paused: true,
            actor: 'op',
            reason: 'pause test',
            changedAt: '2026-10-04T12:00:00Z',
          },
        ],
        automatic: null,
        inFlightMayComplete: true as const,
        resumeConditions: [],
      },
    });
    apiMock.operatorHealth.mockRejectedValue(new Error('Network error on refresh'));

    const pauseFleetButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.includes('Pause fleet scheduling'),
    )!;

    await act(async () => {
      pauseFleetButton.click();
    });

    const form = view.container.querySelector('form')!;
    const textarea = form.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Fleet pause test',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await Promise.resolve();
    });

    // Visible refresh failure alert
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Scheduling updated, but refreshing health telemetry failed: Network error on refresh',
    );

    await view.cleanup();
  });
});
