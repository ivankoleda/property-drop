import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'fs';
import { config, randomDelay } from './config.js';

const SCREENSHOTS_DIR = './screenshots';
const WORKERS = 8;

interface PropertyToScreenshot {
  id: number;
  uuid: string;
  address: string;
  detail_url: string;
}

async function getPropertiesNeedingScreenshots(): Promise<PropertyToScreenshot[]> {
  const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${config.cf.accountId}/d1/database/${config.cf.d1DatabaseId}`;
  const res = await fetch(`${D1_BASE}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.cf.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sql: `SELECT DISTINCT p.id, p.uuid, p.address, p.detail_url
            FROM properties p
            WHERE p.visited = 0 AND p.has_images = 1
              AND (SELECT COUNT(*) FROM transactions t WHERE t.property_id = p.id) >= 2
              AND EXISTS (
                SELECT 1 FROM transactions t1
                JOIN transactions t2 ON t1.property_id = t2.property_id AND t1.id != t2.id
                WHERE t1.property_id = p.id AND t1.date_sold > t2.date_sold AND t1.price < t2.price
              )`,
      params: [],
    }),
  });
  const data = await res.json() as any;
  if (!data.success) throw new Error(`D1 error: ${JSON.stringify(data.errors)}`);
  return data.result[0].results;
}

async function markVisited(propertyId: number, screenshotKey: string): Promise<void> {
  const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${config.cf.accountId}/d1/database/${config.cf.d1DatabaseId}`;
  await fetch(`${D1_BASE}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.cf.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sql: 'UPDATE properties SET visited = 1, screenshot_key = ? WHERE id = ?',
      params: [screenshotKey, propertyId],
    }),
  });
}

async function dismissCookies(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await page.goto('https://www.rightmove.co.uk/house-prices.html', {
    waitUntil: 'domcontentloaded', timeout: 15000,
  });
  const btn = await page.waitForSelector('button:has-text("Accept all")', { timeout: 5000 }).catch(() => null);
  if (btn) {
    await btn.click();
    await page.waitForTimeout(1000);
  }
  await page.close();
}

async function screenshotProperty(page: Page, prop: PropertyToScreenshot): Promise<boolean> {
  await page.goto(prop.detail_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  // Screenshot 1: Sale history card
  const historyLocator = page.locator('div[class*="transaction"], div[class*="Transaction"]').filter({ has: page.locator('table') });
  let gotHistory = false;

  if (await historyLocator.count() > 0) {
    await historyLocator.first().screenshot({ path: `${SCREENSHOTS_DIR}/${prop.uuid}_history.png` });
    gotHistory = true;
  }

  // Screenshot 2: Photo + property type/bedrooms/bathrooms row
  // Check if property has photos
  const hasPhotos = await page.locator('div[class*="_carouselWrapper_"] img').count() > 0;

  if (hasPhotos) {
    // Scroll carousel into view
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
      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/${prop.uuid}_photo.png`,
        clip: { x: 0, y, width: 390, height: bottom - y },
      });
    }
  }

  return gotHistory;
}

async function worker(workerId: number, properties: PropertyToScreenshot[]): Promise<number> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
  });

  await dismissCookies(context);
  let count = 0;

  try {
    const page = await context.newPage();

    for (const prop of properties) {
      try {
        const ok = await screenshotProperty(page, prop);
        if (ok) {
          await markVisited(prop.id, `screenshots/${prop.uuid}`);
          count++;
          console.log(`  [W${workerId}] ${prop.address}`);
        } else {
          console.log(`  [W${workerId}] SKIP: ${prop.address}`);
        }
      } catch (err: any) {
        console.error(`  [W${workerId}] ERROR ${prop.address}: ${err.message}`);
      }
      await randomDelay(2000, 4000);
    }
  } finally {
    await browser.close();
  }

  return count;
}

async function main() {
  console.log('=== Screenshot tool (local, parallel) ===');

  if (!existsSync(SCREENSHOTS_DIR)) {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }

  const properties = await getPropertiesNeedingScreenshots();
  console.log(`Found ${properties.length} properties to screenshot`);

  if (properties.length === 0) return;

  // Distribute across workers
  const workerProps: PropertyToScreenshot[][] = Array.from({ length: WORKERS }, () => []);
  properties.forEach((p, i) => workerProps[i % WORKERS].push(p));

  const counts = await Promise.all(
    workerProps
      .filter(p => p.length > 0)
      .map((props, i) => worker(i + 1, props))
  );

  const total = counts.reduce((a, b) => a + b, 0);
  console.log(`\n=== Done: ${total}/${properties.length} screenshots taken ===`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
