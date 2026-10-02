// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createTestRoot } from './testing/react-root.js';
import { describe, expect, it, vi } from 'vitest';
import type { MonitorSummary } from '@uptime/contracts';

import { MonitorList } from './monitor-list.js';

function summary(id: string, name: string): MonitorSummary {
  return {
    monitor: {
      id,
      name,
      url: `https://${name.toLowerCase()}.example.test`,
      regionIds: ['us-east'],
      intervalSeconds: 300,
      timeoutMs: 10_000,
      enabled: true,
      dnsDiagnosticsEnabled: false,
      isPublic: false,
      publicSlug: null,
      createdAt: '2026-09-03T10:00:00.000Z',
      updatedAt: '2026-09-03T10:00:00.000Z',
    },
    status: 'up',
    latestByRegion: {} as MonitorSummary['latestByRegion'],
    targetChecksPerDay: 288,
  };
}

const bravo = summary('00000000-0000-4000-8000-000000000002', 'Bravo');
const items: MonitorSummary[] = [
  summary('00000000-0000-4000-8000-000000000001', 'Alpha'),
  {
    ...bravo,
    monitor: {
      ...bravo.monitor,
      regionIds: ['eu-west'],
      badge: {
        id: '00000000-0000-4000-8000-000000000003',
        name: 'API',
        color: '#2563eb',
      },
    },
  },
];

describe('bulk monitor editing', () => {
  it('updates the frequency for the selected monitors', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ badges: [], updatedCount: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const changed = vi.fn();
    const { container, root, cleanup } = createTestRoot();

    await act(async () => root.render(createElement(MonitorList, { items, onChanged: changed })));
    const buttons = [...container.querySelectorAll('button')];
    await act(async () =>
      buttons.find((button) => button.textContent === 'Edit multiple')?.click(),
    );
    const selectAll = container.querySelector<HTMLInputElement>(
      '.bulk-monitor-editor__select-all input',
    )!;
    await act(async () => selectAll.click());
    const frequency = container.querySelector<HTMLSelectElement>(
      '.bulk-monitor-editor__frequency select',
    )!;
    await act(async () => {
      frequency.value = '1200';
      frequency.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const apply = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Apply to'),
    )!;
    await act(async () => apply.click());

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/monitors/bulk-frequency',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          monitorIds: items.map((item) => item.monitor.id),
          intervalSeconds: 1_200,
        }),
      }),
    );
    expect(changed).toHaveBeenCalledOnce();

    await cleanup();
    vi.unstubAllGlobals();
  });

  it('selects the visible range between checked monitors with shift-click', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ badges: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const { container, root, cleanup } = createTestRoot();
    const rangeItems = [
      summary('00000000-0000-4000-8000-000000000011', 'Alpha'),
      summary('00000000-0000-4000-8000-000000000012', 'Bravo'),
      summary('00000000-0000-4000-8000-000000000013', 'Charlie'),
    ];

    await act(async () => {
      root.render(createElement(MonitorList, { items: rangeItems, onChanged: () => undefined }));
      await Promise.resolve();
    });
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Edit multiple')
        ?.click(),
    );
    const checkboxes = container.querySelectorAll<HTMLInputElement>('.monitor-row__select');
    await act(async () => checkboxes[0]!.click());
    await act(async () =>
      checkboxes[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })),
    );

    expect([...checkboxes].map((checkbox) => checkbox.checked)).toEqual([true, true, true]);

    await cleanup();
    vi.unstubAllGlobals();
  });
});

describe('monitor filtering', () => {
  it('filters by name, badge, and region', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ badges: [items[1]!.monitor.badge] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(MonitorList, { items, onChanged: () => undefined }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const name = container.querySelector<HTMLInputElement>('.monitor-filters input')!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setInputValue?.call(name, 'bravo');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelectorAll('.monitor-row')).toHaveLength(1);

    await act(async () => {
      setInputValue?.call(name, '');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      const selects = container.querySelectorAll<HTMLSelectElement>('.monitor-filters select');
      selects[0]!.value = items[1]!.monitor.badge!.id;
      selects[0]!.dispatchEvent(new Event('change', { bubbles: true }));
      selects[1]!.value = 'eu-west';
      selects[1]!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelectorAll('.monitor-row')).toHaveLength(1);
    expect(container.querySelector('.monitor-row strong')?.textContent).toBe('Bravo');

    await cleanup();
    vi.unstubAllGlobals();
  });
});
