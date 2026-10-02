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
import type { KeyboardEvent } from 'react';
import type { MonitorSummary } from '@uptime/contracts';
import { api } from './api.js';
import type { ProductSession } from './api.js';
import { MonitorDetail } from './monitor-detail.js';
import { MonitorForm } from './monitor-form.js';
import { monitorDisplayName } from './monitor-format.js';
import { MonitorList } from './monitor-list.js';
import { NotificationsPage } from './notifications.js';
import { PublicStatusPage, StatusPageEditor, StatusPagesIndex } from './status-pages.js';
import './styles.css';
import {
  AuthPage,
  LandingPage,
  OperatorPage,
  ProductSessionContext,
  SettingsPage,
} from './product-shell.js';

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LandingPage,
});
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app',
  component: Overview,
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginRoute,
});
const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signup',
  component: SignupRoute,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});
const operatorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/operator',
  component: OperatorPage,
});
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
  appRoute,
  loginRoute,
  signupRoute,
  settingsRoute,
  operatorRoute,
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
  const isLanding = pathname === '/';
  const isAuthRoute = pathname === '/login' || pathname === '/signup';
  const [session, setSession] = useState<ProductSession | null>(null);
  const [authenticated, setAuthenticated] = useState<boolean | null>(
    isLanding || isAuthRoute ? false : null,
  );
  useEffect(() => {
    if (isPublicRoute || isLanding || isAuthRoute) return;
    api
      .session()
      .then((result) => {
        setSession(result);
        if (result.workspace?.id)
          window.sessionStorage.setItem('uptime.workspaceId', result.workspace.id);
        setAuthenticated(true);
      })
      .catch(() => setAuthenticated(false));
  }, [isPublicRoute, isLanding, isAuthRoute]);
  if (isLanding)
    return (
      <main className="public-workspace">
        <Outlet />
      </main>
    );
  if (isAuthRoute)
    return (
      <main className="public-workspace">
        <Outlet />
      </main>
    );
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
  if (!authenticated)
    return <AuthPage mode="login" onAuthenticated={() => setAuthenticated(true)} />;
  const allowRestrictedRoute = pathname === '/settings' || pathname === '/operator';
  return (
    <ProductSessionContext.Provider value={session}>
      <Workspace
        allowRestrictedRoute={allowRestrictedRoute}
        session={session}
        onSignOut={() => {
          window.sessionStorage.removeItem('uptime.workspaceId');
          setSession(null);
          setAuthenticated(false);
        }}
      >
        <Outlet />
      </Workspace>
    </ProductSessionContext.Provider>
  );
}

function Workspace({
  children,
  onSignOut,
  session,
  allowRestrictedRoute,
}: {
  children: React.ReactNode;
  onSignOut: () => void;
  session: ProductSession | null;
  allowRestrictedRoute: boolean;
}) {
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
            <a className="brand" href="/app">
              Monitors
            </a>
            {session?.workspaces && session.workspaces.length > 1 && (
              <label className="workspace-switcher">
                <span className="sr-only">Workspace</span>
                <select
                  value={session.workspace?.id ?? ''}
                  onChange={(event) => {
                    window.sessionStorage.setItem('uptime.workspaceId', event.target.value);
                    window.location.reload();
                  }}
                >
                  {session.workspaces.map((workspace) => (
                    <option value={workspace.id} key={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className="topbar__divider" aria-hidden="true" />
            <a className="brand" href="/status-pages">
              Status pages
            </a>
            <span className="topbar__divider" aria-hidden="true" />
            <a className="brand" href="/notifications">
              Notifications
            </a>
            <span className="topbar__divider" aria-hidden="true" />
            <a className="brand" href="/settings">
              Settings
            </a>
            {session?.isOperator && (
              <>
                <span className="topbar__divider" aria-hidden="true" />
                <a className="brand" href="/operator">
                  Operator
                </a>
              </>
            )}
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
      <main
        className={`workspace${session?.workspace?.state !== 'active' ? ' workspace--restricted' : ''}`}
      >
        {session?.workspace?.state !== 'active' && !allowRestrictedRoute ? (
          <WorkspaceState state={session?.workspace?.state ?? 'waiting'} />
        ) : (
          children
        )}
      </main>
      <footer className="footer-line">
        <span>Free monitoring</span>
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

function WorkspaceState({ state }: { state: string }) {
  const waiting = state === 'waiting';
  const deleting = state === 'deleting' || state === 'deleted';
  return (
    <section className="workspace-state" role="status">
      <p className="mono-label">
        WORKSPACE {waiting ? 'WAITING' : deleting ? 'DELETION PENDING' : 'SUSPENDED'}
      </p>
      <h1>
        {waiting
          ? 'Your workspace is being prepared.'
          : deleting
            ? 'Workspace deletion is pending.'
            : 'Your workspace is suspended.'}
      </h1>
      <p>
        {waiting
          ? 'Operational forms will be available when setup is complete.'
          : deleting
            ? 'New checks are stopped while workspace data is removed.'
            : 'Operational forms are unavailable while this workspace is suspended.'}
      </p>
    </section>
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

function LoginRoute() {
  return (
    <AuthPage
      mode="login"
      onAuthenticated={() => {
        window.location.assign('/app');
      }}
    />
  );
}
function SignupRoute() {
  return (
    <AuthPage
      mode="signup"
      onAuthenticated={() => {
        window.location.assign('/app');
      }}
    />
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
