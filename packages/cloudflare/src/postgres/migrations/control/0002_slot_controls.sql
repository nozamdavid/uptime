-- Control-plane migration 0002: Slot controls
-- Table: tenant_slot_controls

CREATE TABLE IF NOT EXISTS {{schema}}.tenant_slot_controls (
  binding_name TEXT PRIMARY KEY NOT NULL REFERENCES {{schema}}.tenant_slots(binding_name) ON DELETE CASCADE,
  admission_enabled INTEGER NOT NULL DEFAULT 1 CHECK (admission_enabled IN (0, 1))
);

INSERT INTO {{schema}}.tenant_slot_controls (binding_name, admission_enabled)
SELECT binding_name, 1 FROM {{schema}}.tenant_slots
ON CONFLICT (binding_name) DO NOTHING;
