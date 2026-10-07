// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { regionById, type RegionId } from '@uptime/regions';
import { createTestRoot } from './testing/react-root.js';

const apiMock = vi.hoisted(() => ({
  operatorWorkspaceLimitsPreview: vi.fn(),
  updateOperatorWorkspaceLimits: vi.fn(),
}));

vi.mock('./api.js', () => ({
  api: apiMock,
}));

const { WorkspaceLimitsEditor } = await import('./operator-quota-editor.js');

describe('WorkspaceLimitsEditor', () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  const availableRegions = [regionById['us-east'], regionById['eu-west'], regionById.asia];

  const sampleWorkspace = {
    id: 'workspace-1',
    name: 'Production Workspace',
    ownerDid: 'did:plc:owner',
    ownerHandle: 'owner.test',
    state: 'active' as const,
    monitorCount: 2,
    limits: {
      monitors: 3,
      regions: 2,
      allowedRegionIds: ['us-east', 'eu-west'] as RegionId[],
      intervalSeconds: 300,
      statusPages: 1,
      notificationServices: 3,
      rawRetentionDays: 1,
      dailyRetentionDays: 30,
    },
    rowsRead: 10,
    rowsWritten: 5,
    storageBytes: 1024,
    lastSeenAt: '2026-10-04T00:00:00.000Z',
  };

  const safeCapacity = {
    safe: true,
    intervalSeconds: 300,
    headroomPercent: 20,
    grant: { monitors: 4, regionalTasks: 8 },
    actual: { monitors: 2, regionalTasks: 4 },
    effectiveCaps: {
      monitorClaimsPerMinute: 60,
      regionalTasksPerMinute: 180,
      monitorsPerPeriod: 300,
      regionalTasksPerPeriod: 900,
    },
    utilization: {
      monitorClaims: 0.1,
      regionalTasks: 0.15,
    },
    actualUtilization: {
      monitorClaims: 0.05,
      regionalTasks: 0.08,
    },
    fleet: {
      dispatchesPerMinute: 12,
      configuredWorkspaces: 3,
      safe: true,
    },
    warnings: [] as string[],
  };

  const unsafeCapacity = {
    ...safeCapacity,
    safe: false,
    warnings: ['Monitor claims exceed regional dispatch capacity by 40%.'],
  };

  it('shows the editor for a waiting workspace with effective limits', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceLimitsEditor, {
          workspace: { ...sampleWorkspace, state: 'waiting_for_capacity', monitorCount: 0 },
          availableRegions,
          onSaved: vi.fn(),
        }),
      );
    });
    expect(view.container.querySelector('.operator-limits__form')).not.toBeNull();
    expect(view.container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('3');
    await view.cleanup();
  });

  it('renders quota editor and triggers live capacity preview', async () => {
    vi.useFakeTimers();
    apiMock.operatorWorkspaceLimitsPreview.mockResolvedValue({ capacity: safeCapacity });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceLimitsEditor, {
          workspace: sampleWorkspace,
          availableRegions,
          onSaved: vi.fn(),
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(apiMock.operatorWorkspaceLimitsPreview).toHaveBeenCalledWith('workspace-1', {
      monitors: 3,
      regions: 2,
      allowedRegionIds: ['us-east', 'eu-west'],
    });

    expect(view.container.textContent).toContain('Capacity Preview (20% Headroom)');
    expect(view.container.textContent).toContain('Safe');
    expect(view.container.textContent).toContain('10.0% cap');
    expect(view.container.textContent).toContain('15.0% cap');

    await view.cleanup();
    vi.useRealTimers();
  });

  it('disables save and blocks submit initially while preview is null', async () => {
    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceLimitsEditor, {
          workspace: sampleWorkspace,
          availableRegions,
          onSaved: vi.fn(),
        }),
      );
    });

    const saveButton = view.container.querySelector<HTMLButtonElement>('button')!;
    expect(saveButton.disabled).toBe(true);

    const form = view.container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });

    expect(apiMock.updateOperatorWorkspaceLimits).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('A valid, safe capacity preview is required');

    await view.cleanup();
  });

  it('disables save and presents warnings when server preview returns unsafe', async () => {
    vi.useFakeTimers();
    apiMock.operatorWorkspaceLimitsPreview.mockResolvedValue({ capacity: unsafeCapacity });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceLimitsEditor, {
          workspace: sampleWorkspace,
          availableRegions,
          onSaved: vi.fn(),
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(view.container.textContent).toContain('Exceeds Capacity');
    expect(view.container.textContent).toContain(
      'Monitor claims exceed regional dispatch capacity by 40%.',
    );

    const saveButton = view.container.querySelector<HTMLButtonElement>('button')!;
    expect(saveButton.disabled).toBe(true);

    await view.cleanup();
    vi.useRealTimers();
  });

  it('discards out-of-order preview responses using sequence counter', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: { capacity: typeof safeCapacity }) => void;
    let resolveSecond!: (value: { capacity: typeof safeCapacity }) => void;

    apiMock.operatorWorkspaceLimitsPreview
      .mockReturnValueOnce(new Promise((res) => (resolveFirst = res)))
      .mockReturnValueOnce(new Promise((res) => (resolveSecond = res)));

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceLimitsEditor, {
          workspace: sampleWorkspace,
          availableRegions,
          onSaved: vi.fn(),
        }),
      );
    });

    // First preview debounce trigger
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(apiMock.operatorWorkspaceLimitsPreview).toHaveBeenCalledTimes(1);

    // Change monitor input
    const monitorInput = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Saved monitor limit for Production Workspace"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        monitorInput,
        '5',
      );
      monitorInput.dispatchEvent(new Event('input', { bubbles: true }));
      monitorInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Second preview debounce trigger
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(apiMock.operatorWorkspaceLimitsPreview).toHaveBeenCalledTimes(2);

    // Resolve second preview FIRST (faster)
    const secondCapacity = {
      ...safeCapacity,
      grant: { monitors: 5, regionalTasks: 10 },
      warnings: ['Second preview resolved'],
    };
    await act(async () => {
      resolveSecond({ capacity: secondCapacity });
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Second preview resolved');

    // Resolve first preview LATER (stale)
    const staleCapacity = {
      ...safeCapacity,
      grant: { monitors: 3, regionalTasks: 6 },
      warnings: ['STALE FIRST PREVIEW SHOULD BE DROPPED'],
    };
    await act(async () => {
      resolveFirst({ capacity: staleCapacity });
      await Promise.resolve();
    });

    // Stale preview must not have overwritten the second preview
    expect(view.container.textContent).not.toContain('STALE FIRST PREVIEW SHOULD BE DROPPED');
    expect(view.container.textContent).toContain('Second preview resolved');

    await view.cleanup();
    vi.useRealTimers();
  });

  it('ensures old valid preview arriving after invalid edit is ignored', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: { capacity: typeof safeCapacity }) => void;

    apiMock.operatorWorkspaceLimitsPreview.mockReturnValueOnce(
      new Promise((res) => (resolveFirst = res)),
    );

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceLimitsEditor, {
          workspace: sampleWorkspace,
          availableRegions,
          onSaved: vi.fn(),
        }),
      );
    });

    // Trigger first preview debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(apiMock.operatorWorkspaceLimitsPreview).toHaveBeenCalledTimes(1);

    // Edit input to invalid value (-1)
    const monitorInput = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Saved monitor limit for Production Workspace"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        monitorInput,
        '-1',
      );
      monitorInput.dispatchEvent(new Event('input', { bubbles: true }));
      monitorInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Validation error must be visible immediately
    expect(view.container.textContent).toContain(
      'Monitor limit must be a whole number from 0 to 1000.',
    );

    // Now resolve first preview (stale valid response)
    await act(async () => {
      resolveFirst({ capacity: safeCapacity });
      await Promise.resolve();
    });

    // Stale response must NOT clear the error and must NOT render 'Safe' badge
    expect(view.container.textContent).toContain(
      'Monitor limit must be a whole number from 0 to 1000.',
    );
    expect(view.container.textContent).not.toContain('Safe');
    const saveButton = view.container.querySelector<HTMLButtonElement>('button')!;
    expect(saveButton.disabled).toBe(true);

    await view.cleanup();
    vi.useRealTimers();
  });

  it('field edit immediately disables save and blocks submit before debounce fires', async () => {
    vi.useFakeTimers();
    apiMock.operatorWorkspaceLimitsPreview.mockResolvedValue({ capacity: safeCapacity });

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceLimitsEditor, {
          workspace: sampleWorkspace,
          availableRegions,
          onSaved: vi.fn(),
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    const saveButton = view.container.querySelector<HTMLButtonElement>('button')!;
    expect(saveButton.disabled).toBe(false);
    expect(view.container.textContent).toContain('Safe');

    // Edit a field
    const monitorInput = view.container.querySelector<HTMLInputElement>(
      '[aria-label="Saved monitor limit for Production Workspace"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        monitorInput,
        '4',
      );
      monitorInput.dispatchEvent(new Event('input', { bubbles: true }));
      monitorInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Immediately disabled before debounce timer advances
    expect(saveButton.disabled).toBe(true);
    // Safe badge of prior preview must not be displayed as current
    expect(view.container.textContent).not.toContain('Safe');

    // Attempt submit before debounce completes
    const form = view.container.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });

    expect(apiMock.updateOperatorWorkspaceLimits).not.toHaveBeenCalled();

    await view.cleanup();
    vi.useRealTimers();
  });

  it('displays server rejection errors on preview and save', async () => {
    vi.useFakeTimers();
    apiMock.operatorWorkspaceLimitsPreview.mockRejectedValue(
      new Error('Preview service unavailable'),
    );

    const view = createTestRoot();
    await act(async () => {
      view.root.render(
        createElement(WorkspaceLimitsEditor, {
          workspace: sampleWorkspace,
          availableRegions,
          onSaved: vi.fn(),
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(view.container.textContent).toContain('Preview service unavailable');
    const saveButton = view.container.querySelector<HTMLButtonElement>('button')!;
    expect(saveButton.disabled).toBe(true);

    await view.cleanup();
    vi.useRealTimers();
  });
});
