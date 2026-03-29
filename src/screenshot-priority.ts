import { chromium, type BrowserContext } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { config, randomDelay } from './config.js';
import { markPropertyVisited } from './db.js';

const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${config.cf.accountId}/d1/database/${config.cf.d1DatabaseId}`;

async function query(sql: string, params: unknown[] = []) {
  const res = await fetch(`${D1_BASE}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.cf.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json() as any;
  if (!data.success) throw new Error(`D1 error: ${JSON.stringify(data.errors)}`);
  return data.result[0].results;
}

async function dismissCookieBanner(context: BrowserContext) {
  const page = await context.newPage();
  await page.goto('https://www.rightmove.co.uk/house-prices.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const btn = await page.waitForSelector('button:has-text("Accept all"), button:has-text("Accept All")', { timeout: 5000 }).catch(() => null);
  if (btn) { await btn.click(); await page.waitForTimeout(1000); }
  await page.close();
}

async function main() {
  // Get top pending posts without screenshots
  const props = await query(`
    SELECT p.uuid, p.detail_url, p.id, p.address
    FROM post_queue q
    JOIN properties p ON p.id = q.property_id
    WHERE q.status = 'pending' AND p.screenshot_key IS NULL
    ORDER BY q.score DESC
    LIMIT 100
  `);

  console.log(`Found ${props.length} priority properties needing screenshots`);
  if (props.length === 0) return;

  if (!existsSync('screenshots')) mkdirSync('screenshots', { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
  });

  await dismissCookieBanner(context);
  let count = 0;

  for (const prop of props) {
    try {
      console.log(`  [${count + 1}/${props.length}] ${prop.address}`);
      const page = await context.newPage();
      await page.goto(prop.detail_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const historyLocator = page.locator(
        'div[class*="transaction"], div[class*="Transaction"], div[class*="SoldPrice"], div[class*="soldPrice"]'
      ).filter({ has: page.locator('table') });

      let screenshotBuffer: Buffer;
      if (await historyLocator.count() > 0) {
        screenshotBuffer = Buffer.from(await historyLocator.first().screenshot());
      } else {
        const table = page.locator('table').first();
        if (await table.count() > 0) {
          screenshotBuffer = Buffer.from(await table.screenshot());
        } else {
          console.log(`    No history section found, full page fallback`);
          screenshotBuffer = Buffer.from(await page.screenshot({ fullPage: false }));
        }
      }

      const key = `screenshots/${prop.uuid}.png`;
      writeFileSync(key, screenshotBuffer);
      await markPropertyVisited(prop.id, key);
      console.log(`    Saved: ${key}`);
      count++;

      await page.close();
      await randomDelay(1500, 3000);
    } catch (err: any) {
      console.error(`    Error: ${err.message?.substring(0, 80)}`);
    }
  }

  await browser.close();
  console.log(`\nDone: ${count}/${props.length} screenshots saved`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
