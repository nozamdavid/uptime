// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DnsDiagnosticRecord } from './api.js';

document.body.innerHTML = '<div id="root"></div>';
(window as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
const { DnsDiagnostics } = await import('./monitor-detail.js');

const record: DnsDiagnosticRecord = {
  id: '00000000-0000-4000-8000-000000000001',
  monitorId: '00000000-0000-4000-8000-000000000002',
  checkRunId: null,
  observationId: null,
  regionId: 'eu-west',
  kind: 'dns_candidates',
  windowStartedAt: '2026-08-30T00:00:00.000Z',
  lifecycle: 'complete',
  finalHostname: 'edge.example.com',
  result: {
    diagnosticId: '00000000-0000-4000-8000-000000000001',
    windowStartedAt: '2026-08-30T00:00:00.000Z',
    finalHostname: 'edge.example.com',
    resolver: 'cloudflare-doh',
    observedAt: '2026-08-30T01:02:03.000Z',
    status: 'partial',
    cnameCandidates: ['<untrusted.example>'],
    aCandidates: [{ address: '203.0.113.10', ttl: 60 }],
    aaaaCandidates: [{ address: '2001:db8::10', ttl: 120 }],
    filteredAddressCount: 2,
    errorCode: 'resolver_failure',
    schemaVersion: '1',
    parserVersion: '1',
  },
  failureCode: null,
  requestedAt: '2026-08-30T01:00:00.000Z',
  startedAt: '2026-08-30T01:00:01.000Z',
  completedAt: '2026-08-30T01:02:03.000Z',
  createdAt: '2026-08-30T01:02:03.000Z',
};

function render(props: Partial<Parameters<typeof DnsDiagnostics>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(DnsDiagnostics, {
      enabled: true,
      monitorRegions: ['us-east', 'eu-west', 'asia'],
      range: '7d',
      region: 'all',
      diagnostics: [record],
      nextCursor: 'next',
      loading: false,
      loadingMore: false,
      error: '',
      onRangeChange: () => undefined,
      onRegionChange: () => undefined,
      onRetry: () => undefined,
      onLoadMore: async () => undefined,
      ...props,
    }),
  );
}

describe('DNS diagnostics presentation', () => {
  it('shows the boundary between DNS candidates and the connected HTTP peer', () => {
    const markup = render();
    expect(markup).toContain('DNS candidates — not the connected HTTP peer');
    expect(markup).toContain('no geography claim');
    expect(markup).toContain('203.0.113.10');
    expect(markup).toContain('TTL 60s');
    expect(markup).toContain('Schema 1 · Parser 1');
  });

  it('renders untrusted hostnames as escaped text and exposes accessible filters', () => {
    const markup = render();
    expect(markup).toContain('&lt;untrusted.example&gt;');
    expect(markup).not.toContain('<untrusted.example>');
    expect(markup).toContain('aria-label="DNS diagnostics filters"');
    expect(markup).toContain('Last 7d');
    expect(markup).toContain('All selected regions');
    expect(markup).toContain('Load older DNS snapshots');
  });

  it('keeps disabled and unavailable states honest', () => {
    expect(render({ enabled: false, diagnostics: [] })).toContain(
      'DNS diagnostics are disabled for this monitor',
    );
    expect(
      render({
        diagnostics: [
          {
            ...record,
            lifecycle: 'unavailable',
            result: null,
            finalHostname: null,
            failureCode: 'unsupported',
          },
        ],
        nextCursor: null,
      }),
    ).toContain('unavailable · unavailable');
  });
});
