import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Select } from './select.js';
import type {
  CustomStatusDomainDTO,
  CustomStatusDomainListResponse,
  CustomStatusDomainSetupResponse,
  StatusPageSummary,
} from './api.js';

export interface WorkspaceCustomDomainsPanelProps {
  workspaceId?: string | undefined;
  canManage: boolean;
  importedWorkspace?: boolean | undefined;
}

const HOSTNAME_REGEX = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function isValidHostnameInput(hostname: string): { valid: boolean; error?: string } {
  const trimmed = hostname.trim().toLowerCase();
  if (!trimmed) {
    return { valid: false, error: 'Hostname cannot be empty.' };
  }
  if (trimmed.includes('://') || trimmed.includes('/')) {
    return {
      valid: false,
      error: 'Enter only the domain name (e.g. status.example.com), without protocol or paths.',
    };
  }
  if (trimmed.length > 253) {
    return { valid: false, error: 'Hostname is too long (maximum 253 characters).' };
  }
  const parts = trimmed.split('.');
  for (const part of parts) {
    if (part.length > 63) {
      return { valid: false, error: 'Hostname labels cannot exceed 63 characters.' };
    }
  }
  if (!HOSTNAME_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: 'Enter a valid fully qualified domain name (e.g. status.example.com).',
    };
  }
  return { valid: true };
}

export function formatUtcIso(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return iso;
  }
}

export function formatEligibilityReason(reason: string | null | undefined): string {
  if (!reason) return 'Domain is not currently eligible for public traffic routing.';
  switch (reason) {
    case 'quota_exceeded':
      return 'Workspace exceeds custom domain quota. Upgrade your plan to route traffic.';
    case 'status_page_not_public':
      return 'Target status page is not published as public.';
    case 'unverified':
      return 'Domain DNS ownership is unverified.';
    case 'verification_expired':
      return 'Domain verification has expired. Recheck DNS to restore routing.';
    case 'invalid_verification_timestamp':
    case 'verification_future_timestamp':
      return 'Invalid verification timestamp.';
    case 'mock_simulation_ready':
      return 'Staging simulation active (DNS is not live).';
    case 'mock_pending_simulation':
      return 'Staging simulation pending.';
    default:
      return reason.replace(/_/g, ' ');
  }
}

export function WorkspaceCustomDomainsPanel({
  workspaceId,
  canManage,
  importedWorkspace,
}: WorkspaceCustomDomainsPanelProps) {
  const [data, setData] = useState<CustomStatusDomainListResponse | null>(null);
  const [setup, setSetup] = useState<CustomStatusDomainSetupResponse | null>(null);
  const [statusPages, setStatusPages] = useState<StatusPageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // New domain form
  const [hostnameInput, setHostnameInput] = useState('');
  const [selectedStatusPageId, setSelectedStatusPageId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Per-domain action states
  const [busyDomainId, setBusyDomainId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Synchronous guards and async sequence tracking
  const creatingRef = useRef(false);
  const busyDomainRef = useRef<string | null>(null);
  const fetchSeqRef = useRef(0);
  const currentWorkspaceRef = useRef(workspaceId);
  currentWorkspaceRef.current = workspaceId;

  const loadInitialData = async () => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const [listRes, setupRes, pagesRes] = await Promise.all([
        typeof api.customDomains === 'function' ? api.customDomains() : Promise.resolve(null),
        typeof api.customDomainsSetup === 'function'
          ? api.customDomainsSetup()
          : Promise.resolve(null),
        typeof api.statusPages === 'function'
          ? api.statusPages().catch(() => ({ statusPages: [] }))
          : Promise.resolve({ statusPages: [] }),
      ]);
      if (seq !== fetchSeqRef.current) return;
      setData(listRes);
      setSetup(setupRes);
      const publicPages = (pagesRes?.statusPages || []).filter((p) => p.publicSlug);
      setStatusPages(publicPages);
      if (publicPages.length > 0) {
        setSelectedStatusPageId((current) => current || publicPages[0]?.id || '');
      }
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      setError(err instanceof Error ? err.message : 'Could not load custom status domains');
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    loadInitialData();
  }, [workspaceId]);

  const handleLoadMore = async () => {
    if (!data?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const more = await api.customDomains({ cursor: data.nextCursor });
      setData((prev) => {
        if (!prev) return more;
        const existingIds = new Set(prev.domains.map((d) => d.id));
        const newDomains = more.domains.filter((d) => !existingIds.has(d.id));
        return {
          ...more,
          domains: [...prev.domains, ...newDomains],
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load additional domains');
    } finally {
      setLoadingMore(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingRef.current) return;
    setCreateError(null);
    setActionSuccess(null);

    const validation = isValidHostnameInput(hostnameInput);
    if (!validation.valid) {
      setCreateError(validation.error || 'Invalid hostname');
      return;
    }

    if (!selectedStatusPageId) {
      setCreateError('You must select a published status page for this domain.');
      return;
    }

    creatingRef.current = true;
    setCreating(true);
    try {
      const created = await api.createCustomDomain({
        hostname: hostnameInput.trim().toLowerCase(),
        statusPageId: selectedStatusPageId,
      });
      setHostnameInput('');
      setActionSuccess(`Custom domain ${created.hostname} added successfully.`);
      await loadInitialData();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not add custom domain');
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const handleRefresh = async (domainId: string) => {
    if (busyDomainRef.current) return;
    busyDomainRef.current = domainId;
    setBusyDomainId(domainId);
    setError(null);
    try {
      const refreshed = await api.refreshCustomDomain(domainId);
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          domains: prev.domains.map((d) => (d.id === domainId ? refreshed : d)),
        };
      });
      setActionSuccess(`Refreshed status for ${refreshed.hostname}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh domain status');
    } finally {
      busyDomainRef.current = null;
      setBusyDomainId(null);
    }
  };

  const handleSimulate = async (
    domainId: string,
    targetStatus: 'ready' | 'pending_validation' | 'failed',
  ) => {
    if (busyDomainRef.current) return;
    busyDomainRef.current = domainId;
    setBusyDomainId(domainId);
    setError(null);
    try {
      const simulated = await api.simulateCustomDomain(domainId, targetStatus);
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          domains: prev.domains.map((d) => (d.id === domainId ? simulated : d)),
        };
      });
      setActionSuccess(`Simulated state '${targetStatus}' on domain.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulation failed');
    } finally {
      busyDomainRef.current = null;
      setBusyDomainId(null);
    }
  };

  const handleDelete = async (domainId: string) => {
    if (busyDomainRef.current) return;
    busyDomainRef.current = domainId;
    setBusyDomainId(domainId);
    setError(null);
    try {
      await api.deleteCustomDomain(domainId);
      setConfirmDeleteId(null);
      setActionSuccess('Custom domain deleted.');
      await loadInitialData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete custom domain');
    } finally {
      busyDomainRef.current = null;
      setBusyDomainId(null);
    }
  };

  const copyToClipboard = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2500);
    } catch {
      // Fallback or ignore
    }
  };

  if (loading) {
    return (
      <div className="settings-card" id="custom-domains">
        <h2>Custom Status Domains</h2>
        <p role="status">Loading custom status domains…</p>
      </div>
    );
  }

  // Imported or legacy exempt workspaces have no custom domains capability unless configured
  if (importedWorkspace) {
    return null;
  }

  const isSimulation = Boolean(data?.simulation || setup?.simulation || setup?.mode === 'mock');
  const domains = data?.domains || [];
  const quota = data?.quota ?? 0;
  const totalActive = data?.totalActive ?? domains.length;
  const remaining = Math.max(0, quota - totalActive);

  return (
    <div className="settings-card" id="custom-domains">
      <header className="settings-section-head">
        <div>
          <h2>Custom status domains</h2>
          <p className="settings-card__tier-title">
            Use your own domain for a public status page.
          </p>
        </div>
        {isSimulation && <span className="badge badge--preview">Staging simulation</span>}
      </header>

      {/* Member read-only notice */}
      {!canManage && (
        <p className="settings-note" style={{ fontStyle: 'italic', marginTop: '0.75rem' }}>
          Only workspace owners can configure or modify custom status domains.
        </p>
      )}

      {/* Staging notification */}
      {isSimulation && (
        <div className="settings-domain-notice settings-note">
          <h3>Staging environment</h3>
          <p>
            Custom domain DNS validation is simulated. Do not configure real DNS records at your
            domain registrar. Use the simulation controls below to verify status page routing.
          </p>
        </div>
      )}

      {error && (
        <div className="state state--error" role="alert" style={{ margin: '1rem 0' }}>
          <p>{error}</p>
        </div>
      )}

      {actionSuccess && (
        <div className="state state--success" role="status" style={{ margin: '1rem 0' }}>
          <p>{actionSuccess}</p>
        </div>
      )}

      {/* Quota / Allowance status */}
      <div className="custom-domain-quota">
        <h3>Domain allowance</h3>
        <p className="custom-domain-quota__count">
          <span className="tnum">{totalActive} / {quota}</span> custom domains used
          {quota > 0 && <span> · {remaining} remaining</span>}
        </p>
        {quota === 0 && (
          <p className="settings-note">
            Custom domains are unavailable on the current plan.{' '}
            <a href="#subscription" style={{ fontWeight: 600, textDecoration: 'underline' }}>
              Upgrade your subscription
            </a>{' '}
            to connect custom domains to your public status pages.
          </p>
        )}
      </div>

      {/* Domain Addition Form */}
      {canManage && quota > 0 && remaining > 0 && (
        <form
          onSubmit={handleCreate}
          style={{
            margin: '1.5rem 0',
            padding: '1rem',
            border: '1px solid var(--color-border)',
            borderRadius: '6px',
          }}
        >
          <h3 style={{ marginTop: 0 }}>Add Custom Status Domain</h3>
          {createError && (
            <p className="field-error" role="alert">
              {createError}
            </p>
          )}

          {statusPages.length === 0 ? (
            <div className="field-error" role="alert">
              You must create and publish at least one public status page before attaching a custom
              domain.
            </div>
          ) : (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: '1rem',
                  marginBottom: '1rem',
                }}
              >
                <label className="field">
                  <span>Domain Hostname</span>
                  <input
                    type="text"
                    placeholder="status.example.com"
                    value={hostnameInput}
                    onChange={(e) => setHostnameInput(e.target.value)}
                    disabled={creating}
                    required
                  />
                  <small style={{ color: 'var(--color-muted)' }}>
                    Enter the FQDN without https://
                  </small>
                </label>

                <div className="field">
                  <label htmlFor="custom-domain-status-page">Target Public Status Page</label>
                  <Select
                    id="custom-domain-status-page"
                    value={selectedStatusPageId}
                    onChange={setSelectedStatusPageId}
                    disabled={creating}
                    required
                    placeholder="Choose a status page"
                    options={statusPages.map((page) => ({
                      value: page.id,
                      label: `${page.title} (/status/${page.publicSlug})`,
                    }))}
                  />
                </div>
              </div>

              <button
                type="submit"
                className="button button--primary"
                disabled={creating || !hostnameInput.trim()}
              >
                {creating ? 'Adding…' : 'Add Domain'}
              </button>
            </>
          )}
        </form>
      )}

      {/* Domain List */}
      <div className="custom-domain-list" style={{ marginTop: '1.5rem' }}>
        {domains.length === 0 ? (
          <div className="settings-domain-empty">
            <h3>No custom status domains yet</h3>
            <p className="settings-note">
              {quota === 0
                ? 'Upgrade the plan to connect a domain to a public status page.'
                : 'Add a domain to connect it to a public status page.'}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {domains.map((domain) => {
              const isDomainSimulation = isSimulation || domain.providerMode === 'mock';
              const isReady = domain.status === 'active';
              const isPending = domain.status === 'pending' || domain.status === 'creating';
              const isFailed = domain.status === 'delete_failed';
              const isDeleting = domain.status === 'deleting';
              const isBusy = busyDomainId === domain.id;

              // In live mode, traffic only routes if both active and isEligible are true
              const isPublicEligible = !isDomainSimulation && isReady && domain.isEligible;
              const isPublicIneligible = !isDomainSimulation && isReady && !domain.isEligible;

              return (
                <div
                  key={domain.id}
                  className="custom-domain-item"
                  style={{
                    padding: '1rem',
                    border: '1px solid var(--color-border)',
                    borderRadius: '6px',
                    background: 'var(--color-surface)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      flexWrap: 'wrap',
                      gap: '0.5rem',
                    }}
                  >
                    <div>
                      <h4 style={{ margin: 0, fontSize: '1.1rem' }}>
                        <a
                          href={`https://${domain.hostname}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ textDecoration: 'none', color: 'inherit' }}
                        >
                          {domain.hostname}
                        </a>
                      </h4>
                      <p
                        style={{
                          margin: '0.25rem 0',
                          fontSize: '0.9rem',
                          color: 'var(--color-muted)',
                        }}
                      >
                        Attached to status page ID: <code>{domain.statusPageId}</code>
                      </p>
                    </div>

                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <span
                        className={`badge ${
                          isDomainSimulation
                            ? isReady
                              ? 'badge--success'
                              : isPending
                                ? 'badge--warning'
                                : 'badge--danger'
                            : isPublicEligible
                              ? 'badge--success'
                              : isPublicIneligible
                                ? 'badge--warning'
                                : isPending
                                  ? 'badge--warning'
                                  : 'badge--danger'
                        }`}
                      >
                        {isDomainSimulation
                          ? isReady
                            ? 'ACTIVE (SIMULATED)'
                            : `${domain.status.toUpperCase()} (SIMULATED)`
                          : isPublicIneligible
                            ? 'PAUSED / INELIGIBLE'
                            : domain.status.toUpperCase()}
                      </span>
                    </div>
                  </div>

                  {/* Warning for active domains that are ineligible in live mode */}
                  {!isDomainSimulation &&
                    isPublicIneligible &&
                    domain.eligibilityReason &&
                    !domain.errorCode && (
                      <div
                        className="field-error"
                        role="status"
                        style={{ margin: '0.5rem 0', fontSize: '0.85rem' }}
                      >
                        <strong>Public routing paused:</strong>{' '}
                        {formatEligibilityReason(domain.eligibilityReason)}
                      </div>
                    )}

                  {/* DNS Instructions if not ready and not in mock/simulation */}
                  {!isSimulation && !isReady && (
                    <div
                      style={{
                        margin: '1rem 0',
                        background: 'var(--color-surface-subtle)',
                        padding: '0.75rem',
                        borderRadius: '4px',
                        fontSize: '0.85rem',
                      }}
                    >
                      <strong>Required DNS Configuration:</strong>
                      <div
                        style={{
                          marginTop: '0.5rem',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.5rem',
                        }}
                      >
                        {domain.cnameInstruction && (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '0.5rem',
                            }}
                          >
                            <span>
                              CNAME <code>{domain.cnameInstruction.name}</code> →{' '}
                              <code>{domain.cnameInstruction.target}</code>
                            </span>
                            <button
                              type="button"
                              className="button button--quiet"
                              style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                              onClick={() =>
                                copyToClipboard(
                                  `cname-${domain.id}`,
                                  domain.cnameInstruction!.target,
                                )
                              }
                            >
                              {copiedKey === `cname-${domain.id}` ? 'Copied!' : 'Copy Target'}
                            </button>
                          </div>
                        )}

                        {domain.validationRecords?.map((rec, idx) => {
                          const valText =
                            'value' in rec
                              ? rec.value
                              : 'target' in rec
                                ? rec.target
                                : 'body' in rec
                                  ? rec.body
                                  : '';
                          const nameText = 'name' in rec ? rec.name : 'url' in rec ? rec.url : '';
                          return (
                            <div
                              key={idx}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '0.5rem',
                              }}
                            >
                              <span>
                                {rec.type} <code>{nameText}</code> = <code>{valText}</code>
                              </span>
                              <button
                                type="button"
                                className="button button--quiet"
                                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                                onClick={() => copyToClipboard(`rec-${domain.id}-${idx}`, valText)}
                              >
                                {copiedKey === `rec-${domain.id}-${idx}` ? 'Copied!' : 'Copy Value'}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Timestamps */}
                  <div
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--color-muted)',
                      margin: '0.75rem 0',
                    }}
                  >
                    <span>Created: {formatUtcIso(domain.createdAt)}</span>
                    {domain.verifiedAt && (
                      <span> · Verified: {formatUtcIso(domain.verifiedAt)}</span>
                    )}
                    {domain.recheckDueAt && (
                      <span> · Next Check: {formatUtcIso(domain.recheckDueAt)}</span>
                    )}
                  </div>

                  {domain.errorCode && (
                    <div
                      className="field-error"
                      style={{ margin: '0.5rem 0', fontSize: '0.85rem' }}
                    >
                      <strong>Error:</strong> {domain.errorCode}
                      {domain.eligibilityReason && <span> ({domain.eligibilityReason})</span>}
                    </div>
                  )}

                  {/* Actions & Simulation Bar */}
                  {canManage && (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '0.5rem',
                        marginTop: '1rem',
                        borderTop: '1px solid var(--color-border)',
                        paddingTop: '0.75rem',
                      }}
                    >
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <button
                          type="button"
                          className="button button--quiet"
                          onClick={() => handleRefresh(domain.id)}
                          disabled={isBusy || isDeleting}
                        >
                          {isBusy ? 'Checking…' : 'Recheck Status'}
                        </button>

                        {/* Staging Simulation Buttons */}
                        {isSimulation && (
                          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                            <span
                              style={{
                                fontSize: '0.8rem',
                                color: 'var(--color-muted)',
                                marginRight: '0.25rem',
                              }}
                            >
                              Simulate:
                            </span>
                            <button
                              type="button"
                              className="button button--quiet"
                              style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }}
                              onClick={() => handleSimulate(domain.id, 'ready')}
                              disabled={isBusy || isReady}
                            >
                              Ready
                            </button>
                            <button
                              type="button"
                              className="button button--quiet"
                              style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }}
                              onClick={() => handleSimulate(domain.id, 'pending_validation')}
                              disabled={isBusy || domain.status === 'pending'}
                            >
                              Pending
                            </button>
                            <button
                              type="button"
                              className="button button--quiet"
                              style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }}
                              onClick={() => handleSimulate(domain.id, 'failed')}
                              disabled={isBusy || isFailed}
                            >
                              Failed
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Delete / Retry Delete */}
                      <div>
                        {confirmDeleteId === domain.id ? (
                          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <button
                              type="button"
                              className="button button--danger"
                              onClick={() => handleDelete(domain.id)}
                              disabled={isBusy}
                            >
                              Confirm Delete
                            </button>
                            <button
                              type="button"
                              className="button button--quiet"
                              onClick={() => setConfirmDeleteId(null)}
                              disabled={isBusy}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="button button--quiet button--danger"
                            onClick={() => setConfirmDeleteId(domain.id)}
                            disabled={isBusy || isDeleting}
                          >
                            {domain.status === 'delete_failed' ? 'Retry Deletion' : 'Delete Domain'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination Load More */}
        {data?.nextCursor && (
          <div style={{ textAlign: 'center', marginTop: '1.25rem' }}>
            <button
              type="button"
              className="button button--quiet"
              onClick={handleLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading more…' : 'Load more domains'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
