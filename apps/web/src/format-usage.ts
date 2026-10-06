import type { HistoricalD1Usage } from './api.js';

export function formatBudgetForecast(
  budget: { forecastUsd?: number | null; ceilingUsd?: number } | null | undefined,
): string {
  return formatBudgetCost(budget?.forecastUsd);
}

export function formatBudgetCost(value: number | null | undefined): string {
  return value === null || value === undefined
    ? 'Unknown / unavailable'
    : `$${value.toFixed(2)}/mo`;
}

export function formatMetricNumber(
  value: number | null | undefined,
  fallback = 'unavailable',
): string {
  if (value !== null && value !== undefined) {
    return value.toLocaleString();
  }
  return fallback;
}

export function formatStorageMiB(
  bytes: number | null | undefined,
  fallback = 'storage unavailable',
): string {
  if (bytes !== null && bytes !== undefined) {
    return `${(bytes / 1_048_576).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })} MiB`;
  }
  return fallback;
}

export function formatHistoricalD1Usage(
  usage: HistoricalD1Usage | null | undefined,
): string | null {
  if (!usage) return null;
  if (usage.rowsRead === 0 && usage.rowsWritten === 0 && usage.storageBytes === 0) {
    return null;
  }
  const storageMiB = (usage.storageBytes / 1_048_576).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
  return `Historical D1: ${usage.rowsRead.toLocaleString()} rows read · ${usage.rowsWritten.toLocaleString()} rows written · ${storageMiB} MiB`;
}

export function formatWorkspaceDatabaseMetrics(workspace: {
  rowsRead: number | null;
  rowsWritten: number | null;
  storageBytes: number | null;
}): string {
  const readPart =
    workspace.rowsRead !== null && workspace.rowsRead !== undefined
      ? `${workspace.rowsRead.toLocaleString()} rows read`
      : 'rows read unavailable';
  const writtenPart =
    workspace.rowsWritten !== null && workspace.rowsWritten !== undefined
      ? `${workspace.rowsWritten.toLocaleString()} rows written`
      : 'rows written unavailable';
  const storagePart =
    workspace.storageBytes !== null && workspace.storageBytes !== undefined
      ? `${(workspace.storageBytes / 1_048_576).toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })} MiB`
      : 'storage unavailable';
  return `${readPart} · ${writtenPart} · ${storagePart}`;
}
