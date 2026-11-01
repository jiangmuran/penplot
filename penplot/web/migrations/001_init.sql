-- 001: initial schema (03 §3.2)
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pw_hash TEXT NOT NULL,
  created_at REAL NOT NULL,
  pw_changed_at REAL NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  created_at REAL NOT NULL,
  last_seen REAL NOT NULL,
  expires_at REAL NOT NULL,
  ip TEXT, ua TEXT
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at REAL NOT NULL,
  last_used REAL,
  expires_at REAL
);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  doc TEXT NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE papers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  doc TEXT NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_template INTEGER NOT NULL DEFAULT 0,
  doc TEXT NOT NULL,
  thumb_file_id TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at REAL NOT NULL
);
CREATE INDEX files_sha ON files(sha256);
CREATE INDEX files_kind ON files(kind);

CREATE TABLE fonts (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  format TEXT NOT NULL,
  display_name TEXT NOT NULL,
  glyph_count INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime REAL NOT NULL,
  ref_size REAL NOT NULL,
  coverage BLOB,
  source TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  custom_name TEXT,
  meta TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  batch_id TEXT,
  seq INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  profile_id TEXT,
  overrides TEXT NOT NULL DEFAULT '{}',
  profile_snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  total_lines INTEGER NOT NULL DEFAULT 0,
  acked_line INTEGER NOT NULL DEFAULT 0,
  est_s REAL NOT NULL DEFAULT 0,
  elapsed_s REAL NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]',
  origin TEXT,
  bbox TEXT,
  out_of_work_area INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  started_at REAL,
  finished_at REAL
);
CREATE INDEX jobs_status ON jobs(status);
CREATE INDEX jobs_batch ON jobs(batch_id);

CREATE TABLE job_events (
  job_id TEXT NOT NULL,
  ts REAL NOT NULL,
  from_state TEXT,
  to_state TEXT,
  detail TEXT
);
CREATE INDEX job_events_job ON job_events(job_id);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE audit (
  ts REAL NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
