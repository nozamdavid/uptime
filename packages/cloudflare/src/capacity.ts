import type { ProductLimits } from './product-limits.js';

export const schedulerCapacity = {
  monitorClaimsPerMinute: 50,
  regionalTasksPerMinute: 108,
  dispatchesPerMinute: 20,
  intervalSeconds: 300,
  headroomPercent: 20,
} as const;

export function configuredMonitorBatch(env: Record<string, unknown>): number {
  const value = env.COORDINATOR_MONITOR_BATCH ?? env.MONITOR_BATCH ?? 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500)
    throw new Error('Coordinator monitor batch must be an integer between 1 and 500');
  return Math.min(parsed, schedulerCapacity.monitorClaimsPerMinute);
}

export function evaluateCapacity(
  limits: Pick<ProductLimits, 'monitors' | 'regions'>,
  monitorBatch = 50,
  actual: { monitors: number; regionalTasks: number } | null = null,
  configuredWorkspaces = 10,
) {
  const batch = Math.min(monitorBatch, schedulerCapacity.monitorClaimsPerMinute);
  const monitorsPerPeriod = batch * 4;
  const regionalTasksPerPeriod = schedulerCapacity.regionalTasksPerMinute * 4;
  const grant = { monitors: limits.monitors, regionalTasks: limits.monitors * limits.regions };
  const ratios = (load: typeof grant) => ({
    monitorClaims: load.monitors / monitorsPerPeriod,
    regionalTasks: load.regionalTasks / regionalTasksPerPeriod,
  });
  const tenantSafe =
    grant.monitors <= monitorsPerPeriod && grant.regionalTasks <= regionalTasksPerPeriod;
  const fleetSafe = configuredWorkspaces <= schedulerCapacity.dispatchesPerMinute;
  const warnings: string[] = [];
  if (!tenantSafe) warnings.push('Grant exceeds the coordinator capacity with 20% headroom');
  if (!fleetSafe)
    warnings.push('Configured fleet exceeds the 20 workspace dispatches per minute ceiling');
  if (
    actual &&
    (actual.monitors > monitorsPerPeriod || actual.regionalTasks > regionalTasksPerPeriod)
  )
    warnings.push('Current enabled monitor load exceeds effective coordinator capacity');
  return {
    safe: tenantSafe && fleetSafe,
    intervalSeconds: schedulerCapacity.intervalSeconds,
    headroomPercent: schedulerCapacity.headroomPercent,
    grant,
    actual,
    effectiveCaps: {
      monitorClaimsPerMinute: batch * 0.8,
      regionalTasksPerMinute: 86.4,
      monitorsPerPeriod,
      regionalTasksPerPeriod,
    },
    utilization: ratios(grant),
    actualUtilization: actual ? ratios(actual) : null,
    fleet: {
      dispatchesPerMinute: schedulerCapacity.dispatchesPerMinute,
      configuredWorkspaces,
      safe: fleetSafe,
    },
    warnings,
  };
}
