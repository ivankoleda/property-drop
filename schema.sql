CREATE TABLE IF NOT EXISTS areas (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  rightmove_id  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_scraped  TEXT,
  max_pages     INTEGER NOT NULL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS properties (
  id              INTEGER PRIMARY KEY,
  uuid            TEXT NOT NULL UNIQUE,
  area_id         INTEGER NOT NULL REFERENCES areas(id),
  address         TEXT NOT NULL,
  property_type   TEXT,
  tenure          TEXT,
  bedrooms        INTEGER,
  detail_url      TEXT NOT NULL,
  visited         INTEGER NOT NULL DEFAULT 0,
  screenshot_key  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY,
  property_id   INTEGER NOT NULL REFERENCES properties(id),
  price         INTEGER NOT NULL,
  date_sold     TEXT NOT NULL,
  display_price TEXT,
  source        TEXT NOT NULL DEFAULT 'list',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property_id, date_sold, price)
);

CREATE TABLE IF NOT EXISTS post_queue (
  id            INTEGER PRIMARY KEY,
  property_id   INTEGER NOT NULL UNIQUE REFERENCES properties(id),
  score         REAL NOT NULL,
  drop_amount   INTEGER NOT NULL,
  drop_pct      REAL NOT NULL,
  prev_price    INTEGER NOT NULL,
  curr_price    INTEGER NOT NULL,
  prev_date     TEXT,
  curr_date     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  tweet_id      TEXT,
  posted_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_properties_uuid ON properties(uuid);
CREATE INDEX IF NOT EXISTS idx_transactions_property ON transactions(property_id);
CREATE INDEX IF NOT EXISTS idx_post_queue_status_score ON post_queue(status, score DESC);

-- Seed initial areas
INSERT OR IGNORE INTO areas (name, slug, rightmove_id, max_pages) VALUES
  ('Royal Wharf', 'royal-wharf-94313', '94313', 5),
  ('London City Island', 'london-city-island-94316', '94316', 3),
  ('Kidbrooke Village', 'kidbrooke-village-93498', '93498', 3),
  ('Canary Wharf', 'canary-wharf-87490', '87490', 10),
  ('Vauxhall', 'vauxhall-87613', '87613', 5),
  ('Greenwich Peninsula', 'greenwich-peninsula-93892', '93892', 5),
  ('Battersea Power Station', 'battersea-power-station-94104', '94104', 3),
  ('Nine Elms', 'nine-elms-93925', '93925', 5),
  ('Woolwich', 'woolwich-87629', '87629', 5),
  ('Barking Riverside', 'barking-riverside-94297', '94297', 3);
