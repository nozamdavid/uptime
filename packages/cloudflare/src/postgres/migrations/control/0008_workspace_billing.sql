-- Control-plane migration 0008: Workspace billing
-- Tables: workspace_billing, billing_webhook_events

CREATE TABLE IF NOT EXISTS {{schema}}.workspace_billing (
  workspace_id TEXT PRIMARY KEY REFERENCES {{schema}}.workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('mock', 'stripe')),
  customer_id TEXT UNIQUE,
  subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'none',
  tier_id TEXT,
  revision INTEGER,
  period_end BIGINT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  grace_until BIGINT,
  baseline_tier_id TEXT NOT NULL,
  baseline_revision INTEGER NOT NULL,
  applied_generation INTEGER NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
  activation_error TEXT,
  due_at BIGINT,
  checkout_operation TEXT,
  checkout_tier_id TEXT,
  checkout_revision INTEGER,
  checkout_id TEXT UNIQUE,
  checkout_url TEXT,
  checkout_nonce TEXT,
  checkout_expires BIGINT,
  action_operation TEXT,
  action_kind TEXT,
  lease_token TEXT,
  lease_until BIGINT,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS billing_due ON {{schema}}.workspace_billing(due_at);

CREATE TABLE IF NOT EXISTS {{schema}}.billing_webhook_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES {{schema}}.workspace_billing(workspace_id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed')),
  lease_until BIGINT,
  created_at BIGINT NOT NULL,
  completed_at BIGINT
);

CREATE INDEX IF NOT EXISTS billing_events_pending ON {{schema}}.billing_webhook_events(state, lease_until);
