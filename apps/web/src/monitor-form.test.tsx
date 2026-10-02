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
          onCancel: () => undefined,
          onConfirm,
        }),
      );
    });

    const input = container.querySelector<HTMLInputElement>('input')!;
    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Delete all history',
    )!;
    expect(deleteButton.disabled).toBe(true);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'DELETE',
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

  it('renders the three canonical continent groups and all nine options in registry order', () => {
    const markup = render();
    expect(markup).toContain('North America');
    expect(markup).toContain('Europe');
    expect(markup).toContain('Asia');
    expect(markup.match(/type="checkbox"/g) ?? []).toHaveLength(12);
    expect(markup).toContain('Outage notifications');
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
