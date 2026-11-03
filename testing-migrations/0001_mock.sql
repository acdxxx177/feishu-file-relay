CREATE TABLE mock_files (
  message_id TEXT PRIMARY KEY,
  file_key TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL CHECK(file_size > 0 AND file_size <= 1073741824),
  file_name TEXT NOT NULL DEFAULT 'mock.bin',
  mode TEXT NOT NULL DEFAULT 'ok' CHECK(mode IN ('ok','missing','throttle','forbidden','bad-range','truncate','slow-headers')),
  header_delay_ms INTEGER NOT NULL DEFAULT 0 CHECK(header_delay_ms >= 0 AND header_delay_ms <= 10000)
);
CREATE TABLE mock_replies (
  uuid TEXT PRIMARY KEY,
  receive_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE mock_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  range_header TEXT,
  status INTEGER NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'started',
  colo TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_mock_requests_message ON mock_requests(message_id,id);
