import { chromium } from 'playwright';
import { config, randomDelay } from './config.js';
import { getPropertiesNeedingScreenshot, markPropertyVisited } from './db.js';
import { uploadScreenshot } from './r2.js';

export async function screenshotProperties(): Promise<number> {
  const properties = await getPropertiesNeedingScreenshot(config.scraper.maxScreenshotsPerRun);
  console.log(`Found ${properties.length} properties needing screenshots`);

  if (properties.length === 0) return 0;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
  });

  let count = 0;

  try {
    for (const prop of properties) {
      try {
        console.log(`  Screenshotting: ${prop.address}`);
        const page = await context.newPage();

        await page.goto(prop.detail_url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait for the sale history section
        const historySection = await page.waitForSelector(
          '[data-test="sold-price-history"], .sold-price-history, #soldPriceHistory',
          { timeout: 10000 }
        ).catch(() => null);

        let screenshotBuffer: Buffer;

        if (historySection) {
          // Screenshot just the sale history card
          screenshotBuffer = Buffer.from(await historySection.screenshot());
        } else {
          // Fallback: full page screenshot
          console.log(`    No history section found, taking full page screenshot`);
          screenshotBuffer = Buffer.from(await page.screenshot({ fullPage: false }));
        }

        const key = `screenshots/${prop.uuid}.png`;
        await uploadScreenshot(key, screenshotBuffer);
        await markPropertyVisited(prop.id, key);

        console.log(`    Uploaded: ${key}`);
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
