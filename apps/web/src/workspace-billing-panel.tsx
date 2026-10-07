import { useEffect, useRef, useState } from 'react';
import { findRegion } from '@uptime/regions';
import { api, formatPlanCents, isValidBillingRedirect } from './api.js';
import { Select } from './select.js';
import type {
  ImportedWorkspaceKind,
  PublicProductCatalog,
  WorkspaceBillingResponse,
  WorkspaceEntitlementsResponse,
} from './api.js';

export interface WorkspaceBillingPanelProps {
  workspaceId?: string | undefined;
  canManage: boolean;
  importedWorkspace?: boolean | undefined;
  importedKind?: ImportedWorkspaceKind | undefined;
  onRefresh?: (() => void) | undefined;
}

export function formatUnixSeconds(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || seconds <= 0 || Number.isNaN(seconds)) {
    return '—';
  }
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function WorkspaceBillingPanel({
  workspaceId,
  canManage,
  importedWorkspace,
  importedKind,
  onRefresh,
}: WorkspaceBillingPanelProps) {
  const [billing, setBilling] = useState<WorkspaceBillingResponse | null>(null);
  const [entitlements, setEntitlements] = useState<WorkspaceEntitlementsResponse | null>(null);
  const [catalog, setCatalog] = useState<PublicProductCatalog | null>(null);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof api.usage>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<string>('pro');

  // Synchronous operation lock to prevent concurrent button clicks
  const actionBusyRef = useRef(false);
  // Sequence guard to discard stale async responses across workspace changes or reloads
  const fetchSeqRef = useRef(0);
  const currentWorkspaceRef = useRef(workspaceId);
  currentWorkspaceRef.current = workspaceId;

  const loadData = async () => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const [usageRes, billingRes, entitlementsRes, catalogRes] = await Promise.all([
        typeof api.usage === 'function' ? api.usage().catch(() => null) : Promise.resolve(null),
        typeof api.workspaceBilling === 'function'
          ? api.workspaceBilling().catch(() => null)
          : Promise.resolve(null),
        typeof api.workspaceEntitlements === 'function'
          ? api.workspaceEntitlements().catch(() => null)
          : Promise.resolve(null),
        typeof api.publicPlans === 'function'
          ? api.publicPlans().catch(() => null)
          : Promise.resolve(null),
      ]);
      if (seq !== fetchSeqRef.current) return;
      setUsage(usageRes);
      setBilling(billingRes);
      setEntitlements(entitlementsRes);
      setCatalog(catalogRes);

      // Default selectedPlanId to first non-free plan if available
      if (catalogRes?.plans) {
        const paidPlan = catalogRes.plans.find((p) => p.id !== 'free' && p.active);
        if (paidPlan) {
          setSelectedPlanId(paidPlan.id);
        }
      }
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      setError(err instanceof Error ? err.message : 'Could not load workspace billing');
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    loadData();
  }, [workspaceId]);

  const handleCheckout = async (tierId: string) => {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    setError(null);
    setActionSuccess(null);
    try {
      const targetPlan = catalog?.plans.find((p) => p.id === tierId);
      const revision = targetPlan?.revision ?? billing?.effectivePlan?.revision ?? 1;
      const res = await api.startBillingCheckout(tierId, revision);

      if (!isValidBillingRedirect(res.url, window.location.origin)) {
        throw new Error('Received an unsafe or unauthorized checkout redirect URL.');
      }
      window.location.assign(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not initiate checkout');
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  };

  const handlePortal = async () => {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    setError(null);
    setActionSuccess(null);
    try {
      const res = await api.createBillingPortal();
      if (!isValidBillingRedirect(res.url, window.location.origin)) {
        throw new Error('Received an unsafe or unauthorized billing portal redirect URL.');
      }
      window.location.assign(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open billing portal');
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    setError(null);
    setActionSuccess(null);
    const capturedWorkspace = currentWorkspaceRef.current;
    try {
      const updated = await api.cancelBillingSubscription();
      if (currentWorkspaceRef.current !== capturedWorkspace) return;
      setBilling(updated);
      setConfirmCancel(false);
      setActionSuccess('Subscription set to cancel at the end of the billing period.');
      const nextEntitlements = await api.workspaceEntitlements().catch(() => null);
      if (currentWorkspaceRef.current === capturedWorkspace && nextEntitlements) {
        setEntitlements(nextEntitlements);
      }
      onRefresh?.();
    } catch (err) {
      if (currentWorkspaceRef.current === capturedWorkspace) {
        setError(err instanceof Error ? err.message : 'Could not cancel subscription');
      }
    } finally {
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  };

  const handleResumeSubscription = async () => {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    setError(null);
    setActionSuccess(null);
    const capturedWorkspace = currentWorkspaceRef.current;
    try {
      const updated = await api.resumeBillingSubscription();
      if (currentWorkspaceRef.current !== capturedWorkspace) return;
      setBilling(updated);
      setActionSuccess('Subscription resumed successfully.');
      const nextEntitlements = await api.workspaceEntitlements().catch(() => null);
      if (currentWorkspaceRef.current === capturedWorkspace && nextEntitlements) {
        setEntitlements(nextEntitlements);
      }
      onRefresh?.();
    } catch (err) {
      if (currentWorkspaceRef.current === capturedWorkspace) {
        setError(err instanceof Error ? err.message : 'Could not resume subscription');
      }
    } finally {
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  };

  const handleChangeMockPlan = async (tierId: string) => {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    setError(null);
    setActionSuccess(null);
    const capturedWorkspace = currentWorkspaceRef.current;
    try {
      const targetPlan = catalog?.plans.find((p) => p.id === tierId);
      const revision = targetPlan?.revision ?? 1;
      const updated = await api.changeMockBillingPlan(tierId, revision);
      if (currentWorkspaceRef.current !== capturedWorkspace) return;
      setBilling(updated);
      setActionSuccess(
        `Plan switched to ${tierId.toUpperCase()} (Revision ${revision}) in simulation.`,
      );
      const nextEntitlements = await api.workspaceEntitlements().catch(() => null);
      if (currentWorkspaceRef.current === capturedWorkspace && nextEntitlements) {
        setEntitlements(nextEntitlements);
      }
      onRefresh?.();
    } catch (err) {
      if (currentWorkspaceRef.current === capturedWorkspace) {
        setError(err instanceof Error ? err.message : 'Could not change simulated plan');
      }
    } finally {
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="settings-card" id="subscription">
        <h2>Subscription &amp; Billing</h2>
        <p role="status">Loading subscription details…</p>
      </div>
    );
  }

  // Handle Imported / Legacy Exempt Workspaces
  const isExempt = Boolean(
    importedWorkspace || billing?.legacyExempt || entitlements?.legacyExempt,
  );
  if (isExempt) {
    const isStaging = importedKind === 'staging_import';
    const heading =
      importedKind === 'legacy_import'
        ? 'Imported production monitors'
        : isStaging
          ? 'Imported staging monitors'
          : 'Legacy exempt workspace';

    const monitorCount = usage?.usage?.monitors ?? entitlements?.usage?.monitors ?? 0;
    const statusPageCount = usage?.usage?.statusPages ?? entitlements?.usage?.statusPages ?? 0;
    const notifCount =
      usage?.usage?.notificationServices ??
      entitlements?.usage?.notificationDestinations ??
      entitlements?.usage?.notificationServices ??
      0;

    return (
      <div className="settings-card" id="subscription">
        <h2>{heading}</h2>
        <p>
          {monitorCount} monitors · {statusPageCount} status pages · {notifCount} notification
          services
        </p>
        <p className="settings-note">
          {isStaging
            ? 'This workspace keeps the existing staging checks and history. Its limits and retention follow the imported staging system.'
            : 'This workspace keeps the existing production checks and history. Its limits and retention follow the imported legacy system.'}
        </p>
      </div>
    );
  }

  const sub = billing?.subscription;
  const isPendingReconciliation = Boolean(sub?.pendingReconciliation);
  const planName =
    sub?.plan?.name ??
    (billing?.effectivePlan?.tierId ? billing.effectivePlan.tierId.toUpperCase() : 'Free');
  const planRevision = sub?.revision ?? billing?.effectivePlan?.revision;
  const isSimulation = Boolean(billing?.simulation || billing?.mode === 'mock');

  return (
    <div className="settings-card" id="subscription">
      <header className="settings-section-head">
        <h2>Subscription and billing</h2>
        {isSimulation && <span className="badge badge--preview">Simulation mode</span>}
      </header>

      <dl className="settings-facts settings-facts--summary">
        <div>
          <dt>Current plan</dt>
          <dd>{planName}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{sub?.status ? sub.status.charAt(0).toUpperCase() + sub.status.slice(1) : 'Active'}</dd>
        </div>
        {planRevision !== undefined && planRevision !== null && (
          <div>
            <dt>Plan revision</dt>
            <dd className="tnum">{planRevision}</dd>
          </div>
        )}
        {sub?.currentPeriodEnd && !sub.cancelAtPeriodEnd && (
          <div>
            <dt>Next renewal</dt>
            <dd>{formatUnixSeconds(sub.currentPeriodEnd)}</dd>
          </div>
        )}
      </dl>

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

      {/* Activation Error Alert */}
      {sub?.activationError && (
        <div className="state state--error" role="alert" style={{ margin: '1rem 0' }}>
          <strong>Subscription Activation Error:</strong>
          <p>{sub.activationError}</p>
        </div>
      )}

      {/* Pending Reconciliation Warning */}
      {isPendingReconciliation && (
        <div
          className="badge badge--warning"
          role="status"
          style={{ margin: '0.5rem 0', display: 'block' }}
        >
          Subscription changes are pending reconciliation with the payment provider. Actions are
          temporarily locked.
        </div>
      )}

      <div className="subscription-details">
        {sub?.cancelAtPeriodEnd && sub.currentPeriodEnd && (
          <p className="settings-note settings-billing-alert settings-billing-alert--warning">
            Canceling at end of billing cycle. Access retained until{' '}
            <strong>{formatUnixSeconds(sub.currentPeriodEnd)}</strong>.
          </p>
        )}

        {sub?.graceUntil && (
          <p className="settings-note settings-billing-alert settings-billing-alert--danger">
            Payment past due. Grace period active until{' '}
            <strong>{formatUnixSeconds(sub.graceUntil)}</strong>.
          </p>
        )}
      </div>

      {entitlements?.entitlements && (
        <section className="subscription-usage" aria-labelledby="subscription-usage-heading">
          <h3 id="subscription-usage-heading">Usage and limits</h3>
          <dl className="settings-usage-grid">
            <div>
              <dt>Monitors</dt>
              <dd>{entitlements.usage.monitors} / {entitlements.entitlements.monitors}</dd>
            </div>
            <div>
              <dt>Status pages</dt>
              <dd>{entitlements.usage.statusPages} / {entitlements.entitlements.statusPages}</dd>
            </div>
            <div>
              <dt>Notification destinations</dt>
              <dd>{entitlements.usage.notificationDestinations ?? entitlements.usage.notificationServices} / {entitlements.entitlements.notificationDestinations}</dd>
            </div>
            <div>
              <dt>Seats</dt>
              <dd>{entitlements.usage.seats ?? 1} / {entitlements.entitlements.seats}</dd>
            </div>
            <div>
              <dt>Custom status domains <span className="settings-muted">(preview)</span></dt>
              <dd>{entitlements.entitlements.customDomains} available</dd>
            </div>
            <div>
              <dt>Regions per check</dt>
              <dd>Up to {entitlements.entitlements.regions}</dd>
            </div>
          </dl>
          <p className="settings-note settings-usage-hint">
            These limits are shared by everyone in the workspace. Each monitor can use up to{' '}
            {entitlements.entitlements.regions} region
            {entitlements.entitlements.regions === 1 ? '' : 's'}.
          </p>
          {entitlements.entitlements.allowedRegionIds &&
            entitlements.entitlements.allowedRegionIds.length > 0 && (
              <div className="settings-allowed-regions">
                <h4>Allowed regions</h4>
                <p>
                  {entitlements.entitlements.allowedRegionIds
                    .map((regionId) => findRegion(regionId)?.label ?? regionId)
                    .join(', ')}
                </p>
              </div>
            )}
        </section>
      )}

      {entitlements?.overrides && (
        <div
          className="badge badge--warning"
          role="status"
          style={{ marginBottom: '0.75rem', display: 'inline-block' }}
        >
          Custom limits override active: {entitlements.overrides.monitors} monitors,{' '}
          {entitlements.overrides.regions} regions
        </div>
      )}

      {entitlements?.downgrade?.overLimit && (
        <div className="field-error" role="alert" style={{ marginBottom: '0.75rem' }}>
          {entitlements.downgrade.pausedMonitorCount > 0 ? (
            <>
              Workspace is over tier quota. {entitlements.downgrade.pausedMonitorCount} monitor
              {entitlements.downgrade.pausedMonitorCount === 1 ? '' : 's'} are paused by quota
              policy.
            </>
          ) : entitlements.downgrade.overLimitResources &&
            entitlements.downgrade.overLimitResources.length > 0 ? (
            <>
              Workspace is over tier quota on:{' '}
              {entitlements.downgrade.overLimitResources.join(', ')}. Existing resources remain
              accessible, but new creation is paused until within quota.
            </>
          ) : (
            <>
              Workspace is over tier quota. Creation of new resources is paused until within quota.
            </>
          )}
        </div>
      )}

      {/* Member read-only notice */}
      {!canManage && (
        <p className="settings-note" style={{ fontStyle: 'italic' }}>
          Only the workspace owner can manage subscriptions, billing methods, and checkout.
        </p>
      )}

      {/* Owner Actions */}
      {canManage && (
        <div className="subscription-actions">
          {/* Setup pending notice */}
          {billing && !billing.ready && billing.setupReasons.length > 0 && (
            <div className="field-error" role="status" style={{ marginBottom: '1rem' }}>
              <strong>Billing setup pending:</strong> {billing.setupReasons.join(', ')}
            </div>
          )}

          {/* Checkout / Upgrade Options */}
          {billing?.actions?.checkout && (
            <div className="subscription-upgrade-box">
              <h3>Upgrade workspace plan</h3>
              <div className="subscription-upgrade-controls">
                {catalog?.plans && (
                  <Select
                    aria-label="Plan"
                    value={selectedPlanId}
                    onChange={setSelectedPlanId}
                    disabled={actionBusy || isPendingReconciliation}
                    options={catalog.plans
                      .filter((p) => p.active)
                      .map((p) => ({
                        value: p.id,
                        label: `${p.name} (${formatPlanCents(p.price.amount)})`,
                      }))}
                  />
                )}
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => handleCheckout(selectedPlanId)}
                  disabled={actionBusy || isPendingReconciliation}
                >
                  {actionBusy ? 'Processing…' : 'Proceed to checkout'}
                </button>
              </div>
            </div>
          )}

          {/* Mock Simulation Plan Switcher */}
          {isSimulation && billing?.actions?.changePlan && catalog?.plans && (
            <div
              className="mock-plan-switcher"
              style={{
                margin: '1.25rem 0',
                padding: '0.75rem',
                border: '1px dashed var(--color-border)',
                borderRadius: '6px',
                background: 'var(--color-surface-subtle)',
              }}
            >
              <h4 style={{ margin: '0 0 0.5rem' }}>Staging Simulation Plan Switcher</h4>
              <p className="settings-note" style={{ margin: '0 0 0.5rem' }}>
                Quickly test tier transitions without running checkout. Updates existing
                subscription in place.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {catalog.plans.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`button ${sub?.tierId === p.id ? 'button--primary' : 'button--quiet'}`}
                    disabled={actionBusy || isPendingReconciliation || sub?.tierId === p.id}
                    onClick={() => handleChangeMockPlan(p.id)}
                  >
                    Switch to {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Customer Portal Link */}
          {billing?.actions?.portal && (
            <div style={{ marginBottom: '1rem' }}>
              <button
                type="button"
                className="button button--quiet"
                onClick={handlePortal}
                disabled={actionBusy || isPendingReconciliation}
              >
                {actionBusy ? 'Opening…' : 'Manage Payment Method & Invoices'}
              </button>
              <p className="settings-note" style={{ marginTop: '0.25rem' }}>
                Update credit cards, view invoices, or change subscription details via Stripe
                Customer Portal.
                {billing.policy?.proration && ' Upgrades are prorated immediately.'}
              </p>
            </div>
          )}

          {/* Resume Subscription */}
          {billing?.actions?.resume && (
            <div style={{ marginBottom: '1rem' }}>
              <button
                type="button"
                className="button button--primary"
                onClick={handleResumeSubscription}
                disabled={actionBusy || isPendingReconciliation}
              >
                {actionBusy ? 'Resuming…' : 'Resume Subscription'}
              </button>
            </div>
          )}

          {/* Cancel Subscription */}
          {billing?.actions?.cancel && (
            <div
              style={{
                marginTop: '1.5rem',
                borderTop: '1px solid var(--color-border)',
                paddingTop: '1rem',
              }}
            >
              {!confirmCancel ? (
                <button
                  type="button"
                  className="button button--quiet button--danger"
                  onClick={() => setConfirmCancel(true)}
                  disabled={actionBusy || isPendingReconciliation}
                >
                  Cancel Subscription
                </button>
              ) : (
                <div
                  className="confirm-box"
                  role="alert"
                  style={{
                    padding: '0.75rem',
                    border: '1px solid var(--color-danger, #ef4444)',
                    borderRadius: '4px',
                    background: 'var(--color-surface)',
                  }}
                >
                  <p style={{ margin: '0 0 0.5rem' }}>
                    Are you sure you want to cancel your subscription? You will retain access until
                    the end of the current billing period, after which limits will revert to Free
                    tier.
                  </p>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      type="button"
                      className="button button--danger"
                      onClick={handleCancelSubscription}
                      disabled={actionBusy || isPendingReconciliation}
                    >
                      {actionBusy ? 'Canceling…' : 'Yes, Cancel at End of Period'}
                    </button>
                    <button
                      type="button"
                      className="button button--quiet"
                      onClick={() => setConfirmCancel(false)}
                      disabled={actionBusy || isPendingReconciliation}
                    >
                      Keep Subscription
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
