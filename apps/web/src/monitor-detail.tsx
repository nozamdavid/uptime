import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { AppLink } from './app-link.js';
import {
  Bar,
  BarChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Observation, UptimeThresholds } from '@uptime/contracts';
import { findRegion, regionIds, type RegionId } from '@uptime/regions';
import {
  api,
  type DnsDiagnosticRecord,
  type MonitorDetailResponse,
  type MonitorLatencyData,
  type MonitorUptimeData,
  type PublicMonitorDetailResponse,
} from './api.js';
import * as apiModule from './api.js';
import { useProductSession } from './product-shell.js';
import { EndpointEvidence, summarizeEndpointEvidence } from './endpoint-evidence.js';
import { DeleteHistoryDialog, MonitorForm } from './monitor-form.js';
import { MonitorBadge } from './monitor-badge.js';
import { monitorDisplayName } from './monitor-format.js';
import { Select } from './select.js';
import { ThemeControl } from './theme.js';
import {
  assessLatencySampling,
  formatAge,
  loadStatusPageReport,
  statusPageSnapshotToPage,
} from './reports.js';
import { publicReportsEnabled } from './config.js';
import { defaultFontFamily, resolveFontFamily, type FontFamily } from './font-choice.js';
import { formatLatency, formatPercentage } from './status-page-format.js';
import { UptimeStrip, uptimeSeverity } from './uptime-strip.js';
import './monitor-design.css';

const ranges = ['1h', '24h', '7d', '30d'] as const;
export type LatencyRange = (typeof ranges)[number];
const dnsRanges = ['7d', '30d'] as const;

const latencyBucketLabels: Record<LatencyRange, string> = {
  '1h': '5 minutes',
  '24h': '15 minutes',
  '7d': '1 hour',
  '30d': '6 hours',
};
const aggregateLatencyBucketLabels: Record<LatencyRange, string> = {
  '1h': '1 minute',
  '24h': '5 minutes',
  '7d': '15 minutes',
  '30d': '1 hour',
};

export function latencyBucketLabel(range: LatencyRange) {
  return latencyBucketLabels[range];
}
export function aggregateLatencyBucketLabel(range: LatencyRange) {
  return aggregateLatencyBucketLabels[range];
}
export const monitorDetailRefreshIntervalMs = 60_000;

function workspaceSearch(session: ReturnType<typeof useProductSession>) {
  try {
    const helper = apiModule.publicWorkspaceSearch;
    return typeof helper === 'function' ? helper(window.location.search, session) : '';
  } catch {
    return '';
  }
}

export function monitorHostname(value: string) {
  try {
    return new URL(value).hostname || value;
  } catch {
    return value;
  }
}
export function showsPrivateMonitorData(publicMode: boolean) {
  return !publicMode;
}

const registryRegions: Array<{
  id: RegionId;
  code: string;
  name: string;
}> = [
  { id: 'us-east', code: 'US-E', name: 'US East' },
  { id: 'us-west', code: 'US-W', name: 'US West' },
  { id: 'canada-central', code: 'CA-C', name: 'Canada Central' },
  { id: 'eu-west', code: 'EU-W', name: 'EU West' },
  { id: 'eu-north', code: 'EU-N', name: 'EU North' },
  { id: 'eu-south', code: 'EU-S', name: 'EU South' },
  { id: 'asia', code: 'AS-SE', name: 'Asia SE' },
  { id: 'asia-east', code: 'AS-NE', name: 'Asia East' },
  { id: 'asia-south', code: 'AS-S', name: 'Asia South' },
];

export function RegionGrid({
  monitorRegions,
  latestByRegion,
}: {
  monitorRegions: readonly RegionId[];
  latestByRegion: Partial<
    Record<
      RegionId,
      {
        success: boolean;
        responseMs?: number | null;
        errorCode?: string | null;
        errorDetail?: string | null;
      } | null
    >
  >;
}) {
  return (
    <section className="ut-panel" aria-label="Region health grid">
      <div className="ut-panel__head">
        <h2 className="ut-heading" style={{ margin: 0 }}>Regions now</h2>
      </div>
      <div className="ut-regions">
        {registryRegions.map((reg) => {
          const isSelected = monitorRegions.includes(reg.id);
          const obs = isSelected ? latestByRegion[reg.id] : null;
          const status = !isSelected
            ? 'unknown'
            : !obs
              ? 'unknown'
              : obs.success
                ? 'up'
                : 'down';
          const latencyText = !isSelected
            ? 'Not selected'
            : !obs
              ? 'No data'
              : obs.success
                ? typeof obs.responseMs === 'number'
                  ? `${Math.round(obs.responseMs)} ms`
                  : 'Up'
                : obs.errorCode || obs.errorDetail || 'Down';

          return (
            <div key={reg.id} className="ut-region ut-region-cell">
              <div className="ut-region__top ut-region-cell__head">
                <span className="ut-label">{reg.code}</span>
                <i
                  className={`ut-glyph ut-glyph--${status}`}
                  title={`${reg.name}: ${status === 'unknown' ? (isSelected ? 'No data' : 'Not selected') : status}`}
                  aria-hidden="true"
                />
              </div>
              <span
                className={`ut-region__value ut-figure ${status === 'down' ? 'ut-status--down' : ''}`}
              >
                {latencyText}
              </span>
              <span className="ut-region__name ut-region-cell__sub">
                {reg.name}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function MonitorDetail({
  monitorId,
  publicMode = false,
  statusPageId,
}: {
  monitorId: string;
  publicMode?: boolean;
  statusPageId?: string;
}) {
  const session = useProductSession();
  const publicWorkspaceContext =
    publicMode && new URLSearchParams(window.location.search).has('workspace');
  const hostedFree =
    Boolean(session?.user && session.workspace?.plan === 'free') || publicWorkspaceContext;
  const canWrite = !session?.user || session.role === 'owner' || session.role === 'maintainer';
  const [range, setRange] = useState<LatencyRange>('24h');
  const [data, setData] = useState<MonitorDetailResponse | PublicMonitorDetailResponse | null>(
    null,
  );
  const [observations, setObservations] = useState<Observation[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dnsRange, setDnsRange] = useState<(typeof dnsRanges)[number]>('7d');
  const [dnsRegion, setDnsRegion] = useState<RegionId | 'all'>('all');
  const [dnsDiagnostics, setDnsDiagnostics] = useState<DnsDiagnosticRecord[] | null>(null);
  const [dnsNextCursor, setDnsNextCursor] = useState<string | null>(null);
  const [dnsLoading, setDnsLoading] = useState(false);
  const [dnsLoadingMore, setDnsLoadingMore] = useState(false);
  const [dnsError, setDnsError] = useState('');
  const [dnsReload, setDnsReload] = useState(0);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [pageFont, setPageFont] = useState<{ reference: string; family: FontFamily } | null>(null);
  const inFlightRefresh = useRef<Promise<void> | null>(null);
  const displayedRequestKey = useRef<string | null>(null);
  const observationGeneration = useRef(0);
  const dnsGeneration = useRef(0);
  const [edit, setEdit] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteHistoryOpen, setDeleteHistoryOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const monitorDnsDiagnosticsEnabled = Boolean(
    data &&
    'dnsDiagnosticsEnabled' in data.summary.monitor &&
    data.summary.monitor.dnsDiagnosticsEnabled,
  );
  const load = () => setReload((value) => value + 1);

  useEffect(() => {
    if (!publicMode || !statusPageId) return;
    let active = true;
    const pageRequest = publicReportsEnabled()
      ? loadStatusPageReport(statusPageId).then(statusPageSnapshotToPage)
      : api.publicStatusPage(statusPageId);
    void pageRequest
      .then((page) => {
        if (active)
          setPageFont({ reference: statusPageId, family: resolveFontFamily(page.fontFamily) });
      })
      .catch(() => {
        if (active) setPageFont(null);
      });
    return () => {
      active = false;
    };
  }, [publicMode, statusPageId]);

  useEffect(() => {
    let active = true;
    observationGeneration.current += 1;
    const rangeOverride = range;
    const requestKey = `${monitorId}:${publicMode ? 'public' : 'private'}:${rangeOverride}`;
    if (displayedRequestKey.current !== requestKey) {
      displayedRequestKey.current = requestKey;
      setData(null);
      setObservations(publicMode ? [] : null);
      setDnsDiagnostics(null);
      setDnsNextCursor(null);
      setDnsError('');
    }
    setError('');
    const detail: Promise<MonitorDetailResponse | PublicMonitorDetailResponse> = publicMode
      ? api.publicMonitor(monitorId, rangeOverride)
      : api.monitor(monitorId, rangeOverride);
    const history = publicMode
      ? Promise.resolve({ items: [] as Observation[], nextCursor: null })
      : api.observations(monitorId, rangeOverride);
    const request = Promise.all([detail, history])
      .then(([detail, history]) => {
        if (!active) return;
        setData(detail);
        setObservations(history.items);
        setNextCursor(history.nextCursor);
      })
      .catch((reason) => {
        if (active)
          setError(reason instanceof Error ? reason.message : 'Could not load monitor details.');
      })
      .finally(() => {
        if (inFlightRefresh.current === request) inFlightRefresh.current = null;
      });
    inFlightRefresh.current = request;
    return () => {
      active = false;
    };
  }, [monitorId, publicMode, reload, range]);

  useEffect(() => {
    if (!autoRefresh || (error && !data)) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      await inFlightRefresh.current;
      if (active) load();
    }, monitorDetailRefreshIntervalMs);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [autoRefresh, monitorId, publicMode, range, reload, Boolean(error && !data)]);

  useEffect(() => {
    dnsGeneration.current += 1;
    if (!showsPrivateMonitorData(publicMode)) return;
    const enabled = monitorDnsDiagnosticsEnabled;
    if (!enabled) {
      setDnsDiagnostics([]);
      setDnsNextCursor(null);
      setDnsLoading(false);
      return;
    }
    let active = true;
    setDnsLoading(true);
    setDnsError('');
    setDnsDiagnostics(null);
    setDnsNextCursor(null);
    api
      .dnsDiagnostics(monitorId, dnsRange, dnsRegion === 'all' ? undefined : dnsRegion)
      .then((page) => {
        if (!active) return;
        setDnsDiagnostics(page.items);
        setDnsNextCursor(page.nextCursor);
      })
      .catch((reason) => {
        if (!active) return;
        setDnsError(reason instanceof Error ? reason.message : 'Could not load DNS diagnostics.');
        setDnsDiagnostics([]);
      })
      .finally(() => {
        if (active) setDnsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [monitorDnsDiagnosticsEnabled, dnsRange, dnsRegion, dnsReload, monitorId, publicMode]);

  if (edit && data && 'dnsDiagnosticsEnabled' in data.summary.monitor)
    return (
      <MonitorForm
        monitor={{ ...data.summary.monitor, name: data.summary.monitor.name ?? undefined }}
        onCancel={() => setEdit(false)}
        onSaved={() => {
          setEdit(false);
          load();
        }}
        onHistoryDeleted={load}
      />
    );

  if (error && !data)
    return (
      <>
        {publicMode && (
          <div className="theme-toolbar">
            <ThemeControl />
          </div>
        )}
        <div className="state state--error" role="alert">
          <p>{error}</p>
          <button
            className="button button--quiet ut-btn ut-btn--secondary"
            onClick={() => {
              setError('');
              load();
            }}
          >
            Try again
          </button>
        </div>
      </>
    );

  if (!data || !observations)
    return publicMode ? (
      <>
        <div className="theme-toolbar">
          <ThemeControl />
        </div>
        <MonitorDetailLoadingSkeleton />
      </>
    ) : (
      <div className="state state--loading" role="status">
        <p>Loading monitor history…</p>
      </div>
    );

  const { monitor, status } = data.summary;
  const dnsDiagnosticsEnabled =
    'dnsDiagnosticsEnabled' in monitor ? monitor.dnsDiagnosticsEnabled : false;
  const chartRegions = orderedRegions([
    ...monitor.regionIds,
    ...data.latency.stats.map((stat) => stat.regionId),
    ...data.latency.points.map((point) => point.regionId),
  ]);
  const latestResultState = getLatestResultState(
    monitor.enabled,
    monitor.regionIds,
    data.summary.latestByRegion,
  );
  const lastUpdatedAt = findLatestMonitorUpdate(
    Object.values(data.summary.latestByRegion),
    data.latency.points,
  );

  const effectiveStatus = !monitor.enabled ? 'paused' : status;
  const effectiveWord =
    effectiveStatus === 'paused'
      ? 'Paused'
      : status === 'up'
        ? 'Up'
        : status === 'degraded'
          ? 'Degraded'
          : status === 'down'
            ? 'Down'
            : 'No data';

  const publicUrl = `${window.location.origin}/monitors/public/${monitor.publicSlug ?? monitor.id}${workspaceSearch(session)}`;

  return (
    <section
      className={publicMode ? 'detail font-choice' : 'detail'}
      {...(publicMode
        ? {
            'data-font':
              pageFont && pageFont.reference === statusPageId
                ? pageFont.family
                : defaultFontFamily,
          }
        : {})}
    >
      {/* 1. Header */}
      <div className="page-head ut-detail-header">
        <div className="ut-stack">
          {publicMode && statusPageId ? (
            <AppLink
              href={`/status/${encodeURIComponent(statusPageId)}${workspaceSearch(null)}`}
              className="back-link"
            >
              ← Back to status page
            </AppLink>
          ) : !publicMode ? (
            <AppLink href="/app" className="back-link">
              ← Monitors
            </AppLink>
          ) : null}

          <div className="ut-row">
            <span
              className={`ut-status ut-status--chip ut-status--${effectiveStatus}`}
              role="img"
              aria-label={effectiveStatus}
            >
              <i className={`ut-glyph ut-glyph--${effectiveStatus}`} aria-hidden="true" />
              <span>{effectiveWord}</span>
            </span>
            <MonitorBadge badge={monitor.badge} />
          </div>

          <h1 className="ut-display-lg" style={{ margin: 0 }}>
            {monitorDisplayName(monitor)}
          </h1>

          <p className="ut-data ut-muted" style={{ margin: 0 }}>
            <a href={monitor.url} target="_blank" rel="noreferrer">
              {monitor.url}
            </a>
          </p>

          {!publicMode && monitor.isPublic && (
            <p className="ut-data ut-muted" style={{ margin: 0 }}>
              <a href={publicUrl} target="_blank" rel="noreferrer">
                Public view
              </a>
            </p>
          )}
        </div>

        <div className="page-head__actions ut-detail-header__actions">
          <button
            type="button"
            className="button button--quiet ut-btn ut-btn--secondary monitor-detail__refresh-toggle"
            aria-pressed={autoRefresh}
            onClick={() => setAutoRefresh((enabled) => !enabled)}
          >
            Auto-refresh {autoRefresh ? 'on' : 'off'}
          </button>
          {publicMode && <ThemeControl />}
          {!publicMode && canWrite && (
            <>
              <button
                type="button"
                className="button button--quiet ut-btn ut-btn--secondary"
                onClick={() => setEdit(true)}
              >
                Edit
              </button>
              <button
                type="button"
                className="button button--quiet ut-btn ut-btn--secondary"
                onClick={() => {
                  void api.updateMonitor(monitorId, { enabled: !monitor.enabled }).then(load);
                }}
              >
                {monitor.enabled ? 'Pause' : 'Resume'}
              </button>
              <button
                type="button"
                className="button button--quiet ut-btn ut-btn--secondary"
                onClick={() => {
                  if (monitor.isPublic) {
                    void navigator.clipboard?.writeText(publicUrl).then(() => {
                      setShareCopied(true);
                      setTimeout(() => setShareCopied(false), 2000);
                    });
                  } else {
                    setEdit(true);
                  }
                }}
              >
                {shareCopied ? 'Link copied' : 'Share'}
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <p className="field-error ut-field__error" role="status">
          Latest refresh failed: {error}
        </p>
      )}

      {/* 2. Now: 3x3 RegionGrid */}
      <RegionGrid
        monitorRegions={monitor.regionIds}
        latestByRegion={data.summary.latestByRegion}
      />

      {/* 3. History: 90-day UptimeStrip & LatencyTrace */}
      <MonitorUptimeOverview
        uptime={data.uptime}
        monitorName={monitorDisplayName(monitor)}
        lastUpdatedAt={lastUpdatedAt}
        intervalSeconds={monitor.intervalSeconds}
        enabled={monitor.enabled}
        thresholds={monitor.uptimeThresholds}
      />

      <div
        className="range-tabs ut-row"
        role="tablist"
        aria-label="Latency time range"
      >
        {ranges.map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={range === item}
            className={`ut-btn ut-btn--secondary ut-btn--sm ${range === item ? 'is-active' : ''}`}
            onClick={() => setRange(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {!data.latency.pending && <LatencySampleNote data={data.latency} />}
      {latestResultState.kind === 'partial' && (
        <p className="gap-note" role="status">
          Missing latest result: {latestResultState.missing.map(regionName).join(', ')}. This is
          shown as a system gap, not a target failure.
        </p>
      )}
      {latestResultState.kind === 'awaiting' && (
        <p className="empty-inline" role="status">
          Awaiting first current result.
        </p>
      )}

      {data.latency.pending ? (
        <LatencyLoadingSkeleton />
      ) : (
        <>
          <ResponseLatencyChart data={data} chartRegions={chartRegions} range={range} />
          <section className="stat-strip ut-row">
            {data.latency.stats.map((stat) => (
              <div key={stat.regionId} style={{ flex: '1 1 120px' }}>
                <span className="ut-label">{regionName(stat.regionId)}</span>
                <dl className="region-stats tnum ut-data">
                  <div>
                    <dt>p50</dt>
                    <dd>{formatLatency(stat.p50Ms)}</dd>
                  </div>
                  <div>
                    <dt>p95</dt>
                    <dd>{formatLatency(stat.p95Ms)}</dd>
                  </div>
                  <div>
                    <dt>p99</dt>
                    <dd>{formatLatency(stat.p99Ms)}</dd>
                  </div>
                </dl>
                <small className="ut-muted">
                  {stat.successCount}/{stat.sampleCount} successful requests
                </small>
              </div>
            ))}
          </section>
        </>
      )}

      {/* 4. Evidence: Request table & DNS diagnostics */}
      {showsPrivateMonitorData(publicMode) && (
        <RequestTable
          items={observations}
          hasMore={nextCursor !== null}
          loadingMore={loadingMore}
          onLoadMore={async () => {
            if (!nextCursor) return;
            const generation = observationGeneration.current;
            setLoadingMore(true);
            try {
              const page = await api.observations(monitorId, range, nextCursor);
              if (generation !== observationGeneration.current) return;
              setObservations((current) => [...(current ?? []), ...page.items]);
              setNextCursor(page.nextCursor);
            } catch (reason) {
              if (generation !== observationGeneration.current) return;
              setError(reason instanceof Error ? reason.message : 'Could not load more requests.');
            } finally {
              if (generation === observationGeneration.current) setLoadingMore(false);
            }
          }}
        />
      )}

      {showsPrivateMonitorData(publicMode) && !hostedFree && (
        <DnsDiagnostics
          enabled={dnsDiagnosticsEnabled}
          monitorRegions={monitor.regionIds}
          range={dnsRange}
          region={dnsRegion}
          diagnostics={dnsDiagnostics}
          nextCursor={dnsNextCursor}
          loading={dnsLoading}
          loadingMore={dnsLoadingMore}
          error={dnsError}
          onRangeChange={(next) => setDnsRange(next)}
          onRegionChange={(next) => setDnsRegion(next)}
          onRetry={() => {
            setDnsReload((current) => current + 1);
          }}
          onLoadMore={async () => {
            if (!dnsNextCursor) return;
            const generation = dnsGeneration.current;
            setDnsLoadingMore(true);
            try {
              const page = await api.dnsDiagnostics(
                monitorId,
                dnsRange,
                dnsRegion === 'all' ? undefined : dnsRegion,
                dnsNextCursor,
              );
              if (generation !== dnsGeneration.current) return;
              setDnsDiagnostics((current) => [...(current ?? []), ...page.items]);
              setDnsNextCursor(page.nextCursor);
            } catch (reason) {
              if (generation !== dnsGeneration.current) return;
              setDnsError(
                reason instanceof Error ? reason.message : 'Could not load more DNS diagnostics.',
              );
            } finally {
              if (generation === dnsGeneration.current) setDnsLoadingMore(false);
            }
          }}
        />
      )}

      {/* 5. Danger zone */}
      {showsPrivateMonitorData(publicMode) && canWrite && (
        <section className="ut-danger-zone" aria-labelledby="danger-zone-title">
          <h2 id="danger-zone-title" className="ut-danger-zone__title">
            Danger zone
          </h2>
          <p className="ut-muted">
            Irreversible actions for this monitor. Deleting history wipes telemetry; deleting the
            monitor removes it entirely.
          </p>
          <div className="ut-danger-zone__actions">
            <button
              type="button"
              className="button button--secondary ut-btn ut-btn--secondary"
              onClick={() => setDeleteHistoryOpen(true)}
            >
              Delete history
            </button>
            <button
              type="button"
              className="button button--secondary ut-btn ut-btn--secondary"
              onClick={() => setDeleteOpen(true)}
            >
              Delete monitor
            </button>
          </div>
        </section>
      )}

      {showsPrivateMonitorData(publicMode) && canWrite && deleteHistoryOpen && (
        <DeleteHistoryDialog
          name={monitorDisplayName(monitor)}
          onCancel={() => setDeleteHistoryOpen(false)}
          onConfirm={async () => {
            await api.deleteMonitorHistory(monitorId);
            setDeleteHistoryOpen(false);
            load();
          }}
        />
      )}

      {showsPrivateMonitorData(publicMode) && canWrite && deleteOpen && (
        <DeleteDialog
          name={monitor.name ?? monitor.url}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={async () => {
            await api.deleteMonitor(monitorId);
            window.location.assign('/');
          }}
        />
      )}
    </section>
  );
}

export function MonitorUptimeOverview({
  uptime,
  monitorName,
  lastUpdatedAt,
  intervalSeconds,
  enabled,
  thresholds,
}: {
  uptime: MonitorUptimeData;
  monitorName: string;
  lastUpdatedAt: string | null;
  intervalSeconds: number;
  enabled: boolean;
  thresholds?: UptimeThresholds | undefined;
}) {
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  const firstDay = uptime.days.at(0)?.date;
  const lastDay = uptime.days.at(-1)?.date;
  const nextUpdate = enabled
    ? `Next update in ${formatUpdateCountdown(millisecondsUntilNextUpdate(currentTime, intervalSeconds))}`
    : 'Next update paused';
  const displayStatus = uptime.recoveryStatus ?? uptime.status;
  const percentageSeverity = uptimeSeverity(uptime.uptimePercentage, thresholds);

  return (
    <section className="monitor-uptime ut-stack" aria-labelledby="monitor-uptime-title">
      <div className="monitor-uptime__summary ut-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <p className="ut-label" id="monitor-uptime-title">
            90-day uptime
          </p>
          <strong className={`ut-figure monitor-uptime__value monitor-uptime__value--${percentageSeverity}`}>
            {formatPercentage(uptime.uptimePercentage)}
          </strong>
        </div>
        <span className={`ut-status ut-status--chip ut-status--${displayStatus} monitor-uptime__state monitor-uptime__state--${displayStatus}`}>
          <i className={`ut-glyph ut-glyph--${displayStatus}`} aria-hidden="true" />
          <span className={`status-dot status-dot--${displayStatus}`} />
          {displayStatus === 'up'
            ? 'Operational'
            : displayStatus === 'recovering'
              ? 'Recovering'
              : displayStatus === 'down'
                ? 'Issues'
                : 'No data'}
        </span>
      </div>
      <div className="monitor-uptime__timing tnum ut-data ut-muted ut-row" style={{ justifyContent: 'space-between' }} aria-live="off">
        <span>
          Last updated{' '}
          {lastUpdatedAt ? (
            <time dateTime={lastUpdatedAt}>{formatLastUpdate(lastUpdatedAt)}</time>
          ) : (
            '—'
          )}
        </span>
        <span>{nextUpdate}</span>
      </div>
      <UptimeStrip
        days={uptime.days}
        label={`${monitorName} daily uptime history`}
        thresholds={thresholds}
      />
      <div className="monitor-uptime__range ut-strip__axis" aria-hidden="true">
        <span>{firstDay ? formatUptimeDate(firstDay) : '90 days ago'}</span>
        <span>{lastDay ? formatUptimeDate(lastDay) : 'Today'}</span>
      </div>
    </section>
  );
}

export function findLatestMonitorUpdate(
  latestByRegion: ReadonlyArray<{
    startedAt: string;
    completedAt: string | null;
  } | null>,
  latencyPoints: ReadonlyArray<{ observedAt: string }>,
): string | null {
  const candidates = [
    ...latestByRegion.flatMap((observation) =>
      observation ? [observation.completedAt ?? observation.startedAt] : [],
    ),
    ...latencyPoints.map((point) => point.observedAt),
  ];
  let latest = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const timestamp = new Date(candidate).getTime();
    if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

export function millisecondsUntilNextUpdate(currentTime: number, intervalSeconds: number) {
  const intervalMilliseconds = intervalSeconds * 1_000;
  const elapsed =
    ((currentTime % intervalMilliseconds) + intervalMilliseconds) % intervalMilliseconds;
  return elapsed === 0 ? intervalMilliseconds : intervalMilliseconds - elapsed;
}

function MonitorDetailLoadingSkeleton() {
  return (
    <section className="detail monitor-detail-skeleton" aria-busy="true">
      <span className="sr-only" role="status">
        Loading monitor status and charts.
      </span>
      <div className="monitor-skeleton__head" aria-hidden="true">
        <i className="monitor-skeleton__block monitor-skeleton__line monitor-skeleton__line--short" />
        <i className="monitor-skeleton__block monitor-skeleton__title" />
        <i className="monitor-skeleton__block monitor-skeleton__line monitor-skeleton__line--medium" />
      </div>
      <div className="monitor-skeleton__uptime" aria-hidden="true">
        <i className="monitor-skeleton__block monitor-skeleton__uptime-value" />
        <div className="monitor-skeleton__uptime-days">
          {Array.from({ length: 45 }, (_, index) => (
            <i className="monitor-skeleton__block" key={index} />
          ))}
        </div>
      </div>
      <div className="monitor-skeleton__ranges" aria-hidden="true">
        {ranges.map((item) => (
          <i className="monitor-skeleton__block" key={item} />
        ))}
      </div>
      <LatencyLoadingSkeleton announce={false} />
    </section>
  );
}

function LatencyLoadingSkeleton({ announce = true }: { announce?: boolean }) {
  return (
    <div
      className="monitor-latency-skeleton"
      aria-busy="true"
      {...(announce ? { role: 'status' as const } : {})}
    >
      {announce && <span className="sr-only">Loading latency charts.</span>}
      <section className="chart-section" aria-hidden="true">
        <div className="monitor-skeleton__heading">
          <i className="monitor-skeleton__block monitor-skeleton__line monitor-skeleton__line--medium" />
          <i className="monitor-skeleton__block monitor-skeleton__line monitor-skeleton__line--wide" />
        </div>
        <div className="monitor-skeleton__plot">
          <i className="monitor-skeleton__block monitor-skeleton__plot-line" />
          <i className="monitor-skeleton__block monitor-skeleton__axis" />
        </div>
        <div className="monitor-skeleton__metrics">
          {Array.from({ length: 3 }, (_, index) => (
            <i className="monitor-skeleton__block" key={index} />
          ))}
        </div>
      </section>
      <section className="chart-section" aria-hidden="true">
        <div className="monitor-skeleton__heading">
          <i className="monitor-skeleton__block monitor-skeleton__line monitor-skeleton__line--medium" />
          <i className="monitor-skeleton__block monitor-skeleton__line monitor-skeleton__line--wide" />
        </div>
        <div className="monitor-skeleton__percentiles">
          {Array.from({ length: 3 }, (_, index) => (
            <i className="monitor-skeleton__block" key={index} />
          ))}
        </div>
      </section>
      <div className="monitor-skeleton__regions" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => (
          <i className="monitor-skeleton__block" key={index} />
        ))}
      </div>
    </div>
  );
}

export function formatUpdateCountdown(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatLastUpdate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function formatUptimeDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function LatencySampleNote({
  data,
}: {
  data: Pick<MonitorLatencyData['latency'], 'sampled' | 'sampleLimit' | 'computedAt' | 'pending'>;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (data.pending || !data.computedAt) return;
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, [data.computedAt, data.pending]);
  const sampling = assessLatencySampling(data, now);
  if (data.pending) {
    return (
      <p className="latency-sample-note" role="status">
        Latency graph is being prepared.
      </p>
    );
  }
  if (!sampling.sampled && sampling.computedAt === null) return null;
  return (
    <p className="latency-sample-note" role="status">
      {sampling.sampleLimit === null
        ? sampling.sampled
          ? 'Percentiles and chart points use a bounded recent sample.'
          : null
        : `Percentiles and chart points use up to the most recent ${sampling.sampleLimit.toLocaleString()} observations.`}
      {(sampling.sampled || sampling.sampleLimit !== null) && sampling.computedAgeSeconds !== null
        ? ' '
        : null}
      {sampling.computedAgeSeconds !== null
        ? `Computed ${formatAge(sampling.computedAgeSeconds)} ago.`
        : null}
    </p>
  );
}

export function ResponseLatencyChart({
  data,
  chartRegions,
  range = '24h',
}: {
  data: MonitorLatencyData;
  chartRegions: readonly RegionId[];
  range?: LatencyRange;
}) {
  const [chartView, setChartView] = useState<'all' | 'regions'>('all');
  const [hiddenChartRegions, setHiddenChartRegions] = useState<ReadonlySet<RegionId>>(new Set());
  const regionalChart = useMemo(() => toChart(data), [data.latency]);
  const aggregateChart = useMemo(
    () =>
      (data.latency.aggregatePoints ?? []).map((point) => ({
        time: point.observedAt,
        responseMs: point.responseMs,
      })),
    [data.latency],
  );
  const regionalBucketLabel = latencyBucketLabel(range);
  const aggregateBucketLabel = aggregateLatencyBucketLabel(range);
  const aggregateStats = data.latency.aggregateStats ?? {
    averageResponseMs: null,
    maximumResponseMs: null,
    maximumResponseRegionId: null,
    minimumResponseMs: null,
  };
  const showingAggregate = chartView === 'all';
  const sampling = assessLatencySampling(data.latency);
  const rangeScope = sampling.sampled
    ? sampling.sampleLimit === null
      ? 'in a bounded recent sample'
      : `in the most recent ${sampling.sampleLimit.toLocaleString()} observations`
    : 'in the selected range';
  return (
    <Fragment>
      <section className="chart-section ut-panel">
        <div className="chart-section__intro ut-panel__head">
          <div className="chart-section__title-row ut-row" style={{ justifyContent: 'space-between', width: '100%' }}>
            <h2 className="ut-heading" style={{ margin: 0 }}>Response latency</h2>
            <div className="chart-view-toggle ut-row" role="tablist" aria-label="Latency chart view">
              <button
                type="button"
                role="tab"
                aria-selected={showingAggregate}
                className={`ut-btn ut-btn--secondary ut-btn--sm ${showingAggregate ? 'is-active' : ''}`}
                onClick={() => setChartView('all')}
              >
                All regions
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={!showingAggregate}
                className={`ut-btn ut-btn--secondary ut-btn--sm ${!showingAggregate ? 'is-active' : ''}`}
                onClick={() => setChartView('regions')}
              >
                Per-region
              </button>
            </div>
          </div>
        </div>
        <div className="ut-panel__body">
          <p className="ut-muted" style={{ marginTop: 0, fontSize: 'var(--text-body-sm-size)' }}>
            {showingAggregate
              ? `Each point averages response-to-headers latency equally across regions, grouped every ${aggregateBucketLabel} ${rangeScope}.`
              : `Each point is the average response-to-headers latency for a region, grouped every ${regionalBucketLabel} ${rangeScope}.`}{' '}
            Missing buckets are not interpolated.
          </p>
          <div
            className="chart"
            role="img"
            aria-label={
              showingAggregate
                ? 'All-region average response latency chart'
                : 'Regional response latency chart'
            }
          >
            <ResponsiveContainer width="100%" height={280}>
              <LineChart
                data={showingAggregate ? aggregateChart : regionalChart}
                margin={{ top: 8, right: 16, left: 0, bottom: 16 }}
              >
                <XAxis
                  dataKey="time"
                  stroke="var(--rule-strong)"
                  tick={{ fill: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                  tickFormatter={formatChartDate}
                  angle={-40}
                  textAnchor="end"
                  height={62}
                  minTickGap={24}
                  interval="preserveStartEnd"
                />
                <YAxis
                  unit=" ms"
                  stroke="var(--rule-strong)"
                  tick={{ fill: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--paper)',
                    borderColor: 'var(--rule-strong)',
                    color: 'var(--ink)',
                  }}
                  cursor={{ stroke: 'var(--rule-strong)' }}
                  labelFormatter={formatChartTooltipDate}
                  formatter={formatResponseLatencyTooltip}
                />
                {showingAggregate ? (
                  <Line
                    type="monotone"
                    dataKey="responseMs"
                    name="All regions average"
                    stroke="var(--up)"
                    strokeWidth={1.75}
                    dot={false}
                    connectNulls={false}
                  />
                ) : (
                  chartRegions.map((region) => (
                    <Line
                      key={region}
                      type="monotone"
                      dataKey={region}
                      name={regionName(region)}
                      stroke={regionColour(region)}
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls={false}
                      hide={hiddenChartRegions.has(region)}
                    />
                  ))
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {showingAggregate && (
            <dl className="latency-summary tnum ut-data ut-row" style={{ gap: 'var(--space-6)', marginTop: 'var(--space-3)' }} aria-label="All-region response time summary">
              <div>
                <dd className="ut-figure">{formatLatency(aggregateStats.averageResponseMs)}</dd>
                <dt className="ut-label">Avg. response time</dt>
              </div>
              <div>
                <dd className="ut-figure">{formatLatency(aggregateStats.maximumResponseMs)}</dd>
                <dt className="ut-label">
                  Max. response time
                  {aggregateStats.maximumResponseRegionId
                    ? ` (${aggregateStats.maximumResponseRegionId})`
                    : ''}
                </dt>
              </div>
              <div>
                <dd className="ut-figure">{formatLatency(aggregateStats.minimumResponseMs)}</dd>
                <dt className="ut-label">Min. response time</dt>
              </div>
            </dl>
          )}
          <div className="sr-only">
            <table>
              <caption>
                {showingAggregate
                  ? `Text alternative for the all-region average response latency chart. Each row is an equal-weight regional average, grouped every ${aggregateBucketLabel} in the selected range.`
                  : `Text alternative for the regional response latency chart. Each row is a per-region average, grouped every ${regionalBucketLabel} in the selected range.`}
              </caption>
              <thead>
                <tr>
                  <th>Bucket</th>
                  {!showingAggregate && <th>Region</th>}
                  <th>Average response latency</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {(showingAggregate ? (data.latency.aggregatePoints ?? []) : data.latency.points).map(
                  (point) => (
                    <tr key={`${point.observedAt}-${'regionId' in point ? point.regionId : 'all'}`}>
                      <td>{new Date(point.observedAt).toLocaleString()}</td>
                      {!showingAggregate &&
                        'regionId' in point &&
                        typeof point.regionId === 'string' && <td>{regionName(point.regionId)}</td>}
                      <td>{formatLatency(point.responseMs)}</td>
                      <td>{point.success ? 'Successful' : 'Failed'}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          {!showingAggregate && (
            <div className="chart-legend ut-row" style={{ marginTop: 'var(--space-3)' }}>
              {chartRegions.map((region) => (
                <button
                  key={region}
                  type="button"
                  className={`ut-btn ut-btn--secondary ut-btn--sm ${hiddenChartRegions.has(region) ? 'is-hidden' : ''}`}
                  aria-pressed={!hiddenChartRegions.has(region)}
                  aria-label={`${regionName(region)} response latency line`}
                  onClick={() =>
                    setHiddenChartRegions((current) => {
                      const next = new Set(current);
                      if (next.has(region)) next.delete(region);
                      else next.add(region);
                      return next;
                    })
                  }
                >
                  <i aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: regionColour(region), display: 'inline-block' }} />
                  {regionName(region)}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
      {!showingAggregate && <LatencyPercentileChart data={data} chartRegions={chartRegions} />}
    </Fragment>
  );
}

export function LatencyPercentileChart({
  data,
  chartRegions,
}: {
  data: MonitorLatencyData;
  chartRegions: readonly RegionId[];
}) {
  const percentileChart = toPercentileChart(data, chartRegions);
  const percentileChartHeight = Math.max(280, percentileChart.length * 52 + 32);
  const sampling = assessLatencySampling(data.latency);
  const percentileScope = sampling.sampled
    ? sampling.sampleLimit === null
      ? 'in a bounded recent sample, not the complete selected range'
      : `in the most recent ${sampling.sampleLimit.toLocaleString()} observations, not the complete selected range`
    : 'in this range';
  return (
    <section
      className="chart-section percentile-chart-section ut-panel"
      aria-labelledby="latency-percentiles-title"
    >
      <div className="ut-panel__head">
        <div>
          <h2 id="latency-percentiles-title" className="ut-heading" style={{ margin: 0 }}>Latency percentiles</h2>
          <p className="ut-muted" style={{ margin: 0, fontSize: 'var(--text-body-sm-size)' }}>
            Typical response latency by region. P50 is the midpoint; P95 and P99 show the slower end
            of successful requests {percentileScope}.
          </p>
        </div>
      </div>
      <div className="ut-panel__body">
        <div className="chart" role="img" aria-label="Regional latency percentiles bar chart">
          <ResponsiveContainer width="100%" height={percentileChartHeight}>
            <BarChart
              data={percentileChart}
              layout="vertical"
              margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
            >
              <XAxis
                type="number"
                unit=" ms"
                stroke="var(--rule-strong)"
                tick={{ fill: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              />
              <YAxis
                dataKey="chartLabel"
                type="category"
                width={112}
                interval={0}
                stroke="var(--rule-strong)"
                tick={{ fill: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--paper)',
                  borderColor: 'var(--rule-strong)',
                  color: 'var(--ink)',
                }}
                cursor={{ fill: 'var(--sunken)' }}
                formatter={(value) => (typeof value === 'number' ? formatLatency(value) : '—')}
              />
              <Bar dataKey="p50Ms" name="P50 (median)" fill="var(--series-1)" />
              <Bar dataKey="p95Ms" name="P95" fill="var(--series-2)" />
              <Bar dataKey="p99Ms" name="P99" fill="var(--series-3)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="sr-only">
          <table>
            <caption>Text alternative for the regional latency percentiles bar chart</caption>
            <thead>
              <tr>
                <th>Region</th>
                <th>P50 median response latency</th>
                <th>P95 response latency</th>
                <th>P99 response latency</th>
              </tr>
            </thead>
            <tbody>
              {percentileChart.map((region) => (
                <tr key={region.regionId}>
                  <td>{region.region}</td>
                  <td>{formatLatency(region.p50Ms)}</td>
                  <td>{formatLatency(region.p95Ms)}</td>
                  <td>{formatLatency(region.p99Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="chart-legend percentile-chart-legend ut-row" style={{ marginTop: 'var(--space-3)' }} aria-label="Latency percentile legend">
          <span className="ut-row">
            <i aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--series-1)', display: 'inline-block' }} />
            P50 (median)
          </span>
          <span className="ut-row">
            <i aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--series-2)', display: 'inline-block' }} />
            P95
          </span>
          <span className="ut-row">
            <i aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--series-3)', display: 'inline-block' }} />
            P99
          </span>
        </div>
      </div>
    </section>
  );
}

export function DnsDiagnostics({
  enabled,
  monitorRegions,
  range,
  region,
  diagnostics,
  nextCursor,
  loading,
  loadingMore,
  error,
  onRangeChange,
  onRegionChange,
  onRetry,
  onLoadMore,
}: {
  enabled: boolean;
  monitorRegions: RegionId[];
  range: (typeof dnsRanges)[number];
  region: RegionId | 'all';
  diagnostics: DnsDiagnosticRecord[] | null;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  onRangeChange: (range: (typeof dnsRanges)[number]) => void;
  onRegionChange: (region: RegionId | 'all') => void;
  onRetry: () => void;
  onLoadMore: () => Promise<void>;
}) {
  return (
    <section className="history dns-history ut-panel" aria-labelledby="dns-diagnostics-title">
      <div className="ut-panel__head">
        <div>
          <h2 id="dns-diagnostics-title" className="ut-heading" style={{ margin: 0 }}>DNS diagnostics</h2>
          <p className="ut-muted" style={{ margin: 0 }}>Daily DNS candidate snapshots are stored separately from latency and request history.</p>
          <p className="history__evidence-note ut-muted" style={{ fontSize: 'var(--text-body-sm-size)' }}>
            DNS candidates — not the connected HTTP peer. They help inspect DNS responses; they make
            no geography claim.
          </p>
        </div>
      </div>
      <div className="ut-panel__body">
        {!enabled ? (
          <p className="empty-inline">
            DNS diagnostics are disabled for this monitor. Enable <em>Collect DNS diagnostics</em> in
            monitor settings to capture one snapshot per day in each selected region.
          </p>
        ) : (
          <>
            <div className="diagnostic-filters ut-row" aria-label="DNS diagnostics filters" style={{ marginBottom: 'var(--space-3)' }}>
              <div className="field ut-field">
                <label className="ut-label" htmlFor="dns-history-range">
                  History range
                </label>
                <Select<(typeof dnsRanges)[number]>
                  id="dns-history-range"
                  value={range}
                  onChange={onRangeChange}
                  options={dnsRanges.map((item) => ({ value: item, label: `Last ${item}` }))}
                />
              </div>
              <div className="field ut-field">
                <label className="ut-label" htmlFor="dns-region">
                  Region
                </label>
                <Select<RegionId | 'all'>
                  id="dns-region"
                  value={region}
                  onChange={onRegionChange}
                  options={[
                    { value: 'all', label: 'All selected regions' },
                    ...monitorRegions.map((item) => ({ value: item, label: regionName(item) })),
                  ]}
                />
              </div>
            </div>
            {error ? (
              <div className="state state--error" role="alert">
                <p>{error}</p>
                <button className="button button--quiet ut-btn ut-btn--secondary" onClick={onRetry}>
                  Try again
                </button>
              </div>
            ) : loading || diagnostics === null ? (
              <p className="state state--loading" role="status">
                Loading DNS diagnostics…
              </p>
            ) : diagnostics.length === 0 ? (
              <p className="empty-inline">No DNS diagnostics in this range.</p>
            ) : (
              <DnsDiagnosticsTable items={diagnostics} />
            )}
            {nextCursor && !error && (
              <button
                className="button button--quiet history__more ut-btn ut-btn--secondary"
                disabled={loadingMore}
                onClick={() => void onLoadMore()}
                style={{ marginTop: 'var(--space-3)' }}
              >
                {loadingMore ? 'Loading…' : 'Load older DNS snapshots'}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function DnsDiagnosticsTable({ items }: { items: DnsDiagnosticRecord[] }) {
  return (
    <div className="table-wrap dns-diagnostics-table">
      <table>
        <caption className="sr-only">DNS candidate snapshots</caption>
        <thead>
          <tr>
            <th>Region</th>
            <th>Lifecycle / status</th>
            <th>UTC daily window / observed</th>
            <th>Final hostname</th>
            <th>Resolver</th>
            <th>CNAME candidates</th>
            <th>IPv4 candidates</th>
            <th>IPv6 candidates</th>
            <th>Filtered addresses</th>
            <th>Failure / version</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <DnsDiagnosticRow key={item.id} item={item} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DnsDiagnosticRow({ item }: { item: DnsDiagnosticRecord }) {
  const result = item.result;
  const status = result?.status ?? item.lifecycle;
  const failure = result?.errorCode ?? item.failureCode;
  return (
    <tr>
      <td data-label="Region">{regionName(item.regionId)}</td>
      <td data-label="Lifecycle / status">
        <span
          className={`result result--${status === 'success' ? 'success' : status === 'partial' ? 'partial' : 'failure'}`}
        >
          {item.lifecycle} · {status}
        </span>
      </td>
      <td data-label="UTC daily window / observed" className="tnum">
        <span>{formatUtc(item.windowStartedAt)}</span>
        <small>{result ? formatUtc(result.observedAt) : 'Not observed'}</small>
      </td>
      <td data-label="Final hostname" className="tnum dns-value">
        {item.finalHostname ?? result?.finalHostname ?? 'Unavailable'}
      </td>
      <td data-label="Resolver" className="tnum">
        {result?.resolver ?? '—'}
      </td>
      <td data-label="CNAME candidates" className="tnum dns-value">
        <CandidateList values={result?.cnameCandidates ?? []} />
      </td>
      <td data-label="IPv4 candidates" className="tnum dns-value">
        <AddressList values={result?.aCandidates ?? []} />
      </td>
      <td data-label="IPv6 candidates" className="tnum dns-value">
        <AddressList values={result?.aaaaCandidates ?? []} />
      </td>
      <td data-label="Filtered addresses" className="tnum">
        {result?.filteredAddressCount ?? '—'}
      </td>
      <td data-label="Failure / version" className="tnum dns-value">
        {failure ?? '—'}
        {result && (
          <small>
            Schema {result.schemaVersion} · Parser {result.parserVersion}
          </small>
        )}
      </td>
    </tr>
  );
}

function CandidateList({ values }: { values: string[] }) {
  return values.length === 0 ? '—' : values.map((value) => <span key={value}>{value}</span>);
}

function AddressList({ values }: { values: { address: string; ttl: number }[] }) {
  return values.length === 0
    ? '—'
    : values.map((value) => (
        <span key={`${value.address}-${value.ttl}`}>
          {value.address} <small>TTL {value.ttl}s</small>
        </span>
      ));
}

function formatUtc(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? 'Unknown'
    : parsed.toISOString().replace('.000Z', 'Z').replace('T', ' ');
}

export function toChart(data: MonitorLatencyData) {
  const byTime = new Map<string, Record<string, string | number | null>>();
  for (const point of data.latency.points) {
    const key = new Date(
      Math.floor(new Date(point.observedAt).getTime() / 1000) * 1000,
    ).toISOString();
    const row = byTime.get(key) ?? { time: key };
    row[point.regionId] = point.responseMs;
    byTime.set(key, row);
  }
  return [...byTime.values()].sort((left, right) =>
    String(left.time).localeCompare(String(right.time)),
  );
}

export function formatChartDate(value: string | number) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(parsed);
}

export function formatChartTooltipDate(value: ReactNode) {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Unknown';
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const localDate = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(parsed);
    return `${localDate} (${timeZone})`;
  }
  if (typeof value === 'number') return String(value);
  return '';
}

export function formatResponseLatencyTooltip(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return formatLatency(value);
}

export type LatestResultState =
  { kind: 'complete' | 'disabled' | 'awaiting' } | { kind: 'partial'; missing: RegionId[] };

export function getLatestResultState<T>(
  enabled: boolean,
  monitorRegions: readonly RegionId[],
  latestByRegion: Partial<Record<RegionId, T | null>>,
): LatestResultState {
  if (!enabled) return { kind: 'disabled' };
  const missing = monitorRegions.filter(
    (region) => latestByRegion[region] === null || latestByRegion[region] === undefined,
  );
  if (missing.length === 0) return { kind: 'complete' };
  if (missing.length === monitorRegions.length) return { kind: 'awaiting' };
  return { kind: 'partial', missing };
}

export function toPercentileChart(data: MonitorLatencyData, chartRegions: readonly RegionId[]) {
  const statsByRegion = new Map(data.latency.stats.map((stat) => [stat.regionId, stat]));
  return chartRegions.map((regionId) => {
    const stats = statsByRegion.get(regionId);
    return {
      regionId,
      region: regionName(regionId),
      chartLabel: conciseRegionName(regionName(regionId)),
      p50Ms: stats?.p50Ms ?? null,
      p95Ms: stats?.p95Ms ?? null,
      p99Ms: stats?.p99Ms ?? null,
    };
  });
}

function conciseRegionName(name: string) {
  return name.replace(/\s*\([^)]*\)$/, '');
}

export function RequestTable({
  items,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  items: Observation[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
}) {
  return (
    <section className="history ut-panel">
      <div className="ut-panel__head">
        <div>
          <h2 className="ut-heading" style={{ margin: 0 }}>Exact requests</h2>
          <p className="ut-muted" style={{ margin: 0 }}>Each stored observation is retained for 90 days.</p>
          <p className="history__evidence-note ut-muted" style={{ fontSize: 'var(--text-body-sm-size)' }}>
            Provider headers are response-reported evidence. Workers do not expose the actual
            connected peer IP.
          </p>
        </div>
      </div>
      <div className="ut-panel__body">
        {items.length === 0 ? (
          <p className="empty-inline">No observations in this range.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Region</th>
                  <th>Result</th>
                  <th>Response</th>
                  <th>Total</th>
                  <th>HTTP</th>
                  <th>Error</th>
                  <th>Probe execution</th>
                  <th>Redirects / bytes</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const evidence = summarizeEndpointEvidence(item);
                  const evidenceSummary = evidence.provider
                    ? `${evidence.provider} · ${evidence.reportedEdge ?? 'edge unknown'}`
                    : (evidence.finalHostname ?? 'No endpoint details reported');
                  return (
                    <Fragment key={item.id}>
                      <tr>
                        <td data-label="Started">{new Date(item.startedAt).toLocaleString()}</td>
                        <td data-label="Region">{regionName(item.regionId)}</td>
                        <td data-label="Result">
                          <span className={`result result--${item.success ? 'success' : 'failure'}`}>
                            {item.status}
                          </span>
                        </td>
                        <td data-label="Response" className="tnum">
                          {formatLatency(item.responseMs)}
                        </td>
                        <td data-label="Total" className="tnum">
                          {formatLatency(item.totalMs)}
                        </td>
                        <td data-label="HTTP">{item.httpStatus ?? '—'}</td>
                        <td data-label="Error">
                          {[item.errorCode, item.errorDetail].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td data-label="Probe execution">
                          {[item.placement, item.colo].filter(Boolean).join(' / ') || '—'}
                        </td>
                        <td data-label="Redirects / bytes" className="tnum">
                          {item.redirectCount ?? '—'} / {item.bodyBytes ?? '—'}
                        </td>
                      </tr>
                      <tr className="history__evidence-row">
                        <td colSpan={9} data-label="Endpoint evidence">
                          <details className="history__evidence-disclosure">
                            <summary>
                              Endpoint evidence <span>{evidenceSummary}</span>
                            </summary>
                            <EndpointEvidence item={item} />
                          </details>
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {hasMore && (
          <button
            className="button button--quiet history__more ut-btn ut-btn--secondary"
            disabled={loadingMore}
            onClick={() => void onLoadMore()}
            style={{ marginTop: 'var(--space-3)' }}
          >
            {loadingMore ? 'Loading…' : 'Load older requests'}
          </button>
        )}
      </div>
    </section>
  );
}

function DeleteDialog({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog ref={dialog} className="confirm ut-dialog" onCancel={onCancel} aria-labelledby="delete-title">
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void onConfirm().finally(() => setBusy(false));
        }}
      >
        <h2 id="delete-title" className="ut-heading">Delete {name}?</h2>
        <p className="ut-muted">
          This permanently removes the monitor and its retained observations. Type {name} to
          continue.
        </p>
        <label className="field ut-field">
          <span className="ut-label">Monitor name</span>
          <input className="ut-input" value={typed} onChange={(event) => setTyped(event.target.value)} />
        </label>
        <div className="form-actions ut-row" style={{ marginTop: 'var(--space-4)', justifyContent: 'flex-end' }}>
          <button type="button" className="button button--secondary ut-btn ut-btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="button button--danger ut-btn ut-btn--danger" disabled={typed !== name || busy}>
            {busy ? 'Deleting…' : 'Delete monitor'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function orderedRegions(ids: readonly RegionId[]) {
  const selected = new Set(ids);
  return regionIds.filter((region) => selected.has(region));
}

function regionName(id: RegionId | string) {
  return findRegion(id)?.label ?? `Unknown region (${id})`;
}

function regionColour(id: RegionId) {
  const token = findRegion(id)?.chartSeriesToken;
  return token ? `var(${token})` : 'var(--muted)';
}
