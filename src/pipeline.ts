import { scrapeAllAreas } from './scraper.js';
import { screenshotProperties } from './detail.js';
import { scoreProperty } from './scorer.js';
import { getPropertiesNeedingScreenshot, getPendingPosts, markPosted, getPostsToday } from './db.js';
import { getScreenshot } from './r2.js';
import { TwitterPoster } from './poster.js';
import { config } from './config.js';
import type { Property } from './types.js';

export async function runScrape(): Promise<void> {
  console.log('=== Starting scrape pipeline ===');
  await scrapeAllAreas();
  console.log('=== Scrape complete ===');
}

export async function runScreenshots(): Promise<void> {
  console.log('=== Starting screenshots ===');
  const count = await screenshotProperties();
  console.log(`=== Screenshots complete: ${count} taken ===`);
}

export async function runScore(): Promise<void> {
  console.log('=== Starting scoring (batched) ===');
  const { config: cfg } = await import('./config.js');
  const { calculateDrop } = await import('./scorer.js');

  const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${cfg.cf.accountId}/d1/database/${cfg.cf.d1DatabaseId}`;
  const headers = { 'Authorization': `Bearer ${cfg.cf.apiToken}`, 'Content-Type': 'application/json' };

  // Step 1: Fetch all properties with 2+ transactions in ONE query
  console.log('  Fetching properties...');
  const propRes = await fetch(`${D1_BASE}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({
      sql: `SELECT p.id, p.address, p.has_images, p.tenure FROM properties p
            WHERE (SELECT COUNT(*) FROM transactions t WHERE t.property_id = p.id) >= 2`,
    }),
  });
  const propData = await propRes.json() as any;
  if (!propData.success) throw new Error('Failed to query properties');
  const properties = propData.result[0].results as { id: number; address: string; has_images: number; tenure: string | null }[];
  console.log(`  Found ${properties.length} properties with 2+ transactions`);

  // Step 2: Fetch ALL transactions in ONE query
  console.log('  Fetching all transactions...');
  const txRes = await fetch(`${D1_BASE}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({
      sql: `SELECT t.property_id, t.price, t.date_sold, t.display_price, t.source
            FROM transactions t
            JOIN properties p ON p.id = t.property_id
            WHERE (SELECT COUNT(*) FROM transactions t2 WHERE t2.property_id = p.id) >= 2
            ORDER BY t.property_id, t.date_sold DESC`,
    }),
  });
  const txData = await txRes.json() as any;
  if (!txData.success) throw new Error('Failed to query transactions');
  const allTx = txData.result[0].results as { property_id: number; price: number; date_sold: string; display_price: string; source: string }[];
  console.log(`  Fetched ${allTx.length} transactions`);

  // Step 3: Group transactions by property_id
  const txByProp = new Map<number, typeof allTx>();
  for (const tx of allTx) {
    if (!txByProp.has(tx.property_id)) txByProp.set(tx.property_id, []);
    txByProp.get(tx.property_id)!.push(tx);
  }

  // Step 4: Score all in memory
  console.log('  Scoring...');
  const toUpsert: { propertyId: number; address: string; drop: NonNullable<ReturnType<typeof calculateDrop>> }[] = [];

  for (const prop of properties) {
    const txs = txByProp.get(prop.id);
    if (!txs || txs.length < 2) continue;
    const drop = calculateDrop(txs as any, prop.tenure);
    if (drop) {
      toUpsert.push({ propertyId: prop.id, address: prop.address, drop });
    }
  }
  console.log(`  ${toUpsert.length} properties qualify`);

  // Step 5: Upsert into post_queue in parallel chunks
  console.log('  Upserting to post_queue...');
  const CONCURRENCY = 20;
  for (let i = 0; i < toUpsert.length; i += CONCURRENCY) {
    const chunk = toUpsert.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(({ propertyId, drop }) =>
      fetch(`${D1_BASE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          sql: `INSERT INTO post_queue (property_id, queue_type, score, drop_amount, drop_pct, prev_price, curr_price, prev_date, curr_date, adj_drop_amount, adj_drop_pct)
                VALUES (?, 'sold', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(property_id, queue_type) DO UPDATE SET
                  score = excluded.score, drop_amount = excluded.drop_amount, drop_pct = excluded.drop_pct,
                  prev_price = excluded.prev_price, curr_price = excluded.curr_price,
                  prev_date = excluded.prev_date, curr_date = excluded.curr_date,
                  adj_drop_amount = excluded.adj_drop_amount, adj_drop_pct = excluded.adj_drop_pct,
                  status = CASE WHEN post_queue.status = 'posted' THEN 'posted' ELSE 'pending' END`,
          params: [propertyId, drop.score, drop.dropAmount, drop.dropPct, drop.prevPrice, drop.currPrice, drop.prevDate, drop.currDate, drop.adjDropAmount, drop.adjDropPct],
        }),
      })
    ));
  }

  console.log(`=== Scoring complete: ${toUpsert.length} properties queued ===`);
}

export async function runFullPipeline(): Promise<void> {
  await runScrape();
  await runScreenshots();
  await runScore();
}

export async function runPost(limit: number = 5): Promise<number> {
  console.log('=== Starting post job ===');

  const postedToday = await getPostsToday();
  const remaining = config.bot.dailyPostCap - postedToday;

  if (remaining <= 0) {
    console.log(`Daily cap reached (${postedToday}/${config.bot.dailyPostCap})`);
    return 0;
  }

  const actualLimit = Math.min(limit, remaining);
  const items = await getPendingPosts(actualLimit);
  console.log(`Found ${items.length} pending posts (cap remaining: ${remaining})`);

  if (items.length === 0) return 0;

  const poster = new TwitterPoster();
  let posted = 0;

  for (const item of items) {
    try {
      if (!item.screenshot_key) {
        console.log(`  Skipping ${item.address}: no screenshot`);
        continue;
      }

      const screenshot = await getScreenshot(item.screenshot_key);
      const tweetId = await poster.post(item, [screenshot]);
      await markPosted(item.id, tweetId);

      console.log(`  Posted: ${item.address} (tweet: ${tweetId})`);
      posted++;
    } catch (err) {
      console.error(`  Error posting ${item.address}:`, err);
    }
  }

  console.log(`=== Post job complete: ${posted}/${items.length} posted ===`);
  return posted;
}
