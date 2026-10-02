// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createTestRoot } from './testing/react-root.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  monitors: vi.fn(),
  statusPage: vi.fn(),
  updateStatusPage: vi.fn(),
  publicStatusPage: vi.fn(),
}));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('./api.js', () => ({ api: apiMock }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }));

const { PublicStatusPage, StatusPageEditor } = await import('./status-pages.js');

afterEach(() => {
  vi.clearAllMocks();
});

describe('public status page monitor rows', () => {
  it('clears a loaded page while the next route is loading or has failed', async () => {
    apiMock.publicStatusPage.mockResolvedValueOnce({
      id: 'page-a',
      title: 'Page A',
      publicSlug: null,
      groups: [],
    });
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(PublicStatusPage, { statusPageId: 'page-a' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Page A');

    let rejectPageB!: (error: Error) => void;
    apiMock.publicStatusPage.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPageB = reject;
      }),
    );
    await act(async () => {
      root.render(createElement(PublicStatusPage, { statusPageId: 'page-b' }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Loading status…');
    expect(container.textContent).not.toContain('Page A');

    await act(async () => {
      rejectPageB(new Error('Page B failed'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Page B failed');
    expect(container.textContent).not.toContain('Page A');

    await cleanup();
  });

  it('keeps auto-refresh off by default until the header toggle is switched on', async () => {
    vi.useFakeTimers();
    apiMock.publicStatusPage.mockResolvedValue({
      id: 'page-1',
      title: 'Service status',
      publicSlug: null,
      groups: [],
    });
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(PublicStatusPage, { statusPageId: 'page-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const toggle = container.querySelector<HTMLButtonElement>(
      '.public-status-page__refresh-toggle',
    )!;
    expect(toggle.textContent).toBe('Auto-refresh off');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(apiMock.publicStatusPage).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(apiMock.publicStatusPage).toHaveBeenCalledTimes(1);

    await act(async () => toggle.click());
    expect(toggle.textContent).toBe('Auto-refresh on');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(apiMock.publicStatusPage).toHaveBeenCalledTimes(2);

    await act(async () => toggle.click());
    expect(toggle.textContent).toBe('Auto-refresh off');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(apiMock.publicStatusPage).toHaveBeenCalledTimes(2);

    await cleanup();
    vi.useRealTimers();
  });

  it('pairs half-width groups with shared row tracks and bottom fill for the shorter group', async () => {
    const monitor = (id: string, name: string) => ({
      id,
      name,
      url: `https://${id}.example.test`,
      publicSlug: null,
      uptimePercentage: 100,
      status: 'up' as const,
      configuredRegionCount: 1,
      affectedRegionIds: [],
      days: [],
    });
    apiMock.publicStatusPage.mockResolvedValue({
      id: 'page-1',
      title: 'Service status',
      publicSlug: null,
      groups: [
        {
          id: 'group-1',
          title: 'Primary services',
          width: 'half',
          monitors: [monitor('one', 'One'), monitor('two', 'Two')],
        },
        {
          id: 'group-2',
          title: 'Secondary services with a longer title',
          width: 'half',
          monitors: [monitor('three', 'Three')],
        },
      ],
    });
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(PublicStatusPage, { statusPageId: 'page-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const row = container.querySelector('.public-status-page__group-row--paired');
    expect(row?.querySelectorAll(':scope > .public-status-group')).toHaveLength(2);
    expect(row?.querySelectorAll('.public-status-group__head')).toHaveLength(2);
    const groups = row?.querySelectorAll<HTMLElement>(':scope > .public-status-group');
    expect(groups?.[0]?.querySelector('.public-status-group__fill')).toBeNull();
    expect(
      groups?.[1]?.querySelector<HTMLElement>('.public-status-group__fill')?.style.gridRow,
    ).toBe('span 1');

    await cleanup();
  });

  it('marks a down monitor uptime percentage as down', async () => {
    apiMock.publicStatusPage.mockResolvedValue({
      id: 'page-1',
      title: 'Service status',
      publicSlug: null,
      groups: [
        {
          id: 'group-1',
          title: 'Services',
          monitors: [
            {
              id: 'monitor-1',
              name: 'Unavailable service',
              url: 'https://down.example.test',
              publicSlug: 'unavailable-service',
              uptimePercentage: 0,
              status: 'down',
              configuredRegionCount: 1,
              affectedRegionIds: ['eu-west'],
              days: [],
            },
          ],
        },
      ],
    });
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(PublicStatusPage, { statusPageId: 'page-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.public-status-monitor__uptime')?.textContent).toBe('0%');
    expect(container.querySelector('.public-status-monitor__uptime--red')).not.toBeNull();
    const summary = container.querySelector('.public-status-monitor__summary');
    expect(summary?.querySelector('.public-status-monitor__name')?.textContent).toContain(
      'Unavailable service',
    );
    expect(summary?.querySelector('.public-status-monitor__uptime')?.textContent).toBe('0%');
    expect(summary?.querySelector('.public-status-monitor__state')?.textContent).toBe('Issues');
    expect(summary?.nextElementSibling?.classList.contains('uptime-days')).toBe(true);
    expect(container.querySelector('.status-problem-summary h2')?.textContent).toBe(
      'Some systems currently have problems',
    );
    expect(container.querySelector('.status-problem-summary__list a')?.textContent).toBe(
      'Unavailable service',
    );
    expect(container.querySelector('.status-problem-summary__list a')?.getAttribute('href')).toBe(
      '/monitors/public/unavailable-service?statusPage=page-1',
    );
    expect(container.querySelector('.status-problem-summary__list span')?.textContent).toBe(
      'Currently down',
    );

    await cleanup();
  });

  it('labels a partial multi-region outage and lists its affected regions', async () => {
    apiMock.publicStatusPage.mockResolvedValue({
      id: 'page-1',
      title: 'Service status',
      publicSlug: null,
      groups: [
        {
          id: 'group-1',
          title: 'Services',
          monitors: [
            {
              id: 'monitor-1',
              name: 'Degraded service',
              url: 'https://degraded.example.test',
              publicSlug: null,
              uptimePercentage: 99,
              status: 'down',
              configuredRegionCount: 4,
              affectedRegionIds: ['eu-west', 'asia-south'],
              days: [],
            },
          ],
        },
      ],
    });
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(PublicStatusPage, { statusPageId: 'page-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.status-problem-summary__list span')?.textContent).toBe(
      'Issues (eu-west, asia-south)',
    );

    await cleanup();
  });

  it('keeps a recovering monitor in the problem summary', async () => {
    apiMock.publicStatusPage.mockResolvedValue({
      id: 'page-1',
      title: 'Service status',
      publicSlug: null,
      groups: [
        {
          id: 'group-1',
          title: 'Services',
          monitors: [
            {
              id: 'monitor-1',
              name: 'Recovered service',
              url: 'https://recovered.example.test',
              publicSlug: null,
              uptimePercentage: 99,
              status: 'down',
              configuredRegionCount: 4,
              affectedRegionIds: [],
              recoveryStatus: 'recovering',
              days: [],
            },
          ],
        },
      ],
    });
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(PublicStatusPage, { statusPageId: 'page-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.status-problem-summary')).not.toBeNull();
    expect(container.querySelector('.status-problem-summary__list a')?.textContent).toBe(
      'Recovered service',
    );
    expect(container.querySelector('.status-problem-summary__list span')?.textContent).toBe(
      'Recovering',
    );
    expect(
      container.querySelector('.status-problem-summary__list-item--recovering'),
    ).not.toBeNull();
    expect(container.querySelector('.status-problem-summary__state--recovering')).not.toBeNull();
    expect(container.querySelector('.public-status-monitor__state')?.textContent).toBe(
      'Recovering',
    );
    expect(container.querySelector('.public-status-monitor__state--recovering')).not.toBeNull();
    expect(container.querySelector('.public-status-monitor__uptime--orange')).not.toBeNull();

    await cleanup();
  });

  it('paginates each group at ten monitors with synchronized controls above and below', async () => {
    apiMock.publicStatusPage.mockResolvedValue({
      id: 'page-1',
      title: 'Service status',
      groups: [
        {
          id: 'group-1',
          title: 'Services',
          monitors: Array.from({ length: 16 }, (_, index) => ({
            id: `monitor-${index + 1}`,
            name: `Monitor ${index + 1}`,
            url: `https://monitor-${index + 1}.example.test`,
            publicSlug: index === 0 ? 'monitor-one' : null,
            uptimePercentage: 100,
            status: 'up',
            days: [],
          })),
        },
      ],
    });
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(PublicStatusPage, { statusPageId: 'page-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelectorAll('.public-status-monitor')).toHaveLength(10);
    expect(container.querySelector('.status-problem-summary')).toBeNull();
    expect(container.querySelectorAll('.group-pagination')).toHaveLength(2);
    expect(container.querySelector('.public-status-group__count')?.textContent).toBe('(16 total)');
    expect(container.querySelector('.public-status-monitor')?.getAttribute('href')).toBe(
      '/monitors/public/monitor-one?statusPage=page-1',
    );
    const next = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Next',
    );
    await act(async () => next?.click());
    expect(container.querySelectorAll('.public-status-monitor')).toHaveLength(6);
    expect(
      [...container.querySelectorAll('.group-pagination > span')].map(
        (indicator) => indicator.textContent,
      ),
    ).toEqual(['2 / 2', '2 / 2']);

    await cleanup();
  });
});

describe('status page editor ordering', () => {
  it('ignores requests from obsolete routes and saves the current page state', async () => {
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      return { promise, resolve, reject };
    };
    type Page = {
      id: string;
      title: string;
      publicSlug: string | null;
      groups: { id: string; title: string; monitors: { id: string }[] }[];
    };
    const page = (id: string, title: string): Page => ({
      id,
      title,
      publicSlug: `${id}-slug`,
      groups: [{ id: `${id}-group`, title: `${title} group`, monitors: [] }],
    });
    const requests = new Map(
      ['page-a', 'page-b', 'page-c', 'page-d'].map((id) => [id, deferred<Page>()]),
    );
    apiMock.monitors.mockResolvedValue({ monitors: [] });
    apiMock.statusPage.mockImplementation((id: string) => requests.get(id)!.promise);
    apiMock.updateStatusPage.mockResolvedValue({ id: 'page-d' });
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(StatusPageEditor, { statusPageId: 'page-a' }));
    });
    await act(async () => {
      root.render(createElement(StatusPageEditor, { statusPageId: 'page-b' }));
    });
    await act(async () => {
      requests.get('page-b')!.resolve(page('page-b', 'Page B'));
      await Promise.resolve();
    });
    expect(container.querySelector('h1')?.textContent).toBe('Page B');

    await act(async () => {
      requests.get('page-a')!.resolve(page('page-a', 'Page A'));
      await Promise.resolve();
    });
    expect(container.querySelector('h1')?.textContent).toBe('Page B');
    expect(
      container.querySelector<HTMLInputElement>('.status-page-editor__title input')?.value,
    ).toBe('Page B');

    await act(async () => {
      root.render(createElement(StatusPageEditor, { statusPageId: 'page-c' }));
    });
    await act(async () => {
      root.render(createElement(StatusPageEditor, { statusPageId: 'page-d' }));
    });
    await act(async () => {
      requests.get('page-d')!.resolve(page('page-d', 'Page D'));
      await Promise.resolve();
    });
    await act(async () => {
      requests.get('page-c')!.reject(new Error('obsolete page failed'));
      await Promise.resolve();
    });
    expect(container.querySelector('h1')?.textContent).toBe('Page D');
    expect(container.querySelector('.state--error')).toBeNull();

    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(apiMock.updateStatusPage).toHaveBeenCalledWith('page-d', {
      title: 'Page D',
      publicSlug: 'page-d-slug',
      groups: [
        {
          title: 'Page D group',
          monitorIds: [],
          width: 'full',
          showBadges: true,
        },
      ],
    });

    await act(async () => {
      root.render(createElement(StatusPageEditor, { statusPageId: 'new' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('h1')?.textContent).toBe('New status page');
    expect(
      container.querySelector<HTMLInputElement>('.status-page-editor__title input')?.value,
    ).toBe('');
    expect(
      container.querySelector<HTMLInputElement>('.status-page-editor__slug input')?.value,
    ).toBe('');
    expect(container.querySelector<HTMLInputElement>('[aria-label="Group title"]')?.value).toBe(
      'Services',
    );

    await cleanup();
  });

  it('sorts only the selected group alphabetically by displayed monitor name', async () => {
    apiMock.monitors.mockResolvedValue({
      monitors: [
        {
          monitor: {
            id: 'monitor-z',
            name: 'Zulu',
            url: 'https://z.example.test',
            badge: { id: 'badge-1', name: 'API', color: '#2563eb' },
          },
        },
        { monitor: { id: 'monitor-a', name: 'alpha', url: 'https://a.example.test' } },
        { monitor: { id: 'monitor-b', name: null, url: 'https://beta.example.test' } },
        { monitor: { id: 'monitor-c', name: 'Available', url: 'https://available.example.test' } },
      ],
    });
    apiMock.statusPage.mockResolvedValue({
      id: 'page-1',
      title: 'Service status',
      groups: [
        {
          id: 'group-1',
          title: 'Services',
          monitors: [{ id: 'monitor-z' }, { id: 'monitor-b' }, { id: 'monitor-a' }],
        },
      ],
    });
    const { container, root, cleanup } = createTestRoot();

    await act(async () => {
      root.render(createElement(StatusPageEditor, { statusPageId: 'page-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const sortButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Sort monitors in Services alphabetically"]',
    );
    expect(sortButton).not.toBeNull();
    expect(container.querySelector('.status-page-editor__slug input')).not.toBeNull();
    expect(container.querySelectorAll('.status-monitor-editor[draggable="true"]')).toHaveLength(4);
    expect(container.querySelector('.status-monitor-editor .drag-handle[draggable]')).toBeNull();
    expect(container.querySelector('.status-group-editor .monitor-badge')?.textContent).toBe('API');

    const badgesButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide badges in Services"]',
    );
    expect(badgesButton?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => badgesButton?.click());
    expect(container.querySelector('.status-group-editor .monitor-badge')).toBeNull();
    expect(
      container
        .querySelector('button[aria-label="Show badges in Services"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('false');

    const collapseButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse Services"]',
    );
    expect(collapseButton?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => collapseButton?.click());
    expect(container.querySelector('.status-group-editor__monitors')?.hasAttribute('hidden')).toBe(
      true,
    );
    expect(container.querySelector('.status-group-editor--collapsed')).not.toBeNull();

    const expandButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand Services"]',
    );
    expect(expandButton?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => expandButton?.click());

    const halfWidthButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Make Services half width"]',
    );
    await act(async () => halfWidthButton?.click());
    expect(container.querySelector('.status-group-editor--half')).not.toBeNull();

    await act(async () => sortButton?.click());
    expect(
      [...container.querySelectorAll('.status-group-editor .status-monitor-editor strong')].map(
        (item) => item.textContent,
      ),
    ).toEqual(['alpha', 'beta.example.test', 'Zulu']);

    await cleanup();
  });
});
