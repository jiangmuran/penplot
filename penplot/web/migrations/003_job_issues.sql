-- 003: per-job safety issues (bounds, Z range, machine moves)
ALTER TABLE jobs ADD COLUMN issues TEXT NOT NULL DEFAULT '[]';
