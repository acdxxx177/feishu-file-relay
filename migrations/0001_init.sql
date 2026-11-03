CREATE TABLE files (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER CHECK (file_size IS NULL OR file_size > 0),
  mime_type TEXT,
  uploader_open_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','failed','unavailable','deleted')),
  fail_reason TEXT,
  delete_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  last_downloaded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE recalled_messages (
  message_id TEXT PRIMARY KEY,
  recalled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE bot_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('command','notification')),
  message_id TEXT,
  file_id TEXT,
  uploader_open_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  argument TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_files_status_created ON files(status, created_at);
CREATE INDEX idx_files_uploader ON files(uploader_open_id, created_at);
CREATE INDEX idx_jobs_due ON bot_jobs(state, next_attempt_at);
