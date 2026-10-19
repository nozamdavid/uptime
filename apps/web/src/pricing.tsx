import { useEffect, useState } from 'react';
import { api, formatPlanCents, productWorkspaceId } from './api.js';
import type { PlanDefinition, PublicProductCatalog } from './api.js';
import { SiteFooter } from './site-footer.js';
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
      <header className="landing__nav landing__nav--centered">
        <a className="brand" href="/">
          Uptime
        </a>
      </header>

      <section className="pricing-hero">
        <p className="mono-label">PLANS &amp; PRICING</p>
        <h1>Simple, transparent monitoring.</h1>
        <p className="landing__lede">
          Multi-region easy to use monitoring, alerts and 90-day history
        </p>      </section>

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
      ) : null}

      <SiteFooter />
    </main>
  );
}

const paidPlaceholder = {
  name: 'Coming soon',
  description: 'This tier is not available yet.',
  price: '$00 / month',
  features: Array.from({ length: 8 }, () => 'Coming soon'),
};

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
  // Paid tiers render placeholder text under the blur, so removing the blur reveals nothing.
  const shown = isFree
    ? {
        name: plan.name,
        description: plan.description,
        price: formatPlanCents(plan.price.amount, plan.price.currency, plan.price.interval),
        features: plan.features,
      }
    : paidPlaceholder;

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
      className={`pricing-card ${isFree ? 'pricing-card--featured' : ''}`}
      data-plan={plan.id}
    >
      {/* Paid tiers are not offered yet, so their contents are blurred and inert. */}
      <div
        className={`pricing-card__body${isFree ? '' : ' pricing-card__body--blurred'}`}
        inert={isFree ? undefined : true}
        aria-hidden={isFree ? undefined : true}
      >
        <header className="pricing-card__header">
          <h2 className="pricing-card__title">{shown.name}</h2>
          <p className="pricing-card__description">{shown.description}</p>
        </header>

        <div className="pricing-card__price-box">
          <span className="pricing-card__price">{shown.price}</span>
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
            {shown.features.map((feature, idx) => (
              <li key={idx} className="pricing-card__feature-item">
                <span className="pricing-card__check" aria-hidden="true">
                  ✓
                </span>
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}
