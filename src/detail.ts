import { chromium, type BrowserContext } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { config, randomDelay } from './config.js';
import { getPropertiesNeedingScreenshot, markPropertyVisited } from './db.js';
// import { uploadScreenshot } from './r2.js';

async function dismissCookieBanner(context: BrowserContext): Promise<void> {
  // Navigate to any Rightmove page and accept cookies once for the session
  const page = await context.newPage();
  await page.goto('https://www.rightmove.co.uk/house-prices.html', {
    waitUntil: 'domcontentloaded',
    timeout: 15000,
  });

  // Click "Accept all" on the cookie consent dialog
  const acceptBtn = await page.waitForSelector(
    'button:has-text("Accept all"), button:has-text("Accept All")',
    { timeout: 5000 }
  ).catch(() => null);

  if (acceptBtn) {
    await acceptBtn.click();
    await page.waitForTimeout(1000);
  }

  await page.close();
}

export async function screenshotProperties(): Promise<number> {
  const properties = await getPropertiesNeedingScreenshot(config.scraper.maxScreenshotsPerRun);
  console.log(`Found ${properties.length} properties needing screenshots`);

  if (properties.length === 0) return 0;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
  });

  let count = 0;

  try {
    // Dismiss cookie banner once for the session
    await dismissCookieBanner(context);

    for (const prop of properties) {
      try {
        console.log(`  Screenshotting: ${prop.address}`);
        const page = await context.newPage();

        await page.goto(prop.detail_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        // Look for the transaction/sale history section
        // Try multiple selectors that match the CSS module classes
        const historyLocator = page.locator(
          'div[class*="transaction"], div[class*="Transaction"], div[class*="SoldPrice"], div[class*="soldPrice"]'
        ).filter({ has: page.locator('table') });

        let screenshotBuffer: Buffer;

        if (await historyLocator.count() > 0) {
          screenshotBuffer = Buffer.from(await historyLocator.first().screenshot());
        } else {
          // Fallback: try to find the table directly
          const table = page.locator('table').first();
          if (await table.count() > 0) {
            screenshotBuffer = Buffer.from(await table.screenshot());
          } else {
            console.log(`    No history section found, taking full page screenshot`);
            screenshotBuffer = Buffer.from(await page.screenshot({ fullPage: false }));
          }
        }

        const key = `screenshots/${prop.uuid}.png`;
        // await uploadScreenshot(key, screenshotBuffer);
        if (!existsSync('screenshots')) mkdirSync('screenshots', { recursive: true });
        writeFileSync(key, screenshotBuffer);
        await markPropertyVisited(prop.id, key);

        console.log(`    Saved: ${key}`);
        count++;

        await page.close();
        await randomDelay(config.scraper.screenshotDelayMin, config.scraper.screenshotDelayMax);
      } catch (err) {
        console.error(`    Error screenshotting ${prop.address}:`, err);
      }
    }
  } finally {
    await browser.close();
  }

  return count;
}
