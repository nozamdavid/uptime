import { useEffect, useState } from "react";
import {
  intervalSecondsValues,
  type Badge,
  type IntervalSeconds,
  type MonitorSummary,
  type MonitorMetrics,
} from "@uptime/contracts";
import { regions, type RegionId } from "@uptime/regions";

import { api, productWorkspaceId, type UptimeDay } from "./api.js";
import { AppLink } from "./app-link.js";
import { MonitorBadge } from "./monitor-badge.js";
import { Select } from "./select.js";
import { formatInterval, monitorDisplayName } from "./monitor-format.js";
import {
  defaultMonitorSort,
  sortMonitorSummaries,
  type MonitorSortDirection,
  type MonitorSortKey,
} from "./monitor-list-sort.js";
import { UptimeStrip } from "./uptime-strip.js";
import "./monitor-design.css";

const boardColumns: Array<{ label: string; sortKey?: MonitorSortKey; numeric?: boolean }> = [
  { label: "Status", sortKey: "status" },
  { label: "Monitor", sortKey: "name" },
  { label: "Frequency", sortKey: "frequency" },
  { label: "Regions", sortKey: "regions" },
  { label: "Requests/day", sortKey: "requests", numeric: true },
  { label: "30 days" },
  { label: "24h", numeric: true },
  { label: "p50", numeric: true },
];

export interface RowMetrics {
  days: UptimeDay[] | null;
  uptime24h: number | null;
  p50Ms: number | null;
  loading: boolean;
  error: string | null;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  metrics: Promise<Record<string, MonitorMetrics>>;
  timestamp: number;
  fingerprint: string;
}

const rowMetricsCache = new Map<string, CacheEntry>();

export function clearRowMetricsCache() {
  rowMetricsCache.clear();
}

function getFingerprint(item: MonitorSummary): string {
  return `${item.monitor.id}:${item.monitor.updatedAt}:${JSON.stringify(item.latestByRegion)}`;
}

function fetchListMetrics(
  cacheKey: string,
  fingerprint: string,
): Promise<Record<string, MonitorMetrics>> {
  const entry = rowMetricsCache.get(cacheKey);
  if (entry && Date.now() - entry.timestamp <= CACHE_TTL_MS && entry.fingerprint === fingerprint) {
    return entry.metrics;
  }
  const metrics = api.monitorMetrics().catch((error: unknown) => {
    if (rowMetricsCache.get(cacheKey)?.metrics === metrics) rowMetricsCache.delete(cacheKey);
    throw error;
  });
  rowMetricsCache.set(cacheKey, { metrics, timestamp: Date.now(), fingerprint });
  return metrics;
}

export function MonitorList({
  items,
  onChanged,
}: {
  items: MonitorSummary[];
  onChanged: () => void;
}) {
  const [sort, setSort] = useState<{
    key: MonitorSortKey;
    direction: MonitorSortDirection;
  } | null>(null);
  const [bulkEditing, setBulkEditing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [intervalSeconds, setIntervalSeconds] = useState<IntervalSeconds>(300);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [bulkBadgeId, setBulkBadgeId] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [badgeFilter, setBadgeFilter] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [metrics, setMetrics] = useState<Record<string, MonitorMetrics>>({});
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const workspaceId = productWorkspaceId() ?? "";
  const fingerprint = items.map(getFingerprint).sort().join("|");

  useEffect(() => {
    let active = true;
    setMetrics({});
    setMetricsLoading(true);
    setMetricsError(null);
    if (!fingerprint) {
      setMetricsLoading(false);
      return;
    }
    void fetchListMetrics(workspaceId, fingerprint)
      .then((data) => {
        if (!active) return;
        setMetrics(data);
        setMetricsLoading(false);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setMetricsError(reason instanceof Error ? reason.message : "Metrics unavailable");
        setMetricsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, fingerprint, items]);

  useEffect(() => {
    void api
      .badges()
      .then((result) => setBadges(Array.isArray(result.badges) ? result.badges : []))
      .catch(() => setBadges([]));
  }, []);

  const filtered = items.filter((item) => {
    const name = `${item.monitor.name ?? ""} ${item.monitor.url}`.toLocaleLowerCase();
    return (
      name.includes(nameFilter.trim().toLocaleLowerCase()) &&
      (!badgeFilter || item.monitor.badge?.id === badgeFilter) &&
      (!regionFilter || item.monitor.regionIds.includes(regionFilter as RegionId))
    );
  });

  const shown = sort
    ? sortMonitorSummaries(filtered, sort.key, sort.direction)
    : defaultMonitorSort(filtered);

  const allSelected = selectedIds.size === items.length && items.length > 0;

  function selectSort(key: MonitorSortKey) {
    setSort((current) => ({
      key,
      direction:
        current?.key === key && current.direction === "ascending" ? "descending" : "ascending",
    }));
  }

  function toggleMonitor(id: string, shiftKey: boolean) {
    const shouldSelect = !selectedIds.has(id);
    setSelectedIds((current) => {
      const next = new Set(current);
      const anchorIndex = selectionAnchorId
        ? shown.findIndex((item) => item.monitor.id === selectionAnchorId)
        : -1;
      const targetIndex = shown.findIndex((item) => item.monitor.id === id);
      if (shiftKey && anchorIndex >= 0 && targetIndex >= 0) {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        for (const item of shown.slice(start, end + 1)) {
          if (shouldSelect) next.add(item.monitor.id);
          else next.delete(item.monitor.id);
        }
      } else if (shouldSelect) next.add(id);
      else next.delete(id);
      return next;
    });
    if (shouldSelect) setSelectionAnchorId(id);
  }

  function closeBulkEditor() {
    setBulkEditing(false);
    setSelectedIds(new Set());
    setSelectionAnchorId(null);
    setError("");
  }

  async function applyUpdate(update: () => Promise<unknown>) {
    if (selectedIds.size === 0) return;
    setBusy(true);
    setError("");
    try {
      await update();
      rowMetricsCache.clear();
      closeBulkEditor();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update monitors");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {/* Filter row: search, region and badge */}
      <div className="monitor-list-toolbar ut-row">
        <section
          className="monitor-filters ut-row"
          aria-label="Filter monitors"
          style={{ flex: "1 1 auto" }}
        >
          <label className="field ut-field">
            <span className="sr-only">Name</span>
            <input
              type="search"
              className="ut-input"
              value={nameFilter}
              placeholder="Filter by name or URL"
              onChange={(event) => setNameFilter(event.target.value)}
            />
          </label>
          <div className="field ut-field">
            <Select
              prefix="Badge"
              value={badgeFilter}
              onChange={setBadgeFilter}
              options={[
                { value: "", label: "All badges" },
                ...badges.map((badge) => ({ value: badge.id, label: badge.name })),
              ]}
            />
          </div>
          <div className="field ut-field">
            <Select
              prefix="Region"
              value={regionFilter}
              onChange={setRegionFilter}
              options={[
                { value: "", label: "All regions" },
                ...regions.map((region) => ({ value: region.id, label: region.label })),
              ]}
            />
          </div>
          {(nameFilter || badgeFilter || regionFilter) && (
            <button
              type="button"
              className="button button--quiet ut-btn ut-btn--quiet"
              onClick={() => {
                setNameFilter("");
                setBadgeFilter("");
                setRegionFilter("");
              }}
            >
              Clear filters
            </button>
          )}
        </section>

        {!bulkEditing && (
          <button
            className="button button--quiet ut-btn ut-btn--secondary"
            type="button"
            onClick={() => setBulkEditing(true)}
          >
            Edit multiple
          </button>
        )}
      </div>

      {bulkEditing && (
        <section
          className="bulk-monitor-editor ut-panel"
          style={{ marginBottom: "var(--space-6)", padding: "var(--space-4)" }}
          aria-label="Edit selected monitors"
        >
          <label className="bulk-monitor-editor__select-all ut-row">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => {
                setSelectionAnchorId(null);
                setSelectedIds(
                  allSelected ? new Set() : new Set(items.map((item) => item.monitor.id)),
                );
              }}
            />
            <span>Select all</span>
          </label>
          <div className="ut-row" style={{ marginTop: "var(--space-2)" }}>
            <div className="field bulk-monitor-editor__frequency ut-field">
              <label className="ut-label" htmlFor="bulk-monitor-frequency">
                Check frequency
              </label>
              <Select
                id="bulk-monitor-frequency"
                value={String(intervalSeconds)}
                disabled={busy}
                onChange={(next) => setIntervalSeconds(Number(next) as IntervalSeconds)}
                options={intervalSecondsValues.map((seconds) => ({
                  value: String(seconds),
                  label: `Every ${formatInterval(seconds)}`,
                }))}
              />
            </div>
            <div className="field bulk-monitor-editor__badge ut-field">
              <label className="ut-label" htmlFor="bulk-monitor-badge">
                Badge
              </label>
              <Select
                id="bulk-monitor-badge"
                value={bulkBadgeId}
                disabled={busy}
                onChange={setBulkBadgeId}
                options={[
                  { value: "", label: "No badge" },
                  ...badges.map((badge) => ({ value: badge.id, label: badge.name })),
                ]}
              />
            </div>
          </div>
          <div className="bulk-monitor-editor__actions ut-row" style={{ marginTop: "var(--space-3)" }}>
            <button
              className="button button--primary ut-btn ut-btn--primary"
              type="button"
              disabled={busy || selectedIds.size === 0}
              onClick={() =>
                void applyUpdate(() =>
                  api.updateMonitorFrequencies({
                    monitorIds: [...selectedIds],
                    intervalSeconds,
                  }),
                )
              }
            >
              {busy ? "Saving…" : `Apply to ${selectedIds.size} selected`}
            </button>
            <button
              className="button button--primary ut-btn ut-btn--secondary"
              type="button"
              disabled={busy || selectedIds.size === 0}
              onClick={() =>
                void applyUpdate(() =>
                  api.updateMonitorBadges({
                    monitorIds: [...selectedIds],
                    badgeId: bulkBadgeId || null,
                  }),
                )
              }
            >
              {busy ? "Saving…" : `Apply badge to ${selectedIds.size} selected`}
            </button>
            <button
              className="button button--quiet ut-btn ut-btn--quiet"
              type="button"
              disabled={busy}
              onClick={closeBulkEditor}
            >
              Cancel
            </button>
          </div>
          {error && (
            <p className="field-error ut-field__error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}

      {/* The Board */}
      <div className="ut-board monitor-list" aria-live="polite">
        <div className="ut-board__head" aria-label="Monitor columns">
          {boardColumns.map((column) => {
            const numeric = column.numeric ? " ut-num" : "";
            if (!column.sortKey) {
              return (
                <span
                  key={column.label}
                  className={`ut-label ut-board__column${numeric}`}
                >
                  {column.label}
                </span>
              );
            }
            // With no explicit choice the board keeps its default order: status, then name.
            const sortKey = column.sortKey;
            const active = sort ? sort.key === sortKey : sortKey === "status";
            const direction = sort?.direction ?? "ascending";
            return (
              <span
                key={column.label}
                className={`ut-board__column ut-board__column--sortable${numeric}`}
              >
                <button
                  type="button"
                  className="ut-label ut-board__sort"
                  onClick={() => selectSort(sortKey)}
                >
                  {column.label}
                  <svg
                    className={`ut-board__sort-icon${active ? " is-active" : ""}`}
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                  >
                    {active ? (
                      <path d={direction === "ascending" ? "M3 7.5l3-3 3 3" : "M3 4.5l3 3 3-3"} />
                    ) : (
                      <path d="M3.5 5L6 2.5 8.5 5M3.5 7L6 9.5 8.5 7" />
                    )}
                  </svg>
                  {active && <span className="sr-only">, sorted {direction}</span>}
                </button>
              </span>
            );
          })}
        </div>

        {shown.map((item) => (
          <MonitorRowItem
            key={item.monitor.id}
            item={item}
            metrics={{
              days: metrics[item.monitor.id]?.days ?? null,
              uptime24h: metrics[item.monitor.id]?.uptime24h ?? null,
              p50Ms: metrics[item.monitor.id]?.p50Ms ?? null,
              loading: metricsLoading,
              error: metricsError,
            }}
            bulkEditing={bulkEditing}
            isSelected={selectedIds.has(item.monitor.id)}
            onToggle={(shiftKey) => toggleMonitor(item.monitor.id, shiftKey)}
          />
        ))}

        {shown.length === 0 && (
          <p className="empty-inline" style={{ padding: "var(--space-4)" }}>
            No monitors match these filters.
          </p>
        )}
      </div>
    </div>
  );
}

function MonitorRowItem({
  item,
  metrics,
  bulkEditing,
  isSelected,
  onToggle,
}: {
  item: MonitorSummary;
  metrics: RowMetrics;
  bulkEditing: boolean;
  isSelected: boolean;
  onToggle: (shiftKey: boolean) => void;
}) {
  const name = monitorDisplayName(item.monitor);
  const effectiveStatus = !item.monitor.enabled ? "paused" : item.status;
  const statusWord =
    effectiveStatus === "paused"
      ? "Paused"
      : effectiveStatus === "up"
        ? "Up"
        : effectiveStatus === "degraded"
          ? "Degraded"
          : effectiveStatus === "down"
            ? "Down"
            : "No data";

  return (
    <div
      className={`ut-board__row-shell monitor-row-shell${
        bulkEditing ? " monitor-row-shell--selectable" : ""
      }`}
    >
      {bulkEditing && (
        <input
          className="monitor-row__select"
          type="checkbox"
          checked={isSelected}
          aria-label={`Select ${name}`}
          onChange={(event) =>
            onToggle(event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey)
          }
        />
      )}
      <AppLink className="ut-monitor monitor-row" href={`/monitors/${item.monitor.id}`}>
        {/* 1. Status chip */}
        <div>
          <span
            className={`status-dot status-dot--${effectiveStatus}`}
            role="img"
            aria-label={statusWord}
            title={statusWord}
          />
        </div>

        {/* 2. Identity: name and badges; the URL shows on hover */}
        <div className="ut-monitor__identity monitor-row__identity" title={item.monitor.url}>
          <span className="ut-monitor__title monitor-row__name">
            <strong>{name}</strong>
            <MonitorBadge badge={item.monitor.badge} />
          </span>
        </div>

        <span className="ut-monitor__frequency ut-data">
          {formatInterval(item.monitor.intervalSeconds)}
        </span>

        {/* 3. Nine region dots in registry order */}
        <div>
          <span className="ut-monitor__mobile-label">Regions: </span>
          <span className="ut-dots" aria-label={formatDotsAriaLabel(item)}>
            {regions.map((region) => {
              const dot = getRegionDotState(item, region.id);
              return (
                <i
                  key={region.id}
                  className={`ut-glyph ut-glyph--${dot.status}`}
                  title={`${region.label}: ${dot.label}`}
                  aria-hidden="true"
                />
              );
            })}
          </span>
        </div>

        <span className="ut-monitor__requests ut-data ut-num">
          {item.targetChecksPerDay.toLocaleString()}
        </span>

        {/* 4. 30-day compact strip */}
        <div>
          {metrics.loading ? (
            <span className="ut-muted" aria-label="Loading history">
              Loading…
            </span>
          ) : metrics.days && metrics.days.length > 0 ? (
            <UptimeStrip
              compact
              days={metrics.days}
              label={`${name} 30-day uptime history`}
              thresholds={item.monitor.uptimeThresholds}
            />
          ) : (
            <span className="ut-muted" title={metrics.error ?? "History unavailable"}>
              —
            </span>
          )}
        </div>

        {/* 5. 24h uptime */}
        <div className="ut-monitor__metric ut-num">
          <span className="ut-data">
            {metrics.loading
              ? "—"
              : metrics.uptime24h !== null
                ? `${Math.round(metrics.uptime24h * 10) / 10}%`
                : "—"}
          </span>
        </div>

        {/* 6. p50 latency */}
        <div className="ut-monitor__metric ut-num">
          <span className="ut-data">
            {metrics.loading ? (
              "—"
            ) : metrics.p50Ms !== null ? (
              `${Math.round(metrics.p50Ms)} ms`
            ) : (
              <span
                className="ut-muted"
                title="Aggregate p50 is unavailable"
                aria-label="Aggregate p50 is unavailable"
              >
                —
              </span>
            )}
          </span>
        </div>
      </AppLink>
    </div>
  );
}

function getRegionDotState(
  item: MonitorSummary,
  regionId: RegionId,
): { status: "up" | "degraded" | "down" | "unknown"; label: string } {
  if (!item.monitor.enabled) {
    return { status: "unknown", label: "Monitor paused" };
  }
  if (!item.monitor.regionIds.includes(regionId)) {
    return { status: "unknown", label: "not selected" };
  }
  const obs = item.latestByRegion[regionId];
  if (!obs) {
    return { status: "unknown", label: "No data" };
  }
  if (obs.success) {
    return {
      status: "up",
      label: typeof obs.responseMs === "number" ? `${Math.round(obs.responseMs)} ms` : "Up",
    };
  }
  return {
    status: "down",
    label: obs.errorDetail ?? obs.errorCode ?? "Failed",
  };
}

function formatDotsAriaLabel(item: MonitorSummary): string {
  if (!item.monitor.enabled) {
    return "Monitor paused";
  }
  let up = 0;
  let down = 0;
  let unknown = 0;
  let notSelected = 0;
  for (const region of regions) {
    if (!item.monitor.regionIds.includes(region.id)) {
      notSelected += 1;
    } else {
      const obs = item.latestByRegion[region.id];
      if (!obs) unknown += 1;
      else if (obs.success) up += 1;
      else down += 1;
    }
  }
  return `${up} up, ${down} down, ${unknown} no data, ${notSelected} not selected`;
}
