import { useEffect, useState } from 'react';
import {
  intervalSecondsValues,
  type Badge,
  type IntervalSeconds,
  type MonitorSummary,
} from '@uptime/contracts';
import { regions, type RegionId } from '@uptime/regions';

import { api } from './api.js';
import { MonitorBadge } from './monitor-badge.js';
import { formatInterval, monitorDisplayName } from './monitor-format.js';
import {
  sortMonitorSummaries,
  type MonitorSortDirection,
  type MonitorSortKey,
} from './monitor-list-sort.js';

const sortOptions: Array<{ key: MonitorSortKey; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'frequency', label: 'Check frequency' },
  { key: 'regions', label: 'Regions' },
  { key: 'requests', label: 'Requests/day' },
];

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
  const [bulkBadgeId, setBulkBadgeId] = useState('');
  const [nameFilter, setNameFilter] = useState('');
  const [badgeFilter, setBadgeFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void api
      .badges()
      .then((result) => setBadges(Array.isArray(result.badges) ? result.badges : []))
      .catch(() => setBadges([]));
  }, []);
  const filtered = items.filter((item) => {
    const name = `${item.monitor.name ?? ''} ${item.monitor.url}`.toLocaleLowerCase();
    return (
      name.includes(nameFilter.trim().toLocaleLowerCase()) &&
      (!badgeFilter || item.monitor.badge?.id === badgeFilter) &&
      (!regionFilter || item.monitor.regionIds.includes(regionFilter as RegionId))
    );
  });
  const shown = sort ? sortMonitorSummaries(filtered, sort.key, sort.direction) : filtered;
  const allSelected = selectedIds.size === items.length;

  function selectSort(key: MonitorSortKey) {
    setSort((current) => ({
      key,
      direction:
        current?.key === key && current.direction === 'ascending' ? 'descending' : 'ascending',
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
    setError('');
  }

  async function applyUpdate(update: () => Promise<unknown>) {
    if (selectedIds.size === 0) return;
    setBusy(true);
    setError('');
    try {
      await update();
      closeBulkEditor();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update monitors');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="monitor-list-toolbar">
        <nav className="monitor-sort" aria-label="Sort monitors">
          <span>Sort by</span>
          {sortOptions.map((option) => {
            const selected = sort?.key === option.key;
            return (
              <button
                type="button"
                key={option.key}
                aria-pressed={selected}
                onClick={() => selectSort(option.key)}
              >
                {option.label}
                {selected && (
                  <span aria-hidden="true">{sort.direction === 'ascending' ? ' ↑' : ' ↓'}</span>
                )}
              </button>
            );
          })}
        </nav>
        {!bulkEditing && (
          <button
            className="button button--quiet"
            type="button"
            onClick={() => setBulkEditing(true)}
          >
            Edit multiple
          </button>
        )}
      </div>

      <section className="monitor-filters" aria-label="Filter monitors">
        <label className="field">
          <span>Name</span>
          <input
            type="search"
            value={nameFilter}
            placeholder="Filter by name or URL"
            onChange={(event) => setNameFilter(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Badge</span>
          <select value={badgeFilter} onChange={(event) => setBadgeFilter(event.target.value)}>
            <option value="">All badges</option>
            {badges.map((badge) => (
              <option value={badge.id} key={badge.id}>
                {badge.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Region</span>
          <select value={regionFilter} onChange={(event) => setRegionFilter(event.target.value)}>
            <option value="">All regions</option>
            {regions.map((region) => (
              <option value={region.id} key={region.id}>
                {region.label}
              </option>
            ))}
          </select>
        </label>
        {(nameFilter || badgeFilter || regionFilter) && (
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              setNameFilter('');
              setBadgeFilter('');
              setRegionFilter('');
            }}
          >
            Clear filters
          </button>
        )}
      </section>

      {bulkEditing && (
        <section className="bulk-monitor-editor" aria-label="Edit selected monitors">
          <label className="bulk-monitor-editor__select-all">
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
            Select all
          </label>
          <label className="field bulk-monitor-editor__frequency">
            <span>Check frequency</span>
            <select
              value={intervalSeconds}
              disabled={busy}
              onChange={(event) =>
                setIntervalSeconds(Number(event.target.value) as IntervalSeconds)
              }
            >
              {intervalSecondsValues.map((seconds) => (
                <option key={seconds} value={seconds}>
                  Every {formatInterval(seconds)}
                </option>
              ))}
            </select>
          </label>
          <label className="field bulk-monitor-editor__badge">
            <span>Badge</span>
            <select
              value={bulkBadgeId}
              disabled={busy}
              onChange={(event) => setBulkBadgeId(event.target.value)}
            >
              <option value="">No badge</option>
              {badges.map((badge) => (
                <option value={badge.id} key={badge.id}>
                  {badge.name}
                </option>
              ))}
            </select>
          </label>
          <div className="bulk-monitor-editor__actions">
            <button
              className="button button--primary"
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
              {busy ? 'Saving…' : `Apply to ${selectedIds.size} selected`}
            </button>
            <button
              className="button button--quiet"
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
              {busy ? 'Saving…' : `Apply badge to ${selectedIds.size} selected`}
            </button>
            <button
              className="button button--quiet"
              type="button"
              disabled={busy}
              onClick={closeBulkEditor}
            >
              Cancel
            </button>
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}

      <div className="monitor-list" aria-live="polite">
        {shown.map((item) => {
          const name = monitorDisplayName(item.monitor);
          return (
            <div
              className={`monitor-row-shell${bulkEditing ? ' monitor-row-shell--selectable' : ''}`}
              key={item.monitor.id}
            >
              {bulkEditing && (
                <input
                  className="monitor-row__select"
                  type="checkbox"
                  checked={selectedIds.has(item.monitor.id)}
                  aria-label={`Select ${name}`}
                  onChange={(event) =>
                    toggleMonitor(
                      item.monitor.id,
                      event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey,
                    )
                  }
                />
              )}
              <a className="monitor-row" href={`/monitors/${item.monitor.id}`}>
                <span
                  className={`status-dot status-dot--${item.status}`}
                  role="img"
                  aria-label={item.status}
                />
                <span className="monitor-row__identity">
                  <span className="monitor-row__name">
                    <strong>{name}</strong>
                    <MonitorBadge badge={item.monitor.badge} />
                  </span>
                  <small>{item.monitor.url}</small>
                </span>
                <span className="monitor-row__schedule">
                  {formatInterval(item.monitor.intervalSeconds)} · {item.monitor.timeoutMs / 1000}s
                  timeout
                </span>
                <span className="monitor-row__regions">
                  {item.monitor.regionIds.length} region
                  {item.monitor.regionIds.length === 1 ? '' : 's'}
                </span>
                <span className="tnum">{item.targetChecksPerDay.toLocaleString()} / day</span>
              </a>
            </div>
          );
        })}
        {shown.length === 0 && <p className="empty-inline">No monitors match these filters.</p>}
      </div>
    </div>
  );
}
