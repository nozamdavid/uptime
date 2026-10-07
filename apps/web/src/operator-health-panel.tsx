import { useEffect, useState, useCallback, useRef } from 'react';
import type { FormEvent } from 'react';
import { findRegion, type RegionId } from '@uptime/regions';
import {
  api,
  type OperatorHealthResponse,
  type OperatorWorkspace,
  type WorkspaceHealth,
} from './api.js';
import './operator-operations.css';
import { formatBudgetForecast } from './format-usage.js';

export interface OperatorHealthPanelProps {
  knownWorkspaces?: OperatorWorkspace[];
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'None';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  let rel = '';
  if (diffSec < 60) rel = 'just now';
  else if (diffSec < 3600) rel = `${Math.floor(diffSec / 60)}m ago`;
  else if (diffSec < 86400) rel = `${Math.floor(diffSec / 3600)}h ago`;
  else rel = `${Math.floor(diffSec / 86400)}d ago`;

  return `${date.toLocaleString()} (${rel})`;
}

export function OperatorHealthPanel({ knownWorkspaces = [] }: OperatorHealthPanelProps) {
  const [health, setHealth] = useState<OperatorHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Pagination state: cursor stack
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  // Fleet Pause/Resume dialog
  const [fleetAction, setFleetAction] = useState<'pause' | 'resume' | null>(null);
  const [fleetReason, setFleetReason] = useState('');
  const [fleetSubmitting, setFleetSubmitting] = useState(false);
  const [fleetError, setFleetError] = useState('');

  // Workspace Pause/Resume dialog
  const [wsAction, setWsAction] = useState<{
    workspaceId: string;
    workspaceName: string;
    action: 'pause' | 'resume';
  } | null>(null);
  const [wsReason, setWsReason] = useState('');
  const [wsSubmitting, setWsSubmitting] = useState(false);
  const [wsError, setWsError] = useState('');

  const healthReqSeq = useRef(0);
  const currentCursor = cursorHistory[pageIndex] ?? undefined;

  const loadHealth = useCallback((after?: string) => {
    const seq = ++healthReqSeq.current;
    setLoading(true);
    return api
      .operatorHealth(after, 5)
      .then((res) => {
        if (healthReqSeq.current === seq) {
          setHealth(res);
          setError('');
        }
        return res;
      })
      .catch((err) => {
        if (healthReqSeq.current === seq) {
          setError(err instanceof Error ? err.message : 'Could not load operator health.');
        }
        throw err;
      })
      .finally(() => {
        if (healthReqSeq.current === seq) {
          setLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    loadHealth(currentCursor).catch(() => {});
  }, [loadHealth, currentCursor]);

  function getWorkspaceName(workspaceId: string, source: string | null) {
    const known = knownWorkspaces.find((w) => w.id === workspaceId);
    if (known) return known.name;
    if (source === 'legacy_import') return `Imported Legacy (${workspaceId.slice(0, 8)}…)`;
    if (source === 'staging_import') return `Imported Staging (${workspaceId.slice(0, 8)}…)`;
    return workspaceId;
  }

  function handleNextPage() {
    if (!health?.nextCursor) return;
    const nextCursor = health.nextCursor;
    if (pageIndex + 1 < cursorHistory.length) {
      setPageIndex(pageIndex + 1);
    } else {
      setCursorHistory([...cursorHistory, nextCursor]);
      setPageIndex(pageIndex + 1);
    }
  }

  function handlePrevPage() {
    if (pageIndex > 0) {
      setPageIndex(pageIndex - 1);
    }
  }

  async function submitFleetScheduling(event: FormEvent) {
    event.preventDefault();
    const trimmed = fleetReason.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      setFleetError('Reason is required and must be between 1 and 500 characters.');
      return;
    }
    setFleetSubmitting(true);
    setFleetError('');
    try {
      const res = await api.operatorScheduling(fleetAction === 'pause', trimmed);
      setHealth((cur) => (cur ? { ...cur, scheduling: res.scheduling } : cur));
      setFleetAction(null);
      setFleetReason('');
      try {
        await loadHealth(currentCursor);
      } catch (refreshErr) {
        setError(
          refreshErr instanceof Error
            ? `Scheduling updated, but refreshing health telemetry failed: ${refreshErr.message}`
            : 'Scheduling updated, but refreshing health telemetry failed.',
        );
      }
    } catch (err) {
      setFleetError(err instanceof Error ? err.message : 'Failed to update fleet scheduling.');
    } finally {
      setFleetSubmitting(false);
    }
  }

  async function submitWorkspaceScheduling(event: FormEvent) {
    event.preventDefault();
    if (!wsAction) return;
    const trimmed = wsReason.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      setWsError('Reason is required and must be between 1 and 500 characters.');
      return;
    }
    setWsSubmitting(true);
    setWsError('');
    try {
      const res = await api.operatorWorkspaceScheduling(
        wsAction.workspaceId,
        wsAction.action === 'pause',
        trimmed,
      );
      setHealth((cur) =>
        cur
          ? {
              ...cur,
              workspaces: cur.workspaces.map((w) =>
                w.workspaceId === wsAction.workspaceId ? { ...w, scheduling: res.scheduling } : w,
              ),
            }
          : cur,
      );
      setWsAction(null);
      setWsReason('');
      try {
        await loadHealth(currentCursor);
      } catch (refreshErr) {
        setError(
          refreshErr instanceof Error
            ? `Workspace scheduling updated, but refreshing health telemetry failed: ${refreshErr.message}`
            : 'Workspace scheduling updated, but refreshing health telemetry failed.',
        );
      }
    } catch (err) {
      setWsError(err instanceof Error ? err.message : 'Failed to update workspace scheduling.');
    } finally {
      setWsSubmitting(false);
    }
  }

  const isFleetManuallyPaused = Boolean(
    health?.scheduling.manual.some((m) => m.scope === 'fleet' && m.paused),
  );

  return (
    <div className="operator-health">
      <div className="operator-health__header">
        <div>
          <h2>Operator Fleet Health</h2>
          <small className="settings-note">
            Telemetry and coordinator status across assigned workspaces (page {pageIndex + 1}).
          </small>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            className="button button--quiet"
            onClick={() => {
              loadHealth(currentCursor).catch(() => {});
            }}
          >
            {loading ? 'Refreshing…' : 'Refresh health'}
          </button>
          {health && (
            <button
              className="button button--quiet"
              onClick={() => {
                setFleetAction(isFleetManuallyPaused ? 'resume' : 'pause');
                setFleetReason('');
                setFleetError('');
              }}
            >
              {isFleetManuallyPaused ? 'Resume fleet scheduling' : 'Pause fleet scheduling'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      {/* Fleet Scheduling Modal / Form */}
      {fleetAction && (
        <div
          className="operator-scheduling-box"
          role="dialog"
          aria-labelledby="fleet-sched-heading"
        >
          <h3 id="fleet-sched-heading">
            {fleetAction === 'pause' ? 'Pause Fleet Scheduling' : 'Resume Fleet Scheduling'}
          </h3>
          <p className="settings-note">
            Controls are separate from access suspension. In-flight checks may complete while
            cleanup continues.
          </p>
          {fleetAction === 'resume' && (
            <p className="settings-note">
              Note: Manual resume clears the fleet manual pause. If an automatic monthly budget
              ceiling pause or specific workspace pause is active, monitoring will remain paused for
              those scopes until conditions are met.
            </p>
          )}
          <form onSubmit={(e) => void submitFleetScheduling(e)}>
            <label className="field">
              <span>Reason (audited, 1–500 characters) *</span>
              <textarea
                value={fleetReason}
                onChange={(e) => setFleetReason(e.target.value)}
                placeholder="Explain why fleet scheduling is being paused or resumed…"
                required
                maxLength={500}
                rows={2}
                disabled={fleetSubmitting}
              />
            </label>
            {fleetError && (
              <p className="field-error" role="alert">
                {fleetError}
              </p>
            )}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="button button--quiet"
                type="submit"
                disabled={fleetSubmitting || !fleetReason.trim()}
              >
                {fleetSubmitting
                  ? 'Updating…'
                  : fleetAction === 'pause'
                    ? 'Confirm Pause'
                    : 'Confirm Resume'}
              </button>
              <button
                className="button button--quiet"
                type="button"
                onClick={() => setFleetAction(null)}
                disabled={fleetSubmitting}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Monitoring Paused Banner */}
      {health?.scheduling.paused && (
        <div className="operator-paused-banner" role="alert">
          <h3>Monitoring Paused</h3>
          {health.scheduling.automatic && (
            <p>
              <strong>
                {health.scheduling.automatic.scope === 'budget'
                  ? health.scheduling.automatic.reason.toLowerCase().includes('ceiling')
                    ? 'Budget Ceiling:'
                    : 'Budget Guard:'
                  : 'Automatic Pause:'}
              </strong>{' '}
              {health.scheduling.automatic.reason} (changed{' '}
              <time dateTime={health.scheduling.automatic.changedAt}>
                {formatTimestamp(health.scheduling.automatic.changedAt)}
              </time>
              )
            </p>
          )}
          {health.scheduling.manual
            .filter((m) => m.paused)
            .map((rec, i) => (
              <p key={i}>
                <strong>Manual Pause ({rec.scope}):</strong> {rec.reason} (by {rec.actor} at{' '}
                <time dateTime={rec.changedAt}>{formatTimestamp(rec.changedAt)}</time>)
              </p>
            ))}
          <p>
            <small>
              <em>In-flight checks may complete; background cleanup tasks continue.</em>
            </small>
          </p>
          <strong>Resume conditions:</strong>
          <ul>
            {health.scheduling.resumeConditions.map((cond, i) => (
              <li key={i}>{cond}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Dispatch Health Stats */}
      {health && (
        <div className="operator-dispatch-grid">
          <div className="operator-dispatch-stat">
            <small>Budget Forecast</small>
            <strong>{formatBudgetForecast(health.budget)}</strong>
            <small>Ceiling: ${health.budget.ceilingUsd.toFixed(2)}</small>
          </div>
          <div className="operator-dispatch-stat">
            <small>Oldest Pending Dispatch</small>
            <strong>{formatTimestamp(health.dispatch.oldestPendingAt)}</strong>
            {health.dispatch.pendingAgeSeconds !== null && (
              <small>Age: {health.dispatch.pendingAgeSeconds}s</small>
            )}
          </div>
          <div className="operator-dispatch-stat">
            <small>Dispatch Failures</small>
            <strong>
              {health.dispatch.failedCount}
              {health.dispatch.truncated ? '+ (truncated)' : ''}
            </strong>
            <small>in recent outbox queue</small>
          </div>
          <div className="operator-dispatch-stat">
            <small>Dead Letter Count</small>
            <strong>
              {health.dispatch.deadLetterCount !== null
                ? health.dispatch.deadLetterCount
                : 'unknown'}
            </strong>
            <small>D1 queue state (Not measured)</small>
          </div>
        </div>
      )}

      {/* Workspace Scheduling Dialog */}
      {wsAction && (
        <div className="operator-scheduling-box" role="dialog" aria-labelledby="ws-sched-heading">
          <h3 id="ws-sched-heading">
            {wsAction.action === 'pause' ? 'Pause Workspace' : 'Resume Workspace'} Scheduling:{' '}
            {wsAction.workspaceName}
          </h3>
          <p className="settings-note">
            Controls are separate from access suspension. In-flight checks may complete while
            cleanup continues.
          </p>
          {wsAction.action === 'resume' && (
            <p className="settings-note">
              Note: Manual resume clears this workspace manual pause. Fleet-wide pauses or budget
              ceilings remain in effect.
            </p>
          )}
          <form onSubmit={(e) => void submitWorkspaceScheduling(e)}>
            <label className="field">
              <span>Reason (audited, 1–500 characters) *</span>
              <textarea
                value={wsReason}
                onChange={(e) => setWsReason(e.target.value)}
                placeholder="Explain why this workspace scheduling is being paused or resumed…"
                required
                maxLength={500}
                rows={2}
                disabled={wsSubmitting}
              />
            </label>
            {wsError && (
              <p className="field-error" role="alert">
                {wsError}
              </p>
            )}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="button button--quiet"
                type="submit"
                disabled={wsSubmitting || !wsReason.trim()}
              >
                {wsSubmitting
                  ? 'Updating…'
                  : wsAction.action === 'pause'
                    ? 'Confirm Pause'
                    : 'Confirm Resume'}
              </button>
              <button
                className="button button--quiet"
                type="button"
                onClick={() => setWsAction(null)}
                disabled={wsSubmitting}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Paginated Workspaces List */}
      {health && (
        <div className="operator-workspaces-health">
          {health.workspaces.length === 0 ? (
            <p className="settings-note">No workspaces on this page.</p>
          ) : (
            health.workspaces.map((ws: WorkspaceHealth) => {
              const wsName = getWorkspaceName(ws.workspaceId, ws.source);
              const isImported = ws.source === 'legacy_import' || ws.source === 'staging_import';
              const isLegacyHeartbeatUnconfirmed =
                isImported &&
                Boolean(ws.schedulingEnforcement && !ws.schedulingEnforcement.confirmed);
              const isWsManuallyPaused = Boolean(
                ws.scheduling.manual.some((m) => m.scope === ws.workspaceId && m.paused),
              );

              const reportsFreshness =
                ws.telemetry?.reports.stale === null || ws.telemetry?.reports.stale === undefined
                  ? 'Unknown'
                  : ws.telemetry.reports.stale
                    ? 'Stale'
                    : 'Fresh';

              return (
                <div className="operator-workspace-health-card" key={ws.workspaceId}>
                  <div className="operator-workspace-health-card__header">
                    <div>
                      <strong>{wsName}</strong> <small className="tnum">{ws.workspaceId}</small>{' '}
                      <span className={`operator-badge operator-badge--${ws.source ?? 'unknown'}`}>
                        {ws.source ?? 'unknown'}
                      </span>{' '}
                      {ws.scheduling.paused && (
                        <span className="operator-badge operator-badge--paused">
                          {isLegacyHeartbeatUnconfirmed
                            ? 'Scheduling Pause Requested (Heartbeat Unconfirmed)'
                            : 'Scheduling Paused'}
                        </span>
                      )}
                    </div>
                    <div>
                      <button
                        className="button button--quiet"
                        style={{ padding: '2px 8px', fontSize: '12px' }}
                        onClick={() => {
                          setWsAction({
                            workspaceId: ws.workspaceId,
                            workspaceName: wsName,
                            action: isWsManuallyPaused ? 'resume' : 'pause',
                          });
                          setWsReason('');
                          setWsError('');
                        }}
                      >
                        {isWsManuallyPaused ? 'Resume scheduling' : 'Pause scheduling'}
                      </button>
                    </div>
                  </div>

                  {/* Enforcement status: legacy imported vs hosted */}
                  {ws.schedulingEnforcement && (
                    <div style={{ marginTop: '4px' }}>
                      {isImported ? (
                        <>
                          <span
                            className={`operator-badge ${
                              ws.schedulingEnforcement.confirmed
                                ? 'operator-badge--ok'
                                : 'operator-badge--paused'
                            }`}
                          >
                            {ws.schedulingEnforcement.confirmed
                              ? `Legacy Heartbeat Confirmed${
                                  ws.schedulingEnforcement.observedAt
                                    ? ` (${formatTimestamp(ws.schedulingEnforcement.observedAt)})`
                                    : ''
                                }`
                              : 'Legacy Heartbeat Missing / Stale (>180s)'}
                          </span>
                          {ws.scheduling.paused && !ws.schedulingEnforcement.confirmed && (
                            <small
                              className="field-error"
                              style={{ display: 'block', marginTop: '2px' }}
                            >
                              Pause is requested, but legacy coordinator enforcement is unconfirmed
                              due to missing/stale heartbeat.
                            </small>
                          )}
                        </>
                      ) : (
                        <span
                          className={`operator-badge ${
                            ws.schedulingEnforcement.confirmed
                              ? 'operator-badge--ok'
                              : 'operator-badge--paused'
                          }`}
                        >
                          {ws.schedulingEnforcement.confirmed
                            ? 'Hosted Scheduling Active'
                            : 'Hosted Scheduling Unconfirmed'}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Workspace-specific pause reasons & resume conditions */}
                  {ws.scheduling.paused && (
                    <div
                      className="operator-workspace-pause-details"
                      style={{ marginTop: '6px', fontSize: '13px' }}
                    >
                      {ws.scheduling.automatic && (
                        <p style={{ margin: '2px 0' }}>
                          <strong>Automatic Pause:</strong> {ws.scheduling.automatic.reason}{' '}
                          <small>({formatTimestamp(ws.scheduling.automatic.changedAt)})</small>
                        </p>
                      )}
                      {ws.scheduling.manual
                        .filter((m) => m.paused)
                        .map((rec, i) => (
                          <p key={i} style={{ margin: '2px 0' }}>
                            <strong>
                              Manual Pause ({rec.scope === ws.workspaceId ? 'workspace' : rec.scope}
                              ):
                            </strong>{' '}
                            {rec.reason}{' '}
                            <small>
                              (by {rec.actor} at {formatTimestamp(rec.changedAt)})
                            </small>
                          </p>
                        ))}
                      {ws.scheduling.resumeConditions.length > 0 && (
                        <div style={{ marginTop: '4px' }}>
                          <strong>Resume conditions:</strong>
                          <ul style={{ margin: '2px 0', paddingLeft: '20px' }}>
                            {ws.scheduling.resumeConditions.map((cond, i) => (
                              <li key={i}>{cond}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  {ws.source === null && ws.error && (
                    <p className="field-error" role="alert">
                      Reader failure: {ws.error}
                    </p>
                  )}

                  {ws.source !== null && ws.error && (
                    <p className="field-error" role="alert">
                      Source error: {ws.error}
                    </p>
                  )}

                  {ws.telemetry === null && !ws.error && (
                    <p className="settings-note">Telemetry unknown / unavailable.</p>
                  )}

                  {ws.telemetry && (
                    <div className="operator-telemetry-grid">
                      <div>
                        <span style={{ color: 'var(--color-muted)' }}>Last Tick: </span>
                        <strong>{formatTimestamp(ws.telemetry.lastSuccessfulTickAt)}</strong>
                      </div>
                      <div>
                        <span style={{ color: 'var(--color-muted)' }}>Oldest Overdue: </span>
                        <strong>{formatTimestamp(ws.telemetry.oldestOverdueCheckAt)}</strong>
                      </div>
                      <div>
                        <span style={{ color: 'var(--color-muted)' }}>Reports: </span>
                        <strong>
                          {ws.telemetry.reports.lastSuccessfulAt
                            ? `${formatTimestamp(ws.telemetry.reports.lastSuccessfulAt)} (${reportsFreshness})`
                            : 'None'}
                        </strong>
                        {ws.telemetry.reports.oldestSuccessfulAt && (
                          <small style={{ display: 'block', color: 'var(--color-muted)' }}>
                            Oldest: {formatTimestamp(ws.telemetry.reports.oldestSuccessfulAt)}
                          </small>
                        )}
                        {ws.telemetry.reports.failedCount !== undefined &&
                          ws.telemetry.reports.failedCount > 0 && (
                            <small
                              style={{ display: 'block', color: 'var(--color-danger, #e53e3e)' }}
                            >
                              Failures: {ws.telemetry.reports.failedCount}
                              {ws.telemetry.reports.truncated ? '+ (truncated)' : ''}
                            </small>
                          )}
                      </div>
                      <div>
                        <span style={{ color: 'var(--color-muted)' }}>Notification Fails: </span>
                        <strong>
                          {ws.telemetry.notificationFailures.count}
                          {ws.telemetry.notificationFailures.truncated ? '+ (truncated)' : ''}
                        </strong>
                      </div>
                      {ws.telemetry.targetIncidents !== undefined && (
                        <div>
                          <span style={{ color: 'var(--color-muted)' }}>Target Incidents: </span>
                          <strong>
                            {ws.telemetry.targetIncidents.downCount} down
                            {ws.telemetry.targetIncidents.truncated ? '+ (truncated)' : ''}
                          </strong>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Regional Probes: Compact labeled rows, no raw JSON dump */}
                  {ws.telemetry && (
                    <details className="operator-regional-probes" style={{ marginTop: '8px' }}>
                      <summary>
                        Regional Probes (Last transport attempts, not target website uptime)
                      </summary>
                      {ws.telemetry.regionalProbes === null ? (
                        <p className="settings-note" style={{ margin: '4px 0' }}>
                          Regional probe telemetry: Unknown / not measured yet.
                        </p>
                      ) : Object.keys(ws.telemetry.regionalProbes).length === 0 ? (
                        <p className="settings-note" style={{ margin: '4px 0' }}>
                          No regional probes recorded.
                        </p>
                      ) : (
                        <div style={{ marginTop: '6px', overflowX: 'auto' }}>
                          <table
                            style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}
                          >
                            <thead>
                              <tr
                                style={{
                                  textAlign: 'left',
                                  borderBottom: '1px solid var(--color-border, #eee)',
                                }}
                              >
                                <th style={{ padding: '4px 8px' }}>Region</th>
                                <th style={{ padding: '4px 8px' }}>Transport Attempts</th>
                                <th style={{ padding: '4px 8px' }}>Failures</th>
                                <th style={{ padding: '4px 8px' }}>Missing Results</th>
                              </tr>
                            </thead>
                            <tbody>
                              {Object.entries(ws.telemetry.regionalProbes).map(
                                ([regId, rawMetrics]) => {
                                  const regionName = findRegion(regId as RegionId)?.label ?? regId;
                                  const m = (rawMetrics ?? {}) as {
                                    attempts?: number;
                                    failures?: number;
                                    missingResults?: number;
                                  };
                                  const attempts = m.attempts ?? 0;
                                  const failures = m.failures ?? 0;
                                  const missing = m.missingResults ?? 0;
                                  return (
                                    <tr
                                      key={regId}
                                      style={{
                                        borderBottom: '1px solid var(--color-border, #f4f4f4)',
                                      }}
                                    >
                                      <td style={{ padding: '4px 8px' }}>
                                        <strong>{regionName}</strong>{' '}
                                        <small className="tnum">({regId})</small>
                                      </td>
                                      <td style={{ padding: '4px 8px' }}>{attempts}</td>
                                      <td style={{ padding: '4px 8px' }}>{failures}</td>
                                      <td style={{ padding: '4px 8px' }}>{missing}</td>
                                    </tr>
                                  );
                                },
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </details>
                  )}
                </div>
              );
            })
          )}

          <div className="operator-pagination">
            <button
              className="button button--quiet"
              onClick={handlePrevPage}
              disabled={pageIndex === 0 || loading}
            >
              Previous 5
            </button>
            <small>Page {pageIndex + 1}</small>
            <button
              className="button button--quiet"
              onClick={handleNextPage}
              disabled={!health.nextCursor || loading}
            >
              Next 5
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
