import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { runScrape, runScreenshots, runScore, runFullPipeline, runPost } from './pipeline.js';
import { getStatus, runMigration, getPendingPosts, getPendingByUuid, getPropertyByUuid, getTransactionsForProperty, markPosted, markPropertyVisited, skipByUuid } from './db.js';
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
  // --type sold|listed shorthand
  const typeIdx = process.argv.indexOf('--type');
  if (typeIdx !== -1 && process.argv[typeIdx + 1]) {
    filters['queuetype'] = process.argv[typeIdx + 1];
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

    case 'scrape-listings': {
      const { scrapeListings } = await import('./scrape-listings.js');
      await scrapeListings();
      break;
    }

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
      const previewLimitArg = process.argv.find(a => /^\d+$/.test(a) && process.argv.indexOf(a) > 2);
      const previewLimit = previewLimitArg ? parseInt(previewLimitArg, 10) : 5;
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
      const tweetIdIdx = process.argv.indexOf('--id');
      let items;

      // Detect UUID from --id flag or positional arg (e.g. `tweet 60fc41b5-...` or `tweet --id 60fc41b5-...`)
      const rawIdArg = tweetIdIdx !== -1
        ? process.argv[tweetIdIdx + 1]
        : process.argv[3]?.match(/[a-f0-9-]{36}/) ? process.argv[3] : null;
      const cleanId = rawIdArg?.match(/([a-f0-9-]{36})/)?.[1];

      if (cleanId) {
        let item = await getPendingByUuid(cleanId);
        if (!item) {
          // Not in queue — build from property + transactions directly
          const prop = await getPropertyByUuid(cleanId);
          if (!prop) { console.log(`Property not found: ${cleanId}`); break; }
          const txs = await getTransactionsForProperty(prop.id);
          if (txs.length < 2) { console.log(`Not enough transactions for ${prop.address}`); break; }
          const sorted = [...txs].sort((a, b) => new Date(b.date_sold).getTime() - new Date(a.date_sold).getTime());
          const curr = sorted[0], prev = sorted[1];
          const dropAmount = prev.price - curr.price;
          const dropPct = Math.round((dropAmount / prev.price) * 1000) / 10;
          const { inflationAdjustedPrice } = await import('./scorer.js');
          const adjPrev = inflationAdjustedPrice(prev.price, prev.date_sold, curr.date_sold);
          const adjDropAmount = adjPrev - curr.price;
          const adjDropPct = Math.round((adjDropAmount / adjPrev) * 1000) / 10;
          console.log(`  Not in queue — building tweet directly (drop ${dropPct}%, adj ${adjDropPct}%)`);
          item = {
            id: 0, property_id: prop.id, queue_type: 'sold', score: 0,
            drop_amount: dropAmount, drop_pct: dropPct,
            adj_drop_amount: adjDropAmount, adj_drop_pct: adjDropPct,
            prev_price: prev.price, curr_price: curr.price,
            prev_date: prev.date_sold, curr_date: curr.date_sold,
            status: 'pending', tweet_id: null, posted_at: null, created_at: '',
            address: prop.address, property_type: prop.property_type, tenure: prop.tenure,
            detail_url: prop.detail_url, screenshot_key: prop.screenshot_key,
            postcode: prop.postcode, listing_price: prop.listing_price, listing_url: prop.listing_url,
          };
        }
        items = [item];
      } else {
        const limit = parseInt(process.argv.find(a => /^\d+$/.test(a) && a !== process.argv[2]) || '1', 10);
        items = await getPendingPosts(limit, tweetFilters);
      }

      console.log(`Found ${items.length} pending posts${force ? ' (--force)' : ''}${tweetFilters ? ` (filter: ${JSON.stringify(tweetFilters)})` : ''}`);

      for (const item of items) {
        // Derive UUID from screenshot_key or detail_url
        const uuid = item.screenshot_key
          ? item.screenshot_key.replace('screenshots/', '').replace('.png', '')
          : item.detail_url.match(/\/details\/([a-f0-9-]+)/)?.[1]
            || (item.detail_url.match(/\/properties\/(\d+)/) ? `listing-${item.detail_url.match(/\/properties\/(\d+)/)![1]}` : '');

        if (!uuid) {
          console.log(`  Skipping ${item.address}: can't determine UUID`);
          continue;
        }

        const isListing = uuid.startsWith('listing-');

        const historyPath = `screenshots/${uuid}_history.png`;
        const photoPath = `screenshots/${uuid}_photo.png`;

        // Auto-screenshot if missing
        if (!existsSync(historyPath) || !existsSync(photoPath)) {
          console.log(`  Auto-screenshotting ${item.address}...`);
          try {
            if (!existsSync('screenshots')) mkdirSync('screenshots', { recursive: true });
            const browser = await chromium.launch({ headless: true });
            const ctx = await browser.newContext({
              viewport: { width: 430, height: 932 },
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
            const screenshotUrl = item.listing_url || item.detail_url;
            await page.goto(screenshotUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2500);

            if (isListing) {
              // Listing page: /properties/{id}
              // Photo: from photo-collage to info-reel
              await page.evaluate(() => window.scrollTo(0, 0));
              await page.waitForTimeout(500);
              const photoClip = await page.evaluate(() => {
                const collage = document.querySelector('[data-testid="photo-collage"]');
                const infoReel = document.getElementById('info-reel');
                if (!collage) return null;
                const top = collage.getBoundingClientRect().top;
                const bottom = infoReel ? infoReel.getBoundingClientRect().bottom : collage.getBoundingClientRect().bottom + 200;
                return { y: Math.max(0, top), height: bottom - top };
              });
              if (photoClip) {
                await page.screenshot({ path: photoPath, clip: { x: 0, y: photoClip.y, width: 430, height: photoClip.height } });
                console.log(`    Saved: ${photoPath}`);
              }

              // History: click accordion, screenshot the card
              const accordionBtn = page.locator('button:has-text("Property sale history")').first();
              if (await accordionBtn.count() > 0) {
                await accordionBtn.scrollIntoViewIfNeeded();
                await page.waitForTimeout(500);
                await accordionBtn.click();
                await page.waitForTimeout(1500);
                const historyClip = await page.evaluate(() => {
                  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Property sale history'));
                  if (!btn) return null;
                  let el: Element | null = btn;
                  for (let i = 0; i < 10 && el; i++) { el = el.parentElement; if (!el) break; const r = el.getBoundingClientRect(); if (r.height > 200 && r.height < 800 && r.width > 300 && r.width < 420) return { y: r.top, height: r.height }; }
                  return null;
                });
                if (historyClip) {
                  await page.evaluate((y) => window.scrollTo(0, window.scrollY + y - 10), historyClip.y);
                  await page.waitForTimeout(300);
                  const finalClip = await page.evaluate(() => {
                    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Property sale history'));
                    if (!btn) return null;
                    let el: Element | null = btn;
                    for (let i = 0; i < 10 && el; i++) { el = el.parentElement; if (!el) break; const r = el.getBoundingClientRect(); if (r.height > 200 && r.height < 800 && r.width > 300 && r.width < 420) return { y: r.top, height: r.height }; }
                    return null;
                  });
                  if (finalClip) {
                    await page.screenshot({ path: historyPath, clip: { x: 0, y: Math.max(0, finalClip.y), width: 430, height: finalClip.height } });
                    console.log(`    Saved: ${historyPath}`);
                  }
                }
              }
            } else {
              // Sold property page: /house-prices/details/{uuid}
              // History screenshot
              const historyLocator = page.locator('div[class*="transaction"], div[class*="Transaction"]').filter({ has: page.locator('table') });
              if (await historyLocator.count() > 0) {
                await historyLocator.first().screenshot({ path: historyPath });
                console.log(`    Saved: ${historyPath}`);
              }

              // Photo screenshot
              const carousel = page.locator('div[class*="_carouselWrapper_"]').first();
              if (await carousel.count() > 0) {
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
                  await page.screenshot({ path: photoPath, clip: { x: 0, y, width: 430, height: bottom - y } });
                  console.log(`    Saved: ${photoPath}`);
                }
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
            if (item.id > 0) {
              console.log(`  Marking as posted in DB...`);
              await markPosted(item.id, tweetId);
              console.log(`  Done! Queue item ${item.id} marked as posted`);
            } else {
              console.log(`  Posted (not in queue, no DB update needed)`);
            }
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
      // Skip by UUID: npm run cli skip bc1e23bf-... or skip --id bc1e23bf-...
      const idIdx = process.argv.indexOf('--id');
      const skipRawId = idIdx !== -1
        ? process.argv[idIdx + 1]
        : process.argv[3]?.match(/[a-f0-9-]{36}/) ? process.argv[3] : null;
      const skipCleanUuid = skipRawId?.match(/([a-f0-9-]{36})/)?.[1];

      if (skipCleanUuid) {
        const result = await skipByUuid(skipCleanUuid);
        if (result) {
          console.log(`Skipped: ${result.address}`);
        } else {
          console.log(`No pending item found for UUID: ${cleanUuid}`);
        }
        break;
      }

      // Skip top N: npm run cli skip [n] [--filter tenure=Freehold]
      const skipCountArg = process.argv.find(a => /^\d+$/.test(a) && process.argv.indexOf(a) > 2);
      const skipCount = skipCountArg ? parseInt(skipCountArg, 10) : 1;
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
  scrape          Scrape sold properties from enabled areas
  scrape-listings Scrape for-sale listings (E14, expanding to all London)
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
