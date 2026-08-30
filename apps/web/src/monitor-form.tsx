import type { MonitorCreate } from '@uptime/contracts';
import { checkIntervalPresets, timeoutConstraints } from '@uptime/config';
import { continentIds, continentLabels, regionsByContinent, type RegionId } from '@uptime/regions';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, RequestError } from './api.js';
import { formatInterval } from './main.js';
import { expectedChecksPerDay, expectedDnsSnapshotsPerDay } from './monitor-form.logic.js';

interface Props {
  monitor?: MonitorCreate & { id?: string };
  onCancel: () => void;
  onSaved: () => void;
}
const initial: MonitorCreate = {
  url: '',
  regionIds: ['us-east'],
  intervalSeconds: 300,
  timeoutMs: 10_000,
  enabled: true,
  dnsDiagnosticsEnabled: false,
  isPublic: false,
};

export function MonitorForm({ monitor, onCancel, onSaved }: Props) {
  const [value, setValue] = useState<MonitorCreate>(monitor ?? initial);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [urlError, setUrlError] = useState('');
  const timeoutError =
    value.timeoutMs < timeoutConstraints.minimumMs || value.timeoutMs > timeoutConstraints.maximumMs
      ? 'Timeout must be between 1 and 30 seconds.'
      : value.timeoutMs >= value.intervalSeconds * 1000
        ? 'Timeout must be shorter than the check interval.'
        : '';
  const checksPerDay = expectedChecksPerDay(value.regionIds, value.intervalSeconds);
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
        const url = new URL(raw);
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
  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched({ url: true, timeoutMs: true, regionIds: true });
    const nextUrlError = validateUrl();
    if (nextUrlError || timeoutError || !value.url || value.regionIds.length === 0) return;
    setBusy(true);
    setError('');
    try {
      if (monitor?.id) await api.updateMonitor(monitor.id, value);
      else await api.createMonitor(value);
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
            type="url"
            value={value.url}
            placeholder="https://status.example.com/health"
            onBlur={() => {
              setTouched((state) => ({ ...state, url: true }));
              validateUrl();
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
              : 'HTTP and HTTPS URLs only. Private and reserved addresses are rejected.'}
          </small>
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
            {continentIds.map((continentId) => (
              <section
                key={continentId}
                className="region-group"
                aria-label={continentLabels[continentId]}
              >
                <h2>{continentLabels[continentId]}</h2>
                <div className="region-options">
                  {regionsByContinent[continentId].map((region) => (
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
            ))}
          </div>
          {touched.regionIds && value.regionIds.length === 0 && (
            <p className="field-error">Select at least one region before saving.</p>
          )}
        </fieldset>
        <div className="form-grid">
          <label className="field">
            <span>Check frequency</span>
            <select
              value={value.intervalSeconds}
              onChange={(event) =>
                set(
                  'intervalSeconds',
                  Number(event.target.value) as MonitorCreate['intervalSeconds'],
                )
              }
            >
              {checkIntervalPresets.map((seconds) => (
                <option key={seconds} value={seconds}>
                  Every {formatInterval(seconds)}
                </option>
              ))}
            </select>
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
          <strong className="tnum">{checksPerDay.toLocaleString()}</strong>
          <p>
            {value.regionIds.length} selected region{value.regionIds.length === 1 ? '' : 's'} ×{' '}
            {86_400 / value.intervalSeconds} checks per region. Redirects and manual checks are
            excluded.
          </p>
        </aside>
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
        </fieldset>
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
              Boolean(urlError || timeoutError || !value.url || value.regionIds.length === 0)
            }
          >
            {busy ? 'Saving…' : 'Save monitor'}
          </button>
        </div>
      </form>
    </section>
  );
}
