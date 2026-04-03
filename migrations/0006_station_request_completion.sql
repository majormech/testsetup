ALTER TABLE station_requests ADD COLUMN completed_by TEXT;
ALTER TABLE station_requests ADD COLUMN completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_station_requests_station_completed
ON station_requests(station_id, completed_at, created_at DESC);
