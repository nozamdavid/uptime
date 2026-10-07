import { useEffect, useRef, useState } from 'react';
import { api, formatPlanCents } from './api.js';
import type { WorkspaceBillingResponse } from './api.js';

export function MockBillingCheckoutPage() {
  const [billing, setBilling] = useState<WorkspaceBillingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Synchronous submission lock to prevent double-click / concurrent confirm calls
  const submittingRef = useRef(false);

  const querySessionId =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('session_id')
      : null;

  useEffect(() => {
    if (!querySessionId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .workspaceBilling()
      .then((data) => {
        setBilling(data);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Could not load billing session');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [querySessionId]);

  const session = billing?.mockSession;

  // Validation logic: only derived when initial session fetch has not errored
  let validationError: string | null = null;
  if (!loading && !error) {
    if (!querySessionId) {
      validationError = 'Missing session_id in checkout URL.';
    } else if (!session) {
      validationError = 'No active mock checkout session found for this workspace.';
    } else if (session.sessionId !== querySessionId) {
      validationError = 'Mismatched or spoofed checkout session identifier.';
    } else if (session.expiresAt && session.expiresAt * 1000 < Date.now()) {
      validationError =
        'This checkout session has expired. Please initiate checkout again from settings.';
    }
  }

  const handleOutcome = async (outcome: 'purchase' | 'cancel' | 'payment_failed') => {
    if (submittingRef.current || !session) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setStatusMessage(null);
    try {
      if (outcome === 'cancel') {
        await api.cancelMockBilling(session.sessionId, session.nonce);
        window.location.assign('/settings#subscription');
        return;
      }
      await api.confirmMockBilling(session.sessionId, session.nonce, outcome);
      if (outcome === 'payment_failed') {
        setStatusMessage('Simulated payment failure recorded. Redirecting to settings…');
      } else {
        setStatusMessage('Simulated purchase confirmed! Redirecting to settings…');
      }
      setTimeout(() => {
        window.location.assign('/settings#subscription');
      }, 1000);
    } catch (err) {
      submittingRef.current = false;
      setError(err instanceof Error ? err.message : 'Could not process mock checkout');
      setSubmitting(false);
    }
  };

  const plan = session?.plan;

  return (
    <main
      className="landing"
      style={{
        minHeight: '80vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem 1rem',
      }}
    >
      <div className="settings-card" style={{ maxWidth: '520px', width: '100%', margin: '0 auto' }}>
        <header>
          <span className="mono-label">STAGING ENVIRONMENT</span>
          <h1 style={{ fontSize: '1.5rem', margin: '0.5rem 0' }}>Mock Billing Checkout</h1>
          <p className="settings-note">
            This is a simulated checkout gateway for testing. No real card will be charged.
          </p>
        </header>

        {loading ? (
          <p role="status">Loading session verification…</p>
        ) : error && !plan ? (
          <div className="state state--error" role="alert" style={{ marginTop: '1rem' }}>
            <p>{error}</p>
            <div style={{ marginTop: '1rem' }}>
              <a href="/settings#subscription" className="button button--quiet">
                Return to Settings
              </a>
            </div>
          </div>
        ) : validationError ? (
          <div className="state state--error" role="alert" style={{ marginTop: '1rem' }}>
            <p>{validationError}</p>
            <div style={{ marginTop: '1rem' }}>
              <a href="/settings#subscription" className="button button--quiet">
                Return to Settings
              </a>
            </div>
          </div>
        ) : plan ? (
          <div style={{ marginTop: '1.5rem' }}>
            {error && (
              <div className="state state--error" role="alert" style={{ marginBottom: '1rem' }}>
                <p>{error}</p>
              </div>
            )}

            {statusMessage && (
              <div className="state state--success" role="status" style={{ marginBottom: '1rem' }}>
                <p>{statusMessage}</p>
              </div>
            )}

            <div
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: '6px',
                padding: '1.25rem',
                background: 'var(--color-surface-subtle)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                }}
              >
                <div>
                  <h2 style={{ margin: 0, fontSize: '1.3rem' }}>{plan.name} Plan</h2>
                  <span className="mono-label" style={{ marginTop: '0.25rem' }}>
                    REVISION {plan.revision}
                  </span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <strong style={{ fontSize: '1.3rem' }}>
                    {formatPlanCents(plan.price.amount, plan.price.currency)}
                  </strong>
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-muted)' }}>
                    {' '}
                    / {plan.price.interval}
                  </span>
                </div>
              </div>

              <p style={{ margin: '1rem 0 0.5rem', fontSize: '0.95rem' }}>{plan.description}</p>

              <div
                style={{
                  marginTop: '1rem',
                  borderTop: '1px solid var(--color-border)',
                  paddingTop: '0.75rem',
                }}
              >
                <strong
                  style={{
                    fontSize: '0.85rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  Pinned Plan Entitlements
                </strong>
                <ul
                  style={{
                    listStyle: 'none',
                    padding: 0,
                    margin: '0.5rem 0',
                    fontSize: '0.9rem',
                  }}
                >
                  <li>✓ {plan.entitlements.monitors} monitors</li>
                  <li>✓ Up to {plan.entitlements.regions} regions per check</li>
                  <li>✓ {plan.entitlements.seats} team seats</li>
                  <li>✓ {plan.entitlements.statusPages} status pages</li>
                  <li>✓ {plan.entitlements.customDomains} custom status domains</li>
                </ul>
              </div>
            </div>

            {/* Actions */}
            <div
              style={{
                marginTop: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
              }}
            >
              <button
                type="button"
                className="button button--primary"
                onClick={() => handleOutcome('purchase')}
                disabled={submitting}
              >
                {submitting ? 'Confirming…' : 'Confirm Purchase (Simulated)'}
              </button>

              <button
                type="button"
                className="button button--quiet"
                onClick={() => handleOutcome('payment_failed')}
                disabled={submitting}
              >
                Simulate Payment Failure
              </button>

              <button
                type="button"
                className="button button--quiet button--danger"
                onClick={() => handleOutcome('cancel')}
                disabled={submitting}
              >
                Cancel Checkout
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
