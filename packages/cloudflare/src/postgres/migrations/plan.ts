import { readFile } from 'node:fs/promises';
import type { PostgresMigration } from '../migrate.js';

export type MigrationProfile =
  | 'control'
  | 'full-hosted'
  | 'hosted'
  | 'legacy-import'
  | 'legacy'
  | 'legacy-staging'
  | 'legacy-production'
  | 'predata'
  | 'postdata';

export { CONTROL_TABLES, TENANT_TABLES } from '../tables.js';

const CONTROL_FILES = [
  'control/0001_control.sql',
  'control/0002_slot_controls.sql',
  'control/0003_interest_signups.sql',
  'control/0004_workspace_product_limits.sql',
  'control/0005_operator_operations.sql',
  'control/0006_product_tiers.sql',
  'control/0007_custom_status_domains.sql',
  'control/0008_workspace_billing.sql',
  'control/0009_postgres_tenant_registry.sql',
];

const HOSTED_TENANT_FILES = [
  'tenant/0001_initial.sql',
  'tenant/0002_retention_indexes.sql',
  'tenant/0003_recovery_indexes.sql',
  'tenant/0004_api_query_indexes.sql',
  'tenant/0005_coordinator_work_indexes.sql',
  'tenant/0006_badge_color_constraint.sql',
  'tenant/0007_report_uptime_cache_revision.sql',
  'tenant/0008_report_latency_changefeed.sql',
  'tenant/0009_monitor_report_refresh.sql',
  'tenant/0010_monitor_latency_hourly.sql',
  'tenant/0011_bluesky_notification_provider.sql',
  'tenant/0012_notification_history.sql',
  'tenant/0013_free_workspace.sql',
  'tenant/0013_retire_report_latency_changefeed.sql',
  'tenant/0014_simplify_observation_indexes.sql',
  'tenant/0015_workspace_product_limits.sql',
  'tenant/0016_product_tiers.sql',
  'tenant/0017_status_page_font_family.sql',
];

const LEGACY_TENANT_FILES = [
  'tenant/0001_initial.sql',
  'tenant/0002_retention_indexes.sql',
  'tenant/0003_recovery_indexes.sql',
  'tenant/0004_api_query_indexes.sql',
  'tenant/0005_coordinator_work_indexes.sql',
  'tenant/0006_badge_color_constraint.sql',
  'tenant/0007_report_uptime_cache_revision.sql',
  'tenant/0008_report_latency_changefeed.sql',
  'tenant/0009_monitor_report_refresh.sql',
  'tenant/0010_monitor_latency_hourly.sql',
  'tenant/0011_bluesky_notification_provider.sql',
  'tenant/0012_notification_history.sql',
  'tenant/0013_retire_report_latency_changefeed.sql',
  'tenant/0014_simplify_observation_indexes.sql',
  'tenant/0017_status_page_font_family.sql',
];

const PREDATA_FILES = ['data-import/0001_predata_disable_triggers.sql'];

const POSTDATA_FILES = ['data-import/0002_postdata_enable_triggers.sql'];

export function getMigrationFilesForProfile(profile: MigrationProfile): readonly string[] {
  switch (profile) {
    case 'control':
      return CONTROL_FILES;
    case 'full-hosted':
    case 'hosted':
      return HOSTED_TENANT_FILES;
    case 'legacy-import':
    case 'legacy':
    case 'legacy-staging':
      return [...LEGACY_TENANT_FILES, 'legacy/0013_staging_identity.sql'];
    case 'legacy-production':
      return [...LEGACY_TENANT_FILES, 'legacy/0013_production_identity.sql'];
    case 'predata':
      return PREDATA_FILES;
    case 'postdata':
      return POSTDATA_FILES;
    default:
      throw new Error(`Unknown migration profile: ${profile}`);
  }
}

export async function loadMigrationsForProfile(
  profile: MigrationProfile,
  baseDirectory: URL = new URL('./', import.meta.url),
): Promise<PostgresMigration[]> {
  const relativeFiles = getMigrationFilesForProfile(profile);
  return Promise.all(
    relativeFiles.map(async (relative) => {
      const fileUrl = new URL(relative, baseDirectory);
      const sql = await readFile(fileUrl, 'utf8');
      const id = relative.split('/').pop()!;
      return { id, sql };
    }),
  );
}
