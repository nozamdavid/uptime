import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { RegionDefinition, RegionId } from '@uptime/regions';
import { api, deriveTierFeatures, formatPlanCents } from './api.js';
import type { PlanDefinition, ProductCatalog } from './api.js';
import './operator-tier-catalog.css';

interface OperatorTierCatalogProps {
  availableRegions?: RegionDefinition[];
}

const fallbackRegions: Array<{ id: RegionId; label: string }> = [
  { id: 'us-east', label: 'US East' },
  { id: 'eu-west', label: 'EU West' },
  { id: 'asia', label: 'Asia' },
];

type NumericFieldName =
  | 'priceAmount'
  | 'monitors'
  | 'regions'
  | 'seats'
  | 'statusPages'
  | 'notificationDestinations'
  | 'customDomains';

function initRawDraftsForPlan(plan: PlanDefinition): Record<NumericFieldName, string> {
  return {
    priceAmount: String(plan.price.amount),
    monitors: String(plan.entitlements.monitors),
    regions: String(plan.entitlements.regions),
    seats: String(plan.entitlements.seats),
    statusPages: String(plan.entitlements.statusPages),
    notificationDestinations: String(plan.entitlements.notificationDestinations),
    customDomains: String(plan.entitlements.customDomains),
  };
}

export function OperatorTierCatalog({ availableRegions = [] }: OperatorTierCatalogProps) {
  const [catalog, setCatalog] = useState<ProductCatalog | null>(null);
  const [draftPlans, setDraftPlans] = useState<PlanDefinition[]>([]);
  const [rawNumericDrafts, setRawNumericDrafts] = useState<
    Record<string, Record<NumericFieldName, string>>
  >({});
  const [draftPreview, setDraftPreview] = useState<boolean>(true);
  const [draftBillingMode, setDraftBillingMode] = useState<'disabled' | 'mock' | 'stripe'>('mock');
  const [draftStripePriceIds, setDraftStripePriceIds] = useState<Record<string, string>>({});

  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [expandedPlanId, setExpandedPlanId] = useState<string | null>('free');

  // Synchronous operation locks and fetch sequence guard
  const savingRef = useRef(false);
  const fetchSeqRef = useRef(0);

  const regionChoices: Array<{ id: RegionId; label: string }> =
    availableRegions.length > 0
      ? availableRegions.map((r) => ({ id: r.id, label: r.label }))
      : fallbackRegions;

  const loadCatalog = async () => {
    if (typeof api.operatorPlans !== 'function') {
      setLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    setConflict(null);
    try {
      const data = await api.operatorPlans();
      if (seq !== fetchSeqRef.current) return; // Stale read response ignored
      setCatalog(data);
      setDraftPlans(JSON.parse(JSON.stringify(data.plans)));
      const rawMap: Record<string, Record<NumericFieldName, string>> = {};
      for (const p of data.plans) {
        rawMap[p.id] = initRawDraftsForPlan(p);
      }
      setRawNumericDrafts(rawMap);
      setDraftPreview(data.preview);
      setDraftBillingMode(data.billingMode);
      setDraftStripePriceIds(data.stripePriceIds ? { ...data.stripePriceIds } : {});
    } catch (err) {
      if (seq !== fetchSeqRef.current) return;
      setError(err instanceof Error ? err.message : 'Could not load product tier catalog');
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    loadCatalog();
  }, []);

  const getRawDraft = (planId: string, field: NumericFieldName, fallback: number): string => {
    return rawNumericDrafts[planId]?.[field] ?? String(fallback);
  };

  const setRawDraft = (planId: string, field: NumericFieldName, value: string) => {
    setRawNumericDrafts((prev) => {
      const currentPlanDraft = prev[planId];
      if (!currentPlanDraft) return prev;
      return {
        ...prev,
        [planId]: {
          ...currentPlanDraft,
          [field]: value,
        },
      };
    });
    setSuccess(null);
  };

  const updatePlan = (id: string, updater: (prev: PlanDefinition) => PlanDefinition) => {
    setDraftPlans((current) => current.map((p) => (p.id === id ? updater(p) : p)));
    setSuccess(null);
  };

  const handleAddTier = () => {
    const defaultRegionIds: RegionId[] =
      regionChoices.length > 0
        ? regionChoices.map((r) => r.id)
        : (['us-east', 'eu-west', 'asia'] as RegionId[]);

    const nextId = `tier_${Date.now().toString(36)}`;
    const newPlan: PlanDefinition = {
      id: nextId,
      revision: (catalog?.revision ?? 0) + 1,
      name: 'New Custom Tier',
      description: 'Custom tier description',
      price: {
        amount: 2900,
        currency: 'usd',
        interval: 'month',
      },
      entitlements: {
        monitors: 15,
        regions: 3,
        allowedRegionIds: defaultRegionIds,
        seats: 5,
        statusPages: 3,
        notificationDestinations: 5,
        customDomains: 1,
        intervalSeconds: 300,
        rawRetentionHours: 24,
        dailyRetentionDays: 30,
      },
      features: deriveTierFeatures({
        monitors: 15,
        regions: 3,
        allowedRegionIds: defaultRegionIds,
        seats: 5,
        statusPages: 3,
        notificationDestinations: 5,
        customDomains: 1,
        intervalSeconds: 300,
        rawRetentionHours: 24,
        dailyRetentionDays: 30,
      }),
      active: true,
      published: true,
      preview: true,
    };
    setDraftPlans((current) => [...current, newPlan]);
    setRawNumericDrafts((prev) => ({
      ...prev,
      [nextId]: initRawDraftsForPlan(newPlan),
    }));
    setExpandedPlanId(nextId);
    setSuccess(null);
  };

  const validateNumeric = (
    planName: string,
    fieldLabel: string,
    rawVal: string,
    min: number,
    max: number,
  ): { error?: string; value?: number } => {
    const trimmed = rawVal.trim();
    if (trimmed === '') {
      return { error: `Plan "${planName}" ${fieldLabel} cannot be blank.` };
    }
    if (trimmed.includes('.') || trimmed.toLowerCase().includes('e')) {
      return {
        error: `Plan "${planName}" ${fieldLabel} cannot contain decimals or exponents; must be an integer.`,
      };
    }
    if (!/^\d+$/.test(trimmed)) {
      return { error: `Plan "${planName}" ${fieldLabel} must contain only digits.` };
    }
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed)) {
      return { error: `Plan "${planName}" ${fieldLabel} is not a valid number.` };
    }
    if (!Number.isSafeInteger(parsed)) {
      return { error: `Plan "${planName}" ${fieldLabel} must be a safe integer.` };
    }
    if (parsed < min || parsed > max) {
      return {
        error: `Plan "${planName}" ${fieldLabel} must be an integer between ${min} and ${max}.`,
      };
    }
    return { value: parsed };
  };

  const validateDraft = (): { error: string | null; validatedPlans?: PlanDefinition[] } => {
    if (!catalog) return { error: 'Catalog not loaded' };

    if (!reason.trim()) {
      return { error: 'A reason is required to save catalog changes.' };
    }
    if (reason.trim().length > 500) {
      return { error: 'Reason must be 500 characters or fewer.' };
    }

    const freePlan = draftPlans.find((p) => p.id === 'free');
    if (!freePlan) {
      return { error: 'An active zero-price "free" tier must be present in the catalog.' };
    }
    if (!freePlan.active) {
      return { error: 'The "free" tier cannot be disabled. An active free tier is required.' };
    }

    const ids = new Set<string>();
    const validatedPlans: PlanDefinition[] = [];

    for (const plan of draftPlans) {
      if (!plan.id.trim()) {
        return { error: 'All tiers must have a valid identifier.' };
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(plan.id)) {
        return {
          error: `Tier ID "${plan.id}" is invalid. Must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens.`,
        };
      }
      if (ids.has(plan.id)) {
        return { error: `Duplicate tier ID "${plan.id}" detected.` };
      }
      ids.add(plan.id);

      if (!plan.name.trim() || plan.name.length > 100) {
        return { error: `Plan "${plan.id}" must have a name between 1 and 100 characters.` };
      }
      if (plan.description.length > 1000) {
        return { error: `Plan "${plan.name}" description must not exceed 1000 characters.` };
      }

      // Validate price
      const rawPrice = getRawDraft(plan.id, 'priceAmount', plan.price.amount);
      const priceValidation = validateNumeric(plan.name, 'price amount', rawPrice, 0, 100_000_000);
      if (priceValidation.error) return { error: priceValidation.error };
      const validatedPrice = priceValidation.value!;

      if (plan.id === 'free' && validatedPrice !== 0) {
        return { error: 'The "free" tier price must be exactly 0 cents.' };
      }

      // Validate entitlements
      type EntitlementNumericField =
        | 'monitors'
        | 'regions'
        | 'seats'
        | 'statusPages'
        | 'notificationDestinations'
        | 'customDomains';

      const numFields: Array<[EntitlementNumericField, string, number, number]> = [
        ['monitors', 'monitors limit', 0, 1000],
        ['seats', 'workspace seats', 1, 1000],
        ['statusPages', 'status pages', 0, 1000],
        ['notificationDestinations', 'notification destinations', 0, 1000],
        ['customDomains', 'custom status domains', 0, 1000],
        ['regions', 'regions per monitor', 1, 9],
      ];

      const validatedEntitlements = { ...plan.entitlements };
      for (const [field, label, min, max] of numFields) {
        const raw = getRawDraft(plan.id, field, plan.entitlements[field]);
        const validation = validateNumeric(plan.name, label, raw, min, max);
        if (validation.error) return { error: validation.error };
        validatedEntitlements[field] = validation.value!;
      }

      if (validatedEntitlements.allowedRegionIds.length < 1) {
        return { error: `Plan "${plan.name}" must have at least one allowed region selected.` };
      }
      if (validatedEntitlements.regions > validatedEntitlements.allowedRegionIds.length) {
        return {
          error: `Plan "${plan.name}" regions per monitor (${validatedEntitlements.regions}) cannot exceed allowed regions count (${validatedEntitlements.allowedRegionIds.length}).`,
        };
      }
      if (validatedEntitlements.customDomains > validatedEntitlements.statusPages) {
        return {
          error: `Plan "${plan.name}" custom domains (${validatedEntitlements.customDomains}) cannot exceed status pages count (${validatedEntitlements.statusPages}).`,
        };
      }

      validatedPlans.push({
        ...plan,
        price: {
          ...plan.price,
          amount: validatedPrice,
        },
        entitlements: validatedEntitlements,
      });
    }

    return { error: null, validatedPlans };
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);

    setError(null);
    setConflict(null);
    setSuccess(null);

    const validation = validateDraft();
    if (validation.error || !validation.validatedPlans) {
      setError(validation.error);
      savingRef.current = false;
      setSaving(false);
      return;
    }

    if (!catalog) {
      savingRef.current = false;
      setSaving(false);
      return;
    }

    const expectedRevision = catalog.revision;
    const nextRevision = expectedRevision + 1;

    // Increment catalog revision and all plan revisions
    const updatedPlans: PlanDefinition[] = validation.validatedPlans.map((p) => ({
      ...p,
      revision: nextRevision,
      features: deriveTierFeatures(p.entitlements),
    }));

    const nextCatalog: ProductCatalog = {
      revision: nextRevision,
      preview: draftPreview,
      billingMode: draftBillingMode,
      plans: updatedPlans,
      stripePriceIds: draftStripePriceIds,
    };

    try {
      if (typeof api.saveOperatorPlans !== 'function') {
        throw new Error('API saveOperatorPlans not available');
      }
      const saved = await api.saveOperatorPlans(expectedRevision, reason.trim(), nextCatalog);
      setCatalog(saved);
      setDraftPlans(JSON.parse(JSON.stringify(saved.plans)));
      const rawMap: Record<string, Record<NumericFieldName, string>> = {};
      for (const p of saved.plans) {
        rawMap[p.id] = initRawDraftsForPlan(p);
      }
      setRawNumericDrafts(rawMap);
      setDraftPreview(saved.preview);
      setDraftBillingMode(saved.billingMode);
      setDraftStripePriceIds(saved.stripePriceIds ? { ...saved.stripePriceIds } : {});
      setReason('');
      setSuccess(`Product tier catalog saved successfully as Revision ${saved.revision}.`);
    } catch (err: unknown) {
      const isConflict =
        (err &&
          typeof err === 'object' &&
          'status' in err &&
          (err as { status: number }).status === 409) ||
        (err instanceof Error && err.message.toLowerCase().includes('conflict'));

      if (isConflict) {
        // Crucial: preserve all drafts and raw drafts on 409 conflict, offer explicit reload button
        setConflict(
          'Catalog changed concurrently on the server. You can reload the server version or keep your local draft.',
        );
      } else {
        setError(err instanceof Error ? err.message : 'Could not save product tier catalog');
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <article className="settings-card operator-tier-catalog">
        <h2>Product tier catalog</h2>
        <p role="status">Loading tier catalog…</p>
      </article>
    );
  }

  return (
    <article
      className="settings-card operator-tier-catalog"
      aria-label="Product tier catalog editor"
    >
      <header className="operator-catalog__header">
        <div>
          <h2>Product tier catalog</h2>
          <p>
            Manage subscription plans, limits, and pricing mode. Changes increment the catalog
            revision and take effect on next assignment or manual sync.
          </p>
        </div>
        {catalog && (
          <div className="operator-catalog__revision-badge mono-label">
            REVISION {catalog.revision} · NEXT: {catalog.revision + 1}
          </div>
        )}
      </header>

      {error && (
        <div className="state state--error" role="alert">
          <p>{error}</p>
        </div>
      )}

      {conflict && (
        <div className="state state--error" role="alert">
          <p>{conflict}</p>
          <div className="operator-catalog__conflict-actions">
            <button
              type="button"
              className="button button--quiet"
              onClick={loadCatalog}
              disabled={saving}
            >
              Reload latest server catalog
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setConflict(null)}
              disabled={saving}
            >
              Dismiss and keep my local draft
            </button>
          </div>
        </div>
      )}

      {success && (
        <div className="state state--success" role="status">
          <p>{success}</p>
        </div>
      )}

      <form onSubmit={handleSave} className="operator-catalog__form">
        <fieldset className="operator-catalog__meta" disabled={saving}>
          <legend className="mono-label">CATALOG FLAGS &amp; BILLING MODE</legend>
          <div className="operator-catalog__flags">
            <label className="checkbox">
              <input
                id="catalog-preview"
                type="checkbox"
                checked={draftPreview}
                disabled={saving}
                onChange={(e) => {
                  setDraftPreview(e.target.checked);
                  setSuccess(null);
                }}
              />
              <span>Preview Catalog (Display preview disclaimer to customers)</span>
            </label>

            <label className="field" htmlFor="catalog-billing-mode">
              <span>Billing Mode</span>
              <select
                id="catalog-billing-mode"
                value={draftBillingMode}
                disabled={saving}
                onChange={(e) => {
                  setDraftBillingMode(e.target.value as 'disabled' | 'mock' | 'stripe');
                  setSuccess(null);
                }}
              >
                <option value="disabled">Disabled (No checkout)</option>
                <option value="mock">Mock (Simulated billing)</option>
                <option value="stripe">Stripe (Live payment gateway)</option>
              </select>
            </label>
          </div>
        </fieldset>

        <section className="operator-catalog__plans">
          <div className="operator-catalog__plans-header">
            <h3>Configured Tiers ({draftPlans.length})</h3>
            <button
              type="button"
              className="button button--quiet"
              onClick={handleAddTier}
              disabled={saving}
            >
              + Add custom tier
            </button>
          </div>

          <div className="operator-catalog__plans-list">
            {draftPlans.map((plan) => {
              const isExpanded = expandedPlanId === plan.id;
              const isFree = plan.id === 'free';
              const stripePriceId = draftStripePriceIds[plan.id] ?? '';

              return (
                <div
                  key={plan.id}
                  className={`operator-plan-card ${!plan.active ? 'operator-plan-card--disabled' : ''}`}
                >
                  <header
                    className="operator-plan-card__header"
                    onClick={() => setExpandedPlanId(isExpanded ? null : plan.id)}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpandedPlanId(isExpanded ? null : plan.id);
                      }
                    }}
                  >
                    <div className="operator-plan-card__title-row">
                      <span className="operator-plan-card__name">{plan.name}</span>
                      <span className="operator-plan-card__id mono-label">({plan.id})</span>
                      <span className="operator-plan-card__price-summary">
                        {formatPlanCents(
                          Number(getRawDraft(plan.id, 'priceAmount', plan.price.amount)) ||
                            plan.price.amount,
                          plan.price.currency,
                        )}
                      </span>
                    </div>
                    <div className="operator-plan-card__badges">
                      <span
                        className={`badge ${plan.active ? 'badge--active' : 'badge--inactive'}`}
                      >
                        {plan.active ? 'Active' : 'Disabled'}
                      </span>
                      <span className="badge">{plan.published ? 'Published' : 'Unpublished'}</span>
                      {plan.preview && <span className="badge badge--preview">Preview</span>}
                      <span className="operator-plan-card__toggle-icon" aria-hidden="true">
                        {isExpanded ? '▲' : '▼'}
                      </span>
                    </div>
                  </header>

                  {isExpanded && (
                    <div className="operator-plan-card__body">
                      <div className="operator-plan-card__grid">
                        <label className="field" htmlFor={`plan-name-${plan.id}`}>
                          <span>Tier Name</span>
                          <input
                            id={`plan-name-${plan.id}`}
                            value={plan.name}
                            maxLength={100}
                            required
                            disabled={saving}
                            onChange={(e) =>
                              updatePlan(plan.id, (p) => ({ ...p, name: e.target.value }))
                            }
                          />
                        </label>

                        <label className="field" htmlFor={`plan-currency-${plan.id}`}>
                          <span>Currency</span>
                          <select
                            id={`plan-currency-${plan.id}`}
                            value={plan.price.currency}
                            disabled={saving}
                            onChange={(e) =>
                              updatePlan(plan.id, (p) => ({
                                ...p,
                                price: { ...p.price, currency: e.target.value as 'usd' | 'eur' },
                              }))
                            }
                          >
                            <option value="usd">USD ($)</option>
                            <option value="eur">EUR (€)</option>
                          </select>
                        </label>

                        <label className="field" htmlFor={`plan-price-${plan.id}`}>
                          <span>Price (integer cents / month, e.g. 2900 = $29.00)</span>
                          <input
                            id={`plan-price-${plan.id}`}
                            type="text"
                            inputMode="numeric"
                            value={getRawDraft(plan.id, 'priceAmount', plan.price.amount)}
                            disabled={isFree || saving}
                            onChange={(e) => {
                              setRawDraft(plan.id, 'priceAmount', e.target.value);
                            }}
                          />
                          <small className="settings-note">
                            Formatted:{' '}
                            {formatPlanCents(
                              Number(getRawDraft(plan.id, 'priceAmount', plan.price.amount)) || 0,
                              plan.price.currency,
                            )}
                          </small>
                        </label>

                        <label className="field field--full" htmlFor={`plan-desc-${plan.id}`}>
                          <span>Description</span>
                          <input
                            id={`plan-desc-${plan.id}`}
                            value={plan.description}
                            maxLength={1000}
                            disabled={saving}
                            onChange={(e) =>
                              updatePlan(plan.id, (p) => ({ ...p, description: e.target.value }))
                            }
                          />
                        </label>
                      </div>

                      <fieldset className="operator-plan-card__entitlements" disabled={saving}>
                        <legend className="mono-label">ENTITLEMENTS</legend>
                        <div className="operator-plan-card__entitlements-grid">
                          <label className="field" htmlFor={`plan-monitors-${plan.id}`}>
                            <span>Monitors Limit</span>
                            <input
                              id={`plan-monitors-${plan.id}`}
                              type="text"
                              inputMode="numeric"
                              value={getRawDraft(plan.id, 'monitors', plan.entitlements.monitors)}
                              disabled={saving}
                              onChange={(e) => {
                                setRawDraft(plan.id, 'monitors', e.target.value);
                              }}
                            />
                          </label>

                          <label className="field" htmlFor={`plan-regions-${plan.id}`}>
                            <span>Regions per check (max allowed)</span>
                            <input
                              id={`plan-regions-${plan.id}`}
                              type="text"
                              inputMode="numeric"
                              value={getRawDraft(plan.id, 'regions', plan.entitlements.regions)}
                              disabled={saving}
                              onChange={(e) => {
                                setRawDraft(plan.id, 'regions', e.target.value);
                              }}
                            />
                          </label>

                          <label className="field" htmlFor={`plan-seats-${plan.id}`}>
                            <span>Workspace Seats</span>
                            <input
                              id={`plan-seats-${plan.id}`}
                              type="text"
                              inputMode="numeric"
                              value={getRawDraft(plan.id, 'seats', plan.entitlements.seats)}
                              disabled={saving}
                              onChange={(e) => {
                                setRawDraft(plan.id, 'seats', e.target.value);
                              }}
                            />
                          </label>

                          <label className="field" htmlFor={`plan-pages-${plan.id}`}>
                            <span>Status Pages</span>
                            <input
                              id={`plan-pages-${plan.id}`}
                              type="text"
                              inputMode="numeric"
                              value={getRawDraft(
                                plan.id,
                                'statusPages',
                                plan.entitlements.statusPages,
                              )}
                              disabled={saving}
                              onChange={(e) => {
                                setRawDraft(plan.id, 'statusPages', e.target.value);
                              }}
                            />
                          </label>

                          <label className="field" htmlFor={`plan-destinations-${plan.id}`}>
                            <span>Notification Destinations</span>
                            <input
                              id={`plan-destinations-${plan.id}`}
                              type="text"
                              inputMode="numeric"
                              value={getRawDraft(
                                plan.id,
                                'notificationDestinations',
                                plan.entitlements.notificationDestinations,
                              )}
                              disabled={saving}
                              onChange={(e) => {
                                setRawDraft(plan.id, 'notificationDestinations', e.target.value);
                              }}
                            />
                          </label>

                          <label className="field" htmlFor={`plan-domains-${plan.id}`}>
                            <span>Custom Status Domains (≤ pages)</span>
                            <input
                              id={`plan-domains-${plan.id}`}
                              type="text"
                              inputMode="numeric"
                              value={getRawDraft(
                                plan.id,
                                'customDomains',
                                plan.entitlements.customDomains,
                              )}
                              disabled={saving}
                              onChange={(e) => {
                                setRawDraft(plan.id, 'customDomains', e.target.value);
                              }}
                            />
                          </label>

                          <label className="field">
                            <span>Check Interval (Fixed)</span>
                            <input value="300 seconds (5 min)" readOnly disabled />
                          </label>

                          <label className="field">
                            <span>Raw Retention (Fixed)</span>
                            <input value="24 hours" readOnly disabled />
                          </label>

                          <label className="field">
                            <span>Daily Retention (Fixed)</span>
                            <input value="30 days" readOnly disabled />
                          </label>
                        </div>

                        <div className="operator-plan-card__regions-section">
                          <span className="mono-label">ALLOWED CHECK REGIONS</span>
                          <div className="operator-plan-card__regions-grid">
                            {regionChoices.map((region) => {
                              const checked = plan.entitlements.allowedRegionIds.includes(
                                region.id,
                              );
                              return (
                                <label key={region.id} className="checkbox">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={saving}
                                    onChange={(e) => {
                                      const currentIds = plan.entitlements.allowedRegionIds;
                                      const nextIds = e.target.checked
                                        ? [...currentIds, region.id]
                                        : currentIds.filter((id) => id !== region.id);
                                      updatePlan(plan.id, (p) => ({
                                        ...p,
                                        entitlements: {
                                          ...p.entitlements,
                                          allowedRegionIds: nextIds,
                                        },
                                      }));
                                    }}
                                  />
                                  <span>{region.label}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      </fieldset>

                      <fieldset className="operator-plan-card__flags" disabled={saving}>
                        <legend className="mono-label">PLAN FLAGS</legend>
                        <div className="operator-plan-card__flags-grid">
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              checked={plan.active}
                              disabled={isFree || saving}
                              onChange={(e) =>
                                updatePlan(plan.id, (p) => ({ ...p, active: e.target.checked }))
                              }
                            />
                            <span>Active (Available for assignment and evaluation)</span>
                          </label>

                          <label className="checkbox">
                            <input
                              type="checkbox"
                              checked={plan.published}
                              disabled={saving}
                              onChange={(e) =>
                                updatePlan(plan.id, (p) => ({ ...p, published: e.target.checked }))
                              }
                            />
                            <span>Published (Visible on public /pricing table)</span>
                          </label>

                          <label className="checkbox">
                            <input
                              type="checkbox"
                              checked={plan.preview}
                              disabled={saving}
                              onChange={(e) =>
                                updatePlan(plan.id, (p) => ({ ...p, preview: e.target.checked }))
                              }
                            />
                            <span>Preview (Shows preview disclaimer on plan card)</span>
                          </label>
                        </div>
                      </fieldset>

                      <div className="operator-plan-card__stripe" style={{ marginTop: '1rem' }}>
                        <label className="field" htmlFor={`plan-stripe-${plan.id}`}>
                          <span>Stripe Price ID (Optional)</span>
                          <input
                            id={`plan-stripe-${plan.id}`}
                            value={stripePriceId}
                            placeholder="price_1N..."
                            disabled={saving}
                            onChange={(e) => {
                              const val = e.target.value.trim();
                              setDraftStripePriceIds((prev) => ({
                                ...prev,
                                [plan.id]: val,
                              }));
                              setSuccess(null);
                            }}
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="operator-catalog__save-bar">
          <label className="field field--full" htmlFor="catalog-reason">
            <span>Change Reason (Audited &amp; Required)</span>
            <input
              id="catalog-reason"
              placeholder="e.g., Update pro tier quotas for Q3 release"
              value={reason}
              maxLength={500}
              required
              disabled={saving}
              onChange={(e) => {
                setReason(e.target.value);
                setSuccess(null);
              }}
            />
          </label>

          <div className="operator-catalog__actions">
            <button
              type="submit"
              className="button button--primary"
              disabled={saving || !reason.trim()}
            >
              {saving ? 'Saving catalog revision…' : 'Save Catalog Revision'}
            </button>
          </div>
        </section>
      </form>
    </article>
  );
}
