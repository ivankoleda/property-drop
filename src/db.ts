import { config } from './config.js';
import type { Area, Property, Transaction, QueueItem, QueueItemWithProperty } from './types.js';

const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${config.cf.accountId}/d1/database/${config.cf.d1DatabaseId}`;

interface D1Result {
  results: Record<string, unknown>[];
  success: boolean;
  meta: { changes: number; last_row_id: number; rows_read: number; rows_written: number };
}

interface D1Response {
  result: D1Result[];
  success: boolean;
  errors: { code: number; message: string }[];
}

async function query(sql: string, params: unknown[] = []): Promise<D1Result> {
  const res = await fetch(`${D1_BASE}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.cf.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`D1 query failed (${res.status}): ${text}`);
  }

  const data = await res.json() as D1Response;
  if (!data.success) {
    throw new Error(`D1 error: ${JSON.stringify(data.errors)}`);
  }

  return data.result[0];
}

// --- Areas ---

export async function getEnabledAreas(): Promise<Area[]> {
  const result = await query('SELECT * FROM areas WHERE enabled = 1');
  return result.results as unknown as Area[];
}

export async function updateAreaLastScraped(areaId: number): Promise<void> {
  await query("UPDATE areas SET last_scraped = datetime('now') WHERE id = ?", [areaId]);
}

// --- Properties ---

export async function upsertProperty(
  uuid: string,
  areaId: number,
  address: string,
  propertyType: string | null,
  tenure: string | null,
  bedrooms: number | null,
  detailUrl: string,
  hasImages: boolean = false
): Promise<number> {
  // Try insert, on conflict update
  await query(
    `INSERT INTO properties (uuid, area_id, address, property_type, tenure, bedrooms, detail_url, has_images)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       address = excluded.address,
       property_type = COALESCE(excluded.property_type, properties.property_type),
       tenure = COALESCE(excluded.tenure, properties.tenure),
       bedrooms = COALESCE(excluded.bedrooms, properties.bedrooms),
       has_images = MAX(properties.has_images, excluded.has_images)`,
    [uuid, areaId, address, propertyType, tenure, bedrooms, detailUrl, hasImages ? 1 : 0]
  );

  const result = await query('SELECT id FROM properties WHERE uuid = ?', [uuid]);
  return (result.results[0] as unknown as { id: number }).id;
}

export async function getPropertiesNeedingScreenshot(limit: number): Promise<Property[]> {
  // Properties that have transactions showing a drop and haven't been visited
  const result = await query(
    `SELECT DISTINCT p.* FROM properties p
     JOIN transactions t1 ON t1.property_id = p.id
     JOIN transactions t2 ON t2.property_id = p.id AND t2.id != t1.id
     WHERE p.visited = 0
       AND t1.date_sold > t2.date_sold
       AND t1.price < t2.price
     LIMIT ?`,
    [limit]
  );
  return result.results as unknown as Property[];
}

export async function markPropertyVisited(propertyId: number, screenshotKey: string): Promise<void> {
  await query(
    'UPDATE properties SET visited = 1, screenshot_key = ? WHERE id = ?',
    [screenshotKey, propertyId]
  );
}

// --- Transactions ---

export async function upsertTransaction(
  propertyId: number,
  price: number,
  dateSold: string,
  displayPrice: string,
  source: string = 'list'
): Promise<void> {
  await query(
    `INSERT INTO transactions (property_id, price, date_sold, display_price, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(property_id, date_sold, price) DO NOTHING`,
    [propertyId, price, dateSold, displayPrice, source]
  );
}

export async function getTransactionsForProperty(propertyId: number): Promise<Transaction[]> {
  const result = await query(
    'SELECT * FROM transactions WHERE property_id = ? ORDER BY date_sold DESC',
    [propertyId]
  );
  return result.results as unknown as Transaction[];
}

// --- Post Queue ---

export async function upsertQueueItem(
  propertyId: number,
  score: number,
  dropAmount: number,
  dropPct: number,
  prevPrice: number,
  currPrice: number,
  prevDate: string | null,
  currDate: string | null,
  adjDropAmount: number = 0,
  adjDropPct: number = 0,
  queueType: string = 'sold'
): Promise<void> {
  await query(
    `INSERT INTO post_queue (property_id, queue_type, score, drop_amount, drop_pct, prev_price, curr_price, prev_date, curr_date, adj_drop_amount, adj_drop_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(property_id, queue_type) DO UPDATE SET
       score = excluded.score,
       drop_amount = excluded.drop_amount,
       drop_pct = excluded.drop_pct,
       prev_price = excluded.prev_price,
       curr_price = excluded.curr_price,
       prev_date = excluded.prev_date,
       curr_date = excluded.curr_date,
       adj_drop_amount = excluded.adj_drop_amount,
       adj_drop_pct = excluded.adj_drop_pct,
       status = CASE WHEN post_queue.status = 'posted' THEN 'posted' ELSE 'pending' END`,
    [propertyId, queueType, score, dropAmount, dropPct, prevPrice, currPrice, prevDate, currDate, adjDropAmount, adjDropPct]
  );
}

export async function getPendingPosts(limit: number, filters?: Record<string, string>): Promise<QueueItemWithProperty[]> {
  const allowedFilters: Record<string, string> = {
    tenure: 'p.tenure',
    type: 'p.property_type',
    queuetype: 'q.queue_type',
    county: 'a.county',
  };

  let whereClauses = `q.status = 'pending'`;
  const params: unknown[] = [];

  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      const col = allowedFilters[key];
      if (!col) continue;
      whereClauses += ` AND ${col} = ?`;
      params.push(value);
    }
  }

  params.push(limit);
  const result = await query(
    `SELECT q.*, p.address, p.property_type, p.tenure, p.detail_url, p.screenshot_key, p.postcode, p.listing_price, p.listing_url, a.county
     FROM post_queue q
     JOIN properties p ON p.id = q.property_id
     JOIN areas a ON a.id = p.area_id
     WHERE ${whereClauses}
     ORDER BY q.score DESC
     LIMIT ?`,
    params
  );
  return result.results as unknown as QueueItemWithProperty[];
}

export async function markPosted(queueId: number, tweetId: string): Promise<void> {
  await query(
    "UPDATE post_queue SET status = 'posted', tweet_id = ?, posted_at = datetime('now') WHERE id = ?",
    [tweetId, queueId]
  );
}

export async function getPendingByUuid(uuid: string): Promise<QueueItemWithProperty | null> {
  const result = await query(
    `SELECT q.*, p.address, p.property_type, p.tenure, p.detail_url, p.screenshot_key, p.postcode, p.listing_price, p.listing_url
     FROM post_queue q
     JOIN properties p ON p.id = q.property_id
     WHERE p.uuid = ? AND q.status = 'pending'`,
    [uuid]
  );
  if (result.results.length === 0) return null;
  return result.results[0] as unknown as QueueItemWithProperty;
}

export async function getPropertyByUuid(uuid: string): Promise<{ id: number; address: string; property_type: string | null; tenure: string | null; detail_url: string; screenshot_key: string | null; postcode: string | null; listing_price: number | null; listing_url: string | null } | null> {
  const result = await query(
    `SELECT id, address, property_type, tenure, detail_url, screenshot_key, postcode, listing_price, listing_url FROM properties WHERE uuid = ?`,
    [uuid]
  );
  if (result.results.length === 0) return null;
  return result.results[0] as any;
}

export async function skipByUuid(uuid: string): Promise<{ address: string } | null> {
  const result = await query(
    `SELECT q.id, p.address FROM post_queue q
     JOIN properties p ON p.id = q.property_id
     WHERE p.uuid = ? AND q.status = 'pending'`,
    [uuid]
  );
  if (result.results.length === 0) return null;
  const row = result.results[0] as unknown as { id: number; address: string };
  await markPosted(row.id, 'skipped');
  return { address: row.address };
}

export async function getPostsToday(): Promise<number> {
  const result = await query(
    "SELECT COUNT(*) as count FROM post_queue WHERE status = 'posted' AND date(posted_at) = date('now')"
  );
  return (result.results[0] as unknown as { count: number }).count;
}

// --- Status ---

export async function getStatus(): Promise<{
  areas: number;
  properties: number;
  transactions: number;
  pending: number;
  posted: number;
  postedToday: number;
}> {
  const [areas, properties, transactions, pending, posted, postedToday] = await Promise.all([
    query('SELECT COUNT(*) as count FROM areas WHERE enabled = 1'),
    query('SELECT COUNT(*) as count FROM properties'),
    query('SELECT COUNT(*) as count FROM transactions'),
    query("SELECT COUNT(*) as count FROM post_queue WHERE status = 'pending'"),
    query("SELECT COUNT(*) as count FROM post_queue WHERE status = 'posted'"),
    query("SELECT COUNT(*) as count FROM post_queue WHERE status = 'posted' AND date(posted_at) = date('now')"),
  ]);

  return {
    areas: (areas.results[0] as unknown as { count: number }).count,
    properties: (properties.results[0] as unknown as { count: number }).count,
    transactions: (transactions.results[0] as unknown as { count: number }).count,
    pending: (pending.results[0] as unknown as { count: number }).count,
    posted: (posted.results[0] as unknown as { count: number }).count,
    postedToday: (postedToday.results[0] as unknown as { count: number }).count,
  };
}

// --- Schema Migration ---

export async function runMigration(sql: string): Promise<void> {
  // Split on semicolons and run each statement
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    await query(stmt);
  }
}
