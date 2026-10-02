import {
  checkIntervalPresets,
  defaultUptimeThresholds,
  normalizeMonitorUrl,
  normalizePublicMonitorSlug,
  publicMonitorSlugSchema,
  timeoutConstraints,
  type MonitorCreate,
  type Badge,
  type NotificationService,
} from '@uptime/contracts';
import {
  continentIds,
  continentLabels,
  regions,
  type RegionDefinition,
  type RegionId,
} from '@uptime/regions';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, RequestError } from './api.js';
import { formatInterval } from './monitor-format.js';
import {
  checkFrequencySliderIndex,
  expectedChecksPerDay,
  expectedDnsSnapshotsPerDay,
  intervalSecondsForSliderIndex,
} from './monitor-form.logic.js';

interface Props {
  monitor?: MonitorCreate & { id?: string; badge?: Badge | null | undefined };
  onCancel: () => void;
  onSaved: () => void;
  onHistoryDeleted?: () => void;
}
const initial: MonitorCreate = {
  url: '',
  regionIds: ['us-east'],
  intervalSeconds: 300,
  timeoutMs: 10_000,
  enabled: true,
  dnsDiagnosticsEnabled: false,
  isPublic: false,
  publicSlug: null,
  notificationServiceIds: [],
  outageThreshold: 3,
  recoveryThreshold: 2,
  repeatNotificationMinutes: null,
  badgeId: null,
  uptimeThresholds: defaultUptimeThresholds,
};
const frequencyMarks = [
  { index: 0, label: '1m' },
  { index: 14, label: '15m' },
  { index: 17, label: '30m' },
  { index: 20, label: '45m' },
  { index: 23, label: '60m' },
] as const;

export function MonitorForm({ monitor, onCancel, onSaved, onHistoryDeleted }: Props) {
  const [value, setValue] = useState<MonitorCreate>(() => ({
    ...initial,
    ...monitor,
    notificationServiceIds: monitor?.notificationServiceIds ?? [],
    outageThreshold: monitor?.outageThreshold ?? 3,
    recoveryThreshold: monitor?.recoveryThreshold ?? 2,
    repeatNotificationMinutes: monitor?.repeatNotificationMinutes ?? null,
    badgeId: monitor?.badgeId ?? monitor?.badge?.id ?? null,
    uptimeThresholds: monitor?.uptimeThresholds ?? defaultUptimeThresholds,
  }));
  const [badges, setBadges] = useState<Badge[]>([]);
  const [badgeName, setBadgeName] = useState(monitor?.badge?.name ?? '');
  const [creatingBadge, setCreatingBadge] = useState(false);
  const [availableRegions, setAvailableRegions] = useState<readonly RegionDefinition[]>(regions);
  const [notificationServices, setNotificationServices] = useState<NotificationService[] | null>(
    null,
  );
  const [notificationServicesError, setNotificationServicesError] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [urlError, setUrlError] = useState('');
  const [historyDeleteOpen, setHistoryDeleteOpen] = useState(false);
  const [historyDeleted, setHistoryDeleted] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .badges()
      .then(({ badges: choices }) => {
        if (alive) setBadges(Array.isArray(choices) ? choices : []);
      })
      .catch(() => undefined);
    api
      .regions()
      .then(({ regions: enabledRegions }) => {
        if (!alive) return;
        setAvailableRegions(enabledRegions);
        const enabledIds = new Set(enabledRegions.map((region) => region.id));
        setValue((current) => {
          const regionIds = current.regionIds.filter((regionId) => enabledIds.has(regionId));
          return {
            ...current,
            regionIds:
              regionIds.length > 0 ? regionIds : enabledRegions[0] ? [enabledRegions[0].id] : [],
          };
        });
      })
      .catch(() => undefined);
    api
      .notificationServices()
      .then(({ services }) => {
        if (!alive) return;
        if (!Array.isArray(services)) throw new Error('Notification services response is invalid.');
        setNotificationServices(services);
        setNotificationServicesError('');
      })
      .catch((reason) => {
        if (!alive) return;
        setNotificationServicesError(
          reason instanceof Error ? reason.message : 'Notification services could not be loaded.',
        );
      });
    return () => {
      alive = false;
    };
  }, []);
  const slugError = value.publicSlug
    ? (publicMonitorSlugSchema.safeParse(value.publicSlug).error?.issues[0]?.message ?? '')
    : '';
  const timeoutError =
    value.timeoutMs < timeoutConstraints.minimumMs || value.timeoutMs > timeoutConstraints.maximumMs
      ? 'Timeout must be between 1 and 30 seconds.'
      : value.timeoutMs >= value.intervalSeconds * 1000
        ? 'Timeout must be shorter than the check interval.'
        : '';
  const notificationRulesInvalid =
    [value.outageThreshold, value.recoveryThreshold].some(
      (threshold) => !Number.isInteger(threshold) || (threshold ?? 0) < 1 || (threshold ?? 0) > 100,
    ) ||
    (value.repeatNotificationMinutes !== null &&
      (!Number.isInteger(value.repeatNotificationMinutes) ||
        (value.repeatNotificationMinutes ?? 0) < 1 ||
        (value.repeatNotificationMinutes ?? 0) > 10_080));
  const uptimeThresholds = value.uptimeThresholds ?? defaultUptimeThresholds;
  const uptimeThresholdsInvalid =
    uptimeThresholds.orange < 0 ||
    uptimeThresholds.green > 100 ||
    uptimeThresholds.orange > uptimeThresholds.lightGreen ||
    uptimeThresholds.lightGreen > uptimeThresholds.green;
  const matchingBadge = badges.find(
    (badge) => badge.name.toLocaleLowerCase() === badgeName.trim().toLocaleLowerCase(),
  );
  const unresolvedBadge = Boolean(badgeName.trim() && !matchingBadge);
  const checksPerDay = expectedChecksPerDay(value.regionIds, value.intervalSeconds);
  const displayedChecksPerDay = Math.round(checksPerDay);
  const displayedChecksPerRegion = Math.round(86_400 / value.intervalSeconds);
  const frequencyMinutes = value.intervalSeconds / 60;
  const frequencySliderIndex = checkFrequencySliderIndex(value.intervalSeconds);
  const dnsSnapshotsPerDay = expectedDnsSnapshotsPerDay(
    value.regionIds,
    value.dnsDiagnosticsEnabled,
  );
  function set<K extends keyof MonitorCreate>(key: K, next: MonitorCreate[K]) {
    setValue((current) => ({ ...current, [key]: next }));
  }
  function validateUrl(raw = value.url) {
    let message = '';
    if (!raw) message = 'A monitoring URL is required. Enter an absolute HTTP or HTTPS URL.';
    else {
      try {
        const url = new URL(normalizeMonitorUrl(raw));
        message = ['http:', 'https:'].includes(url.protocol) ? '' : 'URL must use HTTP or HTTPS.';
      } catch {
        message = 'Enter an absolute HTTP or HTTPS URL.';
      }
    }
    setUrlError(message);
    return message;
  }
  function toggle(region: RegionId) {
    set(
      'regionIds',
      value.regionIds.includes(region)
        ? value.regionIds.filter((id) => id !== region)
        : [...value.regionIds, region],
    );
  }
  function toggleNotificationService(serviceId: string) {
    const selected = value.notificationServiceIds ?? [];
    set(
      'notificationServiceIds',
      selected.includes(serviceId)
        ? selected.filter((id) => id !== serviceId)
        : [...selected, serviceId],
    );
  }
  async function createBadge() {
    const name = badgeName.trim();
    if (!name || name.length > 40) return;
    setCreatingBadge(true);
    setError('');
    try {
      const badge = await api.createBadge({ name });
      setBadges((current) =>
        current.some((item) => item.id === badge.id) ? current : [...current, badge],
      );
      setBadgeName(badge.name);
      set('badgeId', badge.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The badge could not be created.');
    } finally {
      setCreatingBadge(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched({ url: true, timeoutMs: true, regionIds: true, publicSlug: true });
    const normalizedUrl = normalizeMonitorUrl(value.url);
    const nextUrlError = validateUrl(normalizedUrl);
    if (
      nextUrlError ||
      timeoutError ||
      slugError ||
      notificationRulesInvalid ||
      uptimeThresholdsInvalid ||
      unresolvedBadge ||
      !value.url ||
      value.regionIds.length === 0
    )
      return;
    const input = { ...value, url: normalizedUrl };
    setValue(input);
    setBusy(true);
    setError('');
    try {
      if (monitor?.id) await api.updateMonitor(monitor.id, input);
      else await api.createMonitor(input);
      onSaved();
    } catch (reason) {
      setError(
        reason instanceof RequestError
          ? reason.message
          : 'The monitor could not be saved. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="form-page">
      <div className="page-head">
        <div>
          <h1>{monitor ? 'Edit monitor' : 'Add monitor'}</h1>
          <p>Every selected region performs one bounded GET for each scheduled interval.</p>
        </div>
      </div>
      <form className="monitor-form" onSubmit={submit} noValidate>
        <label className="field">
          <span>
            Monitoring URL <b aria-hidden="true">*</b>
          </span>
          <input
            type="text"
            inputMode="url"
            value={value.url}
            placeholder="https://status.example.com/health"
            onBlur={() => {
              setTouched((state) => ({ ...state, url: true }));
              if (value.url) {
                const normalizedUrl = normalizeMonitorUrl(value.url);
                set('url', normalizedUrl);
                validateUrl(normalizedUrl);
              } else validateUrl();
            }}
            onChange={(event) => {
              const next = event.target.value;
              set('url', next);
              if (touched.url) validateUrl(next);
            }}
            aria-invalid={Boolean(touched.url && urlError)}
            aria-describedby="url-help"
            required
          />{' '}
          <small id="url-help" className={touched.url && urlError ? 'field-error' : ''}>
            {touched.url && urlError
              ? urlError
              : 'HTTPS is used when no scheme is provided. Private and reserved addresses are rejected.'}
          </small>
        </label>
        <label className="field monitor-badge-field">
          <span>
            Badge <em>optional</em>
          </span>
          <input
            list="monitor-badge-options"
            value={badgeName}
            maxLength={40}
            placeholder="API, Storefront, Internal…"
            onChange={(event) => {
              const name = event.target.value;
              const match = badges.find(
                (badge) => badge.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
              );
              setBadgeName(name);
              set('badgeId', match?.id ?? null);
            }}
          />
          <datalist id="monitor-badge-options">
            {badges.map((badge) => (
              <option value={badge.name} key={badge.id} />
            ))}
          </datalist>
          {badgeName.trim() && !matchingBadge ? (
            <span className="badge-create-prompt">
              No existing badge matches.
              <button
                type="button"
                className="button button--quiet"
                disabled={creatingBadge}
                onClick={() => void createBadge()}
              >
                {creatingBadge ? 'Creating…' : `Create “${badgeName.trim()}”`}
              </button>
            </span>
          ) : (
            <small>Choose an existing badge or type a new name.</small>
          )}
        </label>
        <label className="field">
          <span>
            Label <em>optional</em>
          </span>
          <input
            value={value.name ?? ''}
            onChange={(event) => set('name', event.target.value || null)}
            placeholder="Public status page"
          />
          <small>Used in the monitor list. The URL host is shown when left empty.</small>
        </label>
        <fieldset className="regions">
          <legend>
            Regions <b aria-hidden="true">*</b>
          </legend>
          <div className="region-groups">
            {continentIds.map((continentId) => {
              const continentRegions = availableRegions.filter(
                (region) => region.continentId === continentId,
              );
              return continentRegions.length > 0 ? (
                <section
                  key={continentId}
                  className="region-group"
                  aria-label={continentLabels[continentId]}
                >
                  <h2>{continentLabels[continentId]}</h2>
                  <div className="region-options">
                    {continentRegions.map((region) => (
                      <label key={region.id} className="region-option">
                        <input
                          type="checkbox"
                          checked={value.regionIds.includes(region.id)}
                          onChange={() => toggle(region.id)}
                          disabled={busy}
                        />
                        <span>
                          <strong>{region.label}</strong>
                          <small>
                            {region.approximateAnchor} · {region.placementRegion}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                </section>
              ) : null;
            })}
          </div>
          {touched.regionIds && value.regionIds.length === 0 && (
            <p className="field-error">Select at least one region before saving.</p>
          )}
        </fieldset>
        <div className="form-grid">
          <label className="field frequency-field">
            <span className="frequency-field__heading">
              <span>Check frequency</span>
              <output className="frequency-field__value tnum" htmlFor="check-frequency">
                Every {formatInterval(value.intervalSeconds)}
              </output>
            </span>
            <input
              id="check-frequency"
              className="frequency-slider"
              type="range"
              min="0"
              max={checkIntervalPresets.length - 1}
              step="1"
              value={frequencySliderIndex}
              aria-label="Check frequency"
              aria-valuetext={`${frequencyMinutes} minute${frequencyMinutes === 1 ? '' : 's'}`}
              onInput={(event) =>
                set(
                  'intervalSeconds',
                  intervalSecondsForSliderIndex(Number(event.currentTarget.value)),
                )
              }
            />
            <span className="frequency-slider__marks" aria-hidden="true">
              {frequencyMarks.map((mark) => (
                <span
                  className="frequency-slider__mark"
                  key={mark.index}
                  style={{
                    left: `${(mark.index / (checkIntervalPresets.length - 1)) * 100}%`,
                  }}
                >
                  {mark.label}
                </span>
              ))}
            </span>
            <small>Schedules are aligned to UTC interval boundaries.</small>
          </label>
          <label className="field">
            <span>Request timeout</span>
            <input
              type="number"
              min={timeoutConstraints.minimumMs / 1000}
              max={timeoutConstraints.maximumMs / 1000}
              step="1"
              value={value.timeoutMs / 1000}
              onBlur={() => setTouched((state) => ({ ...state, timeoutMs: true }))}
              onChange={(event) => set('timeoutMs', Number(event.target.value) * 1000)}
              aria-invalid={Boolean(touched.timeoutMs && timeoutError)}
            />
            <small className={touched.timeoutMs && timeoutError ? 'field-error' : ''}>
              {touched.timeoutMs && timeoutError
                ? timeoutError
                : 'Between 1 and 30 seconds, and shorter than the interval.'}
            </small>
          </label>
        </div>
        <aside className="estimate">
          <span className="mono-label">EXPECTED TARGET CHECKS/DAY</span>
          <strong className="tnum">{displayedChecksPerDay.toLocaleString()}</strong>
          <p>
            {value.regionIds.length} selected region{value.regionIds.length === 1 ? '' : 's'} ×{' '}
            {displayedChecksPerRegion.toLocaleString()} checks per region. Redirects and manual
            checks are excluded.
          </p>
        </aside>
        <fieldset className="diagnostic-option uptime-thresholds">
          <legend>Uptime color thresholds</legend>
          <p className="notification-rules__intro">
            Set the percentage bands used in uptime history. Values above green and light green use
            those colors; orange includes its boundary; lower values are red.
          </p>
          <div className="form-grid">
            {(
              [
                ['green', 'Green above'],
                ['lightGreen', 'Light green above'],
                ['orange', 'Orange from'],
              ] as const
            ).map(([key, label]) => (
              <label className="field" key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={uptimeThresholds[key]}
                  onChange={(event) =>
                    set('uptimeThresholds', {
                      ...uptimeThresholds,
                      [key]: Number(event.target.value),
                    })
                  }
                />
              </label>
            ))}
          </div>
          {uptimeThresholdsInvalid && (
            <p className="field-error">Thresholds must descend from green to orange.</p>
          )}
        </fieldset>
        <fieldset className="diagnostic-option">
          <legend>Network diagnostics</legend>
          <label className="region-option diagnostic-option__control">
            <input
              type="checkbox"
              checked={value.dnsDiagnosticsEnabled}
              disabled={busy}
              onChange={(event) => set('dnsDiagnosticsEnabled', event.target.checked)}
              aria-describedby="dns-diagnostics-help"
            />
            <span>
              <strong>Collect DNS diagnostics</strong>
              <small id="dns-diagnostics-help">
                Captures DNS candidates for the final hostname at most once per day in each selected
                region. Candidates may differ from the IP used by HTTP; this is not traceroute.
              </small>
            </span>
          </label>
          {value.dnsDiagnosticsEnabled && (
            <aside className="estimate estimate--secondary" aria-live="polite">
              <span className="mono-label">DNS SNAPSHOTS/DAY</span>
              <strong className="tnum">{dnsSnapshotsPerDay.toLocaleString()}</strong>
              <p>
                At most {dnsSnapshotsPerDay.toLocaleString()} regional snapshot
                {dnsSnapshotsPerDay === 1 ? '' : 's'} per day, up to 3 resolver queries per
                snapshot. This does not change expected target checks/day.
              </p>
            </aside>
          )}
        </fieldset>
        <fieldset className="diagnostic-option notification-rules">
          <legend>Outage notifications</legend>
          <p className="notification-rules__intro">
            A check counts as failed when any region returns a failure. Recovery requires every
            configured region to return success. A round with missing results and no reported
            failure breaks either streak.
          </p>
          {notificationServicesError && (
            <p className="field-error" role="alert">
              Notification services could not be loaded: {notificationServicesError} Existing
              selections are preserved.
            </p>
          )}
          {notificationServices === null && !notificationServicesError ? (
            <p role="status">Loading notification services…</p>
          ) : (
            <div className="notification-service-options">
              {(notificationServices ?? []).map((service) => (
                <label className="region-option" key={service.id}>
                  <input
                    type="checkbox"
                    checked={(value.notificationServiceIds ?? []).includes(service.id)}
                    disabled={busy}
                    onChange={() => toggleNotificationService(service.id)}
                  />
                  <span>
                    <strong>{service.name}</strong>
                    <small>
                      {service.provider === 'telegram' ? 'Telegram' : 'Discord'}
                      {service.enabled ? '' : ' · disabled'}
                    </small>
                  </span>
                </label>
              ))}
              {(value.notificationServiceIds ?? [])
                .filter((id) => !(notificationServices ?? []).some((service) => service.id === id))
                .map((id) => (
                  <label className="region-option" key={id}>
                    <input
                      type="checkbox"
                      checked
                      disabled={busy}
                      onChange={() => toggleNotificationService(id)}
                    />
                    <span>
                      <strong>Unavailable notification service</strong>
                      <small>{id}</small>
                    </span>
                  </label>
                ))}
              {notificationServices?.length === 0 &&
                (value.notificationServiceIds ?? []).length === 0 && (
                  <p>No services configured. Add one from the Notifications section.</p>
                )}
            </div>
          )}
          <div className="form-grid notification-thresholds">
            {(
              [
                ['outageThreshold', 'Failed checks before outage', 3],
                ['recoveryThreshold', 'Healthy checks before recovery', 2],
              ] as const
            ).map(([key, label, fallback]) => (
              <label className="field" key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  required
                  value={value[key] ?? fallback}
                  onChange={(event) => set(key, Number(event.target.value))}
                />
              </label>
            ))}
          </div>
          <label className="region-option diagnostic-option__control">
            <input
              type="checkbox"
              checked={value.repeatNotificationMinutes !== null}
              disabled={busy}
              onChange={(event) =>
                set('repeatNotificationMinutes', event.target.checked ? 60 : null)
              }
            />
            <span>
              <strong>Repeat notifications while down</strong>
              <small>Send reminders until the monitor recovers.</small>
            </span>
          </label>
          {value.repeatNotificationMinutes !== null && (
            <label className="field notification-repeat-field">
              <span>Reminder interval in minutes</span>
              <input
                type="number"
                min="1"
                max="10080"
                required
                value={value.repeatNotificationMinutes}
                onChange={(event) => set('repeatNotificationMinutes', Number(event.target.value))}
              />
              <small>Between 1 minute and 7 days.</small>
            </label>
          )}
          {notificationRulesInvalid && (
            <p className="field-error">
              Outage and recovery thresholds must be 1–100. Reminder intervals must be 1–10,080
              minutes.
            </p>
          )}
        </fieldset>
        <fieldset className="diagnostic-option">
          <legend>Public sharing</legend>
          <label className="region-option diagnostic-option__control">
            <input
              type="checkbox"
              checked={value.isPublic}
              disabled={busy}
              onChange={(event) => set('isPublic', event.target.checked)}
              aria-describedby="public-sharing-help"
            />
            <span>
              <strong>Share this monitor publicly</strong>
              <small id="public-sharing-help">
                Anyone with the public link can view aggregate status and latency graphs. Exact
                requests and DNS diagnostics remain private.
              </small>
            </span>
          </label>
          {monitor?.id && (
            <label className="field public-slug-field">
              <span>
                Public URL slug <em>optional</em>
              </span>
              <span className="public-slug-field__input">
                <span aria-hidden="true">/monitors/public/</span>
                <input
                  value={value.publicSlug ?? ''}
                  placeholder={monitor.id}
                  disabled={busy}
                  onBlur={() => {
                    setTouched((state) => ({ ...state, publicSlug: true }));
                    if (value.publicSlug) {
                      set('publicSlug', normalizePublicMonitorSlug(value.publicSlug));
                    }
                  }}
                  onChange={(event) => set('publicSlug', event.target.value || null)}
                  aria-invalid={Boolean(touched.publicSlug && slugError)}
                  aria-describedby="public-slug-help"
                />
              </span>
              <small
                id="public-slug-help"
                className={touched.publicSlug && slugError ? 'field-error' : ''}
              >
                {touched.publicSlug && slugError
                  ? slugError
                  : 'Uses lowercase letters, numbers, dots, and hyphens. Leave empty to use the monitor ID.'}
              </small>
            </label>
          )}
        </fieldset>
        {monitor?.id && (
          <section className="monitor-history-danger" aria-labelledby="monitor-history-title">
            <div>
              <h2 id="monitor-history-title">Monitor history</h2>
              <p>
                Permanently remove stored uptime, latency, request, DNS diagnostic, and notification
                delivery history without deleting this monitor.
              </p>
              {historyDeleted && (
                <p className="monitor-history-danger__success" role="status">
                  History deleted. A fresh check has been scheduled.
                </p>
              )}
            </div>
            <button
              type="button"
              className="button button--danger"
              disabled={busy}
              onClick={() => setHistoryDeleteOpen(true)}
            >
              Delete all history
            </button>
          </section>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button button--quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="button button--primary"
            disabled={
              busy ||
              Boolean(
                urlError ||
                timeoutError ||
                slugError ||
                notificationRulesInvalid ||
                uptimeThresholdsInvalid ||
                unresolvedBadge ||
                !value.url ||
                value.regionIds.length === 0,
              )
            }
          >
            {busy ? 'Saving…' : 'Save monitor'}
          </button>
        </div>
      </form>
      {historyDeleteOpen && monitor?.id && (
        <DeleteHistoryDialog
          onCancel={() => setHistoryDeleteOpen(false)}
          onConfirm={async () => {
            await api.deleteMonitorHistory(monitor.id!);
            setHistoryDeleteOpen(false);
            setHistoryDeleted(true);
            onHistoryDeleted?.();
          }}
        />
      )}
    </section>
  );
}

export function DeleteHistoryDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="confirm"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      aria-labelledby="delete-history-title"
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed !== 'DELETE' || busy) return;
          setBusy(true);
          setError('');
          void onConfirm()
            .catch((reason) => {
              setError(reason instanceof Error ? reason.message : 'History could not be deleted.');
            })
            .finally(() => setBusy(false));
        }}
      >
        <h2 id="delete-history-title">Delete all monitor history?</h2>
        <p>
          This cannot be undone. The monitor and its settings will remain, and a fresh check will be
          scheduled. Type DELETE to continue.
        </p>
        <label className="field">
          <span>Confirmation</span>
          <input
            value={typed}
            autoComplete="off"
            autoFocus
            onChange={(event) => setTyped(event.target.value)}
            aria-describedby={error ? 'delete-history-error' : undefined}
          />
        </label>
        {error && (
          <p id="delete-history-error" className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button button--quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="button button--danger" disabled={typed !== 'DELETE' || busy}>
            {busy ? 'Deleting history…' : 'Delete all history'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
