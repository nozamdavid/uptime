import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
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
import type { Observation } from '@uptime/contracts';
import { findRegion, regionIds, type RegionId } from '@uptime/regions';
import {
  api,
  type DnsDiagnosticRecord,
  type MonitorDetailResponse,
  type MonitorLatencyData,
  type PublicMonitorDetailResponse,
} from './api.js';
import { EndpointEvidence, summarizeEndpointEvidence } from './endpoint-evidence.js';
import { MonitorForm } from './monitor-form.js';

const ranges = ['1h', '24h', '7d', '30d'] as const;
export type LatencyRange = (typeof ranges)[number];
const dnsRanges = ['7d', '30d'] as const;

const latencyBucketLabels: Record<LatencyRange, string> = {
  '1h': '5 minutes',
  '24h': '15 minutes',
  '7d': '1 hour',
  '30d': '6 hours',
};

export function latencyBucketLabel(range: LatencyRange) {
  return latencyBucketLabels[range];
}
export function showsPrivateMonitorData(publicMode: boolean) {
  return !publicMode;
}
export function MonitorDetail({
  monitorId,
  publicMode = false,
}: {
  monitorId: string;
  publicMode?: boolean;
}) {
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
  const [edit, setEdit] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const monitorDnsDiagnosticsEnabled = Boolean(
    data &&
    'dnsDiagnosticsEnabled' in data.summary.monitor &&
    data.summary.monitor.dnsDiagnosticsEnabled,
  );
  const load = () => {
    setData(null);
    setObservations(publicMode ? [] : null);
    setDnsDiagnostics(null);
    setDnsNextCursor(null);
    setDnsError('');
    setError('');
    const detail = publicMode ? api.publicMonitor(monitorId, range) : api.monitor(monitorId, range);
    const history = publicMode
      ? Promise.resolve({ items: [] as Observation[], nextCursor: null })
      : api.observations(monitorId, range);
    Promise.all([detail, history])
      .then(([detail, history]) => {
        setData(detail);
        setObservations(history.items);
        setNextCursor(history.nextCursor);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : 'Could not load monitor details.'),
      );
  };
  useEffect(load, [monitorId, publicMode, range]);
  useEffect(() => {
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
      />
    );
  if (error)
    return (
      <div className="state state--error" role="alert">
        <p>{error}</p>
        <button
          className="button button--quiet"
          onClick={() => {
            setError('');
            load();
          }}
        >
          Try again
        </button>
      </div>
    );
  if (!data || !observations)
    return (
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
  return (
    <section className="detail">
      <div className="page-head">
        <div>
          {!publicMode && (
            <a href="/" className="back-link">
              ← Monitors
            </a>
          )}
          <p className="mono-label">{status.toUpperCase()}</p>
          <h1>{monitor.name ?? new URL(monitor.url).hostname}</h1>
          <p>
            <a href={monitor.url} target="_blank" rel="noreferrer">
              {monitor.url}
            </a>
          </p>
        </div>
        {!publicMode && (
          <div className="page-head__actions">
            <button className="button button--quiet" onClick={() => setEdit(true)}>
              Edit
            </button>
            <button className="button button--danger" onClick={() => setDeleteOpen(true)}>
              Delete
            </button>
          </div>
        )}
      </div>
      {!publicMode && monitor.isPublic && <PublicShareLink monitorId={monitorId} />}
      <div className="range-tabs" role="tablist" aria-label="Latency time range">
        {ranges.map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={range === item}
            className={range === item ? 'is-active' : ''}
            onClick={() => setRange(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <section className="stat-strip">
        {data.latency.stats.map((stat) => (
          <div key={stat.regionId}>
            <span>{regionName(stat.regionId)}</span>
            <dl className="region-stats tnum">
              <div>
                <dt>p50</dt>
                <dd>{formatMs(stat.p50Ms)}</dd>
              </div>
              <div>
                <dt>p95</dt>
                <dd>{formatMs(stat.p95Ms)}</dd>
              </div>
              <div>
                <dt>p99</dt>
                <dd>{formatMs(stat.p99Ms)}</dd>
              </div>
            </dl>
            <small>
              {stat.successCount}/{stat.sampleCount} successful requests
            </small>
          </div>
        ))}
      </section>
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
      <ResponseLatencyChart data={data} chartRegions={chartRegions} range={range} />
      <LatencyPercentileChart data={data} chartRegions={chartRegions} />
      {showsPrivateMonitorData(publicMode) && (
        <RequestTable
          items={observations}
          hasMore={nextCursor !== null}
          loadingMore={loadingMore}
          onLoadMore={async () => {
            if (!nextCursor) return;
            setLoadingMore(true);
            try {
              const page = await api.observations(monitorId, range, nextCursor);
              setObservations((current) => [...(current ?? []), ...page.items]);
              setNextCursor(page.nextCursor);
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : 'Could not load more requests.');
            } finally {
              setLoadingMore(false);
            }
          }}
        />
      )}
      {showsPrivateMonitorData(publicMode) && (
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
            setDnsLoadingMore(true);
            try {
              const page = await api.dnsDiagnostics(
                monitorId,
                dnsRange,
                dnsRegion === 'all' ? undefined : dnsRegion,
                dnsNextCursor,
              );
              setDnsDiagnostics((current) => [...(current ?? []), ...page.items]);
              setDnsNextCursor(page.nextCursor);
            } catch (reason) {
              setDnsError(
                reason instanceof Error ? reason.message : 'Could not load more DNS diagnostics.',
              );
            } finally {
              setDnsLoadingMore(false);
            }
          }}
        />
      )}
      {showsPrivateMonitorData(publicMode) && deleteOpen && (
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

function PublicShareLink({ monitorId }: { monitorId: string }) {
  const url = `${window.location.origin}/monitors/public/${monitorId}`;
  const [copied, setCopied] = useState(false);
  return (
    <aside className="estimate estimate--secondary public-share" aria-label="Public share link">
      <span className="mono-label">PUBLIC VIEW</span>
      <a href={url} target="_blank" rel="noreferrer">
        {url}
      </a>
      <div className="form-actions">
        <button
          type="button"
          className="button button--quiet"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <a className="button button--quiet" href={url} target="_blank" rel="noreferrer">
          Open public view
        </a>
      </div>
    </aside>
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
  const [hiddenChartRegions, setHiddenChartRegions] = useState<ReadonlySet<RegionId>>(new Set());
  const chart = toChart(data);
  const bucketLabel = latencyBucketLabel(range);
  return (
    <section className="chart-section">
      <div>
        <h2>Response latency</h2>
        <p>
          Each point is the average response-to-headers latency for a region, grouped every{' '}
          {bucketLabel} in the selected range. Missing buckets are not interpolated.
        </p>
      </div>
      <div className="chart" role="img" aria-label="Regional response latency chart">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chart} margin={{ top: 8, right: 16, left: 0, bottom: 16 }}>
            <XAxis
              dataKey="time"
              stroke="var(--color-rule-strong)"
              tick={{ fill: 'var(--color-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
              tickFormatter={formatChartDate}
              angle={-40}
              textAnchor="end"
              height={62}
              minTickGap={24}
              interval="preserveStartEnd"
            />
            <YAxis
              unit=" ms"
              stroke="var(--color-rule-strong)"
              tick={{ fill: 'var(--color-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--color-paper)',
                borderColor: 'var(--color-rule-strong)',
                color: 'var(--color-ink)',
              }}
              cursor={{ stroke: 'var(--color-rule-strong)' }}
              labelFormatter={formatChartTooltipDate}
              formatter={formatResponseLatencyTooltip}
            />
            {chartRegions.map((region) => (
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
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="sr-only">
        <table>
          <caption>
            Text alternative for the regional response latency chart. Each row is a per-region
            average, grouped every {bucketLabel} in the selected range.
          </caption>
          <thead>
            <tr>
              <th>Bucket</th>
              <th>Region</th>
              <th>Average response latency</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {data.latency.points.map((point) => (
              <tr key={`${point.observedAt}-${point.regionId}`}>
                <td>{new Date(point.observedAt).toLocaleString()}</td>
                <td>{regionName(point.regionId)}</td>
                <td>{formatMs(point.responseMs)}</td>
                <td>{point.success ? 'Successful' : 'Failed'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="chart-legend">
        {chartRegions.map((region) => (
          <button
            key={region}
            type="button"
            className={hiddenChartRegions.has(region) ? 'is-hidden' : ''}
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
            <i aria-hidden="true" style={{ background: regionColour(region) }} />
            {regionName(region)}
          </button>
        ))}
      </div>
    </section>
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
  return (
    <section
      className="chart-section percentile-chart-section"
      aria-labelledby="latency-percentiles-title"
    >
      <div>
        <h2 id="latency-percentiles-title">Latency percentiles</h2>
        <p>
          Typical response latency by region. P50 is the midpoint; P95 and P99 show the slower end
          of successful requests in this range.
        </p>
      </div>
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
              stroke="var(--color-rule-strong)"
              tick={{ fill: 'var(--color-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            />
            <YAxis
              dataKey="chartLabel"
              type="category"
              width={112}
              interval={0}
              stroke="var(--color-rule-strong)"
              tick={{ fill: 'var(--color-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--color-paper)',
                borderColor: 'var(--color-rule-strong)',
                color: 'var(--color-ink)',
              }}
              cursor={{ fill: 'var(--color-paper-muted)' }}
              formatter={(value) => (typeof value === 'number' ? formatMs(value) : '—')}
            />
            <Bar dataKey="p50Ms" name="P50 (median)" fill="var(--region-series-1)" />
            <Bar dataKey="p95Ms" name="P95" fill="var(--region-series-2)" />
            <Bar dataKey="p99Ms" name="P99" fill="var(--region-series-3)" />
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
                <td>{formatMs(region.p50Ms)}</td>
                <td>{formatMs(region.p95Ms)}</td>
                <td>{formatMs(region.p99Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="chart-legend percentile-chart-legend" aria-label="Latency percentile legend">
        <span>
          <i aria-hidden="true" className="percentile-chart-legend__p50" />
          P50 (median)
        </span>
        <span>
          <i aria-hidden="true" className="percentile-chart-legend__p95" />
          P95
        </span>
        <span>
          <i aria-hidden="true" className="percentile-chart-legend__p99" />
          P99
        </span>
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
    <section className="history dns-history" aria-labelledby="dns-diagnostics-title">
      <div>
        <h2 id="dns-diagnostics-title">DNS diagnostics</h2>
        <p>Daily DNS candidate snapshots are stored separately from latency and request history.</p>
        <p className="history__evidence-note">
          DNS candidates — not the connected HTTP peer. They help inspect DNS responses; they make
          no geography claim.
        </p>
      </div>
      {!enabled ? (
        <p className="empty-inline">
          DNS diagnostics are disabled for this monitor. Enable <em>Collect DNS diagnostics</em> in
          monitor settings to capture one snapshot per day in each selected region.
        </p>
      ) : (
        <>
          <div className="diagnostic-filters" aria-label="DNS diagnostics filters">
            <label className="field">
              <span>History range</span>
              <select
                value={range}
                onChange={(event) =>
                  onRangeChange(event.target.value as (typeof dnsRanges)[number])
                }
              >
                {dnsRanges.map((item) => (
                  <option key={item} value={item}>
                    Last {item}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Region</span>
              <select
                value={region}
                onChange={(event) => onRegionChange(event.target.value as RegionId | 'all')}
              >
                <option value="all">All selected regions</option>
                {monitorRegions.map((item) => (
                  <option key={item} value={item}>
                    {regionName(item)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error ? (
            <div className="state state--error" role="alert">
              <p>{error}</p>
              <button className="button button--quiet" onClick={onRetry}>
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
              className="button button--quiet history__more"
              disabled={loadingMore}
              onClick={() => void onLoadMore()}
            >
              {loadingMore ? 'Loading…' : 'Load older DNS snapshots'}
            </button>
          )}
        </>
      )}
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
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  }).format(parsed);
}
function formatChartTooltipDate(value: ReactNode) {
  if (typeof value === 'string') return formatUtc(value);
  if (typeof value === 'number') return String(value);
  return '';
}
export function formatResponseLatencyTooltip(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Number(value.toFixed(2))}ms`;
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
    <section className="history">
      <div>
        <h2>Exact requests</h2>
        <p>Each stored observation is retained for 90 days.</p>
        <p className="history__evidence-note">
          Provider headers are response-reported evidence. Workers do not expose the actual
          connected peer IP.
        </p>
      </div>
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
                        {formatMs(item.responseMs)}
                      </td>
                      <td data-label="Total" className="tnum">
                        {formatMs(item.totalMs)}
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
          className="button button--quiet history__more"
          disabled={loadingMore}
          onClick={() => void onLoadMore()}
        >
          {loadingMore ? 'Loading…' : 'Load older requests'}
        </button>
      )}
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
    <dialog ref={dialog} className="confirm" onCancel={onCancel} aria-labelledby="delete-title">
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void onConfirm().finally(() => setBusy(false));
        }}
      >
        <h2 id="delete-title">Delete monitor?</h2>
        <p>
          This permanently removes the monitor and its retained observations. Type the monitor name
          to continue.
        </p>
        <label className="field">
          <span>Monitor name</span>
          <input value={typed} onChange={(event) => setTyped(event.target.value)} />
        </label>
        <div className="form-actions">
          <button type="button" className="button button--quiet" onClick={onCancel}>
            Cancel
          </button>
          <button className="button button--danger" disabled={typed !== name || busy}>
            {busy ? 'Deleting…' : 'Delete monitor'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function formatMs(value: number | null) {
  return value === null ? '—' : `${Math.round(value)} ms`;
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
  return token ? `var(${token})` : 'var(--color-muted)';
}
