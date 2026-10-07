-- Billing locks are separate from execution leases checked by tier assignment.
CREATE TABLE workspace_billing (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('mock','stripe')),
  customer_id TEXT UNIQUE,
  subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'none',
  tier_id TEXT,
  revision INTEGER,
  period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(cancel_at_period_end IN (0,1)),
  grace_until INTEGER,
  baseline_tier_id TEXT NOT NULL,
  baseline_revision INTEGER NOT NULL,
  applied_generation INTEGER NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0 CHECK(pending IN (0,1)),
  activation_error TEXT,
  due_at INTEGER,
  checkout_operation TEXT,
  checkout_tier_id TEXT,
  checkout_revision INTEGER,
  checkout_id TEXT UNIQUE,
  checkout_url TEXT,
  checkout_nonce TEXT,
  checkout_expires INTEGER,
  action_operation TEXT,
  action_kind TEXT,
  lease_token TEXT,
  lease_until INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX billing_due ON workspace_billing(due_at);
CREATE TABLE billing_webhook_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace_billing(workspace_id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','completed')),
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX billing_events_pending ON billing_webhook_events(state,lease_until);
