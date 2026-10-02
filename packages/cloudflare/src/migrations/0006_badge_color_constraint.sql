-- D1 limits LIKE/GLOB patterns to 50 bytes. Replace the original repeated
-- character-class pattern while preserving badges and monitor references.

CREATE TABLE badges_constraint_fixed (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) ||
      '-' || hex(randomblob(6)))
  ),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT badges_name_not_blank CHECK (length(trim(name)) BETWEEN 1 AND 40),
  CONSTRAINT badges_color_hex CHECK (
    length(color) = 7 AND substr(color, 1, 1) = '#'
      AND substr(color, 2) NOT GLOB '*[^0-9a-fA-F]*'
  )
);

INSERT INTO badges_constraint_fixed (id, name, color, created_at)
SELECT id, name, color, created_at FROM badges;

-- Dropping the parent applies monitors.badge_id ON DELETE SET NULL. Preserve
-- those links explicitly so this migration is safe on populated databases.
CREATE TABLE badge_constraint_monitor_refs (
  monitor_id TEXT PRIMARY KEY NOT NULL,
  badge_id TEXT NOT NULL
);
INSERT INTO badge_constraint_monitor_refs (monitor_id, badge_id)
SELECT id, badge_id FROM monitors WHERE badge_id IS NOT NULL;

DROP TABLE badges;
ALTER TABLE badges_constraint_fixed RENAME TO badges;
CREATE UNIQUE INDEX badges_name_unique ON badges (lower(name));

UPDATE monitors
SET badge_id = (
  SELECT refs.badge_id FROM badge_constraint_monitor_refs refs
  WHERE refs.monitor_id = monitors.id
)
WHERE id IN (SELECT monitor_id FROM badge_constraint_monitor_refs);
DROP TABLE badge_constraint_monitor_refs;
