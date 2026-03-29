import { chromium, type BrowserContext, type Page } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { config, randomDelay } from './config.js';
import { calculateListingDrop } from './scorer.js';
import { upsertTransaction } from './db.js';

const WORKERS = 4;
const MAX_PAGES_PER_POSTCODE = 20; // 24 results per page = ~480 listings max
const SCREENSHOTS_DIR = './screenshots';

// London outcodes with their Rightmove location identifiers
// Format: [outcode, rightmove_identifier]
const LONDON_OUTCODES: [string, string][] = [
  ['E14', 'OUTCODE%5E749'],
  // TODO: expand to all London outcodes
];

// --- D1 helpers ---

function getD1Headers() {
  return { 'Authorization': `Bearer ${config.cf.apiToken}`, 'Content-Type': 'application/json' };
}

function getD1Base() {
  return `https://api.cloudflare.com/client/v4/accounts/${config.cf.accountId}/d1/database/${config.cf.d1DatabaseId}`;
}

async function d1Query(sql: string, params: unknown[] = []) {
  const res = await fetch(`${getD1Base()}/query`, {
    method: 'POST',
    headers: getD1Headers(),
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json() as any;
  if (!data.success) throw new Error(`D1 error: ${JSON.stringify(data.errors)}`);
  return data.result[0].results;
}

// --- Price parsing ---

function parsePrice(text: string): number {
  const cleaned = text.replace(/[£,\s.]/g, '');
  const pounds = parseInt(cleaned, 10);
  return isNaN(pounds) ? 0 : pounds * 100; // pence
}

// --- Ensure area exists ---

async function ensureArea(outcode: string): Promise<number> {
  await d1Query(
    `INSERT OR IGNORE INTO areas (name, slug, rightmove_id, max_pages) VALUES (?, ?, ?, ?)`,
    [outcode, `listing-${outcode.toLowerCase()}`, outcode, MAX_PAGES_PER_POSTCODE]
  );
  const rows = await d1Query(`SELECT id FROM areas WHERE slug = ?`, [`listing-${outcode.toLowerCase()}`]);
  return rows[0].id;
}

// --- Fetch known properties for skip-check ---

async function getKnownProperties(areaId: number): Promise<Map<string, { visited: number; lastPrice: number | null }>> {
  const rows = await d1Query(
    `SELECT uuid, visited, last_price FROM properties WHERE area_id = ?`,
    [areaId]
  );
  const map = new Map<string, { visited: number; lastPrice: number | null }>();
  for (const r of rows as any[]) {
    map.set(r.uuid, { visited: r.visited, lastPrice: r.last_price });
  }
  return map;
}

// --- List page scraping ---

interface ListingCard {
  propertyId: string; // numeric rightmove ID
  address: string;
  askingPrice: number; // pence
  propertyType: string | null;
  bedrooms: number | null;
  listingUrl: string;
}

async function scrapeListPage(page: Page, url: string): Promise<ListingCard[]> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    const results: any[] = [];
    const seen = new Set<string>();
    // Rightmove uses data-testid="propertyCard-N" for each card
    const cards = document.querySelectorAll('[data-testid^="propertyCard-"]');

    for (const card of cards) {
      const link = card.querySelector('a[href*="/properties/"]');
      if (!link) continue;
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/properties\/(\d+)/);
      if (!match) continue;

      const propertyId = match[1];
      if (seen.has(propertyId)) continue; // dedupe (multiple links per card)
      seen.add(propertyId);

      const address = card.querySelector('address')?.textContent?.trim().replace(/\s+/g, ' ') || '';

      // Price text may include prefixes like "FEATURED NEW HOME" — extract £ amount
      const fullText = card.textContent || '';
      const priceMatch = fullText.match(/£[\d,]+/);
      const askingPriceText = priceMatch ? priceMatch[0] : '';

      // Property type
      const propTypes = ['Flat', 'Apartment', 'House', 'Terraced', 'Semi-Detached', 'Detached', 'Bungalow', 'Maisonette', 'Penthouse'];
      let propertyType: string | null = null;
      for (const t of propTypes) {
        if (fullText.includes(t)) { propertyType = t; break; }
      }

      const bedsMatch = fullText.match(/(\d+)\s*bed/i);
      const bedrooms = bedsMatch ? parseInt(bedsMatch[1], 10) : null;

      if (!propertyId || !askingPriceText) continue;

      results.push({
        propertyId,
        address: address || `Property ${propertyId}`,
        askingPriceText,
        propertyType,
        bedrooms,
        listingUrl: `https://www.rightmove.co.uk/properties/${propertyId}`,
      });
    }
    return results;
  }).then(raw => raw.map(r => ({
    ...r,
    askingPrice: parsePrice(r.askingPriceText),
  })).filter(r => r.askingPrice > 0));
}

function hasNextPage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const next = document.querySelector('[data-testid="nextPage"]:not([disabled])');
    return !!next;
  });
}

// --- Detail page scraping ---

interface SaleHistoryEntry {
  year: string;
  price: number; // pence
  displayPrice: string;
}

async function scrapeDetailPage(
  page: Page,
  listing: ListingCard,
  uuid: string,
): Promise<{ history: SaleHistoryEntry[]; gotHistoryScreenshot: boolean; gotPhotoScreenshot: boolean }> {
  await page.goto(listing.listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  // Screenshot 1: Property photo — from photo-collage top to info-reel bottom
  let gotPhotoScreenshot = false;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  const photoClip = await page.evaluate(() => {
    const collage = document.querySelector('[data-testid="photo-collage"]');
    const infoReel = document.getElementById('info-reel');
    if (!collage) return null;
    const top = collage.getBoundingClientRect().top;
    const bottom = infoReel
      ? infoReel.getBoundingClientRect().bottom
      : collage.getBoundingClientRect().bottom + 200;
    return { y: Math.max(0, top), height: bottom - top };
  });
  if (photoClip) {
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/${uuid}_photo.png`,
      clip: { x: 0, y: photoClip.y, width: 430, height: photoClip.height },
    });
    gotPhotoScreenshot = true;
  }

  // Find and click "Property sale history" accordion
  let gotHistoryScreenshot = false;
  const history: SaleHistoryEntry[] = [];

  // Try clicking the accordion
  const accordionBtn = page.locator('button:has-text("Property sale history"), summary:has-text("Property sale history"), [data-testid="price-history-toggle"]').first();
  if (await accordionBtn.count() > 0) {
    await accordionBtn.scrollIntoViewIfNeeded();
    await accordionBtn.click();
    await page.waitForTimeout(1500);

    // Extract sale history rows
    const rows = await page.evaluate(() => {
      const results: { year: string; priceText: string }[] = [];
      // Look for the expanded history section
      const historySection = document.querySelector('[data-testid="price-history"]')
        || document.querySelector('div[class*="saleHistory"]')
        || document.querySelector('div[class*="priceHistory"]');

      // Try table rows first
      const tableRows = (historySection || document).querySelectorAll('tr, [class*="historyRow"], [class*="saleRow"]');
      for (const row of tableRows) {
        const cells = row.querySelectorAll('td, span, div');
        const text = row.textContent || '';
        const yearMatch = text.match(/\b(19|20)\d{2}\b/);
        const priceMatch = text.match(/£[\d,]+/);
        if (yearMatch && priceMatch) {
          results.push({ year: yearMatch[0], priceText: priceMatch[0] });
        }
      }

      // If no table rows, try text-based extraction from the section
      if (results.length === 0 && historySection) {
        const allText = historySection.textContent || '';
        const matches = allText.matchAll(/((?:19|20)\d{2})\s*[^\d£]*(£[\d,]+)/g);
        for (const m of matches) {
          results.push({ year: m[1], priceText: m[2] });
        }
      }

      return results;
    });

    for (const row of rows) {
      const price = parsePrice(row.priceText);
      if (price > 0) {
        history.push({ year: row.year, price, displayPrice: row.priceText });
      }
    }

    // Screenshot the expanded history card
    if (history.length > 0) {
      // Find the card container by walking up from the button
      const historyClip = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent?.includes('Property sale history'));
        if (!btn) return null;
        let el: Element | null = btn;
        for (let i = 0; i < 10 && el; i++) {
          el = el.parentElement;
          if (!el) break;
          const rect = el.getBoundingClientRect();
          if (rect.height > 200 && rect.height < 800 && rect.width > 300 && rect.width < 420) {
            return { y: rect.top, height: rect.height };
          }
        }
        return null;
      });

      if (historyClip) {
        await page.evaluate((y) => window.scrollTo(0, window.scrollY + y - 10), historyClip.y);
        await page.waitForTimeout(300);
        // Re-measure after scroll
        const finalClip = await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent?.includes('Property sale history'));
          if (!btn) return null;
          let el: Element | null = btn;
          for (let i = 0; i < 10 && el; i++) {
            el = el.parentElement;
            if (!el) break;
            const rect = el.getBoundingClientRect();
            if (rect.height > 200 && rect.height < 800 && rect.width > 300 && rect.width < 420) {
              return { y: rect.top, height: rect.height };
            }
          }
          return null;
        });
        if (finalClip) {
          await page.screenshot({
            path: `${SCREENSHOTS_DIR}/${uuid}_history.png`,
            clip: { x: 0, y: Math.max(0, finalClip.y), width: 430, height: finalClip.height },
          });
          gotHistoryScreenshot = true;
        }
      }
    }
  }

  return { history, gotHistoryScreenshot, gotPhotoScreenshot };
}

// --- Worker ---

async function worker(workerId: number, outcodes: [string, string][]): Promise<number> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
  });

  // Dismiss cookies
  const cp = await context.newPage();
  await cp.goto('https://www.rightmove.co.uk/property-for-sale.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const btn = await cp.waitForSelector('button:has-text("Accept all")', { timeout: 5000 }).catch(() => null);
  if (btn) { await btn.click(); await cp.waitForTimeout(1000); }
  await cp.close();

  let totalQueued = 0;

  for (const [outcode, identifier] of outcodes) {
    try {
      console.log(`  [W${workerId}] Starting ${outcode}...`);
      const areaId = await ensureArea(outcode);
      const known = await getKnownProperties(areaId);

      const page = await context.newPage();
      let scraped = 0;
      let queued = 0;
      let skipped = 0;

      for (let pageIdx = 0; pageIdx < MAX_PAGES_PER_POSTCODE; pageIdx++) {
        const offset = pageIdx * 24;
        const url = `https://www.rightmove.co.uk/property-for-sale/find.html?useLocationIdentifier=true&locationIdentifier=${identifier}&_includeSSTC=on&index=${offset}&sortType=2&channel=BUY&transactionType=BUY`;

        const listings = await scrapeListPage(page, url);
        if (listings.length === 0) break;
        console.log(`  [W${workerId}] ${outcode} page ${pageIdx + 1}: ${listings.length} listings`);

        for (const listing of listings) {
          const uuid = `listing-${listing.propertyId}`;
          scraped++;

          // Skip check: already visited and price unchanged
          const existing = known.get(uuid);
          if (existing && existing.visited === 1 && existing.lastPrice === listing.askingPrice) {
            skipped++;
            continue;
          }

          // Upsert property
          await d1Query(
            `INSERT INTO properties (uuid, area_id, address, property_type, bedrooms, detail_url, listing_price, listing_url, last_price)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(uuid) DO UPDATE SET
               address = excluded.address,
               property_type = COALESCE(excluded.property_type, properties.property_type),
               bedrooms = COALESCE(excluded.bedrooms, properties.bedrooms),
               listing_price = excluded.listing_price,
               listing_url = excluded.listing_url,
               last_price = excluded.last_price`,
            [uuid, areaId, listing.address, listing.propertyType, listing.bedrooms,
             listing.listingUrl, listing.askingPrice, listing.listingUrl, listing.askingPrice]
          );

          // Visit detail page
          try {
            const { history, gotHistoryScreenshot, gotPhotoScreenshot } = await scrapeDetailPage(page, listing, uuid);

            // Save transactions
            const propRows = await d1Query(`SELECT id FROM properties WHERE uuid = ?`, [uuid]);
            const propertyId = propRows[0].id;

            for (const entry of history) {
              await upsertTransaction(propertyId, entry.price, `${entry.year}-01-01`, entry.displayPrice, 'listing-history');
            }

            // Mark as visited regardless of drop
            const screenshotKey = gotHistoryScreenshot ? `screenshots/${uuid}` : null;
            await d1Query(
              `UPDATE properties SET visited = 1, screenshot_key = ?, last_price = ? WHERE uuid = ?`,
              [screenshotKey, listing.askingPrice, uuid]
            );

            // Score if there's a drop
            if (history.length > 0) {
              // Most recent sold price (history is typically newest first, but sort to be safe)
              const sorted = [...history].sort((a, b) => parseInt(b.year) - parseInt(a.year));
              const lastSold = sorted[0];

              const drop = calculateListingDrop(listing.askingPrice, lastSold.price, `${lastSold.year}-01-01`);
              if (drop && gotHistoryScreenshot) {
                await d1Query(
                  `INSERT INTO post_queue (property_id, queue_type, score, drop_amount, drop_pct, prev_price, curr_price, prev_date, curr_date, adj_drop_amount, adj_drop_pct)
                   VALUES (?, 'listed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(property_id, queue_type) DO UPDATE SET
                     score = excluded.score, drop_amount = excluded.drop_amount, drop_pct = excluded.drop_pct,
                     prev_price = excluded.prev_price, curr_price = excluded.curr_price,
                     prev_date = excluded.prev_date, curr_date = excluded.curr_date,
                     adj_drop_amount = excluded.adj_drop_amount, adj_drop_pct = excluded.adj_drop_pct,
                     status = CASE WHEN post_queue.status = 'posted' THEN 'posted' ELSE 'pending' END`,
                  [propertyId, drop.score, drop.dropAmount, drop.dropPct, drop.prevPrice, drop.currPrice, drop.prevDate, drop.currDate, drop.adjDropAmount, drop.adjDropPct]
                );
                queued++;
                console.log(`    [W${workerId}] QUEUED: ${listing.address} — £${listing.askingPrice / 100} vs £${lastSold.price / 100} (${drop.dropPct}%)`);
              }
            }

            await randomDelay(2000, 4000);
          } catch (err: any) {
            console.error(`    [W${workerId}] Error on ${listing.address}: ${err.message?.substring(0, 60)}`);
          }
        }

        // If we got fewer than 24 results, we're on the last page
        if (listings.length < 24) break;

        await randomDelay(1500, 3000);
      }

      await page.close();
      totalQueued += queued;
      console.log(`  [W${workerId}] ${outcode}: ${scraped} listings, ${skipped} skipped, ${queued} queued`);
    } catch (err: any) {
      console.error(`  [W${workerId}] ${outcode} error: ${err.message}`);
    }

    await randomDelay(2000, 4000);
  }

  await browser.close();
  return totalQueued;
}

// --- Main ---

export async function scrapeListings(outcodesArg?: string[]) {
  const outcodes = outcodesArg
    ? outcodesArg.map(o => [o, ''] as [string, string]) // identifier will need lookup
    : LONDON_OUTCODES;

  console.log(`=== Listings scraper (${outcodes.length} outcodes, ${WORKERS} workers) ===`);

  if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Distribute across workers
  const workerOutcodes: [string, string][][] = Array.from({ length: WORKERS }, () => []);
  outcodes.forEach((o, i) => workerOutcodes[i % WORKERS].push(o));

  const counts = await Promise.all(
    workerOutcodes
      .filter(o => o.length > 0)
      .map((ocs, i) => worker(i + 1, ocs))
  );

  const total = counts.reduce((a, b) => a + b, 0);
  console.log(`\n=== Done: ${total} listings queued ===`);
}

// Allow running directly: npx tsx src/scrape-listings.ts
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('scrape-listings.ts')) {
  scrapeListings().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
