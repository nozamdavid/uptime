import type { MonitorSummary, PublicMonitorSummary } from './index.js';

export function toPublicMonitorSummary(summary: MonitorSummary): PublicMonitorSummary {
  const {
    dnsDiagnosticsEnabled: _dns,
    notificationServiceIds: _services,
    outageThreshold: _outage,
    recoveryThreshold: _recovery,
    repeatNotificationMinutes: _repeat,
    ...monitor
  } = summary.monitor;
  const latestByRegion = Object.fromEntries(
    Object.entries(summary.latestByRegion).map(([regionId, observation]) => [
      regionId,
      observation
        ? {
            regionId: observation.regionId,
            status: observation.status,
            success: observation.success,
            httpStatus: observation.httpStatus,
            responseMs: observation.responseMs,
            totalMs: observation.totalMs,
            errorCode: observation.errorCode,
            startedAt: observation.startedAt,
            completedAt: observation.completedAt,
          }
        : null,
    ]),
  ) as PublicMonitorSummary['latestByRegion'];
  return {
    monitor,
    status: summary.status,
    latestByRegion,
    targetChecksPerDay: summary.targetChecksPerDay,
  };
}
