import { useEffect, useState } from 'react';
import { api, formatPlanCents, productWorkspaceId } from './api.js';
import type { PlanDefinition, PublicProductCatalog } from './api.js';
import './pricing.css';

export function PricingPage() {
  const [catalog, setCatalog] = useState<PublicProductCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return Boolean(productWorkspaceId());
  });

  const loadPlans = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.publicPlans();
      setCatalog(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load pricing catalog');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlans();
    // Check if session exists to route CTA appropriately
    api
      .session()
      .then((session) => {
        if (session?.user || session?.workspace) {
          setIsAuthenticated(true);
        } else {
          setIsAuthenticated(false);
          if (typeof window !== 'undefined' && window.sessionStorage) {
            window.sessionStorage.removeItem('uptime.workspaceId');
          }
        }
      })
      .catch(() => {
        // Session failure clears stored workspace-isAuthenticated fallback
        setIsAuthenticated(false);
        if (typeof window !== 'undefined' && window.sessionStorage) {
          window.sessionStorage.removeItem('uptime.workspaceId');
        }
      });
  }, []);

  return (
    <main className="landing pricing-page">
      <header className="landing__nav">
        <a className="brand" href="/">
          Uptime
        </a>
        <nav className="landing__nav-links">
          <a href="/" className="landing__nav-link">
            Home
          </a>
          {isAuthenticated ? (
            <a href="/app" className="landing__nav-link">
              Console
            </a>
          ) : (
            <a href="/login" className="landing__nav-link">
              Sign in
            </a>
          )}
        </nav>
      </header>

      <section className="pricing-hero">
        <p className="mono-label">PLANS &amp; PRICING</p>
        <h1>Simple, transparent monitoring.</h1>
        <p className="landing__lede">
          Multi-region synthetic checks, confirmed alerting, and incident history for every project.
        </p>

        {(catalog?.preview || catalog?.billingMode === 'mock') && (
          <div className="pricing-banner" role="region" aria-label="Pricing note">
            {catalog?.preview && <span className="pricing-banner__tag">DRAFT PRICING</span>}
            {catalog?.billingMode === 'mock' && (
              <span className="pricing-banner__tag pricing-banner__tag--mock">SIMULATION</span>
            )}
            <p className="pricing-banner__text">
              {catalog?.billingMode === 'mock'
                ? 'Staging simulation only — no real charges will be made. Mock billing mode active.'
                : 'Draft pricing preview — plans and pricing are subject to change.'}
            </p>
          </div>
        )}
      </section>

      {loading ? (
        <div className="pricing-loading" role="status">
          <p>Loading pricing catalog…</p>
        </div>
      ) : error ? (
        <div className="state state--error" role="alert">
          <p>{error}</p>
          <button type="button" className="button button--quiet" onClick={loadPlans}>
            Retry loading plans
          </button>
        </div>
      ) : catalog ? (
        <>
          <section className="pricing-cards" aria-label="Available plans">
            <div className="pricing-grid">
              {catalog.plans.map((plan) => (
                <PricingCard
                  key={plan.id}
                  plan={plan}
                  isAuthenticated={isAuthenticated}
                  checkoutCapable={Boolean(catalog.capabilities?.checkout)}
                />
              ))}
            </div>
          </section>

          <section className="pricing-comparison" aria-label="Feature comparison">
            <h2>Detailed plan comparison</h2>
            <PricingComparisonTable plans={catalog.plans} />
          </section>
        </>
      ) : null}

      <footer className="landing__footer">
        <span>
          Built by <a href="https://bsky.app/profile/noz.am">@noz.am</a>
        </span>
        <a href="/">Home</a>
        <a href="/operator">Operator</a>
      </footer>
    </main>
  );
}

export function PricingCard({
  plan,
  isAuthenticated,
  checkoutCapable,
}: {
  plan: PlanDefinition;
  isAuthenticated: boolean;
  checkoutCapable: boolean;
}) {
  const isFree = plan.price.amount === 0;
  const priceDisplay = formatPlanCents(plan.price.amount, plan.price.currency, plan.price.interval);

  // Exact routing contract:
  // Authenticated -> /settings#subscription
  // Unauthenticated -> /signup (respects interest-only admission, avoids accidental open signup)
  const ctaHref = isAuthenticated ? '/settings#subscription' : '/signup';
  const ctaLabel = isAuthenticated
    ? 'Manage subscription'
    : isFree
      ? 'Get started free'
      : 'Join interest list';

  return (
    <article
      className={`pricing-card ${plan.id === 'pro' ? 'pricing-card--featured' : ''}`}
      data-plan={plan.id}
    >
      <header className="pricing-card__header">
        <h2 className="pricing-card__title">{plan.name}</h2>
        <p className="pricing-card__description">{plan.description}</p>
      </header>

      <div className="pricing-card__price-box">
        <span className="pricing-card__price">{priceDisplay}</span>
      </div>

      <div className="pricing-card__cta-box">
        <a href={ctaHref} className="button button--primary pricing-card__cta">
          {ctaLabel}
        </a>
        {!checkoutCapable && (
          <p className="pricing-card__setup-notice" role="status">
            Billing setup pending
          </p>
        )}
      </div>

      <div className="pricing-card__features">
        <h3 className="mono-label">INCLUDED ENTITLEMENTS</h3>
        <ul className="pricing-card__feature-list">
          {plan.features.map((feature, idx) => (
            <li key={idx} className="pricing-card__feature-item">
              <span className="pricing-card__check" aria-hidden="true">
                ✓
              </span>
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

export function PricingComparisonTable({ plans }: { plans: PlanDefinition[] }) {
  return (
    <div
      className="pricing-table-container"
      tabIndex={0}
      role="region"
      aria-label="Feature comparison table"
    >
      <table className="pricing-table">
        <caption className="sr-only">
          Detailed comparison of monitor limits, regions, and capabilities
        </caption>
        <thead>
          <tr>
            <th scope="col" className="pricing-table__feature-col">
              Capability
            </th>
            {plans.map((p) => (
              <th scope="col" key={p.id} className="pricing-table__plan-col">
                {p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="pricing-table__section-row">
            <th scope="row" colSpan={plans.length + 1} className="pricing-table__section-header">
              Monitoring &amp; Capacity
            </th>
          </tr>
          <tr>
            <th scope="row">Monitors</th>
            {plans.map((p) => (
              <td key={p.id}>{p.entitlements.monitors}</td>
            ))}
          </tr>
          <tr>
            <th scope="row">Regions per check</th>
            {plans.map((p) => (
              <td key={p.id}>{p.entitlements.regions}</td>
            ))}
          </tr>
          <tr>
            <th scope="row">Global region pool</th>
            {plans.map((p) => (
              <td key={p.id}>{p.entitlements.allowedRegionIds.length} regions</td>
            ))}
          </tr>
          <tr>
            <th scope="row">Workspace seats</th>
            {plans.map((p) => (
              <td key={p.id}>{p.entitlements.seats}</td>
            ))}
          </tr>
          <tr>
            <th scope="row">Public status pages</th>
            {plans.map((p) => (
              <td key={p.id}>{p.entitlements.statusPages}</td>
            ))}
          </tr>
          <tr>
            <th scope="row">Notification destinations</th>
            {plans.map((p) => (
              <td key={p.id}>{p.entitlements.notificationDestinations}</td>
            ))}
          </tr>
          <tr>
            <th scope="row">Custom status domains</th>
            {plans.map((p) => (
              <td key={p.id}>
                {p.entitlements.customDomains > 0
                  ? `${p.entitlements.customDomains} (preview)`
                  : '—'}
              </td>
            ))}
          </tr>

          <tr className="pricing-table__section-row">
            <th scope="row" colSpan={plans.length + 1} className="pricing-table__section-header">
              Timing &amp; Retention
            </th>
          </tr>
          <tr>
            <th scope="row">Check frequency</th>
            {plans.map((p) => (
              <td key={p.id}>{p.entitlements.intervalSeconds / 60} minutes (fixed)</td>
            ))}
          </tr>
          <tr>
            <th scope="row">Raw ping history</th>
            {plans.map((p) => (
              <td key={p.id}>{p.entitlements.rawRetentionHours} hours</td>
            ))}
          </tr>
          <tr>
            <th scope="row">Daily uptime metrics</th>
            {plans.map((p) => (
              <td key={p.id}>{p.entitlements.dailyRetentionDays} days</td>
            ))}
          </tr>

          <tr className="pricing-table__section-row">
            <th scope="row" colSpan={plans.length + 1} className="pricing-table__section-header">
              Alert Destinations
            </th>
          </tr>
          <tr>
            <th scope="row">Telegram &amp; Discord</th>
            {plans.map((p) => (
              <td key={p.id}>Included</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
