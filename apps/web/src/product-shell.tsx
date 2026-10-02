import { createContext, useContext, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from './api.js';
import type { ProductSession } from './api.js';

const FREE_LIMITS = [
  ['3 monitors', 'Track the endpoints that matter most.'],
  ['5 minute checks', 'A calm cadence for personal services.'],
  ['up to 3 regions', 'Checks from three locations.'],
  ['24h detailed history', 'Inspect every recent check.'],
  ['30d daily history', 'See the longer uptime trend.'],
  ['1 status page', 'Share one clear public status page.'],
] as const;

export const ProductSessionContext = createContext<ProductSession | null>(null);
export function useProductSession() {
  return useContext(ProductSessionContext);
}

export function LandingPage() {
  return (
    <main className="landing">
      <header className="landing__nav">
        <a className="brand" href="/">
          Uptime
        </a>
        <nav aria-label="Site navigation">
          <a href="#limits">Free plan</a>
          <a href="/login">Log in</a>
        </nav>
      </header>
      <section className="landing__hero">
        <p className="mono-label">UPTIME FOR SMALL SYSTEMS</p>
        <h1>Know when your service is down.</h1>
        <p className="landing__lede">
          Simple regional checks, useful history, and a public status page. Free for personal
          projects.
        </p>
        <div className="landing__actions">
          <a className="button button--primary" href="/signup">
            Start free with AT Protocol
          </a>
          <a className="button button--quiet" href="https://bsky.app/signup">
            Create an AT Protocol account
          </a>
        </div>
        <p className="landing__note">
          No password or email stored here. Your DID is the stable account identity; your handle can
          change.
        </p>
      </section>
      <section className="landing__details" id="limits" aria-labelledby="free-plan-title">
        <div>
          <p className="mono-label">THE FREE PLAN</p>
          <h2 id="free-plan-title">Everything needed to keep an eye on a small service.</h2>
        </div>
        <div className="free-limit-grid">
          {FREE_LIMITS.map(([title, detail]) => (
            <article className="free-limit" key={title}>
              <strong>{title}</strong>
              <p>{detail}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="landing__policies" aria-label="Policies">
        <p id="privacy">
          <strong>Privacy.</strong> Uptime uses your AT Protocol DID as your stable account identity
          and displays your current handle. It stores encrypted session tokens needed to keep you
          signed in. Monitored URLs, check results, notification settings, and public status content
          are used to provide the service.
        </p>
        <p id="terms">
          <strong>Terms.</strong> Use the service for systems you own or are authorized to monitor.
          Workspace owners control members and deletion; deletion requests are queued and stop new
          checks while data is removed. For account or monitoring questions, contact the service
          owner.
        </p>
      </section>
      <footer className="landing__footer">
        <span>Built for independent builders.</span>
        <span>
          <a href="#privacy">Privacy</a> · <a href="#terms">Terms</a> ·{' '}
          <a href="/signup">Start monitoring</a>
        </span>
      </footer>
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
          <a href={isSignup ? '/login' : '/signup'}>{isSignup ? 'Log in' : 'Create one free'}</a>
        </p>
      </form>
    </main>
  );
}

export function SettingsPage() {
  const session = useProductSession();
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
    <section className="settings-page">
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
        <h2>Free plan</h2>
        {usage ? (
          <p>
            {usage.usage.monitors} / {usage.limits.monitors} monitors · {usage.usage.statusPages} /{' '}
            {usage.limits.statusPages} status pages · {usage.usage.notificationServices} /{' '}
            {usage.limits.notificationServices} notification services
          </p>
        ) : (
          <p role="status">Loading usage…</p>
        )}
        <p className="settings-note">
          Includes 5 minute checks, up to 3 regions, 24 hours of detailed history, and 30 days of
          daily history.
        </p>
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
                  <a href={`/settings?invite=${encodeURIComponent(invitation.id)}`}>
                    Share accept link
                  </a>
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
        <p>Download a JSON copy of your workspace or permanently delete it.</p>
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
                <button className="button button--danger" onClick={() => setDeleteOpen(true)}>
                  Delete workspace
                </button>
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
  const [error, setError] = useState('');
  const [controlError, setControlError] = useState('');
  const [savingControls, setSavingControls] = useState(false);
  useEffect(() => {
    if (session?.isOperator)
      api
        .operatorWorkspaces()
        .then(setData)
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
    <section className="settings-page">
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
      {!data ? (
        <p role="status">Loading workspaces…</p>
      ) : (
        <>
          <article className="settings-card operator-budget">
            <h2>Admission and budget</h2>
            <p className="operator-budget__summary">
              Forecast $
              {((data.budget.baseUsd ?? 0) + (data.budget.externalMonthlyCostUsd ?? 0)).toFixed(2)}
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
          <div className="operator-list">
            {data.workspaces?.map((workspace) => {
              const canSuspend = workspace.state === 'active' || workspace.state === 'suspended';
              return (
                <article className="settings-card operator-row" key={workspace.id}>
                  <div>
                    <h2>{workspace.name}</h2>
                    <p>
                      {workspace.ownerHandle} · {workspace.ownerDid} · {workspace.state}
                    </p>
                    <small>
                      {workspace.monitorCount} monitors · {workspace.rowsRead} rows read ·{' '}
                      {workspace.rowsWritten} rows written · {workspace.storageBytes} bytes · last
                      seen {workspace.lastSeenAt ?? 'never'}
                    </small>
                  </div>
                  {canSuspend && (
                    <button
                      className="button button--quiet"
                      onClick={() => {
                        const state = workspace.state === 'suspended' ? 'active' : 'suspended';
                        setControlError('');
                        void api
                          .setWorkspaceState(
                            workspace.id,
                            state,
                            state === 'suspended' ? 'Operator action' : 'Operator restored',
                          )
                          .then(() =>
                            setData((current) =>
                              current
                                ? {
                                    ...current,
                                    workspaces: current.workspaces?.map((item) =>
                                      item.id === workspace.id ? { ...item, state } : item,
                                    ),
                                  }
                                : current,
                            ),
                          )
                          .catch((reason) =>
                            setControlError(
                              reason instanceof Error
                                ? reason.message
                                : 'Could not update workspace',
                            ),
                          );
                      }}
                    >
                      {workspace.state === 'suspended' ? 'Activate' : 'Suspend'}
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
