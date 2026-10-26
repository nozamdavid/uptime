import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { MonitorSummary } from '@uptime/contracts';
import './styles.css';
import { api, RequestError } from './api.js';
import type { ProductSession } from './api.js';
import { MonitorDetail } from './monitor-detail.js';
import { MonitorForm } from './monitor-form.js';
import { monitorDisplayName } from './monitor-format.js';
import { MonitorList } from './monitor-list.js';
import { NotificationsPage } from './notifications.js';
import { PricingPage } from './pricing.js';
import { ContactPage, PrivacyPage, TermsPage } from './legal.js';
import { PublicStatusPage, StatusPageEditor, StatusPagesIndex } from './status-pages.js';
import { WorkspaceState } from './workspace-state.js';
import {
  AuthPage,
  InterestSignupPage,
  LandingPage,
  OperatorPage,
  OperatorWorkspaceEditPage,
  ProductSessionContext,
  SettingsPage,
} from './product-shell.js';
import { MockBillingCheckoutPage } from './mock-billing-checkout.js';
import { Select } from './select.js';
import { ThemeControl } from './theme.js';
import { usePageMetadata } from './metadata.js';

function BuildVersion() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (pathname.startsWith('/status/') || pathname.startsWith('/monitors/public/')) return null;
  return <span className="build-version">{__APP_VERSION__}</span>;
}

const rootRoute = createRootRoute({
  component: () => (
    <>
      <AppShell />
      <BuildVersion />
    </>
  ),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LandingPage,
});
const pricingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pricing',
  component: PricingPage,
});
const termsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/terms',
  component: TermsPage,
});
const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/privacy',
  component: PrivacyPage,
});
const contactRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contact',
  component: ContactPage,
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
const operatorWorkspaceEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/operator/workspaces/$workspaceId',
  component: OperatorWorkspaceEditRoute,
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
const mockBillingCheckoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mock-billing/checkout',
  component: MockBillingCheckoutPage,
});
const routeTree = rootRoute.addChildren([
  indexRoute,
  pricingRoute,
  termsRoute,
  privacyRoute,
  contactRoute,
  appRoute,
  loginRoute,
  signupRoute,
  settingsRoute,
  operatorRoute,
  operatorWorkspaceEditRoute,
  detailRoute,
  publicDetailRoute,
  statusPagesRoute,
  notificationsRoute,
  statusPageEditorRoute,
  publicStatusPageRoute,
  mockBillingCheckoutRoute,
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

function workspacePlanLabel(tierId: string | null, legacyExempt: boolean) {
  if (legacyExempt && !tierId) return 'Imported';
  if (!tierId) return null;
  return tierId === 'free' ? 'Free' : tierId === 'pro' ? 'Pro' : tierId;
}

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isPublicRoute = isPublicMonitorPath(pathname);
  const isPublicStatusPage = pathname.startsWith('/status/');
  const isLanding = pathname === '/';
  const isPricing = ['/pricing', '/terms', '/privacy', '/contact'].includes(pathname);
  const isAuthRoute = pathname === '/login' || pathname === '/signup';
  const [session, setSession] = useState<ProductSession | null>(null);
  const sessionGeneration = useRef(0);
  const [sessionError, setSessionError] = useState(false);
  const [sessionRetry, setSessionRetry] = useState(0);
  const [authenticated, setAuthenticated] = useState<boolean | null>(
    isLanding || isPricing || isAuthRoute ? false : null,
  );
  const clearSession = () => {
    sessionGeneration.current += 1;
    window.sessionStorage.removeItem('uptime.workspaceId');
    setSession(null);
    setAuthenticated(false);
    setSessionError(false);
  };
  useEffect(() => {
    if (isPublicRoute || isLanding || isPricing || isAuthRoute) return;
    let active = true;
    const generation = sessionGeneration.current;
    setAuthenticated(null);
    api
      .session()
      .then((result) => {
        if (!active || generation !== sessionGeneration.current) return;
        setSessionError(false);
        setSession(result);
        if (result.workspace?.id)
          window.sessionStorage.setItem('uptime.workspaceId', result.workspace.id);
        setAuthenticated(true);
      })
      .catch((error: unknown) => {
        if (!active || generation !== sessionGeneration.current) return;
        if (error instanceof RequestError && error.status === 401) clearSession();
        else {
          setSessionError(true);
          setAuthenticated(null);
        }
      });
    return () => {
      active = false;
    };
  }, [isPublicRoute, isLanding, isPricing, isAuthRoute, sessionRetry]);
  useEffect(() => {
    window.addEventListener('uptime:session-expired', clearSession);
    return () => window.removeEventListener('uptime:session-expired', clearSession);
  }, []);
  const isPublic = isLanding || isPricing || isPublicRoute;
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let robotsMeta = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (!isPublic) {
      if (!robotsMeta) {
        robotsMeta = document.createElement('meta');
        robotsMeta.name = 'robots';
        document.head.append(robotsMeta);
      }
      robotsMeta.content = 'noindex';
      robotsMeta.dataset.managedBy = 'app-shell';
    } else {
      if (robotsMeta && robotsMeta.dataset.managedBy === 'app-shell') {
        robotsMeta.remove();
      }
    }
    return () => {
      const currentMeta = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
      if (currentMeta && currentMeta.dataset.managedBy === 'app-shell') {
        currentMeta.remove();
      }
    };
  }, [isPublic]);
  if (isLanding || isPricing)
    return (
      <main className="public-workspace public-workspace--nav-theme">
        <div className="theme-toolbar">
          <ThemeControl />
        </div>
        <Outlet />
      </main>
    );
  if (isAuthRoute)
    return (
      <main className="public-workspace">
        <div className="theme-toolbar">
          <ThemeControl />
        </div>
        <Outlet />
      </main>
    );
  if (isPublicRoute)
    return (
      <main
        className={`workspace public-workspace font-choice${isPublicStatusPage ? ' public-status-workspace' : ' public-monitor-workspace'}`}
        data-font="josefin-sans"
      >
        <Outlet />
      </main>
    );
  if (authenticated === null)
    if (sessionError)
      return (
        <div className="center-state" role="alert">
          <p>Can't reach the server right now.</p>
          <button className="button button--primary" onClick={() => setSessionRetry((value) => value + 1)}>
            Try again
          </button>
        </div>
      );
  if (authenticated === null)
    return (
      <div className="center-state" role="status">
        Loading session…
      </div>
    );
  if (!authenticated)
    return (
      <AuthPage
        mode="login"
        onAuthenticated={() => {
          const generation = sessionGeneration.current;
          void api
            .session()
            .then((result) => {
              if (generation !== sessionGeneration.current) return;
              setSession(result);
              if (result.workspace?.id)
                window.sessionStorage.setItem('uptime.workspaceId', result.workspace.id);
              setAuthenticated(true);
            })
            .catch(() => {
              if (generation === sessionGeneration.current) clearSession();
            });
        }}
      />
    );
  const allowRestrictedRoute =
    pathname === '/settings' ||
    pathname === '/operator' ||
    pathname.startsWith('/operator/') ||
    pathname === '/mock-billing/checkout';
  return (
    <ProductSessionContext.Provider value={session}>
      <Workspace
        allowRestrictedRoute={allowRestrictedRoute}
        session={session}
        onSignOut={clearSession}
      >
        <Outlet />
      </Workspace>
    </ProductSessionContext.Provider>
  );
}

export function Workspace({
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [monitors, setMonitors] = useState<MonitorSummary[] | null>(null);
  const [workspaceTier, setWorkspaceTier] = useState<{
    workspaceId: string;
    label: string | null;
  } | null>(null);
  const requestedWorkspaceId = useRef(session?.workspace?.id);
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const mobileToggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const wasMobileOpen = useRef(false);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    const workspaceId = session?.workspace?.id;
    requestedWorkspaceId.current = workspaceId;
    if (!workspaceId) return;
    let active = true;
    api.workspaceEntitlements()
      .then(({ tierId, legacyExempt }) => {
        if (active && requestedWorkspaceId.current === workspaceId) {
          setWorkspaceTier({ workspaceId, label: workspacePlanLabel(tierId, legacyExempt) });
        }
      })
      .catch(() => {
        if (active && requestedWorkspaceId.current === workspaceId) {
          setWorkspaceTier({ workspaceId, label: null });
        }
      });
    return () => {
      active = false;
    };
  }, [session?.workspace?.id]);

  const refreshMonitors = useCallback(() => {
    api
      .monitors()
      .then((result) => setMonitors(result.monitors))
      .catch(() => setMonitors(null));
  }, []);

  useEffect(() => {
    refreshMonitors();
  }, [pathname, refreshMonitors]);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const handleRefresh = () => refreshMonitors();
    window.addEventListener('uptime:monitors-changed', handleRefresh);
    window.addEventListener('focus', handleRefresh);
    return () => {
      window.removeEventListener('uptime:monitors-changed', handleRefresh);
      window.removeEventListener('focus', handleRefresh);
    };
  }, [refreshMonitors]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMobileMenuOpen(false);
        setOpen(true);
        return;
      }
      if (event.key === 'Escape') {
        if (open) {
          event.preventDefault();
          setOpen(false);
        } else if (mobileMenuOpen) {
          event.preventDefault();
          setMobileMenuOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, mobileMenuOpen]);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      setSelected(0);
      refreshMonitors();
      setTimeout(() => input.current?.focus(), 0);
      document.body.style.overflow = 'hidden';
    } else if (wasOpen.current) {
      wasOpen.current = false;
      trigger.current?.focus();
      if (!mobileMenuOpen) {
        document.body.style.overflow = '';
      }
    }
  }, [open, mobileMenuOpen, refreshMonitors]);

  useEffect(() => {
    if (mobileMenuOpen) {
      wasMobileOpen.current = true;
      document.body.style.overflow = 'hidden';
      const firstFocusable = navRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      firstFocusable?.focus();
    } else if (wasMobileOpen.current) {
      wasMobileOpen.current = false;
      mobileToggleRef.current?.focus();
      if (!open) {
        document.body.style.overflow = '';
      }
    }
  }, [mobileMenuOpen, open]);

  const handleNavKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !mobileMenuOpen) return;
    const navEl = navRef.current;
    const toggleEl = mobileToggleRef.current;
    if (!navEl) return;
    const focusables = Array.from(
      navEl.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled') && (el as HTMLElement).offsetParent !== null);
    if (toggleEl) {
      focusables.unshift(toggleEl);
    }
    if (focusables.length === 0) return;
    const firstEl = focusables[0];
    const lastEl = focusables[focusables.length - 1];
    if (!firstEl || !lastEl) return;
    if (event.shiftKey && document.activeElement === firstEl) {
      event.preventDefault();
      lastEl.focus();
    } else if (!event.shiftKey && document.activeElement === lastEl) {
      event.preventDefault();
      firstEl.focus();
    }
  };

  const results = (monitors ?? [])
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

  const hasMonitorsData = monitors !== null;
  const downCount = hasMonitorsData ? monitors.filter((item) => item.status === 'down').length : null;
  const totalMonitors = hasMonitorsData ? monitors.length : session?.usage?.monitors;
  const statusPagesCount = session?.usage?.statusPages ?? 0;
  const notificationsCount = session?.usage?.notificationServices ?? 0;
  const planLabel =
    requestedWorkspaceId.current === session?.workspace?.id &&
    workspaceTier !== null &&
    workspaceTier.workspaceId === session?.workspace?.id
      ? workspaceTier.label
      : null;

  return (
    <div className="admin-shell">
      <div className="admin-mobile-bar">
        <Link to="/app" className="admin-mobile-bar__brand">
          Uptime
        </Link>
        <button
          ref={mobileToggleRef}
          type="button"
          className="admin-mobile-bar__toggle"
          aria-label="Toggle navigation menu"
          aria-expanded={mobileMenuOpen}
          onClick={() => setMobileMenuOpen((prev) => !prev)}
        >
          {mobileMenuOpen ? 'Close' : 'Menu'}
        </button>
      </div>

      <nav
        ref={navRef}
        onKeyDown={handleNavKeyDown}
        className={`ut-nav${mobileMenuOpen ? ' is-open' : ''}`}
        aria-label="Admin sections"
      >
        <Link
          to="/app"
          className="ut-wordmark"
          onClick={() => setMobileMenuOpen(false)}
        >
          Uptime
        </Link>

        <button
          ref={trigger}
          className="ut-nav__search"
          onClick={() => {
            setMobileMenuOpen(false);
            setOpen(true);
          }}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <span>Search monitors</span>
          <kbd className="ut-kbd">⌘K</kbd>
        </button>

        <ul className="ut-nav__items">
          <li>
            <SectionLink to="/app" onClick={() => setMobileMenuOpen(false)}>
              <span className="ut-nav__label">Monitors</span>
              {downCount !== null && downCount > 0 ? (
                <span className="ut-count ut-count--down">{downCount} down</span>
              ) : totalMonitors !== undefined && totalMonitors !== null && totalMonitors > 0 ? (
                <span className="ut-count">{totalMonitors}</span>
              ) : null}
            </SectionLink>
          </li>
          <li>
            <SectionLink to="/status-pages" onClick={() => setMobileMenuOpen(false)}>
              <span className="ut-nav__label">Status pages</span>
              {statusPagesCount > 0 ? (
                <span className="ut-count">{statusPagesCount}</span>
              ) : null}
            </SectionLink>
          </li>
          <li>
            <SectionLink to="/notifications" onClick={() => setMobileMenuOpen(false)}>
              <span className="ut-nav__label">Notifications</span>
              {notificationsCount > 0 ? (
                <span className="ut-count">{notificationsCount}</span>
              ) : null}
            </SectionLink>
          </li>
          <li>
            <SectionLink to="/settings" onClick={() => setMobileMenuOpen(false)}>
              <span className="ut-nav__label">Settings</span>
            </SectionLink>
          </li>
        </ul>

        {session?.isOperator && (
          <div className="ut-nav__group ut-nav__operator">
            <ul className="ut-nav__items">
              <li>
                <SectionLink to="/operator" onClick={() => setMobileMenuOpen(false)}>
                  <span className="ut-nav__label">Operator</span>
                </SectionLink>
              </li>
            </ul>
          </div>
        )}

        <div className="ut-nav__bottom">
          {session?.workspaces && session.workspaces.length > 0 && (
            <div className="ut-nav__workspace">
              <label className="ut-nav__workspace-label" htmlFor="workspace-select">
                Workspace{planLabel ? ` (${planLabel})` : ''}
              </label>
              <Select
                id="workspace-select"
                className="ut-nav__workspace-select"
                value={session.workspace?.id ?? ''}
                options={session.workspaces.map((workspace) => ({
                  value: workspace.id,
                  label: workspace.name,
                }))}
                onChange={(val) => {
                  requestedWorkspaceId.current = val;
                  setWorkspaceTier(null);
                  window.sessionStorage.setItem('uptime.workspaceId', val);
                  window.location.reload();
                }}
              />
            </div>
          )}
          <button
            className="ut-nav__signout"
            onClick={() => void api.signOut().finally(onSignOut)}
          >
            Sign out
          </button>
        </div>
      </nav>

      <div className="admin-main" inert={mobileMenuOpen ? true : undefined}>
        <div className="admin-theme-toolbar">
          <ThemeControl />
        </div>
        <main
          className={`admin-content workspace${session?.workspace?.state !== 'active' ? ' workspace--restricted' : ''}`}
        >
          {session?.workspace?.state !== 'active' && !allowRestrictedRoute ? (
            <WorkspaceState state={session?.workspace?.state ?? 'waiting_for_capacity'} />
          ) : (
            children
          )}
        </main>
      </div>

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
    </div>
  );
}

function SectionLink({
  to,
  children,
  onClick,
}: {
  to: '/app' | '/status-pages' | '/notifications' | '/settings' | '/operator';
  children: React.ReactNode;
  onClick?: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isActive =
    to === '/app'
      ? pathname === '/app' || pathname.startsWith('/monitors/')
      : pathname === to || pathname.startsWith(`${to}/`);
  return (
    <Link
      className="ut-nav__item brand"
      to={to}
      activeOptions={{ exact: false }}
      activeProps={{ 'aria-current': 'page' }}
      aria-current={isActive ? 'page' : undefined}
      onClick={onClick}
    >
      {children}
    </Link>
  );
}

function Overview() {
  const [formOpen, setFormOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.monitors>>['monitors'] | null>(
    null,
  );
  const [error, setError] = useState('');

  const handleMonitorsChanged = () => {
    setReload((value) => value + 1);
    window.dispatchEvent(new CustomEvent('uptime:monitors-changed'));
  };

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

  const upCount = items ? items.filter((item) => item.status === 'up').length : 0;
  const degradedCount = items ? items.filter((item) => item.status === 'degraded').length : 0;
  const downCount = items ? items.filter((item) => item.status === 'down').length : 0;

  if (formOpen) {
    return (
      <MonitorForm
        onCancel={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          handleMonitorsChanged();
        }}
      />
    );
  }

  return (
    <section className="overview">
      <div className="page-head">
        <div>
          <h1 className="ut-title-lg">Monitors</h1>
          <p className="ut-summary-line" aria-label="System status summary">
            <span className="ut-status ut-status--up">
              <span className="ut-glyph ut-glyph--up" aria-hidden="true" />
              <strong className="ut-figure">{upCount}</strong> up
            </span>
            <span className="ut-status ut-status--degraded">
              <span className="ut-glyph ut-glyph--degraded" aria-hidden="true" />
              <strong className="ut-figure">{degradedCount}</strong> degraded
            </span>
            <span className="ut-status ut-status--down">
              <span className="ut-glyph ut-glyph--down" aria-hidden="true" />
              <strong className="ut-figure">{downCount}</strong> down
            </span>
          </p>
        </div>
        <div className="actions">
          <button
            className="button button--quiet"
            type="button"
            onClick={() => {
              setReload((value) => value + 1);
            }}
          >
            Refresh
          </button>
          {items && items.length > 0 && (
            <button
              className="button button--primary button--accent"
              type="button"
              onClick={() => setFormOpen(true)}
            >
              Add monitor
            </button>
          )}
        </div>
      </div>
      {error ? (
        <State
          kind="error"
          text={error}
          action={() => {
            setError('');
            handleMonitorsChanged();
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
        <MonitorList items={items} onChanged={handleMonitorsChanged} />
      )}
    </section>
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
  return <InterestSignupPage />;
}

function DetailRoute() {
  const { monitorId } = detailRoute.useParams();
  return <MonitorDetail monitorId={monitorId} />;
}
function OperatorWorkspaceEditRoute() {
  const { workspaceId } = operatorWorkspaceEditRoute.useParams();
  return <OperatorWorkspaceEditPage workspaceId={workspaceId} />;
}
function PublicDetailRoute() {
  const { monitorId } = publicDetailRoute.useParams();
  const statusPageId = new URLSearchParams(window.location.search).get('statusPage') ?? undefined;
  usePageMetadata({
    title: 'Monitor details',
    description: 'Public uptime monitoring details and regional response metrics.',
    canonical: `/monitors/public/${monitorId}`,
  });
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
        <button
          className={
            kind === 'empty' ? 'button button--primary button--accent' : 'button button--secondary'
          }
          onClick={action}
        >
          {kind === 'empty' ? 'Add monitor' : 'Retry'}
        </button>
      )}
    </div>
  );
}

export { router };

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(<RouterProvider router={router} />);
