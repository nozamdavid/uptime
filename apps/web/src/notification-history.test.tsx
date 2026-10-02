// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationsPage } from './notifications.js';

const reactEnvironment = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const service = {
  id: '20000000-0000-4000-8000-000000000001',
  name: 'Operations Telegram',
  provider: 'telegram',
  enabled: true,
  config: { chatId: '-100123456' },
  createdAt: '2026-09-16T10:00:00.000Z',
  updatedAt: '2026-09-16T10:00:00.000Z',
};

const entry = {
  id: '30000000-0000-4000-8000-000000000001',
  notificationServiceId: service.id,
  monitorId: '40000000-0000-4000-8000-000000000001',
  monitorName: 'Homepage',
  monitorUrl: 'https://example.test',
  provider: 'bluesky',
  kind: 'outage',
  status: 'sent',
  createdAt: '2026-09-29T18:42:00.000Z',
  text: 'Homepage is down.\nHTTP checks are failing.',
  externalUrl: 'javascript:alert(1)',
  error: null,
  preview: { handle: 'status.example' },
};

afterEach(() => vi.unstubAllGlobals());

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function openHistory(
  fetchMock: ReturnType<typeof vi.fn>,
  container: HTMLDivElement,
  root: ReturnType<typeof createRoot>,
) {
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root.render(createElement(NotificationsPage));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'History')
      ?.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('notification history', () => {
  it('loads history pages, renders the provider preview, links monitor, and rejects unsafe post URLs', async () => {
    const secondEntry = {
      ...entry,
      id: '30000000-0000-4000-8000-000000000002',
      kind: 'recovery',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/notification-services')) return response({ services: [service] });
      if (url.endsWith('/notification-history')) return response({ entries: [], nextCursor: null });
      if (url.endsWith('/history?cursor=older')) {
        return response({ entries: [entry, secondEntry], nextCursor: null });
      }
      if (url.endsWith('/history')) return response({ entries: [entry], nextCursor: 'older' });
      throw new Error(`Unexpected request: ${url}`);
    });
    const container = document.createElement('div');
    const root = createRoot(container);

    await openHistory(fetchMock, container, root);

    expect(container.textContent).toContain('Operations Telegram history');
    expect(container.textContent).toContain('Homepage is down.\nHTTP checks are failing.');
    expect(
      container.querySelector('a[href="/monitors/40000000-0000-4000-8000-000000000001"]')
        ?.textContent,
    ).toBe('Homepage');
    expect(container.querySelector('.notification-preview--bluesky')).not.toBeNull();
    expect(container.querySelector('.notification-preview__bsky')?.textContent).toContain(
      '@status.example',
    );
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();

    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Load more')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelectorAll('.notification-history__entry')).toHaveLength(2);
    const pageRequest = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/history?cursor=older'),
    );
    expect(pageRequest).toBeDefined();

    await act(async () => root.unmount());
  });

  it('shows a retry action instead of an empty-history message when loading fails', async () => {
    let failed = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/notification-services')) return response({ services: [service] });
      if (url.endsWith('/notification-history')) return response({ entries: [], nextCursor: null });
      if (!failed) {
        failed = true;
        return response({ error: { message: 'History unavailable' } }, 503);
      }
      return response({ entries: [], nextCursor: null });
    });
    const container = document.createElement('div');
    const root = createRoot(container);

    await openHistory(fetchMock, container, root);
    expect(container.textContent).toContain('History unavailable');
    expect(container.textContent).toContain('Try again');
    expect(container.textContent).not.toContain('No notification history yet.');

    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Try again')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('No notification history yet.');

    await act(async () => root.unmount());
  });

  it('keeps test notification titles unlinked even when legacy rows contain a monitor URL', async () => {
    const testEntry = {
      ...entry,
      kind: 'test',
      monitorId: null,
      monitorName: 'Uptime notification test',
      monitorUrl: 'https://example.com',
      externalUrl: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/notification-services')) return response({ services: [service] });
      if (url.endsWith('/notification-history')) return response({ entries: [], nextCursor: null });
      if (url.endsWith('/history')) return response({ entries: [testEntry], nextCursor: null });
      throw new Error(`Unexpected request: ${url}`);
    });
    const container = document.createElement('div');
    const root = createRoot(container);

    await openHistory(fetchMock, container, root);

    const monitor = container.querySelector('.notification-history__monitor');
    expect(monitor?.textContent).toBe('Uptime notification test');
    expect(monitor?.querySelector('a')).toBeNull();
    expect(container.querySelector('a[href="https://example.com/"]')).toBeNull();

    await act(async () => root.unmount());
  });
});

describe('global notification history', () => {
  it('shows all providers below the services in collapsed rows and pages without duplicates', async () => {
    const blueskyService = {
      ...service,
      id: 'second-service',
      name: 'Public status',
      provider: 'bluesky',
    };
    const telegramEntry = { ...entry, provider: 'telegram', preview: {} };
    const failedEntry = {
      ...entry,
      id: 'failed-entry',
      notificationServiceId: blueskyService.id,
      monitorName: 'API',
      status: 'failed',
      error: 'Provider unavailable',
      text: 'API is down.',
    };
    const olderEntry = { ...telegramEntry, id: 'older-entry', kind: 'recovery' };
    let failNextPage = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/notification-services'))
        return response({ services: [service, blueskyService] });
      if (url.endsWith('/notification-history?cursor=older')) {
        if (failNextPage) {
          failNextPage = false;
          return response({ error: { message: 'Page unavailable' } }, 503);
        }
        return response({ entries: [failedEntry, olderEntry], nextCursor: null });
      }
      if (url.endsWith('/notification-history')) {
        return response({ entries: [telegramEntry, failedEntry], nextCursor: 'older' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(NotificationsPage)));

    const history = container.querySelector('.notification-history--global')!;
    const list = container.querySelector('.notification-list')!;
    expect(list.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rows = [...history.querySelectorAll<HTMLDetailsElement>('details')];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.open)).toBe(true);
    expect(rows[0]?.querySelector('summary')?.textContent).toContain('Operations Telegram');
    expect(rows[0]?.querySelector('summary')?.textContent).toContain('telegram');
    expect(rows[1]?.querySelector('summary')?.textContent).toContain('Public status');
    expect(rows[1]?.querySelector('summary')?.textContent).toContain('Failed');
    await act(async () => rows[1]?.querySelector('summary')?.click());
    expect(rows[1]?.open).toBe(true);
    expect(rows[1]?.querySelector('.notification-history__error')?.textContent).toBe(
      'Provider unavailable',
    );
    expect(rows[1]?.querySelector('.notification-preview__text')?.textContent).toBe('API is down.');
    expect(history.querySelector('a[href^="javascript:"]')).toBeNull();

    const loadMore = () =>
      [...history.querySelectorAll('button')].find((button) => button.textContent === 'Load more')!;
    await act(async () => loadMore().click());
    expect(history.textContent).toContain('Page unavailable');
    expect(history.querySelectorAll('details')).toHaveLength(2);
    await act(async () => loadMore().click());
    expect(history.querySelectorAll('details')).toHaveLength(3);
    expect(history.textContent).not.toContain('Load more');
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/notification-services/')),
    ).toBe(false);
    await act(async () => root.unmount());
  });

  it('retries a failed global load and refreshes after sending a test notification', async () => {
    let historyRequests = 0;
    let tested = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/notification-services')) return response({ services: [service] });
      if (url.endsWith('/test')) {
        tested = true;
        return response({ success: true });
      }
      if (url.endsWith('/notification-history')) {
        historyRequests += 1;
        if (historyRequests === 1)
          return response({ error: { message: 'History unavailable' } }, 503);
        return response({ entries: tested ? [{ ...entry, kind: 'test' }] : [], nextCursor: null });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(NotificationsPage)));
    expect(container.textContent).toContain('History unavailable');
    expect(container.textContent).not.toContain('No notification history yet.');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Try again')
        ?.click(),
    );
    expect(container.textContent).toContain('No notification history yet.');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Test')
        ?.click(),
    );
    expect(container.querySelectorAll('.notification-history__row')).toHaveLength(1);
    expect(historyRequests).toBe(3);
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Refresh history')
        ?.click(),
    );
    expect(historyRequests).toBe(4);
    await act(async () => root.unmount());
  });
});
