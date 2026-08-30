// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Observation } from '@uptime/contracts';

document.body.innerHTML = '<div id="root"></div>';
(window as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
const { RequestTable } = await import('./monitor-detail.js');

const item: Observation = {
  id: '00000000-0000-4000-8000-000000000001',
  checkRunId: '00000000-0000-4000-8000-000000000002',
  monitorId: '00000000-0000-4000-8000-000000000003',
  regionId: 'eu-west',
  status: 'success',
  success: true,
  httpStatus: 200,
  responseMs: 120,
  totalMs: 150,
  errorCode: null,
  errorDetail: null,
  placement: 'aws:eu-west-1',
  colo: 'DUB',
  finalUrl: 'https://www.example.com/health?check=1',
  endpointEvidence: {
    finalHostname: 'www.example.com',
    signals: [],
    primaryCdn: {
      provider: 'cloudflare',
      reportedEdge: 'LHR',
      inferredContinent: 'europe',
      confidence: 'provider_reported',
      evidenceHeader: 'cf-ray',
      parserVersion: '1',
    },
  },
  dnsDiagnostic: null,
  redirectCount: 0,
  bodyBytes: 42,
  probeVersion: '1',
  startedAt: '2026-08-30T10:00:00.000Z',
  completedAt: '2026-08-30T10:00:00.150Z',
};

describe('request table evidence disclosure', () => {
  it('keeps endpoint evidence collapsed in an indented row beneath each request', () => {
    const markup = renderToStaticMarkup(
      createElement(RequestTable, {
        items: [item],
        hasMore: false,
        loadingMore: false,
        onLoadMore: async () => undefined,
      }),
    );

    expect(markup).not.toContain('<th>Endpoint evidence</th>');
    expect(markup).toContain('class="history__evidence-row"');
    expect(markup).toContain('<details class="history__evidence-disclosure">');
    expect(markup).not.toContain('<details class="history__evidence-disclosure" open');
    expect(markup).toContain('Endpoint evidence <span>Cloudflare · LHR</span>');
  });
});
