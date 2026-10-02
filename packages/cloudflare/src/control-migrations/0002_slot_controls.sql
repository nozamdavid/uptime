CREATE TABLE IF NOT EXISTS tenant_slot_controls (
  binding_name TEXT PRIMARY KEY NOT NULL REFERENCES tenant_slots(binding_name) ON DELETE CASCADE,
  admission_enabled INTEGER NOT NULL DEFAULT 1 CHECK (admission_enabled IN (0,1))
);
