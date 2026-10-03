import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  normalizePublicMonitorSlug,
  publicStatusPageSlugSchema,
  type MonitorSummary,
  type StatusPageSave,
} from '@uptime/contracts';

import { api, type PublicStatusPage as PublicStatusPageData } from './api.js';
import * as apiModule from './api.js';
import { useProductSession } from './product-shell.js';
import { publicReportsEnabled } from './config.js';
import { monitorDisplayName } from './monitor-format.js';
import { MonitorBadge } from './monitor-badge.js';
import {
  loadStatusPageReport,
  statusPageSnapshotToPage,
  type SnapshotFreshness as SnapshotFreshnessMetadata,
} from './reports.js';
import { ReportFreshness } from './report-freshness.js';
import { formatPercentage } from './status-page-format.js';
import { UptimeStrip, uptimeSeverity } from './uptime-strip.js';

interface EditorGroup {
  key: string;
  title: string;
  monitorIds: string[];
  collapsed: boolean;
  width: 'full' | 'half';
  showBadges: boolean;
}

type SortableMonitor = Pick<MonitorSummary['monitor'], 'name' | 'url'>;
function workspaceSearch(session: ReturnType<typeof useProductSession>) {
  try {
    const helper = apiModule.publicWorkspaceSearch;
    return typeof helper === 'function' ? helper(window.location.search, session) : '';
  } catch {
    return '';
  }
}
const monitorNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortMonitorIdsAlphabetically(
  monitorIds: readonly string[],
  monitorById: ReadonlyMap<string, SortableMonitor>,
): string[] {
  return [...monitorIds].sort((leftId, rightId) => {
    const left = monitorById.get(leftId);
    const right = monitorById.get(rightId);
    const leftLabel = left ? monitorDisplayName(left) : leftId;
    const rightLabel = right ? monitorDisplayName(right) : rightId;
    return (
      monitorNameCollator.compare(leftLabel, rightLabel) ||
      monitorNameCollator.compare(left?.url ?? leftId, right?.url ?? rightId) ||
      leftId.localeCompare(rightId)
    );
  });
}

export function StatusPagesIndex() {
  const session = useProductSession();
  const canWrite = !session?.user || session.role === 'owner' || session.role === 'maintainer';
  const [pages, setPages] = useState<Awaited<ReturnType<typeof api.statusPages>>['statusPages']>();
  const [error, setError] = useState('');
  useEffect(() => {
    void api
      .statusPages()
      .then((result) => setPages(result.statusPages))
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : 'Could not load pages'),
      );
  }, []);
  return (
    <section className="overview status-pages-index">
      <div className="page-head">
        <div>
          <p className="mono-label">PUBLIC COMMUNICATION</p>
          <h1>Status pages</h1>
          <p>Group monitors into a public, ninety-day service history.</p>
        </div>
        {canWrite && (
          <AppLink className="button button--primary" href="/status-pages/new">
            Add status page
          </AppLink>
        )}
      </div>
      {error ? (
        <p className="state state--error">{error}</p>
      ) : !pages ? (
        <p className="state state--loading">Loading status pages…</p>
      ) : pages.length === 0 ? (
        <p className="empty-inline">No status pages yet.</p>
      ) : (
        <div className="status-page-list">
          {pages.map((page) => (
            <div className="status-page-list__row" key={page.id}>
              <AppLink className="status-page-list__details" href={`/status-pages/${page.id}`}>
                <strong>{page.title}</strong>
                <span>{page.monitorCount} monitors</span>
                <small>Updated {new Date(page.updatedAt).toLocaleString()}</small>
              </AppLink>
              <a
                className="status-page-list__external"
                href={`/status/${page.publicSlug ?? page.id}${workspaceSearch(session)}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${page.title} public status page`}
                title="Open public status page"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M14 4h6v6M20 4l-9 9" />
                  <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
                </svg>
              </a>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function StatusPageEditor({ statusPageId }: { statusPageId: string }) {
  const session = useProductSession();
  const canWrite = !session?.user || session.role === 'owner' || session.role === 'maintainer';
  const creating = statusPageId === 'new';
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [publicSlug, setPublicSlug] = useState<string | null>(null);
  const [groups, setGroups] = useState<EditorGroup[]>([]);
  const [monitors, setMonitors] = useState<MonitorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setTitle('');
    setPublicSlug(null);
    setGroups([]);
    setMonitors([]);
    Promise.all([api.monitors(), creating ? Promise.resolve(null) : api.statusPage(statusPageId)])
      .then(([monitorResult, page]) => {
        if (!active) return;
        setMonitors(monitorResult.monitors);
        if (page && 'groups' in page) {
          setTitle(page.title);
          setPublicSlug(page.publicSlug);
          setGroups(
            page.groups.map((group) => ({
              key: group.id,
              title: group.title,
              monitorIds: group.monitors.map((monitor) => monitor.id),
              collapsed: false,
              width: group.width ?? 'full',
              showBadges: group.showBadges ?? true,
            })),
          );
        } else {
          setGroups([
            {
              key: crypto.randomUUID(),
              title: 'Services',
              monitorIds: [],
              collapsed: false,
              width: 'full',
              showBadges: true,
            },
          ]);
        }
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load page');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [creating, statusPageId]);
  const monitorById = useMemo(
    () => new Map(monitors.map((item) => [item.monitor.id, item.monitor])),
    [monitors],
  );
  const selected = new Set(groups.flatMap((group) => group.monitorIds));
  const available = monitors.filter((item) => !selected.has(item.monitor.id));
  const slugError = publicSlug
    ? (publicStatusPageSlugSchema.safeParse(publicSlug).error?.issues[0]?.message ?? '')
    : '';

  function moveGroup(source: number, target: number) {
    setGroups((current) => reorder(current, source, target));
  }
  function updateGroup(groupIndex: number, update: (group: EditorGroup) => EditorGroup) {
    setGroups((current) =>
      current.map((group, index) => (index === groupIndex ? update(group) : group)),
    );
  }
  function moveGroupBeside(source: number, target: number, side: 'left' | 'right') {
    if (source === target) return;
    setGroups((current) => {
      const moving = current[source];
      const targetGroup = current[target];
      if (!moving || !targetGroup) return current;
      const next = current.filter((_, index) => index !== source);
      const targetIndex = next.findIndex((group) => group.key === targetGroup.key);
      next.splice(targetIndex + (side === 'right' ? 1 : 0), 0, moving);
      return next.map((group) =>
        group.key === moving.key || group.key === targetGroup.key
          ? { ...group, width: 'half' as const }
          : group,
      );
    });
  }
  function moveMonitor(monitorId: string, targetGroup: number, targetPosition: number) {
    setGroups((current) => {
      const next = current.map((group) => ({ ...group, monitorIds: [...group.monitorIds] }));
      let sourceGroup = -1;
      let sourcePosition = -1;
      for (const [groupIndex, group] of next.entries()) {
        const index = group.monitorIds.indexOf(monitorId);
        if (index >= 0) {
          sourceGroup = groupIndex;
          sourcePosition = index;
          group.monitorIds.splice(index, 1);
        }
      }
      const adjustedPosition =
        sourceGroup === targetGroup && sourcePosition < targetPosition
          ? targetPosition - 1
          : targetPosition;
      next[targetGroup]?.monitorIds.splice(adjustedPosition, 0, monitorId);
      return next;
    });
  }
  function removeMonitor(monitorId: string) {
    setGroups((current) =>
      current.map((group) => ({
        ...group,
        monitorIds: group.monitorIds.filter((id) => id !== monitorId),
      })),
    );
  }
  function sortGroupAlphabetically(groupIndex: number) {
    updateGroup(groupIndex, (group) => ({
      ...group,
      monitorIds: sortMonitorIdsAlphabetically(group.monitorIds, monitorById),
    }));
  }
  function dragPayload(event: DragEvent, payload: object) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/json', JSON.stringify(payload));
  }
  function dropped(event: DragEvent, groupIndex: number, position?: number) {
    event.preventDefault();
    try {
      const payload = JSON.parse(event.dataTransfer.getData('application/json')) as {
        type: 'group' | 'monitor';
        index?: number;
        monitorId?: string;
      };
      if (payload.type === 'group' && payload.index !== undefined) {
        const bounds = event.currentTarget.getBoundingClientRect();
        const horizontalPosition = bounds.width
          ? (event.clientX - bounds.left) / bounds.width
          : 0.5;
        if (horizontalPosition < 0.33) moveGroupBeside(payload.index, groupIndex, 'left');
        else if (horizontalPosition > 0.67) moveGroupBeside(payload.index, groupIndex, 'right');
        else moveGroup(payload.index, groupIndex);
      }
      if (payload.type === 'monitor' && payload.monitorId)
        moveMonitor(
          payload.monitorId,
          groupIndex,
          position ?? groups[groupIndex]?.monitorIds.length ?? 0,
        );
    } catch {
      // Ignore unrelated drag payloads.
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const input: StatusPageSave = {
      title,
      publicSlug,
      groups: groups.map((group) => ({
        title: group.title,
        monitorIds: group.monitorIds,
        width: group.width,
        showBadges: group.showBadges,
      })),
    };
    try {
      const saved = creating
        ? await api.createStatusPage(input)
        : await api.updateStatusPage(statusPageId, input);
      void navigate({ to: '/status-pages/$statusPageId', params: { statusPageId: saved.id } });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save status page');
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <p className="state state--loading">Loading status page…</p>;
  return (
    <form className="status-page-editor" onSubmit={save}>
      <div className="page-head">
        <div>
          <p className="mono-label">STATUS PAGE EDITOR</p>
          <h1>{creating ? 'New status page' : title || 'Status page'}</h1>
          <p>
            Drag groups and monitors to set the public display order. Drop a group on another
            group’s left or right edge to place them in two columns.
          </p>
        </div>
        <div className="form-actions">
          {!creating && (
            <a
              className="button button--quiet"
              href={`/status/${publicSlug ?? statusPageId}${workspaceSearch(session)}`}
              target="_blank"
            >
              Open public page
            </a>
          )}
          {canWrite && (
            <button
              className="button button--primary"
              disabled={busy || !title.trim() || Boolean(slugError)}
            >
              {busy ? 'Saving…' : 'Save page'}
            </button>
          )}
        </div>
      </div>
      {error && <p className="state state--error">{error}</p>}
      <label className="field status-page-editor__title">
        <span>Page title</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={!canWrite || busy}
          maxLength={120}
          required
        />
      </label>
      <label className="field public-slug-field status-page-editor__slug">
        <span>
          Public URL slug <em>optional</em>
        </span>
        <span className="public-slug-field__input">
          <span aria-hidden="true">/status/</span>
          <input
            value={publicSlug ?? ''}
            placeholder={creating ? 'service-status' : statusPageId}
            disabled={!canWrite || busy}
            onBlur={() => {
              if (publicSlug) setPublicSlug(normalizePublicMonitorSlug(publicSlug));
            }}
            onChange={(event) => setPublicSlug(event.target.value || null)}
            aria-invalid={Boolean(slugError)}
            aria-describedby="status-page-slug-help"
          />
        </span>
        <small id="status-page-slug-help" className={slugError ? 'field-error' : ''}>
          {slugError ||
            'Uses lowercase letters, numbers, dots, and hyphens. Leave empty to use the page ID.'}
        </small>
      </label>
      <div className="status-page-editor__layout">
        <section className="status-page-editor__groups" aria-label="Status page groups">
          {groups.map((group, groupIndex) => (
            <article
              className={`status-group-editor status-group-editor--${group.width}${group.collapsed ? ' status-group-editor--collapsed' : ''}`}
              key={group.key}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropped(event, groupIndex)}
            >
              <div className="status-group-editor__head">
                <span
                  className="drag-handle"
                  draggable
                  title="Drag to reorder group"
                  onDragStart={(event) => dragPayload(event, { type: 'group', index: groupIndex })}
                >
                  ⠿
                </span>
                <input
                  aria-label="Group title"
                  value={group.title}
                  maxLength={120}
                  required
                  onChange={(event) =>
                    updateGroup(groupIndex, (item) => ({ ...item, title: event.target.value }))
                  }
                />
                <div className="status-group-editor__actions">
                  <button
                    type="button"
                    className="button button--quiet"
                    aria-pressed={group.showBadges}
                    aria-label={`${group.showBadges ? 'Hide' : 'Show'} badges in ${group.title || 'group'}`}
                    onClick={() =>
                      updateGroup(groupIndex, (item) => ({ ...item, showBadges: !item.showBadges }))
                    }
                  >
                    Badges {group.showBadges ? 'on' : 'off'}
                  </button>
                  <button
                    type="button"
                    className="button button--quiet"
                    aria-label={`Make ${group.title || 'group'} ${group.width === 'full' ? 'half width' : 'full width'}`}
                    onClick={() =>
                      updateGroup(groupIndex, (item) => ({
                        ...item,
                        width: item.width === 'full' ? 'half' : 'full',
                      }))
                    }
                  >
                    {group.width === 'full' ? '½ width' : 'Full width'}
                  </button>
                  <button
                    type="button"
                    className="button button--quiet"
                    aria-expanded={!group.collapsed}
                    aria-controls={`status-group-${group.key}-monitors`}
                    aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} ${group.title || 'group'}`}
                    onClick={() =>
                      updateGroup(groupIndex, (item) => ({ ...item, collapsed: !item.collapsed }))
                    }
                  >
                    {group.collapsed ? 'Expand' : 'Collapse'}
                  </button>
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={group.monitorIds.length < 2}
                    aria-label={`Sort monitors in ${group.title || 'group'} alphabetically`}
                    onClick={() => sortGroupAlphabetically(groupIndex)}
                  >
                    Sort A–Z
                  </button>
                  <button
                    type="button"
                    className="button button--quiet"
                    onClick={() =>
                      setGroups((current) => current.filter((_, index) => index !== groupIndex))
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div
                className="status-group-editor__monitors"
                id={`status-group-${group.key}-monitors`}
                hidden={group.collapsed}
              >
                {group.monitorIds.map((monitorId, position) => {
                  const monitor = monitorById.get(monitorId);
                  if (!monitor) return null;
                  return (
                    <div
                      className="status-monitor-editor"
                      key={monitorId}
                      draggable
                      onDragStart={(event) => dragPayload(event, { type: 'monitor', monitorId })}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.stopPropagation();
                        dropped(event, groupIndex, position);
                      }}
                    >
                      <span className="drag-handle" title="Drag to move monitor">
                        ⠿
                      </span>
                      <span>
                        <span className="monitor-row__name">
                          <strong>{monitorDisplayName(monitor)}</strong>
                          {group.showBadges && <MonitorBadge badge={monitor.badge} />}
                        </span>
                        <small>{monitor.url}</small>
                      </span>
                      <button
                        type="button"
                        onClick={() => removeMonitor(monitorId)}
                        aria-label={`Remove ${monitor.name ?? monitor.url}`}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                {group.monitorIds.length === 0 && <p>Drop monitors here</p>}
              </div>
            </article>
          ))}
          <button
            type="button"
            className="button button--quiet"
            onClick={() =>
              setGroups((current) => [
                ...current,
                {
                  key: crypto.randomUUID(),
                  title: `Group ${current.length + 1}`,
                  monitorIds: [],
                  collapsed: false,
                  width: 'full',
                  showBadges: true,
                },
              ])
            }
          >
            Add group
          </button>
        </section>
        <aside className="status-page-editor__available">
          <h2>Available monitors</h2>
          <p>Drag a monitor into a group. Included monitors become publicly viewable.</p>
          {available.map((item) => (
            <div
              className="status-monitor-editor"
              key={item.monitor.id}
              draggable
              onDragStart={(event) =>
                dragPayload(event, { type: 'monitor', monitorId: item.monitor.id })
              }
            >
              <span className="drag-handle" title="Drag to add monitor">
                ⠿
              </span>
              <span>
                <span className="monitor-row__name">
                  <strong>{monitorDisplayName(item.monitor)}</strong>
                  <MonitorBadge badge={item.monitor.badge} />
                </span>
                <small>{item.monitor.url}</small>
              </span>
            </div>
          ))}
          {available.length === 0 && <p className="empty-inline">All monitors are assigned.</p>}
        </aside>
      </div>
    </form>
  );
}

export const statusPageRefreshIntervalMs = 60_000;

export function PublicStatusPage({ statusPageId }: { statusPageId: string }) {
  const [loadedPage, setLoadedPage] = useState<{
    reference: string;
    page: PublicStatusPageData;
    snapshot: SnapshotFreshnessMetadata | null;
  }>();
  const currentPage = loadedPage?.reference === statusPageId ? loadedPage : undefined;
  const page = currentPage?.page;
  const snapshotMetadata = currentPage?.snapshot ?? null;
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const refreshGeneration = useRef(0);
  const inFlightRefresh = useRef<{ pageId: string; promise: Promise<void> } | null>(null);
  const refreshPage = useCallback(() => {
    if (inFlightRefresh.current?.pageId === statusPageId) {
      return inFlightRefresh.current.promise;
    }
    const generation = ++refreshGeneration.current;
    const request = (
      publicReportsEnabled()
        ? loadStatusPageReport(statusPageId).then((snapshot) => {
            if (generation !== refreshGeneration.current) return;
            setLoadedPage({
              reference: statusPageId,
              page: statusPageSnapshotToPage(snapshot),
              snapshot,
            });
            setError('');
          })
        : api.publicStatusPage(statusPageId).then((result) => {
            if (generation !== refreshGeneration.current) return;
            setLoadedPage({ reference: statusPageId, page: result, snapshot: null });
            setError('');
          })
    )
      .catch((reason) => {
        if (generation === refreshGeneration.current) {
          setError(reason instanceof Error ? reason.message : 'Could not load page');
        }
      })
      .finally(() => {
        if (inFlightRefresh.current?.promise === request) inFlightRefresh.current = null;
      });
    inFlightRefresh.current = { pageId: statusPageId, promise: request };
    return request;
  }, [statusPageId]);
  useEffect(() => {
    setLoadedPage(undefined);
    setError('');
    void refreshPage();
    return () => {
      refreshGeneration.current += 1;
      if (inFlightRefresh.current?.pageId === statusPageId) inFlightRefresh.current = null;
    };
  }, [refreshPage, statusPageId]);
  useEffect(() => {
    if (!autoRefresh) return;
    let active = true;
    let timer: number | undefined;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await refreshPage();
        if (active) schedule();
      }, statusPageRefreshIntervalMs);
    };
    schedule();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [autoRefresh, refreshPage]);
  if (error && !page) return <p className="state state--error">{error}</p>;
  if (!page) return <p className="state state--loading">Loading status…</p>;
  const monitorSearch = new URLSearchParams({ statusPage: statusPageId });
  if (snapshotMetadata?.generation) monitorSearch.set('generation', snapshotMetadata.generation);
  const problemMonitors = [
    ...new Map(
      page.groups
        .flatMap((group) => group.monitors)
        .filter((monitor) => {
          const displayStatus = monitor.recoveryStatus ?? monitor.status;
          return (
            displayStatus === 'recovering' ||
            (displayStatus === 'down' &&
              (monitor.affectedRegionIds === undefined || monitor.affectedRegionIds.length > 0))
          );
        })
        .map((monitor) => [monitor.id, monitor] as const),
    ).values(),
  ];
  return (
    <article className="public-status-page">
      <header className="public-status-page__head">
        <div className="public-status-page__topline">
          <p className="product-mark">UPTIME STATUS</p>
          <button
            type="button"
            className="button button--quiet public-status-page__refresh-toggle"
            aria-pressed={autoRefresh}
            onClick={() => setAutoRefresh((enabled) => !enabled)}
          >
            Auto-refresh {autoRefresh ? 'on' : 'off'}
          </button>
        </div>
        <h1>{page.title}</h1>
        <p>Service availability over the last 90 days.</p>
        <ReportFreshness
          snapshot={snapshotMetadata}
          className="public-status-page__freshness"
          ariaLabel="Public report freshness"
        />
        {error && (
          <p className="field-error" role="status">
            Latest refresh failed: {error}
          </p>
        )}
      </header>
      {problemMonitors.length > 0 && (
        <section className="status-problem-summary" aria-labelledby="status-problem-title">
          <div className="status-problem-summary__heading">
            <span className="status-problem-summary__indicator" aria-hidden="true">
              !
            </span>
            <h2 id="status-problem-title">Some systems currently have problems</h2>
          </div>
          <ul className="status-problem-summary__list">
            {problemMonitors.map((monitor) => (
              <li
                className={
                  monitor.recoveryStatus === 'recovering'
                    ? 'status-problem-summary__list-item--recovering'
                    : undefined
                }
                key={monitor.id}
              >
                <a
                  href={`/monitors/public/${monitor.publicSlug ?? monitor.id}?${monitorSearch.toString()}`}
                >
                  {monitorDisplayName(monitor)}
                </a>
                <span
                  className={
                    monitor.recoveryStatus === 'recovering'
                      ? 'status-problem-summary__state--recovering'
                      : undefined
                  }
                >
                  {monitor.recoveryStatus === 'recovering'
                    ? 'Recovering'
                    : monitor.configuredRegionCount > 1 &&
                        (monitor.affectedRegionIds?.length ?? 0) > 0 &&
                        (monitor.affectedRegionIds?.length ?? 0) < monitor.configuredRegionCount
                      ? `Issues (${monitor.affectedRegionIds?.join(', ')})`
                      : 'Currently down'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="public-status-page__groups">
        {statusPageGroupRows(page.groups).map((row) => {
          const paired = row.length === 2;
          const pairedRowCount = paired
            ? Math.max(
                ...row.map((group) => Math.min(monitorsPerStatusGroupPage, group.monitors.length)),
              )
            : undefined;
          const pairedHasPagination = paired
            ? row.some((group) => group.monitors.length > monitorsPerStatusGroupPage)
            : false;
          const pairedTrackCount =
            pairedRowCount !== undefined
              ? 1 + pairedRowCount + (pairedHasPagination ? 1 : 0)
              : undefined;
          return (
            <div
              className={`public-status-page__group-row${paired ? ' public-status-page__group-row--paired' : ''}`}
              key={row.map((group) => group.id).join(':')}
              style={
                pairedTrackCount !== undefined
                  ? ({ '--paired-track-count': pairedTrackCount } as React.CSSProperties)
                  : undefined
              }
            >
              {row.map((group) => (
                <PublicStatusGroup
                  group={group}
                  monitorSearch={monitorSearch.toString()}
                  pairedHasPagination={pairedHasPagination}
                  {...(pairedRowCount === undefined ? {} : { pairedRowCount })}
                  key={group.id}
                />
              ))}
            </div>
          );
        })}
      </div>
    </article>
  );
}

const monitorsPerStatusGroupPage = 10;

function StatusGroupPagination({
  groupTitle,
  currentPage,
  pageCount,
  position,
  setPage,
}: {
  groupTitle: string;
  currentPage: number;
  pageCount: number;
  position: 'top' | 'bottom';
  setPage: React.Dispatch<React.SetStateAction<number>>;
}) {
  return (
    <nav
      className={`group-pagination group-pagination--${position}`}
      aria-label={`${groupTitle} pagination (${position})`}
    >
      <button
        type="button"
        className="button button--quiet"
        disabled={currentPage === 0}
        onClick={() => setPage((value) => Math.max(0, value - 1))}
      >
        Previous
      </button>
      <span className="tnum">
        {currentPage + 1} / {pageCount}
      </span>
      <button
        type="button"
        className="button button--quiet"
        disabled={currentPage === pageCount - 1}
        onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
      >
        Next
      </button>
    </nav>
  );
}

function PublicStatusGroup({
  group,
  monitorSearch,
  pairedRowCount,
  pairedHasPagination = false,
}: {
  group: PublicStatusPageData['groups'][number];
  monitorSearch: string;
  pairedRowCount?: number;
  pairedHasPagination?: boolean;
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(group.monitors.length / monitorsPerStatusGroupPage));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleMonitors = group.monitors.slice(
    currentPage * monitorsPerStatusGroupPage,
    (currentPage + 1) * monitorsPerStatusGroupPage,
  );
  return (
    <section
      className={`public-status-group public-status-group--${group.width ?? 'full'}${pairedRowCount !== undefined ? ' public-status-group--paired' : ''}`}
    >
      <div className="public-status-group__head">
        <div className="public-status-group__title">
          <h2>{group.title}</h2>
          <span className="public-status-group__count">({group.monitors.length} total)</span>
        </div>
        {pageCount > 1 && (
          <StatusGroupPagination
            groupTitle={group.title}
            currentPage={currentPage}
            pageCount={pageCount}
            position="top"
            setPage={setPage}
          />
        )}
      </div>
      {visibleMonitors.map((monitor) => {
        const displayStatus = monitor.recoveryStatus ?? monitor.status;
        const percentageSeverity = uptimeSeverity(
          monitor.uptimePercentage,
          monitor.uptimeThresholds,
        );
        return (
          <a
            className="public-status-monitor"
            href={`/monitors/public/${monitor.publicSlug ?? monitor.id}?${monitorSearch.toString()}`}
            key={monitor.id}
          >
            <span className="public-status-monitor__summary">
              <span className="public-status-monitor__name">
                <strong>{monitorDisplayName(monitor)}</strong>
                {group.showBadges !== false && <MonitorBadge badge={monitor.badge} />}
                <span className={`status-dot status-dot--${displayStatus}`} />
              </span>
              <span
                className={`public-status-monitor__uptime public-status-monitor__uptime--${percentageSeverity} tnum`}
              >
                {formatPercentage(monitor.uptimePercentage)}
              </span>
              <span
                className={`public-status-monitor__state public-status-monitor__state--${displayStatus}`}
              >
                {displayStatus === 'up'
                  ? 'Up'
                  : displayStatus === 'recovering'
                    ? 'Recovering'
                    : displayStatus === 'down'
                      ? 'Issues'
                      : 'No data'}
              </span>
            </span>
            <UptimeStrip
              days={monitor.days}
              label={`${monitor.name ?? monitor.url} daily uptime history`}
              thresholds={monitor.uptimeThresholds}
            />
          </a>
        );
      })}
      {pairedRowCount !== undefined && visibleMonitors.length < pairedRowCount && (
        <span
          className="public-status-group__fill"
          style={{ gridRow: `span ${pairedRowCount - visibleMonitors.length}` }}
          aria-hidden="true"
        />
      )}
      {pageCount > 1 && (
        <StatusGroupPagination
          groupTitle={group.title}
          currentPage={currentPage}
          pageCount={pageCount}
          position="bottom"
          setPage={setPage}
        />
      )}
      {pairedHasPagination && pageCount === 1 && (
        <span className="public-status-group__pagination-spacer" aria-hidden="true" />
      )}
    </section>
  );
}

function statusPageGroupRows(groups: PublicStatusPageData['groups']) {
  const rows: Array<PublicStatusPageData['groups']> = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group) continue;
    const next = groups[index + 1];
    if ((group.width ?? 'full') === 'half' && next && (next.width ?? 'full') === 'half') {
      rows.push([group, next]);
      index += 1;
    } else {
      rows.push([group]);
    }
  }
  return rows;
}

function reorder<T>(items: T[], source: number, target: number) {
  const next = [...items];
  const [item] = next.splice(source, 1);
  if (item !== undefined) next.splice(target, 0, item);
  return next;
}
import { AppLink } from './app-link.js';
