import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { runScrape, runScreenshots, runScore, runFullPipeline, runPost } from './pipeline.js';
import { getStatus, runMigration, getPendingPosts, markPosted, markPropertyVisited, skipByUuid } from './db.js';
import { twitterLogin, postTweet } from './twitter-browser.js';
import { buildTweet } from './poster.js';
import { chromium } from 'playwright';

const command = process.argv[2];

function parseFilters(): Record<string, string> | undefined {
  const filters: Record<string, string> = {};
  for (const arg of process.argv) {
    if (arg.startsWith('--filter')) {
      // Support both --filter tenure=freehold and --filter=tenure=freehold
      const value = arg.includes('=') && arg !== '--filter'
        ? arg.substring('--filter='.length)
        : process.argv[process.argv.indexOf(arg) + 1];
      if (value && value.includes('=')) {
        const [k, v] = value.split('=', 2);
        filters[k] = v;
      }
    }
  }
  return Object.keys(filters).length > 0 ? filters : undefined;
}

async function main() {
  switch (command) {
    case 'migrate': {
      console.log('Running database migration...');
      const sql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf-8');
      await runMigration(sql);
      console.log('Migration complete');
      break;
    }

    case 'scrape':
      await runScrape();
      break;

    case 'screenshot':
      await runScreenshots();
      break;

    case 'score':
      await runScore();
      break;

    case 'run':
      await runFullPipeline();
      break;

    case 'twitter-login':
      await twitterLogin();
      break;

    case 'preview': {
      const previewLimit = parseInt(process.argv[3] || '5', 10);
      const previewFilters = parseFilters();
      const previewItems = await getPendingPosts(previewLimit, previewFilters);
      console.log(`\n${previewItems.length} pending tweets:\n`);
      previewItems.forEach((item, i) => {
        const { main } = buildTweet(item);
        console.log(`--- ${i + 1} ---`);
        console.log(main);
        console.log('');
      });
      break;
    }

    case 'tweet': {
      const force = process.argv.includes('--force');
      const tweetFilters = parseFilters();
      const limit = parseInt(process.argv.find(a => /^\d+$/.test(a) && a !== process.argv[2]) || '1', 10);
      const items = await getPendingPosts(limit, tweetFilters);
      console.log(`Found ${items.length} pending posts${force ? ' (--force)' : ''}${tweetFilters ? ` (filter: ${JSON.stringify(tweetFilters)})` : ''}`);

      for (const item of items) {
        // Derive UUID from detail_url as fallback
        const uuid = item.screenshot_key
          ? item.screenshot_key.replace('screenshots/', '').replace('.png', '')
          : item.detail_url.match(/\/details\/([a-f0-9-]+)/)?.[1] || '';

        if (!uuid) {
          console.log(`  Skipping ${item.address}: can't determine UUID`);
          continue;
        }

        const historyPath = `screenshots/${uuid}_history.png`;
        const photoPath = `screenshots/${uuid}_photo.png`;

        // Auto-screenshot if missing
        if (!existsSync(historyPath) || !existsSync(photoPath)) {
          console.log(`  Auto-screenshotting ${item.address}...`);
          try {
            if (!existsSync('screenshots')) mkdirSync('screenshots', { recursive: true });
            const browser = await chromium.launch({ headless: true });
            const ctx = await browser.newContext({
              viewport: { width: 390, height: 844 },
              deviceScaleFactor: 3,
              userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
              isMobile: true,
            });
            // Dismiss cookies
            const cp = await ctx.newPage();
            await cp.goto('https://www.rightmove.co.uk/house-prices.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
            const cookieBtn = await cp.waitForSelector('button:has-text("Accept all")', { timeout: 5000 }).catch(() => null);
            if (cookieBtn) { await cookieBtn.click(); await cp.waitForTimeout(1000); }
            await cp.close();

            const page = await ctx.newPage();
            await page.goto(item.detail_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2500);

            // History screenshot
            const historyLocator = page.locator('div[class*="transaction"], div[class*="Transaction"]').filter({ has: page.locator('table') });
            if (await historyLocator.count() > 0) {
              await historyLocator.first().screenshot({ path: historyPath });
              console.log(`    Saved: ${historyPath}`);
            }

            // Photo screenshot
            const hasPhotos = await page.locator('div[class*="_carouselWrapper_"] img').count() > 0;
            if (hasPhotos) {
              const carousel = page.locator('div[class*="_carouselWrapper_"]').first();
              await carousel.scrollIntoViewIfNeeded();
              await page.waitForTimeout(500);
              const rects = await page.evaluate(() => {
                const cw = document.querySelector('div[class*="_carouselWrapper_"]');
                const ir = document.querySelector('div[class*="_infoReel_"]');
                return {
                  cw: cw ? (() => { const r = cw.getBoundingClientRect(); return { y: r.y, h: r.height, bottom: r.bottom }; })() : null,
                  ir: ir ? (() => { const r = ir.getBoundingClientRect(); return { y: r.y, h: r.height, bottom: r.bottom }; })() : null,
                };
              });
              if (rects.cw) {
                const y = Math.max(0, rects.cw.y);
                const bottom = rects.ir ? rects.ir.bottom + 10 : rects.cw.bottom;
                await page.screenshot({ path: photoPath, clip: { x: 0, y, width: 390, height: bottom - y } });
                console.log(`    Saved: ${photoPath}`);
              }
            }

            await browser.close();
            // Update DB
            const key = `screenshots/${uuid}`;
            await markPropertyVisited(item.property_id, key);
          } catch (err: any) {
            console.log(`    Screenshot failed: ${err.message?.substring(0, 80)}`);
          }
        }

        // Check what we have now
        const images: string[] = [];
        if (existsSync(historyPath)) images.push(historyPath);
        if (existsSync(photoPath)) images.push(photoPath);

        if (images.length < 2 && !force) {
          console.log(`  Skipping ${item.address}: missing screenshots (history: ${existsSync(historyPath)}, photo: ${existsSync(photoPath)}). Use --force to post anyway`);
          continue;
        }

        if (images.length === 0) {
          console.log(`  Skipping ${item.address}: no screenshot files found`);
          continue;
        }

        const { main: tweetText, reply: replyText } = buildTweet(item);
        console.log(`\nPosting: ${tweetText}`);
        console.log(`  Images: ${images.join(', ')}`);

        try {
          const tweetId = await postTweet(tweetText, images, replyText || undefined);
          console.log(`  Tweet ID: ${tweetId || 'none'}`);
          if (tweetId) {
            console.log(`  Marking as posted in DB...`);
            await markPosted(item.id, tweetId);
            console.log(`  Done! Queue item ${item.id} marked as posted`);
          } else {
            console.log(`  WARNING: No tweet ID captured, not marking as posted`);
          }
        } catch (err: any) {
          console.error(`  Error: ${err.message}`);
        }
      }
      break;
    }

    case 'post': {
      const limit = parseInt(process.argv[3] || '5', 10);
      await runPost(limit);
      break;
    }

    case 'status': {
      const status = await getStatus();
      console.log('\n=== Property Drop Bot Status ===');
      console.log(`  Areas enabled:     ${status.areas}`);
      console.log(`  Properties:        ${status.properties}`);
      console.log(`  Transactions:      ${status.transactions}`);
      console.log(`  Queue (pending):   ${status.pending}`);
      console.log(`  Queue (posted):    ${status.posted}`);
      console.log(`  Posted today:      ${status.postedToday}`);
      console.log('');
      break;
    }

    case 'skip': {
      // Skip by UUID: npm run cli skip --id bc1e23bf-...
      const idIdx = process.argv.indexOf('--id');
      if (idIdx !== -1) {
        const uuid = process.argv[idIdx + 1];
        if (!uuid) { console.log('Usage: npm run cli skip --id <uuid>'); break; }
        // Support full URL or just UUID
        const cleanUuid = uuid.match(/([a-f0-9-]{36})/)?.[1] || uuid;
        const result = await skipByUuid(cleanUuid);
        if (result) {
          console.log(`Skipped: ${result.address}`);
        } else {
          console.log(`No pending item found for UUID: ${cleanUuid}`);
        }
        break;
      }

      // Skip top N: npm run cli skip [n] [--filter tenure=Freehold]
      const skipCount = parseInt(process.argv[3] || '1', 10);
      const skipFilters = parseFilters();
      const skipItems = await getPendingPosts(skipCount, skipFilters);
      console.log(`Skipping ${skipItems.length} items from top of queue:`);
      for (const item of skipItems) {
        await markPosted(item.id, 'skipped');
        console.log(`  Skipped: ${item.address} (drop ${item.drop_pct}%, -£${(item.drop_amount / 100).toLocaleString()})`);
      }
      break;
    }

    default:
      console.log(`Usage: npm run cli <command>

Commands:
  migrate         Run database schema migration
  scrape          Scrape all enabled areas
  screenshot      Take screenshots of properties with drops
  score           Score properties and populate post queue
  run             Full pipeline: scrape → screenshot → score
  twitter-login   Login to Twitter (opens browser, saves session)
  tweet [n]       Post top N pending items via browser (default: 1)
  post [n]        Post via API (needs API keys)
  skip [n]        Skip top N pending items (default: 1)
  preview [n]     Preview top N pending tweets
  status          Show bot status summary`);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
