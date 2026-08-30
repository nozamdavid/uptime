// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { regionIds } from '@uptime/regions';

document.body.innerHTML = '<div id="root"></div>';
(window as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
const { MonitorForm } = await import('./monitor-form.js');

function render(regionSelection = regionIds) {
  return renderToStaticMarkup(
    createElement(MonitorForm, {
      monitor: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'All regions',
        url: 'https://status.example.test/health',
        regionIds: [...regionSelection],
        intervalSeconds: 60,
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
  it('renders the three canonical continent groups and all nine options in registry order', () => {
    const markup = render();
    expect(markup).toContain('North America');
    expect(markup).toContain('Europe');
    expect(markup).toContain('Asia');
    expect(markup.match(/type="checkbox"/g) ?? []).toHaveLength(11);
    expect(markup).toContain('Share this monitor publicly');
    expect(markup).toContain('Exact requests and DNS diagnostics remain private.');
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
});
