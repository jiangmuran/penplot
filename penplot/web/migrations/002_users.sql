-- 002: multi-user (roles admin/operator/viewer); per-user sessions and tokens
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  role TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  pw_changed_at REAL NOT NULL,
  last_login REAL
);
INSERT INTO users(id,username,display_name,role,pw_hash,created_at,pw_changed_at)
  SELECT 'u1','admin','管理员','admin',pw_hash,created_at,pw_changed_at FROM admin;
ALTER TABLE sessions ADD COLUMN user_id TEXT;
UPDATE sessions SET user_id='u1';
ALTER TABLE api_tokens ADD COLUMN user_id TEXT;
UPDATE api_tokens SET user_id='u1';
