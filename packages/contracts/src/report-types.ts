import type { Badge, PublicMonitorSummary, UptimeThresholds } from './index.js';
import type { RegionId } from '@uptime/regions';

export interface SnapshotFreshness {
  schemaVersion: string;
  generatedAt: string;
  latestObservationAt: string | null;
  staleAfterSeconds: number;
}

export interface LatencyPoint {
  observedAt: string;
  regionId: RegionId;
  responseMs: number | null;
  success: boolean;
}

export interface LatencyStats {
  regionId: RegionId;
  sampleCount: number;
  successCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface AggregateLatencyPoint {
  observedAt: string;
  responseMs: number | null;
  success: boolean;
}

export interface AggregateLatencyStats {
  averageResponseMs: number | null;
  maximumResponseMs: number | null;
  maximumResponseRegionId: RegionId | null;
  minimumResponseMs: number | null;
}

export interface LatencyPayload {
  /** True while a newly published monitor waits for its bounded graph refresh turn. */
  pending?: boolean;
  points: LatencyPoint[];
  stats: LatencyStats[];
  aggregatePoints: AggregateLatencyPoint[];
  aggregateStats: AggregateLatencyStats;
  /** True when this payload covers only a bounded recent sample. */
  sampled?: boolean;
  /** Raw observation row budget applied, when bounded. */
  sampleLimit?: number;
  /** When this range's data was computed (ISO-8601 UTC). */
  computedAt?: string;
}

export type LatencyRangeKey = '1h' | '24h' | '7d' | '30d';

export interface UptimeDay {
  date: string;
  uptimePercentage: number | null;
  averageResponseMs: number | null;
}

export interface MonitorUptimeData {
  uptimePercentage: number | null;
  status: 'up' | 'down' | 'unknown';
  recoveryStatus?: 'up' | 'down' | 'recovering' | null;
  days: UptimeDay[];
}

export interface MonitorReportSnapshot extends SnapshotFreshness {
  summary: PublicMonitorSummary;
  uptime: MonitorUptimeData;
  latency: LatencyPayload;
  latencyByRange?: Partial<Record<LatencyRangeKey, LatencyPayload>>;
}

export interface StatusPageReportSnapshotMonitor {
  id: string;
  name: string | null;
  url: string;
  publicSlug: string | null;
  badge?: Badge | null;
  uptimeThresholds?: UptimeThresholds;
  uptimePercentage: number | null;
  status: 'up' | 'down' | 'unknown';
  configuredRegionCount: number;
  affectedRegionIds: RegionId[];
  recoveryStatus: 'up' | 'down' | 'recovering' | null;
  days: UptimeDay[];
}

export interface StatusPageReportSnapshot extends SnapshotFreshness {
  statusPage: {
    id: string;
    title: string;
    publicSlug: string | null;
    groups: Array<{
      id: string;
      title: string;
      width: 'full' | 'half';
      showBadges: boolean;
      monitors: StatusPageReportSnapshotMonitor[];
    }>;
  };
}

export interface StatusPageIndexSnapshot extends SnapshotFreshness {
  statusPages: Array<{ id: string; title: string; publicSlug: string | null }>;
}
