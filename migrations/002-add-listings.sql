-- Migration: Add listings support
-- 1. Recreate post_queue with queue_type column and updated unique constraint
-- 2. Add listing_price, listing_url, last_price to properties

-- Step 1: Recreate post_queue with queue_type
CREATE TABLE IF NOT EXISTS post_queue_v2 (
  id              INTEGER PRIMARY KEY,
  property_id     INTEGER NOT NULL REFERENCES properties(id),
  queue_type      TEXT NOT NULL DEFAULT 'sold',
  score           REAL NOT NULL,
  drop_amount     INTEGER NOT NULL,
  drop_pct        REAL NOT NULL,
  adj_drop_amount INTEGER NOT NULL DEFAULT 0,
  adj_drop_pct    REAL NOT NULL DEFAULT 0,
  prev_price      INTEGER NOT NULL,
  curr_price      INTEGER NOT NULL,
  prev_date       TEXT,
  curr_date       TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  tweet_id        TEXT,
  posted_at       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(property_id, queue_type)
);

INSERT INTO post_queue_v2 (id, property_id, queue_type, score, drop_amount, drop_pct, adj_drop_amount, adj_drop_pct, prev_price, curr_price, prev_date, curr_date, status, tweet_id, posted_at, created_at)
  SELECT id, property_id, 'sold', score, drop_amount, drop_pct, adj_drop_amount, adj_drop_pct, prev_price, curr_price, prev_date, curr_date, status, tweet_id, posted_at, created_at FROM post_queue;

DROP TABLE post_queue;

ALTER TABLE post_queue_v2 RENAME TO post_queue;

CREATE INDEX IF NOT EXISTS idx_post_queue_type_status_score ON post_queue(queue_type, status, score DESC);

-- Step 2: Add new columns to properties
ALTER TABLE properties ADD COLUMN listing_price INTEGER;

ALTER TABLE properties ADD COLUMN listing_url TEXT;

ALTER TABLE properties ADD COLUMN last_price INTEGER;
