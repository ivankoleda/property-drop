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
  console.log('=== Starting scoring ===');

  const properties = await getPropertiesWithMultipleTransactions();
  console.log(`Found ${properties.length} properties to score`);

  let scored = 0;
  for (const prop of properties) {
    const result = await scoreProperty(prop);
    if (result) {
      scored++;
      console.log(`  Scored: ${prop.address} - drop ${result.dropPct}% (-£${(result.dropAmount / 100).toLocaleString()})`);
    }
  }

  console.log(`=== Scoring complete: ${scored} properties queued ===`);
}

async function getPropertiesWithMultipleTransactions(): Promise<Property[]> {
  // Import query function - we need a raw query here
  const { config: cfg } = await import('./config.js');

  const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${cfg.cf.accountId}/d1/database/${cfg.cf.d1DatabaseId}`;

  const res = await fetch(`${D1_BASE}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.cf.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sql: `SELECT p.* FROM properties p
            WHERE (SELECT COUNT(*) FROM transactions t WHERE t.property_id = p.id) >= 2`,
      params: [],
    }),
  });

  const data = await res.json() as { result: { results: Property[] }[]; success: boolean };
  if (!data.success) throw new Error('Failed to query properties');
  return data.result[0].results;
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
      const tweetId = await poster.post(item, screenshot);
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
