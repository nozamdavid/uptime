/** Worker-safe inventories. Migration loading stays in owner tooling. */
export const CONTROL_TABLES = [
  'users',
  'workspaces',
  'memberships',
  'tenant_slots',
  'workspace_usage_daily',
  'service_controls',
  'workspace_invitations',
  'request_budgets',
  'workspace_events',
  'dispatch_outbox',
  'atproto_oauth_states',
  'atproto_oauth_sessions',
  'atproto_oauth_locks',
  'atproto_login_sessions',
  'tenant_slot_controls',
  'interest_signups',
  'workspace_product_limits',
  'scheduling_controls',
  'coordinator_runtime_health',
  'product_catalog_revisions',
  'product_catalog_current',
  'workspace_tier_assignments',
  'custom_status_domains',
  'workspace_billing',
  'billing_webhook_events',
  'postgres_tenant_registry',
] as const;

export const TENANT_TABLES = [
  'admins',
  'sessions',
  'badges',
  'monitors',
  'status_pages',
  'status_page_groups',
  'status_page_monitors',
  'monitor_regions',
  'check_runs',
  'observations',
  'network_diagnostics',
  'notification_services',
  'monitor_notification_services',
  'monitor_notification_state',
  'notification_deliveries',
  'monitor_daily_uptime',
  'jobs',
  'report_publications',
  'report_cache_revisions',
  'report_latency_changes',
  'monitor_report_refresh',
  'monitor_latency_hourly',
  'monitor_latency_dirty',
  'monitor_latency_coverage',
  'notification_history',
  'workspace_metadata',
  'verified_targets',
] as const;

export type RuntimePostgresProfile = 'full-hosted' | 'legacy-staging' | 'legacy-production';

export function tablesForRuntimeProfile(profile: RuntimePostgresProfile): readonly string[] {
  if (profile === 'full-hosted')
    return [...TENANT_TABLES, 'tier_schedulable_monitors', 'tier_active_notification_services'];
  return [
    ...TENANT_TABLES.filter(
      (table) => table !== 'workspace_metadata' && table !== 'verified_targets',
    ),
    profile === 'legacy-staging' ? 'staging_workspace_identity' : 'production_workspace_identity',
  ];
}
