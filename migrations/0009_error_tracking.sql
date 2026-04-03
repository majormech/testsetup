CREATE TABLE IF NOT EXISTS error_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK(source IN ('server', 'client')),
  category TEXT NOT NULL DEFAULT 'general',
  message TEXT NOT NULL,
  stack TEXT,
  path TEXT,
  method TEXT,
  page TEXT,
  status_code INTEGER,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_error_events_created_at ON error_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_events_source_created_at ON error_events(source, created_at DESC);
