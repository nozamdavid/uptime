import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { MonitorSummary } from '@uptime/contracts';
import { api } from './api.js';
import { MonitorDetail } from './monitor-detail.js';
import { MonitorForm } from './monitor-form.js';
import { monitorDisplayName } from './monitor-format.js';
import { MonitorList } from './monitor-list.js';
import { NotificationsPage } from './notifications.js';
import { PublicStatusPage, StatusPageEditor, StatusPagesIndex } from './status-pages.js';
import './styles.css';

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Overview });
const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/monitors/$monitorId',
  component: DetailRoute,
});
const publicDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/monitors/public/$monitorId',
  component: PublicDetailRoute,
});
const statusPagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/status-pages',
  component: StatusPagesIndex,
});
const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notifications',
  component: NotificationsPage,
});
const statusPageEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/status-pages/$statusPageId',
  component: StatusPageEditorRoute,
});
const publicStatusPageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/status/$statusPageId',
  component: PublicStatusPageRoute,
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  detailRoute,
  publicDetailRoute,
  statusPagesRoute,
  notificationsRoute,
  statusPageEditorRoute,
  publicStatusPageRoute,
]);
const router = createRouter({ routeTree });
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function isPublicMonitorPath(pathname: string) {
  return pathname.startsWith('/monitors/public/') || pathname.startsWith('/status/');
}

function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isPublicRoute = isPublicMonitorPath(pathname);
  const isPublicStatusPage = pathname.startsWith('/status/');
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  useEffect(() => {
    if (isPublicRoute) return;
    api
      .session()
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, [isPublicRoute]);
  if (isPublicRoute)
    return (
      <main
        className={`workspace public-workspace${isPublicStatusPage ? ' public-status-workspace' : ''}`}
      >
        <Outlet />
      </main>
    );
  if (authenticated === null)
    return (
      <div className="center-state" role="status">
        Loading session…
      </div>
    );
  if (!authenticated) return <SignIn onSuccess={() => setAuthenticated(true)} />;
  return (
    <Workspace onSignOut={() => setAuthenticated(false)}>
      <Outlet />
    </Workspace>
  );
}

function SignIn({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.signIn(password);
      onSuccess();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="signin">
      <form className="signin__form" onSubmit={submit}>
        <p className="product-mark">UPTIME / PERSONAL ADMIN</p>
        <h1>Sign in</h1>
        <p>Use the administrator account configured for this installation.</p>
        <Field label="Password" type="password" value={password} onChange={setPassword} required />
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button className="button button--primary" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

function Workspace({ children, onSignOut }: { children: React.ReactNode; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [monitors, setMonitors] = useState<MonitorSummary[]>([]);
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const navigate = useNavigate();
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      setSelected(0);
      void api
        .monitors()
        .then((result) => setMonitors(result.monitors))
        .catch(() => setMonitors([]));
      setTimeout(() => input.current?.focus(), 0);
      document.body.style.overflow = 'hidden';
    } else if (wasOpen.current) {
      wasOpen.current = false;
      trigger.current?.focus();
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);
  const results = monitors
    .filter((item) =>
      `${item.monitor.name ?? ''} ${item.monitor.url}`.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 8);
  const openResult = (item: MonitorSummary | undefined) => {
    if (!item) return;
    void navigate({ to: '/monitors/$monitorId', params: { monitorId: item.monitor.id } });
    setOpen(false);
    setQuery('');
  };
  return (
    <>
      <header className="topbar">
        <div className="topbar__inner">
          <nav className="topbar__nav" aria-label="Admin sections">
            <a className="brand" href="/">
              Monitors
            </a>
            <span className="topbar__divider" aria-hidden="true" />
            <a className="brand" href="/status-pages">
              Status pages
            </a>
            <span className="topbar__divider" aria-hidden="true" />
            <a className="brand" href="/notifications">
              Notifications
            </a>
          </nav>
          <button
            ref={trigger}
            className="search-pill"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
          >
            <span>Search monitors</span>
            <span className="search-pill__mobile">Search</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="topbar__actions">
            <button
              className="button button--quiet"
              onClick={() => void api.signOut().finally(onSignOut)}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="workspace">{children}</main>
      <footer className="footer-line">
        <span>Personal monitor</span>
      </footer>
      {open && (
        <div
          className="palette-layer"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Search monitors"
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const focusable = [
                ...event.currentTarget.querySelectorAll<HTMLElement>('input, button'),
              ];
              const first = focusable[0];
              const last = focusable.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <label className="sr-only" htmlFor="monitor-search">
              Search monitors
            </label>
            <div className="palette__head">
              <input
                ref={input}
                id="monitor-search"
                className="palette__input"
                role="combobox"
                aria-expanded="true"
                aria-controls="monitor-search-results"
                aria-activedescendant={
                  results[selected] ? `monitor-result-${results[selected].monitor.id}` : undefined
                }
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelected(0);
                }}
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setSelected((value) => Math.min(value + 1, Math.max(0, results.length - 1)));
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setSelected((value) => Math.max(0, value - 1));
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    openResult(results[selected]);
                  }
                }}
                placeholder="Search monitors…"
              />
              <button className="button button--quiet" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            <div className="palette__results" id="monitor-search-results" role="listbox">
              {results.length === 0 ? (
                <p className="palette__empty">No matching monitors.</p>
              ) : (
                results.map((item, index) => (
                  <button
                    id={`monitor-result-${item.monitor.id}`}
                    key={item.monitor.id}
                    className={`palette__result${index === selected ? ' is-active' : ''}`}
                    role="option"
                    aria-selected={index === selected}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => openResult(item)}
                  >
                    <strong>{monitorDisplayName(item.monitor)}</strong>
                    <small>{item.monitor.url}</small>
                  </button>
                ))
              )}
            </div>
            <p className="palette__hint">
              <kbd>↑</kbd>
              <kbd>↓</kbd> navigate <kbd>Enter</kbd> open <kbd>Esc</kbd> close
            </p>
          </section>
        </div>
      )}
    </>
  );
}

function Overview() {
  const [formOpen, setFormOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.monitors>>['monitors'] | null>(
    null,
  );
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setItems(null);
    api
      .monitors()
      .then((data) => alive && setItems(data.monitors))
      .catch(
        (reason) =>
          alive && setError(reason instanceof Error ? reason.message : 'Could not load monitors'),
      );
    return () => {
      alive = false;
    };
  }, [reload]);
  return (
    <>
      {formOpen ? (
        <MonitorForm
          onCancel={() => setFormOpen(false)}
          onSaved={() => {
            setFormOpen(false);
            setReload((value) => value + 1);
          }}
        />
      ) : (
        <section className="overview">
          <div className="page-head">
            <div>
              <h1>Monitors</h1>
              {items && (
                <p className="tnum">
                  {items
                    .reduce((total, item) => total + item.targetChecksPerDay, 0)
                    .toLocaleString()}{' '}
                  total requests/day
                </p>
              )}
            </div>
            {items && items.length > 0 && (
              <button className="button button--primary" onClick={() => setFormOpen(true)}>
                Add monitor
              </button>
            )}
          </div>
          {error ? (
            <State
              kind="error"
              text={error}
              action={() => {
                setError('');
                setReload((value) => value + 1);
              }}
            />
          ) : items === null ? (
            <State kind="loading" text="Loading monitors…" />
          ) : items.length === 0 ? (
            <State
              kind="empty"
              text="No monitors yet. Add a URL to start recording regional checks."
              action={() => setFormOpen(true)}
            />
          ) : (
            <MonitorList items={items} onChanged={() => setReload((value) => value + 1)} />
          )}
        </section>
      )}
    </>
  );
}

function DetailRoute() {
  const { monitorId } = detailRoute.useParams();
  return <MonitorDetail monitorId={monitorId} />;
}
function PublicDetailRoute() {
  const { monitorId } = publicDetailRoute.useParams();
  const statusPageId = new URLSearchParams(window.location.search).get('statusPage') ?? undefined;
  return (
    <MonitorDetail monitorId={monitorId} publicMode {...(statusPageId ? { statusPageId } : {})} />
  );
}
function StatusPageEditorRoute() {
  const { statusPageId } = statusPageEditorRoute.useParams();
  return <StatusPageEditor statusPageId={statusPageId} />;
}
function PublicStatusPageRoute() {
  const { statusPageId } = publicStatusPageRoute.useParams();
  return <PublicStatusPage statusPageId={statusPageId} />;
}
function Field({
  label,
  type,
  value,
  onChange,
  required,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
      />
    </label>
  );
}
function State({
  kind,
  text,
  action,
}: {
  kind: 'loading' | 'error' | 'empty';
  text: string;
  action?: () => void;
}) {
  return (
    <div className={`state state--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <p>{text}</p>
      {action && (
        <button className="button button--quiet" onClick={action}>
          {kind === 'error' ? 'Try again' : 'Add monitor'}
        </button>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
