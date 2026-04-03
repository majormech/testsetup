ALTER TABLE station_requests ADD COLUMN canceled_by TEXT;
ALTER TABLE station_requests ADD COLUMN cancel_reason TEXT;
ALTER TABLE station_requests ADD COLUMN canceled_at TEXT;
ALTER TABLE station_requests ADD COLUMN modified_by TEXT;
ALTER TABLE station_requests ADD COLUMN modification_reason TEXT;
ALTER TABLE station_requests ADD COLUMN modified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_station_requests_canceled_at ON station_requests(canceled_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_station_requests_modified_at ON station_requests(modified_at, created_at DESC);
