import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, isImportedWorkspaceKind } from './api.js';
import type { ProductSession } from './api.js';
import { AppLink } from './app-link.js';
import { SlotAssignment } from './slot-assignment.js';
import { WorkspaceSettingsMembers } from './workspace-settings-members.js';
import { OperatorHealthPanel } from './operator-health-panel.js';
import { OperatorTierCatalog } from './operator-tier-catalog.js';
import { WorkspaceLimitsEditor, workspaceRegionNames } from './operator-quota-editor.js';
import { WorkspaceBillingPanel } from './workspace-billing-panel.js';
import { WorkspaceCustomDomainsPanel } from './workspace-custom-domains-panel.js';
import { formatBudgetForecast, formatWorkspaceDatabaseMetrics } from './format-usage.js';
import { fontOptions, readFontPreference, saveFontPreference } from './font-choice.js';
import { Select } from './select.js';
import './admin-views.css';

export const ProductSessionContext = createContext<ProductSession | null>(null);
export function useProductSession() {
  return useContext(ProductSessionContext);
}

export function LandingPage() {
  const [interestState, setInterestState] = useState<'idle' | 'loading' | 'confirmed' | 'error'>(
    'idle',
  );
  const [interestSignup, setInterestSignup] = useState<{ handle: string } | null>(null);
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      new URLSearchParams(window.location.search).get('interest') !== 'joined'
    )
      return;
    setInterestState('loading');
    api
      .interestSession()
      .then(({ signup }) => {
        if (!signup) {
          setInterestState('error');
          return;
        }
        setInterestSignup({ handle: signup.handle });
        setInterestState('confirmed');
      })
      .catch(() => setInterestState('error'));
  }, []);
  return (
    <main className="landing">
      <header className="landing__nav">
        <a className="brand" href="/">
          Uptime
        </a>
        <a className="brand" href="/pricing">
          Pricing
        </a>
        <span className="mono-label">COMING SOON</span>
      </header>
      <section className="landing__hero">
        <h1>Simple uptime monitoring</h1>
        <p className="landing__lede">Free early access soon</p>
        {interestState === 'confirmed' ? (
          <p role="status">Thanks, @{interestSignup?.handle} is on the interest list.</p>
        ) : interestState === 'loading' ? (
          <p role="status">Checking your signup…</p>
        ) : (
          <>
            {interestState === 'error' && (
              <p className="field-error" role="alert">
                We couldn’t confirm that signup. Please try again.
              </p>
            )}
            <InterestForm />
          </>
        )}
        <details className="landing__disclosure">
          <summary>What we store</summary>
          <p>
            Sign in requires only identification — we do not ask for repo or account write access.
            We store your handle, DID, and workspace configuration so we know who created monitors.
            Tokens are encrypted at rest and never shared. We do not sell data or run ads.
          </p>
        </details>
      </section>
      <footer className="landing__foot">
        <p>
          An experimental project by{' '}
          <a href="https://bsky.app/profile/noz.am" target="_blank" rel="noopener noreferrer">
            @noz.am
          </a>
        </p>
      </footer>
    </main>
  );
}

export function InterestSignupPage() {
  return (
    <main className="landing landing--signup">
      <header className="landing__nav">
        <a className="brand" href="/">
          Uptime
        </a>
        <a className="brand" href="/pricing">
          Pricing
        </a>
        <span className="mono-label">EARLY ACCESS</span>
      </header>
      <section className="landing__hero">
        <h1>Join the interest list.</h1>
        <p className="landing__lede">
          We’re rolling out hosted monitoring gradually. Leave your AT Protocol handle to get early
          access when capacity opens.
        </p>
        <InterestForm />
      </section>
    </main>
  );
}

function normalizeInterestHandle(value: string) {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

export function InterestForm() {
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeInterestHandle(handle);
    if (!normalized) {
      setError('Enter your AT Protocol handle');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const returnPath = '/?interest=joined';
      const { authorizationUrl } = await api.startAtProto(normalized, returnPath);
      setSubmitted(true);
      window.location.assign(authorizationUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not reach authorization server');
      setBusy(false);
    }
  }

  return (
    <form className="landing__form" onSubmit={submit}>
      <label className="field">
        <span className="sr-only">AT Protocol handle</span>
        <input
          id="interest-handle"
          type="text"
          autoComplete="username"
          placeholder="handle.bsky.social"
          value={handle}
          disabled={busy || submitted}
          onChange={(event) => setHandle(event.target.value)}
        />
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="button button--primary"
        disabled={busy || submitted || !handle.trim()}
      >
        {busy ? 'Connecting…' : "I'm interested!"}
      </button>
    </form>
  );
}

export function AuthPage({
  mode,
  onAuthenticated,
}: {
  mode: 'login' | 'signup';
  onAuthenticated?: () => void;
}) {
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isSignup = mode === 'signup';

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeInterestHandle(handle);
    if (!normalized) {
      setError('Enter your AT Protocol handle');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { authorizationUrl } = await api.startAtProto(normalized);
      window.location.assign(authorizationUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start AT Protocol sign in');
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <header className="landing__nav">
        <a className="brand" href="/">
          Uptime
        </a>
        <a className="brand" href="/pricing">
          Pricing
        </a>
      </header>
      <form className="auth-card" onSubmit={submit}>
        <h1>{isSignup ? 'Create your workspace' : 'Sign in'}</h1>
        <p className="auth-card__lede">
          {isSignup
            ? 'Free hosted uptime monitoring. Enter your AT Protocol handle to get started.'
            : 'Sign in to access your monitored endpoints.'}
        </p>
        <label className="field">
          <span>Handle</span>
          <input
            id="atproto-handle"
            type="text"
            autoComplete="username"
            placeholder="handle.bsky.social"
            value={handle}
            disabled={busy}
            onChange={(event) => setHandle(event.target.value)}
            required
          />
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button className="button button--primary" disabled={busy || !handle.trim()}>
          {busy
            ? 'Connecting…'
            : isSignup
              ? 'Continue with AT Protocol'
              : 'Log in with AT Protocol'}
        </button>
        <p className="auth-card__switch">
          {isSignup ? 'Already have a workspace?' : 'New here?'}{' '}
          <a href={isSignup ? '/login' : '/signup'}>
            {isSignup ? 'Log in' : 'Join the interest list'}
          </a>
        </p>
      </form>
    </main>
  );
}

export function SettingsPage() {
  const session = useProductSession();
  const [fontFamily, setFontFamily] = useState(readFontPreference);
  const importedKind = session?.workspace?.kind;
  const importedWorkspace = isImportedWorkspaceKind(importedKind);
  const [members, setMembers] = useState<Awaited<ReturnType<typeof api.workspaceMembers>> | null>(
    null,
  );
  const [deletionQueued, setDeletionQueued] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [inviteHandled, setInviteHandled] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .workspaceMembers()
      .then(setMembers)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : 'Could not load workspace settings'),
      );
  }, []);

  useEffect(() => {
    const invitationId =
      typeof window === 'undefined'
        ? null
        : new URLSearchParams(window.location.search).get('invite');
    if (!invitationId || inviteHandled) return;
    setInviteHandled(true);
    api
      .acceptWorkspaceInvitation(invitationId)
      .then(async () => {
        const refreshed = await api.session();
        if (refreshed.workspace?.id)
          window.sessionStorage.setItem('uptime.workspaceId', refreshed.workspace.id);
        window.location.reload();
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : 'Could not accept invitation'),
      );
  }, [inviteHandled]);

  const canManage = session?.role === 'owner';

  async function downloadExport() {
    try {
      const payload = await api.exportWorkspace();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${session?.workspace?.name ?? 'workspace'}-export.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not export workspace');
    }
  }

  async function deleteWorkspace() {
    try {
      await api.deleteWorkspace();
      setDeleteOpen(false);
      setDeletionQueued(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not queue workspace deletion');
    }
  }

  return (
    <section className="settings-page settings-page--account">
      <div className="page-head">
        <div>
          <p className="mono-label">ACCOUNT</p>
          <h1>Settings</h1>
        </div>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-card settings-card--account">
        <h2>{session?.workspace?.name ?? 'Workspace'}</h2>
        <dl className="settings-facts">
          <div>
            <dt>Signed in as</dt>
            <dd>{session?.user?.handle ?? 'AT Protocol account'}</dd>
          </div>
          {session?.user?.did && (
            <div>
              <dt>Account ID</dt>
              <dd className="tnum">{session.user.did}</dd>
            </div>
          )}
          <div>
            <dt>Role</dt>
            <dd>{session?.role ?? 'owner'}</dd>
          </div>
        </dl>
      </div>

      <div className="settings-card">
        <h2>Appearance</h2>
        <label htmlFor="settings-font-family">Font</label>
        <Select
          id="settings-font-family"
          options={fontOptions}
          value={fontFamily}
          onChange={(value) => {
            setFontFamily(value);
            saveFontPreference(value);
          }}
        />
        <p className="ut-muted">Your font choice is saved in this browser.</p>
      </div>

      <WorkspaceBillingPanel
        workspaceId={session?.workspace?.id}
        canManage={canManage}
        importedWorkspace={importedWorkspace}
        importedKind={importedKind}
      />

      <WorkspaceCustomDomainsPanel
        workspaceId={session?.workspace?.id}
        canManage={canManage}
        importedWorkspace={importedWorkspace}
      />

      <WorkspaceSettingsMembers
        canManage={canManage}
        members={members}
        onMembersChanged={setMembers}
      />

      <div className="settings-card settings-card--actions">
        <h2>Workspace data</h2>
        <p>
          {importedWorkspace
            ? 'Download a JSON copy of your workspace.'
            : 'Download a JSON copy of your workspace or permanently delete it.'}
        </p>
        {deletionQueued ? (
          <p className="field-success" role="status">
            Deletion queued. This workspace will stop accepting checks while it is removed.
          </p>
        ) : (
          session?.role === 'owner' && (
            <>
              <div className="form-actions">
                <button className="button button--quiet" onClick={() => void downloadExport()}>
                  Download export
                </button>
                {!importedWorkspace && (
                  <button className="button button--danger" onClick={() => setDeleteOpen(true)}>
                    Delete workspace
                  </button>
                )}
              </div>
              {deleteOpen && (
                <div className="confirm-box" role="alert">
                  <p>Delete this workspace permanently?</p>
                  <div className="form-actions">
                    <button
                      className="button button--danger"
                      onClick={() => void deleteWorkspace()}
                    >
                      Yes, delete it
                    </button>
                    <button className="button button--quiet" onClick={() => setDeleteOpen(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )
        )}
      </div>
    </section>
  );
}

export function OperatorPage() {
  const session = useProductSession();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.operatorWorkspaces>> | null>(null);
  const [slots, setSlots] = useState<Awaited<ReturnType<typeof api.operatorSlots>> | null>(null);
  const [interest, setInterest] = useState<Awaited<ReturnType<typeof api.operatorInterest>> | null>(
    null,
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [controlError, setControlError] = useState('');
  const [savingControls, setSavingControls] = useState(false);
  const [workspaceActions, setWorkspaceActions] = useState<
    Record<string, { pending: boolean; error?: string }>
  >({});

  const loadOperatorData = useCallback(() => {
    setLoading(true);
    setError('');
    void Promise.all([api.operatorWorkspaces(), api.operatorSlots(), api.operatorInterest()])
      .then(([workspaces, inventory, interestList]) => {
        setData(workspaces);
        setSlots(inventory);
        setInterest(interestList);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : 'Could not load workspaces'),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (session?.isOperator) loadOperatorData();
  }, [loadOperatorData, session?.isOperator]);

  if (!session?.isOperator) {
    return (
      <section className="state state--error" role="alert">
        <p>Operator access required.</p>
      </section>
    );
  }

  return (
    <section className="settings-page operator-page">
      <div className="page-head">
        <div>
          <p className="mono-label">FOUNDER VIEW</p>
          <h1>Workspaces</h1>
        </div>
      </div>
      {error && (
        <>
          <p className="field-error" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="button button--quiet"
            disabled={loading}
            onClick={loadOperatorData}
          >
            {loading ? 'Loading…' : 'Retry loading workspaces'}
          </button>
        </>
      )}
      {!data || !slots || !interest ? (
        <p role="status">{loading ? 'Loading workspaces…' : 'Workspace data is unavailable.'}</p>
      ) : (
        <>
          <article className="settings-card operator-budget">
            <h2>Admission and budget</h2>
            <p className="operator-budget__summary">
              {data.budget.forecastUsd !== null && data.budget.forecastUsd !== undefined ? (
                <>Forecast {formatBudgetForecast(data.budget)}</>
              ) : (
                <>Forecast: Unknown / unavailable</>
              )}
              {' · ceiling $' + data.budget.ceilingUsd.toFixed(2)}
            </p>
            <p className="operator-budget__coverage">
              Coverage: {data.budget.coverage ?? 'Coverage details are pending.'} Forecast is an
              operational estimate for admission decisions and alerts.
            </p>
            <form
              className="operator-controls"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                setSavingControls(true);
                setControlError('');
                void api
                  .updateOperatorControls({
                    admissionOpen: form.get('admissionOpen') === 'on',
                    externalMonthlyCostUsd: Number(form.get('externalMonthlyCostUsd') ?? 0),
                  })
                  .then((result) =>
                    setData((current) =>
                      current ? { ...current, budget: result.budget } : current,
                    ),
                  )
                  .catch((reason) =>
                    setControlError(
                      reason instanceof Error ? reason.message : 'Could not save controls',
                    ),
                  )
                  .finally(() => setSavingControls(false));
              }}
            >
              <label className="operator-controls__admission ut-field">
                <input
                  type="checkbox"
                  name="admissionOpen"
                  defaultChecked={Boolean(data.budget.admissionOpen)}
                />
                <span>Admission {data.budget.admissionOpen ? 'open' : 'closed'}</span>
              </label>
              <label className="operator-controls__cost ut-field">
                <span className="ut-field__label">External monthly cost (USD)</span>
                <input
                  className="ut-input ut-input--mono"
                  name="externalMonthlyCostUsd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={data.budget.externalMonthlyCostUsd ?? 0}
                />
              </label>
              <button className="button button--quiet" disabled={savingControls}>
                {savingControls ? 'Saving…' : 'Save controls'}
              </button>
            </form>
            {controlError && (
              <p className="field-error" role="alert">
                {controlError}
              </p>
            )}
          </article>

          <article className="settings-card operator-budget">
            <h2>Interest list · {interest.total}</h2>
            {interest.signups.length === 0 ? (
              <p>No signups yet.</p>
            ) : (
              <ul className="operator-list">
                {interest.signups.map((signup) => (
                  <li key={signup.did} className="operator-row">
                    <div>
                      <strong>@{signup.handle}</strong>
                      <p className="tnum">{signup.did}</p>
                    </div>
                    <small>joined {new Date(signup.createdAt).toLocaleDateString()}</small>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="settings-card operator-budget">
            <details className="operator-collapsible">
              <summary>
                <span className="operator-collapsible__title">
                  <strong>Available database slots</strong>
                </span>
                <span className="operator-slots-badge">
                  {slots.availableSlots} of {slots.configuredSlots} available
                </span>
              </summary>
              <p className="operator-budget__summary">
                {slots.availableSlots} available · {slots.assignedSlots} assigned ·{' '}
                {slots.heldSlots} held · {slots.quarantinedSlots} quarantined
              </p>
              <form
                className="operator-controls"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (savingControls) return;
                  const maximum = Number(new FormData(event.currentTarget).get('maxWorkspaces'));
                  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 10) {
                    setControlError('Capacity must be a whole number from 0 to 10.');
                    return;
                  }
                  setControlError('');
                  setSavingControls(true);
                  void api
                    .updateOperatorSlots(maximum)
                    .then(setSlots)
                    .catch((reason) =>
                      setControlError(
                        reason instanceof Error ? reason.message : 'Could not update capacity',
                      ),
                    )
                    .finally(() => setSavingControls(false));
                }}
              >
                <label className="operator-controls__capacity ut-field">
                  <span className="ut-field__label">Maximum active workspaces</span>
                  <input
                    className="ut-input ut-input--mono"
                    name="maxWorkspaces"
                    type="number"
                    min="0"
                    max="10"
                    required
                    defaultValue={slots.maxWorkspaces}
                    disabled={savingControls}
                  />
                </label>
                <button className="button button--quiet" disabled={savingControls}>
                  {savingControls ? 'Saving…' : 'Save capacity'}
                </button>
              </form>
              <p className="operator-budget__coverage">
                Managed slot inventory across target regions. Pre-provisioned databases allow
                immediate assignment without deploy-time provisioning.
              </p>
              <div className="operator-slots-grid">
                {slots.slots.map((slot) => (
                  <div
                    key={slot.bindingName}
                    className={`operator-slot-card ${slot.status === 'assigned' ? 'is-assigned' : ''}`}
                  >
                    <div className="operator-slot-card__identity">
                      <div className="operator-slot-card__name">
                        <strong>
                          {slot.kind === 'legacy_import'
                            ? 'Imported production monitors'
                            : slot.kind === 'staging_import'
                              ? 'Imported staging monitors'
                              : slot.bindingName}
                        </strong>
                      </div>
                      <div className="operator-slot-card__status">
                        <small>
                          {slot.status === 'assigned'
                            ? `Assigned to ${slot.ownerHandle ?? slot.workspaceId ?? 'workspace'}`
                            : slot.status === 'deleting'
                              ? 'Deleting'
                              : slot.status === 'quarantined'
                                ? 'Quarantined'
                                : slot.admissionEnabled
                                  ? 'Available'
                                  : 'Held'}
                        </small>
                      </div>
                    </div>
                    {!isImportedWorkspaceKind(slot.kind) &&
                      slot.status === 'available' &&
                      slot.workspaceId === null && (
                        <button
                          className="button button--quiet"
                          disabled={savingControls}
                          onClick={() => {
                            if (savingControls) return;
                            setControlError('');
                            setSavingControls(true);
                            void api
                              .setSlotAdmission(slot.bindingName, !slot.admissionEnabled)
                              .then(setSlots)
                              .catch((reason) =>
                                setControlError(
                                  reason instanceof Error
                                    ? reason.message
                                    : 'Could not change slot admission',
                                ),
                              )
                              .finally(() => setSavingControls(false));
                          }}
                        >
                          {slot.admissionEnabled ? 'Hold' : 'Make available'}
                        </button>
                      )}
                    {slot.status === 'available' && slot.workspaceId === null && (
                      <SlotAssignment
                        bindingName={slot.bindingName}
                        imported={isImportedWorkspaceKind(slot.kind)}
                        signups={interest.signups}
                        onAssigned={async () => {
                          const [inventory, workspaces] = await Promise.all([
                            api.operatorSlots(),
                            api.operatorWorkspaces(),
                          ]);
                          setSlots(inventory);
                          setData(workspaces);
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </details>
          </article>

          <article className="settings-card">
            <OperatorHealthPanel knownWorkspaces={data.workspaces} />
          </article>

          <OperatorTierCatalog availableRegions={data.availableRegions} />

          <div className="operator-list operator-workspaces">
            {data.workspaces?.map((workspace) => {
              const canSuspend =
                workspace.state === 'active' ||
                workspace.state === 'suspended' ||
                workspace.state === 'waiting_for_capacity';
              const nextState = workspace.state === 'active' ? 'suspended' : 'active';
              return (
                <article className="settings-card operator-row" key={workspace.id}>
                  <div>
                    <h2>{workspace.name}</h2>
                    <p>
                      {workspace.ownerHandle} · {workspace.ownerDid} · {workspace.state}
                    </p>
                    <small>
                      {workspace.monitorCount.toLocaleString()} monitors ·{' '}
                      {formatWorkspaceDatabaseMetrics(workspace)} · last seen{' '}
                      {workspace.lastSeenAt
                        ? new Date(workspace.lastSeenAt).toLocaleString()
                        : 'never'}
                    </small>
                    {workspace.limits ? (
                      <p className="operator-workspace-limits">
                        Limit: {workspace.limits.monitors.toLocaleString()} saved monitors · up to{' '}
                        {workspace.limits.regions} regions per monitor · allowed:{' '}
                        {workspaceRegionNames(workspace.limits.allowedRegionIds)}
                      </p>
                    ) : (
                      <p className="operator-workspace-limits">
                        Hosted limit editing is unavailable for this workspace's import or
                        provisioning state.
                      </p>
                    )}
                  </div>
                  <div className="operator-row__actions">
                    <AppLink
                      className="button button--secondary"
                      href={`/operator/workspaces/${encodeURIComponent(workspace.id)}`}
                    >
                      Edit workspace
                    </AppLink>
                    {canSuspend && (
                      <>
                        <button
                          className="button button--quiet"
                          disabled={workspaceActions[workspace.id]?.pending}
                          onClick={() => {
                            if (workspaceActions[workspace.id]?.pending) return;
                            setWorkspaceActions((current) => ({
                              ...current,
                              [workspace.id]: { pending: true },
                            }));
                            void api
                              .setWorkspaceState(
                                workspace.id,
                                nextState,
                                nextState === 'suspended' ? 'Operator action' : 'Operator restored',
                              )
                              .then(() => api.operatorSlots())
                              .then((inventory) => {
                                setSlots(inventory);
                                setData((current) =>
                                  current
                                    ? {
                                        ...current,
                                        workspaces: current.workspaces?.map((item) =>
                                          item.id === workspace.id
                                            ? { ...item, state: nextState }
                                            : item,
                                        ),
                                      }
                                    : current,
                                );
                              })
                              .catch((reason) =>
                                setWorkspaceActions((current) => ({
                                  ...current,
                                  [workspace.id]: {
                                    pending: false,
                                    error:
                                      reason instanceof Error
                                        ? reason.message
                                        : 'Could not update workspace',
                                  },
                                })),
                              )
                              .finally(() =>
                                setWorkspaceActions((current) => ({
                                  ...current,
                                  [workspace.id]: { ...current[workspace.id], pending: false },
                                })),
                              );
                          }}
                        >
                          {workspace.state === 'active'
                            ? 'Suspend'
                            : workspace.state === 'suspended'
                              ? 'Resume'
                              : 'Activate'}
                        </button>
                        {workspaceActions[workspace.id]?.pending && (
                          <p role="status">
                            {nextState === 'suspended'
                              ? 'Suspending'
                              : workspace.state === 'suspended'
                                ? 'Resuming'
                                : 'Activating'}{' '}
                            workspace…
                          </p>
                        )}
                        {workspaceActions[workspace.id]?.error && (
                          <p role="alert" className="field-error">
                            {workspaceActions[workspace.id]?.error}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

export function OperatorWorkspaceEditPage({ workspaceId }: { workspaceId: string }) {
  const session = useProductSession();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.operatorWorkspaces>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!session?.isOperator) return;
    let active = true;
    setLoading(true);
    setError('');
    void api
      .operatorWorkspaces()
      .then((result) => {
        if (active) setData(result);
      })
      .catch((reason) => {
        if (active)
          setError(reason instanceof Error ? reason.message : 'Could not load workspace.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session?.isOperator, workspaceId, reload]);

  if (!session?.isOperator) {
    return (
      <section className="state state--error" role="alert">
        <p>Operator access required.</p>
      </section>
    );
  }

  const workspace = data?.workspaces?.find((item) => item.id === workspaceId);

  return (
    <section className="settings-page operator-workspace-edit">
      <AppLink className="button button--quiet" href="/operator">
        Back to workspaces
      </AppLink>
      <div className="page-head">
        <div>
          <p className="mono-label">Operator</p>
          <h1>{workspace?.name ?? 'Edit workspace'}</h1>
        </div>
      </div>
      {loading ? (
        <p role="status">Loading workspace…</p>
      ) : error ? (
        <div className="state state--error" role="alert">
          <p>Could not load workspace: {error}</p>
          <button className="button button--quiet" onClick={() => setReload((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : !workspace ? (
        <p role="alert">
          Workspace not found. Return to the workspace list and choose another workspace.
        </p>
      ) : (
        <>
          <article className="settings-card operator-workspace-edit__summary">
            <h2>Workspace</h2>
            <p>{workspace.ownerHandle} · {workspace.ownerDid}</p>
            <p>Status: {workspace.state} · {workspace.monitorCount.toLocaleString()} monitors</p>
          </article>
          {workspace.limits ? (
            <article className="settings-card operator-workspace-edit__limits">
              <h2>Limits</h2>
              <WorkspaceLimitsEditor
                workspace={workspace}
                availableRegions={data?.availableRegions ?? []}
                onSaved={(limits) =>
                  setData((current) =>
                    current
                      ? {
                          ...current,
                          workspaces: current.workspaces.map((item) =>
                            item.id === workspaceId ? { ...item, limits } : item,
                          ),
                        }
                      : current,
                  )
                }
              />
              <AppLink className="button button--quiet" href="/operator">
                Cancel and return to workspaces
              </AppLink>
            </article>
          ) : (
            <p>
              Hosted limit editing is unavailable for this workspace's import or provisioning state.
            </p>
          )}
        </>
      )}
    </section>
  );
}
