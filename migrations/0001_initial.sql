CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT UNIQUE,
  qr_code TEXT UNIQUE,
  description TEXT,
  total_quantity INTEGER NOT NULL DEFAULT 0 CHECK(total_quantity >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS station_inventory (
  station_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  PRIMARY KEY (station_id, item_id),
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stock_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  station_id INTEGER,
  quantity_delta INTEGER NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('restock', 'issue', 'adjustment')),
  source TEXT NOT NULL CHECK(source IN ('manual', 'scan')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_items_qr_code ON items(qr_code);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON stock_transactions(created_at DESC);

INSERT OR IGNORE INTO stations (name, code) VALUES
  ('Station 1', 'ST01'),
  ('Station 2', 'ST02'),
  ('Station 3', 'ST03'),
  ('Station 4', 'ST04'),
  ('Station 5', 'ST05'),
  ('Station 6', 'ST06'),
  ('Station 7', 'ST07');
