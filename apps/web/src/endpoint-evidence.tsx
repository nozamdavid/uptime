import { useState } from 'react';
import type { EndpointSignal, Observation } from '@uptime/contracts';

const providerNames = {
  cloudflare: 'Cloudflare',
  cloudfront: 'CloudFront',
  fastly: 'Fastly',
  vercel: 'Vercel',
} as const;

const continentNames = {
  africa: 'Africa',
  asia: 'Asia',
  europe: 'Europe',
  north_america: 'North America',
  oceania: 'Oceania',
  south_america: 'South America',
} as const;

export interface EndpointEvidenceSummary {
  finalUrl: string | null;
  finalHostname: string | null;
  provider: string | null;
  reportedEdge: string | null;
  inferredContinent: string | null;
  evidenceHeader: string | null;
  parserVersion: string | null;
  signals: EndpointSignal[];
}

export function summarizeEndpointEvidence(item: Observation): EndpointEvidenceSummary {
  const evidence = item.endpointEvidence;
  const primary = evidence?.primaryCdn;
  let fallbackHostname: string | null = null;
  if (item.finalUrl) {
    try {
      fallbackHostname = new URL(item.finalUrl).hostname;
    } catch {
      // The API contract validates this URL. Keep the UI resilient to old data anyway.
    }
  }
  return {
    finalUrl: item.finalUrl,
    finalHostname: evidence?.finalHostname ?? fallbackHostname,
    provider: primary ? providerNames[primary.provider] : null,
    reportedEdge: primary?.reportedEdge ?? null,
    inferredContinent: primary?.inferredContinent
      ? continentNames[primary.inferredContinent]
      : null,
    evidenceHeader: primary?.evidenceHeader ?? null,
    parserVersion: primary?.parserVersion ?? null,
    signals: evidence?.signals ?? [],
  };
}

export function truncateEndpointValue(value: string, maxLength = 120): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function EndpointEvidence({ item }: { item: Observation }) {
  const summary = summarizeEndpointEvidence(item);
  return (
    <div className="endpoint-evidence">
      <div className="endpoint-evidence__target">
        <span className="endpoint-evidence__label">Final URL</span>
        <span
          className="endpoint-evidence__value endpoint-evidence__value--url"
          title={summary.finalUrl ?? undefined}
          aria-label={summary.finalUrl ?? 'Final URL unknown'}
        >
          {summary.finalUrl ? truncateEndpointValue(summary.finalUrl) : 'Unknown'}
        </span>
        <span className="endpoint-evidence__hostname">
          <span className="endpoint-evidence__label">Normalized hostname</span>
          <span className="endpoint-evidence__value" title={summary.finalHostname ?? undefined}>
            {summary.finalHostname ?? 'Unknown'}
          </span>
        </span>
      </div>
      <div className="endpoint-evidence__cdn">
        <span className="endpoint-evidence__label">CDN response evidence</span>
        {summary.provider ? (
          <>
            <span className="endpoint-evidence__value">
              {summary.provider} · {summary.reportedEdge}
            </span>
            <span className="endpoint-evidence__meta">
              {summary.inferredContinent
                ? `Inferred continent: ${summary.inferredContinent}`
                : 'Inferred continent: Unknown'}{' '}
              · Provider-reported
            </span>
            <span className="endpoint-evidence__meta">
              Header: {summary.evidenceHeader} · Parser {summary.parserVersion}
            </span>
          </>
        ) : (
          <span className="endpoint-evidence__meta">No CDN evidence reported</span>
        )}
      </div>
      <RawSignals signals={summary.signals} />
    </div>
  );
}

function RawSignals({ signals }: { signals: EndpointSignal[] }) {
  return (
    <details className="endpoint-evidence__signals">
      <summary>Response signals ({signals.length})</summary>
      {signals.length === 0 ? (
        <p className="endpoint-evidence__empty">No allowlisted response signals.</p>
      ) : (
        <ul>
          {signals.map((signal) => (
            <SignalRow key={signal.name} signal={signal} />
          ))}
        </ul>
      )}
    </details>
  );
}

function SignalRow({ signal }: { signal: EndpointSignal }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'unavailable'>('idle');
  async function copyValue() {
    if (!navigator.clipboard?.writeText) {
      setCopyState('unavailable');
      return;
    }
    try {
      await navigator.clipboard.writeText(signal.value);
      setCopyState('copied');
    } catch {
      setCopyState('unavailable');
    }
  }
  return (
    <li>
      <span className="endpoint-evidence__signal-name">{signal.name}</span>
      <span
        className="endpoint-evidence__signal-value"
        title={signal.value}
        aria-label={`${signal.name} value: ${signal.value}`}
      >
        {truncateEndpointValue(signal.value)}
      </span>
      <button
        type="button"
        className="endpoint-evidence__copy"
        onClick={() => void copyValue()}
        aria-label={`Copy ${signal.name} response value`}
      >
        {copyState === 'copied' ? 'Copied' : copyState === 'unavailable' ? 'Unavailable' : 'Copy'}
      </button>
    </li>
  );
}
