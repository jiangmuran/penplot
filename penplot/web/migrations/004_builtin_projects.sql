-- 004: built-in (seeded, read-only) templates + project metadata
ALTER TABLE projects ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
