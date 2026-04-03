ALTER TABLE items ADD COLUMN unit_cost REAL NOT NULL DEFAULT 0;
ALTER TABLE stock_transactions ADD COLUMN performed_by TEXT NOT NULL DEFAULT 'Unknown';

CREATE TABLE IF NOT EXISTS admin_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  supply_officer_email TEXT,
  admin_emails TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO admin_settings (id, supply_officer_email, admin_emails)
VALUES (1, '', '');

CREATE TABLE IF NOT EXISTS station_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL,
  requester_name TEXT NOT NULL,
  requested_items_json TEXT NOT NULL,
  other_items TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_station_requests_created_at ON station_requests(created_at DESC);
