-- Tenant migration 0006: Badge color constraint
-- Ensures badge color constraint matches canonical hex format

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '{{schema}}.badges'::regclass
      AND conname = 'badges_color_hex'
  ) THEN
    ALTER TABLE {{schema}}.badges ADD CONSTRAINT badges_color_hex
      CHECK (length(color) = 7 AND substr(color, 1, 1) = '#' AND color ~ '^#[0-9a-fA-F]{6}$');
  END IF;
END $$;
