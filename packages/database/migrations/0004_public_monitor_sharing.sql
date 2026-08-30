ALTER TABLE monitors
  ADD COLUMN is_public boolean NOT NULL DEFAULT false;

CREATE INDEX monitors_public_idx ON monitors (id) WHERE is_public = true;
