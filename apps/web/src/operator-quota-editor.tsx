import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { findRegion, type RegionDefinition, type RegionId } from '@uptime/regions';
import { api, type Capacity, type OperatorWorkspace, type ProductLimits } from './api.js';
import './operator-operations.css';

export interface WorkspaceLimitsEditorProps {
  workspace: OperatorWorkspace;
  availableRegions: RegionDefinition[];
  onSaved: (limits: ProductLimits) => void;
}

export function workspaceRegionNames(regionIds: readonly RegionId[]) {
  return regionIds.map((regionId) => findRegion(regionId)?.label ?? regionId).join(', ');
}

function computeQuotaKey(
  workspaceId: string,
  monitors: string,
  regions: string,
  allowedRegionIds: readonly RegionId[],
) {
  const sorted = [...new Set(allowedRegionIds)].sort().join(',');
  return `${workspaceId}:${monitors.trim()}:${regions.trim()}:${sorted}`;
}

export function WorkspaceLimitsEditor({
  workspace,
  availableRegions,
  onSaved,
}: WorkspaceLimitsEditorProps) {
  const limits = workspace.limits;
  const [monitors, setMonitors] = useState(() => String(limits?.monitors ?? 3));
  const [regions, setRegions] = useState(() => String(limits?.regions ?? 3));
  const [allowedRegionIds, setAllowedRegionIds] = useState<RegionId[]>(
    () => limits?.allowedRegionIds ?? [],
  );

  const [pending, setPending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<Capacity | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  const previewSeq = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorId = useId();
  const [invalidField, setInvalidField] = useState<
    'monitors' | 'regions' | 'allowedRegionIds' | null
  >(null);

  const lastWorkspaceId = useRef(workspace.id);
  // Sync state if workspace changes
  useEffect(() => {
    if (lastWorkspaceId.current !== workspace.id) {
      lastWorkspaceId.current = workspace.id;
      if (workspace.limits) {
        setMonitors(String(workspace.limits.monitors));
        setRegions(String(workspace.limits.regions));
        setAllowedRegionIds(workspace.limits.allowedRegionIds ?? []);
      }
      previewSeq.current += 1;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      setPreview(null);
      setPreviewKey(null);
      setPreviewing(false);
      setPreviewError('');
      setSaveError('');
      setSaved(false);
    }
  }, [workspace.id, workspace.limits]);

  // Run preview on values change
  useEffect(() => {
    const seq = ++previewSeq.current;
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }

    const currentKey = computeQuotaKey(workspace.id, monitors, regions, allowedRegionIds);
    const monitorLimit = Number(monitors);
    const regionLimit = Number(regions);
    const configuredIds = new Set(availableRegions.map((region) => region.id));
    const uniqueRegionIds = [...new Set(allowedRegionIds)];

    if (
      monitors.trim() === '' ||
      !Number.isInteger(monitorLimit) ||
      monitorLimit < 0 ||
      monitorLimit > 1000
    ) {
      setPreview(null);
      setPreviewKey(null);
      setPreviewing(false);
      setPreviewError('Monitor limit must be a whole number from 0 to 1000.');
      setInvalidField('monitors');
      return;
    }

    if (
      regions.trim() === '' ||
      !Number.isInteger(regionLimit) ||
      regionLimit < 1 ||
      regionLimit > 9
    ) {
      setPreview(null);
      setPreviewKey(null);
      setPreviewing(false);
      setPreviewError('Regions per monitor must be a whole number from 1 to 9.');
      setInvalidField('regions');
      return;
    }

    if (
      uniqueRegionIds.length === 0 ||
      uniqueRegionIds.some((regionId) => !configuredIds.has(regionId))
    ) {
      setPreview(null);
      setPreviewKey(null);
      setPreviewing(false);
      setPreviewError('Select at least one deployment-configured region.');
      setInvalidField('allowedRegionIds');
      return;
    }

    if (regionLimit > uniqueRegionIds.length) {
      setPreview(null);
      setPreviewKey(null);
      setPreviewing(false);
      setPreviewError('Regions per monitor cannot exceed the number of allowed regions.');
      setInvalidField('regions');
      return;
    }

    setInvalidField(null);
    setPreviewError('');
    setPreviewing(true);
    // Invalidate prior preview while loading new preview
    setPreview(null);
    setPreviewKey(null);

    debounceTimer.current = setTimeout(() => {
      api
        .operatorWorkspaceLimitsPreview(workspace.id, {
          monitors: monitorLimit,
          regions: regionLimit,
          allowedRegionIds: uniqueRegionIds,
        })
        .then((res) => {
          if (previewSeq.current === seq) {
            setPreview(res.capacity);
            setPreviewKey(currentKey);
            setPreviewError('');
          }
        })
        .catch((reason) => {
          if (previewSeq.current === seq) {
            setPreview(null);
            setPreviewKey(null);
            setPreviewError(reason instanceof Error ? reason.message : 'Could not preview limits.');
          }
        })
        .finally(() => {
          if (previewSeq.current === seq) {
            setPreviewing(false);
          }
        });
    }, 200);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [monitors, regions, allowedRegionIds, availableRegions, workspace.id]);

  const selectedNames = workspaceRegionNames(allowedRegionIds);

  function toggleRegion(regionId: RegionId) {
    setAllowedRegionIds((current) =>
      current.includes(regionId)
        ? current.filter((selected) => selected !== regionId)
        : [...current, regionId],
    );
    setPreview(null);
    setPreviewKey(null);
    setSaved(false);
    setSaveError('');
  }

  const currentKey = computeQuotaKey(workspace.id, monitors, regions, allowedRegionIds);
  const isPreviewValidAndSafe =
    !previewing &&
    !pending &&
    !previewError &&
    preview !== null &&
    preview.safe === true &&
    previewKey === currentKey;

  const isSaveDisabled = !isPreviewValidAndSafe || availableRegions.length === 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError('');
    setSaved(false);

    const monitorLimit = Number(monitors);
    const regionLimit = Number(regions);
    const configuredIds = new Set(availableRegions.map((region) => region.id));
    const uniqueRegionIds = [...new Set(allowedRegionIds)];

    if (
      monitors.trim() === '' ||
      !Number.isInteger(monitorLimit) ||
      monitorLimit < 0 ||
      monitorLimit > 1000
    ) {
      setSaveError('Monitor limit must be a whole number from 0 to 1000.');
      setInvalidField('monitors');
      return;
    }
    if (
      regions.trim() === '' ||
      !Number.isInteger(regionLimit) ||
      regionLimit < 1 ||
      regionLimit > 9
    ) {
      setSaveError('Regions per monitor must be a whole number from 1 to 9.');
      setInvalidField('regions');
      return;
    }
    if (
      uniqueRegionIds.length === 0 ||
      uniqueRegionIds.some((regionId) => !configuredIds.has(regionId))
    ) {
      setSaveError('Select at least one deployment-configured region.');
      setInvalidField('allowedRegionIds');
      return;
    }
    if (regionLimit > uniqueRegionIds.length) {
      setSaveError('Regions per monitor cannot exceed the number of allowed regions.');
      setInvalidField('regions');
      return;
    }

    if (!isPreviewValidAndSafe || !preview) {
      if (preview && !preview.safe) {
        setSaveError(preview.warnings.join('; ') || 'Proposed limits exceed capacity limits.');
      } else if (previewError) {
        setSaveError(previewError);
      } else {
        setSaveError('A valid, safe capacity preview is required before saving.');
      }
      return;
    }

    setPending(true);
    try {
      const result = await api.updateOperatorWorkspaceLimits(workspace.id, {
        monitors: monitorLimit,
        regions: regionLimit,
        allowedRegionIds: uniqueRegionIds,
      });
      onSaved(result.limits);
      setMonitors(String(result.limits.monitors));
      setRegions(String(result.limits.regions));
      setAllowedRegionIds(result.limits.allowedRegionIds);
      setSaved(true);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : 'Could not update workspace limits.');
    } finally {
      setPending(false);
    }
  }

  if (!limits) return null;

  return (
    <div className="operator-limits">
      <form className="operator-limits__form" noValidate onSubmit={(event) => void submit(event)}>
        <label>
          Saved monitors
          <input
            type="number"
            min="0"
            max="1000"
            step="1"
            required
            value={monitors}
            disabled={pending}
            aria-invalid={invalidField === 'monitors'}
            aria-describedby={invalidField === 'monitors' ? errorId : undefined}
            aria-label={`Saved monitor limit for ${workspace.name}`}
            onChange={(event) => {
              setMonitors(event.target.value);
              setPreview(null);
              setPreviewKey(null);
              setSaved(false);
              setSaveError('');
            }}
          />
        </label>
        <label>
          Regions per monitor
          <input
            type="number"
            min="1"
            max="9"
            step="1"
            required
            value={regions}
            disabled={pending}
            aria-invalid={invalidField === 'regions'}
            aria-describedby={invalidField === 'regions' ? errorId : undefined}
            aria-label={`Regions per monitor for ${workspace.name}`}
            onChange={(event) => {
              setRegions(event.target.value);
              setPreview(null);
              setPreviewKey(null);
              setSaved(false);
              setSaveError('');
            }}
          />
        </label>
        <fieldset aria-describedby={invalidField === 'allowedRegionIds' ? errorId : undefined}>
          <legend>Allowed regions</legend>
          {availableRegions.length === 0 ? (
            <p>No regions are configured for this deployment.</p>
          ) : (
            <div className="operator-limits__regions">
              {availableRegions.map((region) => (
                <label key={region.id}>
                  <input
                    type="checkbox"
                    name="allowedRegionIds"
                    value={region.id}
                    checked={allowedRegionIds.includes(region.id)}
                    disabled={pending}
                    onChange={() => toggleRegion(region.id)}
                  />
                  {region.label}
                </label>
              ))}
            </div>
          )}
          <small>Selected: {selectedNames || 'none'}</small>
        </fieldset>

        {/* Live Server Preview Section */}
        {previewing && <p className="operator-preview-status">Previewing capacity…</p>}
        {previewError && (
          <p id={errorId} className="field-error" role="alert">
            {previewError}
          </p>
        )}
        {preview && (
          <div
            className={`operator-capacity-preview ${
              !preview.safe ? 'operator-capacity-preview--unsafe' : ''
            }`}
          >
            <div className="operator-capacity-preview__title">
              <span>Capacity Preview ({preview.headroomPercent}% Headroom)</span>
              <span
                className={`operator-badge ${
                  preview.safe ? 'operator-badge--ok' : 'operator-badge--paused'
                }`}
              >
                {preview.safe ? 'Safe' : 'Exceeds Capacity'}
              </span>
            </div>

            <div className="operator-capacity-metrics">
              <div className="operator-capacity-metric-item">
                <strong>Planned Grant (Worst-case)</strong>
                <span>
                  {preview.grant.monitors} monitors · {preview.grant.regionalTasks} regional checks
                </span>
                <small>
                  Monitor claims:{' '}
                  <strong>{(preview.utilization.monitorClaims * 100).toFixed(1)}%</strong> cap
                </small>
                <small>
                  Regional tasks:{' '}
                  <strong>{(preview.utilization.regionalTasks * 100).toFixed(1)}%</strong> cap
                </small>
              </div>

              <div className="operator-capacity-metric-item">
                <strong>Current Enabled Load (Actual)</strong>
                {preview.actual ? (
                  <>
                    <span>
                      {preview.actual.monitors} monitors · {preview.actual.regionalTasks} regional
                      checks
                    </span>
                    {preview.actualUtilization && (
                      <>
                        <small>
                          Claims: {(preview.actualUtilization.monitorClaims * 100).toFixed(1)}% cap
                        </small>
                        <small>
                          Tasks: {(preview.actualUtilization.regionalTasks * 100).toFixed(1)}% cap
                        </small>
                      </>
                    )}
                  </>
                ) : (
                  <span>No enabled monitors loaded</span>
                )}
              </div>

              <div className="operator-capacity-metric-item">
                <strong>Effective Caps ({preview.intervalSeconds / 60}m period)</strong>
                <small>
                  Monitors: {preview.effectiveCaps.monitorsPerPeriod} / period (
                  {preview.effectiveCaps.monitorClaimsPerMinute}/min)
                </small>
                <small>
                  Regional tasks: {preview.effectiveCaps.regionalTasksPerPeriod} / period (
                  {preview.effectiveCaps.regionalTasksPerMinute}/min)
                </small>
                <small>
                  Fleet dispatch: {preview.fleet.configuredWorkspaces} /{' '}
                  {preview.fleet.dispatchesPerMinute} workspaces/min
                </small>
              </div>
            </div>

            {preview.warnings.length > 0 && (
              <ul className="operator-capacity-warnings" role="alert">
                {preview.warnings.map((warning, idx) => (
                  <li key={idx}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {saveError && (
          <p id={errorId} className="field-error" role="alert">
            {saveError}
          </p>
        )}
        {pending && <p role="status">Saving workspace limits…</p>}
        {saved && <p role="status">Workspace limits saved.</p>}

        <button className="button button--quiet" disabled={isSaveDisabled}>
          {pending ? 'Saving…' : 'Save limits'}
        </button>
      </form>
    </div>
  );
}
