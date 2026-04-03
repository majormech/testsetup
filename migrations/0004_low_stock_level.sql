ALTER TABLE items ADD COLUMN low_stock_level INTEGER NOT NULL DEFAULT 0 CHECK(low_stock_level >= 0);
