import { createContext, useContext, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from './api.js';
import type { ProductSession } from './api.js';
import { SlotAssignment } from './slot-assignment.js';
import { AppLink } from './app-link.js';

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
            Your verified AT Protocol DID, handle, and signup date, for this interest check only.
            The list is visible to the service owner. Joining is free, creates no monitoring
            workspace, and does not guarantee a launch date or early access.
          </p>
        </details>
      </section>
      <footer className="landing__footer">
        <span>
          Built by <a href="https://bsky.app/profile/noz.am">@noz.am</a>
        </span>
        <a href="/operator">Operator</a>
      </footer>
    </main>
  );
}

export function InterestForm() {
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('auth_error')
      ? 'AT Protocol sign-in was not completed. Please try again.'
      : '',
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.startAtProto(handle.trim(), '/?interest=joined');
      if (result.authorizationUrl) window.location.assign(result.authorizationUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start signup');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="auth-card" onSubmit={submit} noValidate>
      <label className="field" htmlFor="interest-handle">
        <span>AT Protocol handle</span>
        <input
          id="interest-handle"
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          placeholder="you.bsky.social"
          autoComplete="username"
          required
        />
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button className="button button--primary" disabled={busy || !handle.trim()}>
        {busy ? 'Connecting…' : "I'm interested!"}
      </button>
    </form>
  );
}

export function InterestSignupPage() {
  return (
    <main className="auth-page">
      <a className="brand auth-page__brand" href="/">
        Uptime
      </a>
      <p className="mono-label">COMING SOON</p>
      <h1>Join the interest list.</h1>
      <p>We’ll use your AT Protocol identity only. No password or posting permission.</p>
      <InterestForm />
      <p className="auth-card__switch">
        <a href="/">Back to home</a>
      </p>
    </main>
  );
}

export function AuthPage({
  mode,
  onAuthenticated,
}: {
  mode: 'login' | 'signup';
  onAuthenticated: () => void;
}) {
  const [handle, setHandle] = useState('');
  const [error, setError] = useState(() => {
    const authError =
      typeof window === 'undefined'
        ? ''
        : new URLSearchParams(window.location.search).get('auth_error');
    return authError
      ? 'AT Protocol sign-in was not completed. Check the handle and try again.'
      : '';
  });
  const [busy, setBusy] = useState(false);
  const isSignup = mode === 'signup';
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.startAtProto(handle.trim());
      if (result.authorizationUrl) window.location.assign(result.authorizationUrl);
      else onAuthenticated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start AT Protocol login');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <a className="brand auth-page__brand" href="/">
        Uptime
      </a>
      <form className="auth-card" onSubmit={submit} noValidate>
        <p className="mono-label">{isSignup ? 'CREATE YOUR FREE WORKSPACE' : 'WELCOME BACK'}</p>
        <h1>{isSignup ? 'Start with your AT Protocol handle.' : 'Log in with AT Protocol.'}</h1>
        <p>
          {isSignup
            ? 'Your first successful login creates a free workspace automatically.'
            : 'Continue with the identity you use on the AT Protocol.'}
        </p>
        <label className="field" htmlFor="atproto-handle">
          <span>Handle</span>
          <input
            id="atproto-handle"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="you.bsky.social"
            autoComplete="username"
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
  const importedStaging = session?.workspace?.kind === 'staging_import';
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof api.usage>> | null>(null);
  const [members, setMembers] = useState<Awaited<ReturnType<typeof api.workspaceMembers>> | null>(
    null,
  );
  const [inviteDid, setInviteDid] = useState('');
  const [inviteRole, setInviteRole] = useState<'maintainer' | 'viewer'>('viewer');
  const [message, setMessage] = useState('');
  const [deletionQueued, setDeletionQueued] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [inviteHandled, setInviteHandled] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([api.usage(), api.workspaceMembers()])
      .then(([nextUsage, nextMembers]) => {
        setUsage(nextUsage);
        setMembers(nextMembers);
      })
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
  async function invite(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    try {
      await api.inviteWorkspaceMember(inviteDid.trim(), inviteRole);
      setInviteDid('');
      setMessage('Invitation sent.');
      const next = await api.workspaceMembers();
      setMembers(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not invite member');
    }
  }
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
      <div className="settings-card">
        <h2>{session?.workspace?.name ?? 'Workspace'}</h2>
        <p>
          Signed in as <strong>{session?.user?.handle ?? 'AT Protocol account'}</strong>
        </p>
        {session?.user?.did && <p className="tnum">{session.user.did}</p>}
        <p>Role: {session?.role ?? 'owner'}</p>
      </div>
      <div className="settings-card">
        <h2>{importedStaging ? 'Imported staging monitors' : 'Free plan'}</h2>
        {usage && importedStaging ? (
          <>
            <p>
              {usage.usage.monitors} monitors · {usage.usage.statusPages} status pages ·{' '}
              {usage.usage.notificationServices} notification services
            </p>
            <p className="settings-note">
              This workspace keeps the existing staging checks and history. Its limits and retention
              follow the imported staging system.
            </p>
          </>
        ) : usage && usage.limits ? (
          <p>
            {usage.usage.monitors} / {usage.limits.monitors} monitors · {usage.usage.statusPages} /{' '}
            {usage.limits.statusPages} status pages · {usage.usage.notificationServices} /{' '}
            {usage.limits.notificationServices} notification services
          </p>
        ) : (
          <p role="status">Loading usage…</p>
        )}
        {!importedStaging && (
          <p className="settings-note">
            Includes 5 minute checks, up to 3 regions, 24 hours of detailed history, and 30 days of
            daily history.
          </p>
        )}
      </div>
      <div className="settings-card">
        <h2>Members</h2>
        {members ? (
          <div className="member-list">
            {members.members.map((member) => (
              <div className="member-row" key={member.did}>
                <span>
                  <strong>{member.handle}</strong>
                  <small className="tnum">{member.did}</small>
                </span>
                <span>
                  {member.role}
                  {canManage && member.role !== 'owner' && (
                    <button
                      className="button button--quiet"
                      onClick={() =>
                        void api
                          .removeWorkspaceMember(member.did)
                          .then(() => api.workspaceMembers())
                          .then(setMembers)
                      }
                    >
                      Remove
                    </button>
                  )}
                </span>
              </div>
            ))}
            {members.invitations.map((invitation) => (
              <div className="member-row" key={invitation.id}>
                <span>
                  Invitation to <span className="tnum">{invitation.inviteeDid}</span>
                </span>
                <span>
                  {invitation.role} · expires in 7 days{' '}
                  <AppLink href={`/settings?invite=${encodeURIComponent(invitation.id)}`}>
                    Share accept link
                  </AppLink>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p role="status">Loading members…</p>
        )}
        {canManage && (
          <form className="member-invite" onSubmit={invite}>
            <label className="field">
              <span>Invite DID</span>
              <input
                value={inviteDid}
                onChange={(event) => setInviteDid(event.target.value)}
                placeholder="did:plc:…"
                required
              />
            </label>
            <label className="field">
              <span>Role</span>
              <select
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as 'maintainer' | 'viewer')}
              >
                <option value="viewer">Viewer</option>
                <option value="maintainer">Maintainer</option>
              </select>
            </label>
            <button className="button button--quiet" disabled={!inviteDid.trim()}>
              Invite member
            </button>
          </form>
        )}
        {message && <p role="status">{message}</p>}
      </div>
      <div className="settings-card settings-card--actions">
        <h2>Workspace data</h2>
        <p>
          {importedStaging
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
                {!importedStaging && (
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
  const [controlError, setControlError] = useState('');
  const [savingControls, setSavingControls] = useState(false);
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    if (session?.isOperator)
      Promise.all([api.operatorWorkspaces(), api.operatorSlots(), api.operatorInterest()])
        .then(([workspaces, inventory, interestList]) => {
          setData(workspaces);
          setSlots(inventory);
          setInterest(interestList);
        })
        .catch((reason) =>
          setError(reason instanceof Error ? reason.message : 'Could not load workspaces'),
        );
  }, [session?.isOperator]);
  if (!session?.isOperator)
    return (
      <section className="state state--error" role="alert">
        <p>Operator access required.</p>
      </section>
    );
  return (
    <section className="settings-page operator-page">
      <div className="page-head">
        <div>
          <p className="mono-label">FOUNDER VIEW</p>
          <h1>Workspaces</h1>
        </div>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {!data || !slots || !interest ? (
        <p role="status">Loading workspaces…</p>
      ) : (
        <>
          <article className="settings-card operator-budget">
            <h2>Admission and budget</h2>
            <p className="operator-budget__summary">
              Forecast $
              {(
                data.budget.forecastUsd ??
                (data.budget.baseUsd ?? 0) + (data.budget.externalMonthlyCostUsd ?? 0)
              ).toFixed(2)}
              /mo · ceiling ${data.budget.ceilingUsd.toFixed(2)}
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
              <label className="operator-controls__admission">
                <input
                  type="checkbox"
                  name="admissionOpen"
                  defaultChecked={data.budget.admissionOpen ?? true}
                />
                <span>Admission {data.budget.admissionOpen === false ? 'closed' : 'open'}</span>
              </label>
              <label>
                External monthly cost (USD)
                <input
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
              <details className="operator-interest">
                <summary>View {interest.signups.length} recent signups</summary>
                <div className="operator-list">
                  {interest.signups.map((signup) => (
                    <div className="operator-row" key={signup.did}>
                      <div>
                        <strong>@{signup.handle}</strong>
                        <small>{signup.did}</small>
                      </div>
                      <small>{new Date(signup.createdAt).toLocaleDateString()}</small>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </article>
          <article className="settings-card operator-budget operator-capacity">
            <h2>Capacity pool</h2>
            <p>
              {slots.availableSlots} available · {slots.assignedSlots} assigned · {slots.heldSlots}{' '}
              held · {slots.quarantinedSlots} quarantined
            </p>
            <p className="operator-budget__coverage">
              {slots.configuredSlots} configured Cloudflare database slots. This controls the
              configured pool; deployment precreates and migrates its databases. The last available
              database stays reserved for testing.
            </p>
            <form
              className="operator-controls"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                setSavingControls(true);
                setControlError('');
                void api
                  .updateOperatorSlots(Number(form.get('maxWorkspaces') ?? slots.maxWorkspaces))
                  .then(setSlots)
                  .catch((reason) =>
                    setControlError(
                      reason instanceof Error ? reason.message : 'Could not update capacity limit',
                    ),
                  )
                  .finally(() => setSavingControls(false));
              }}
            >
              <label>
                Public workspace limit
                <input
                  name="maxWorkspaces"
                  type="number"
                  min="1"
                  max="10"
                  defaultValue={slots.maxWorkspaces}
                  disabled={savingControls}
                />
              </label>
              <button className="button button--quiet" disabled={savingControls}>
                {savingControls ? 'Saving…' : 'Save limit'}
              </button>
            </form>
            <details className="operator-capacity-details">
              <summary>Manage {slots.configuredSlots} database slots</summary>
              <div className="operator-list operator-slot-list">
                {slots.slots.map((slot) => (
                  <div className="operator-row" key={slot.bindingName}>
                    <div>
                      <strong>
                        {slot.kind === 'staging_import'
                          ? 'Imported staging monitors'
                          : slot.bindingName}
                      </strong>
                      <small>
                        {slot.status === 'assigned'
                          ? `Assigned to ${slot.ownerHandle ?? slot.workspaceId ?? 'workspace'}`
                          : slot.status === 'deleting'
                            ? 'Deleting'
                            : slot.admissionEnabled
                              ? 'Available'
                              : 'Held'}
                      </small>
                    </div>
                    {slot.kind !== 'staging_import' &&
                      slot.status === 'available' &&
                      slot.workspaceId === null && (
                        <button
                          className="button button--quiet"
                          disabled={savingControls}
                          onClick={() => {
                            setSavingControls(true);
                            setControlError('');
                            void api
                              .setSlotAdmission(slot.bindingName, !slot.admissionEnabled)
                              .then(setSlots)
                              .catch((reason) =>
                                setControlError(
                                  reason instanceof Error
                                    ? reason.message
                                    : 'Could not update slot admission',
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
                        imported={slot.kind === 'staging_import'}
                        signups={interest.signups.filter(
                          (signup) => signup.did !== session?.user?.did,
                        )}
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
                      {workspace.rowsRead.toLocaleString()} rows read ·{' '}
                      {workspace.rowsWritten.toLocaleString()} rows written ·{' '}
                      {(workspace.storageBytes / 1_048_576).toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}{' '}
                      MiB · last seen{' '}
                      {workspace.lastSeenAt
                        ? new Date(workspace.lastSeenAt).toLocaleString()
                        : 'never'}
                    </small>
                  </div>
                  {canSuspend && (
                    <button
                      className="button button--quiet"
                      disabled={pendingWorkspaceId === workspace.id}
                      onClick={() => {
                        setPendingWorkspaceId(workspace.id);
                        setControlError('');
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
                            setControlError(
                              reason instanceof Error
                                ? reason.message
                                : 'Could not update workspace',
                            ),
                          )
                          .finally(() => setPendingWorkspaceId(null));
                      }}
                    >
                      {workspace.state === 'active'
                        ? 'Suspend'
                        : workspace.state === 'suspended'
                          ? 'Resume'
                          : 'Activate'}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
