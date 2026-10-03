import { nowIso } from '@uptime/cloudflare';

import type { ReportConfig } from './env.js';
import { publishDueReports } from './publisher.js';
import { meterDatabase, type QueryWorkByStage } from './query-metrics.js';
import { refreshDirtyLatencyHours } from './hourly-latency.js';

export interface ReportJobDependencies {
  readonly log: Pick<Console, 'warn' | 'error'>;
  readonly now?: () => Date;
  readonly jobLeaseToken?: string;
  readonly publicationDisabled?: boolean;
}

export interface ReportJobMetrics {
  readonly updatedAt: string;
  readonly lastTickAt: string;
  readonly durationMs: number;
  readonly scheduled: number;
  readonly published: number;
  readonly removed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly queryWork: QueryWorkByStage;
}

export class ReportJobFailure extends Error {
  constructor(
    readonly originalError: unknown,
    readonly metrics: ReportJobMetrics,
  ) {
    super(String(originalError));
    this.name = 'ReportJobFailure';
  }
}

function metricsAt(
  startedAt: Date,
  completedAt: Date,
  meter: ReturnType<typeof meterDatabase>,
  result: {
    scheduled: number;
    published: number;
    removed: number;
    skipped: number;
    failed: number;
  },
): ReportJobMetrics {
  const queryWork = {
    reports: { statements: 0, rowsRead: 0, rowsWritten: 0, unmeasured: 0 },
    ...meter.work,
  };
  return {
    updatedAt: nowIso(completedAt),
    lastTickAt: nowIso(startedAt),
    durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    ...result,
    queryWork,
  };
}

/** Publish snapshots with a live clock and an independently metered database. */
export async function runReportJob(
  inputConfig: ReportConfig,
  dependencies: ReportJobDependencies,
): Promise<ReportJobMetrics> {
  const startedAt = dependencies.now?.() ?? new Date();
  const meter = meterDatabase(inputConfig.db);
  meter.setStage('reports');
  meter.setStatementLimit(100);
  try {
    if (dependencies.publicationDisabled) {
      return metricsAt(startedAt, dependencies.now?.() ?? new Date(), meter, {
        scheduled: 0,
        published: 0,
        removed: 0,
        skipped: 0,
        failed: 0,
      });
    }
    const result = await publishDueReports(
      {
        ...inputConfig,
        db: meter.db,
        // Two selection/claim statements, two per startup, then at most 15
        // hourly maintenance statements. Keep five additional statements spare.
        monitorRefreshStartLimit: () =>
          Math.max(0, Math.min(20, Math.floor((100 - meter.statementCount() - 22) / 2))),
      },
      startedAt,
      dependencies.log,
      dependencies.jobLeaseToken,
    );
    meter.setStage('hourly-rollups');
    await refreshDirtyLatencyHours(meter.db, {
      now: dependencies.now?.() ?? new Date(),
      limit: 4,
    });
    return metricsAt(startedAt, dependencies.now?.() ?? new Date(), meter, result);
  } catch (error) {
    const metrics = metricsAt(startedAt, dependencies.now?.() ?? new Date(), meter, {
      scheduled: 0,
      published: 0,
      removed: 0,
      skipped: 0,
      failed: 1,
    });
    throw new ReportJobFailure(error, metrics);
  }
}
