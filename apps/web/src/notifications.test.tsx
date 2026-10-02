// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildNotificationConfig, NotificationsPage } from './notifications.js';

const reactEnvironment = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notifications admin', () => {
  function setField(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function renderPage(response: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async (input: RequestInfo | URL) =>
          new Response(
            JSON.stringify(
              String(input).endsWith('/notification-history')
                ? { entries: [], nextCursor: null }
                : response,
            ),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    return { container, root };
  }

  it('offers all supported providers and serializes Resend recipients', async () => {
    const { container, root } = renderPage({ services: [] });
    await act(async () => {
      root.render(createElement(NotificationsPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Add service')
        ?.click(),
    );
    const provider = container.querySelector<HTMLSelectElement>('select')!;
    expect([...provider.options].map((option) => option.value)).toEqual(
      expect.arrayContaining([
        'telegram',
        'discord',
        'resend',
        'gotify',
        'webhook',
        'smtp',
        'home-assistant',
        'bluesky',
      ]),
    );
    await act(async () => {
      provider.value = 'resend';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const labels = [...container.querySelectorAll('label')];
    const inputFor = (text: string) =>
      labels
        .find((label) => label.textContent?.startsWith(text))
        ?.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement;
    await act(async () => {
      setField(inputFor('Name')!, 'Email');
      setField(inputFor('API key')!, 're_test');
      setField(inputFor('From email')!, 'from@example.com');
      setField(inputFor('To email addresses')!, 'a@example.com, b@example.com\nc@example.com');
    });
    expect(
      buildNotificationConfig({
        name: 'Email',
        provider: 'resend',
        enabled: true,
        apiKey: 're_test',
        from: 'from@example.com',
        to: 'a@example.com, b@example.com\nc@example.com',
        subject: '',
        botToken: '',
        chatId: '',
        webhookUrl: '',
        serverUrl: '',
        applicationToken: '',
        priority: '8',
        bearerToken: '',
        host: '',
        port: '587',
        security: 'starttls',
        username: '',
        password: '',
        accessToken: '',
        service: 'notify',
      }),
    ).toMatchObject({ to: ['a@example.com', 'b@example.com', 'c@example.com'] });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const request = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      provider: 'resend',
      config: {
        apiKey: 're_test',
        from: 'from@example.com',
        to: ['a@example.com', 'b@example.com', 'c@example.com'],
      },
    });
    await act(async () => root.unmount());
  });

  it('omits blank SMTP secrets when editing', async () => {
    const { container, root } = renderPage({
      services: [
        {
          id: '20000000-0000-4000-8000-000000000002',
          name: 'Relay',
          provider: 'smtp',
          enabled: true,
          config: {
            host: 'smtp.example.com',
            port: 587,
            security: 'starttls',
            from: 'from@example.com',
            to: ['to@example.com'],
          },
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
    await act(async () => {
      root.render(createElement(NotificationsPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Edit')
        ?.click(),
    );
    expect(container.textContent).toContain('SMTP host');
    const config = buildNotificationConfig({
      name: 'Relay',
      id: 'x',
      provider: 'smtp',
      enabled: true,
      apiKey: '',
      from: 'from@example.com',
      to: 'to@example.com',
      subject: '',
      botToken: '',
      chatId: '',
      webhookUrl: '',
      serverUrl: '',
      applicationToken: '',
      priority: '8',
      bearerToken: '',
      host: 'smtp.example.com',
      port: '587',
      security: 'starttls',
      username: '',
      password: '',
      accessToken: '',
      service: 'notify',
    });
    expect(config).not.toHaveProperty('password');
    expect(config).toMatchObject({ username: '', subject: '' });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const request = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PATCH');
    const submitted = JSON.parse(String(request?.[1]?.body));
    expect(submitted.config).toMatchObject({ username: '', subject: '', port: 587 });
    expect(submitted.config).not.toHaveProperty('password');
    await act(async () => root.unmount());
  });

  it.each([
    ['gotify', 'Application token', 'Priority (0–10)'],
    ['webhook', 'Webhook URL', 'Bearer token'],
    ['home-assistant', 'Access token', 'Service'],
    ['smtp', 'Password', 'SMTP host'],
  ])('renders %s provider fields and defaults', async (providerName, secretLabel, secondLabel) => {
    const { container, root } = renderPage({ services: [] });
    await act(async () => {
      root.render(createElement(NotificationsPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Add service')
        ?.click(),
    );
    const provider = container.querySelector<HTMLSelectElement>('select')!;
    await act(async () => {
      provider.value = providerName;
      provider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain(secretLabel);
    expect(container.textContent).toContain(secondLabel);
    if (providerName === 'webhook' || providerName === 'smtp') {
      const label = providerName === 'webhook' ? 'Bearer token' : 'Password';
      const optionalSecret = [...container.querySelectorAll('label')]
        .find((element) => element.textContent?.startsWith(label))
        ?.querySelector('input');
      expect(optionalSecret?.required).toBe(false);
    }
    if (providerName === 'home-assistant') {
      const serviceInput = [...container.querySelectorAll('label')]
        .find((label) => label.textContent?.startsWith('Service'))
        ?.querySelector('input') as HTMLInputElement;
      expect(serviceInput.value).toBe('notify');
    }
    await act(async () => root.unmount());
  });

  it('never displays a saved Telegram token while editing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            services: [
              {
                id: '20000000-0000-4000-8000-000000000001',
                name: 'Operations Telegram',
                provider: 'telegram',
                enabled: true,
                config: { chatId: '-100123456' },
                createdAt: '2026-09-16T10:00:00.000Z',
                updatedAt: '2026-09-16T10:00:00.000Z',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(NotificationsPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    const edit = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Edit',
    );
    await act(async () => edit?.click());

    const token = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(token?.value).toBe('');
    expect(token?.placeholder).toBe('Leave blank to keep the saved token');
    expect(container.textContent).toContain('Chat ID');
    expect(container.textContent).toContain('BotFather');
    expect(container.innerHTML).not.toContain('botToken');

    await act(async () => root.unmount());
  });

  it('creates, edits, retains a blank Bluesky app password, and tests without publishing live posts', async () => {
    const existing = {
      id: '20000000-0000-4000-8000-000000000003',
      name: 'Status account',
      provider: 'bluesky',
      enabled: true,
      config: { handle: 'status.example' },
      createdAt: '',
      updatedAt: '',
    };
    let created = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/notification-history')) {
        return new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 });
      }
      if (url.endsWith('/notification-services') && method === 'GET') {
        return new Response(JSON.stringify({ services: created ? [existing] : [] }), {
          status: 200,
        });
      }
      if (url.endsWith('/notification-services') && method === 'POST') {
        created = true;
        return new Response(JSON.stringify({ service: existing }), { status: 200 });
      }
      if (url.endsWith('/notification-services') && method === 'PATCH') {
        return new Response(JSON.stringify({ service: existing }), { status: 200 });
      }
      if (url.endsWith('/notification-services')) {
        return new Response(JSON.stringify({ services: [existing] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(NotificationsPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
    });
    const provider = container.querySelector<HTMLSelectElement>('select')!;
    await act(async () => {
      provider.value = 'bluesky';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain('Settings → Privacy and Security → App Passwords');
    expect(container.textContent).toContain('publish publicly');
    const inputFor = (labelText: string) =>
      [...container.querySelectorAll('label')]
        .find((label) => label.textContent?.startsWith(labelText))
        ?.querySelector('input') as HTMLInputElement;
    await act(async () => {
      setField(inputFor('Name'), 'Status account');
      setField(inputFor('Bluesky handle'), 'status.example');
      setField(inputFor('App password'), 'secret-app-password');
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    const createRequest = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(createRequest?.[1]?.body))).toMatchObject({
      provider: 'bluesky',
      config: { handle: 'status.example', appPassword: 'secret-app-password' },
    });
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain('@status.example · Bluesky');
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Test')
        ?.click();
      await Promise.resolve();
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/20000000-0000-4000-8000-000000000003/test'),
      ),
    ).toBe(true);

    // Load an existing service and verify the password remains write-only on edit.
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/notification-history')) {
        return new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 });
      }
      if (url.endsWith('/notification-services') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ services: [existing] }), { status: 200 });
      }
      return new Response(JSON.stringify({ service: existing }), { status: 200 });
    });
    await act(async () => root.unmount());
    const editRoot = createRoot(container);
    await act(async () => {
      editRoot.render(createElement(NotificationsPage));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Edit')
        ?.click();
    });
    expect(inputFor('Bluesky handle')?.value).toBe('status.example');
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    const updateRequest = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    const updateBody = JSON.parse(String(updateRequest?.[1]?.body));
    expect(updateBody.config).toMatchObject({ handle: 'status.example' });
    expect(updateBody.config).not.toHaveProperty('appPassword');
    await act(async () => editRoot.unmount());
  });
});
