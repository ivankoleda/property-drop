import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'fs';

const DIR = './screenshots';
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

// Test with a few different properties to get consistent results
const TEST_URLS = [
  'https://www.rightmove.co.uk/house-prices/details/a34a0c42-e89a-419d-a6ea-65e2591aa0c7', // flat with photos
  'https://www.rightmove.co.uk/house-prices/details/0249cfca-845d-4807-a7e8-067ee1298c0b', // house
  'https://www.rightmove.co.uk/house-prices/details/fa4003bd-3a38-4449-b4dd-b2820d9d97aa', // another
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3, // Retina 3x for crisp screenshots
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
  });

  // Dismiss cookies
  const cp = await context.newPage();
  await cp.goto('https://www.rightmove.co.uk/house-prices.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const btn = await cp.waitForSelector('button:has-text("Accept all")', { timeout: 5000 }).catch(() => null);
  if (btn) { await btn.click(); await cp.waitForTimeout(1000); }
  await cp.close();

  const page = await context.newPage();

  for (let i = 0; i < TEST_URLS.length; i++) {
    const url = TEST_URLS[i];
    const uuid = url.match(/\/details\/([a-f0-9-]+)/)?.[1] || `test${i}`;
    console.log(`\n=== Testing ${uuid} ===`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Screenshot 1: History (already works fine)
    const historyLocator = page.locator('div[class*="transaction"], div[class*="Transaction"]').filter({ has: page.locator('table') });
    if (await historyLocator.count() > 0) {
      await historyLocator.first().screenshot({ path: `${DIR}/test_${i}_history.png` });
      console.log('  History: OK');
    }

    // Screenshot 2: Photo + property details row
    // Strategy: find the photo carousel image, then find the property info row below it
    // Capture from top of photo to bottom of info row

    // Check if property has photos
    const photoImg = page.locator('div[class*="_photoCollage_"] img, div[class*="_carouselWrapper_"] img').first();
    const hasPhotos = await photoImg.count() > 0;
    console.log(`  Has photos: ${hasPhotos}`);

    if (!hasPhotos) {
      console.log('  Skipping photo screenshot (no images)');
      continue;
    }

    // The photo carousel card contains both the image and sits above the property info
    // Let's find the exact elements
    const photoCard = page.locator('div[class*="_photoCollage_"]').first();
    const photoCardBox = await photoCard.boundingBox();

    // Find the property info row (PROPERTY TYPE / BEDROOMS / BATHROOMS)
    // It's in a section right after the photo, look for elements with these texts
    const propInfoSection = page.locator('div[class*="_propertyDetails_"], section[class*="_propertyDetails_"]').first();
    const propInfoBox = await propInfoSection.boundingBox().catch(() => null);

    console.log(`  Photo card: y=${photoCardBox?.y} h=${photoCardBox?.height}`);
    console.log(`  Prop info: y=${propInfoBox?.y} h=${propInfoBox?.height}`);

    // Also look for the specific icons row
    const iconsRow = await page.evaluate(() => {
      // Find elements containing "PROPERTY TYPE" or "BEDROOMS" text
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const text = el.textContent || '';
        if (text.includes('PROPERTY TYPE') && text.includes('BEDROOMS') && el.children.length > 0) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 200 && rect.height < 200 && rect.height > 20) {
            return { y: rect.y, height: rect.height, bottom: rect.bottom, cls: (typeof el.className === 'string' ? el.className : '').substring(0, 60) };
          }
        }
      }
      return null;
    });
    console.log(`  Icons row:`, iconsRow);

    // Scroll the photo carousel into view
    const carousel = page.locator('div[class*="_carouselWrapper_"]').first();
    await carousel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // Get positions after scrolling (relative to viewport now)
    const rects = await page.evaluate(() => {
      // The carousel wrapper contains the photo
      const cw = document.querySelector('div[class*="_carouselWrapper_"]');
      // The info reel has property type / bedrooms / bathrooms
      const ir = document.querySelector('div[class*="_infoReel_"]');

      const cwRect = cw?.getBoundingClientRect();
      const irRect = ir?.getBoundingClientRect();

      return {
        cw: cwRect ? { y: cwRect.y, h: cwRect.height, bottom: cwRect.bottom } : null,
        ir: irRect ? { y: irRect.y, h: irRect.height, bottom: irRect.bottom } : null,
      };
    });

    console.log(`  After scroll - carousel:`, rects.cw);
    console.log(`  After scroll - infoReel:`, rects.ir);

    if (rects.cw && rects.ir) {
      // Clip from carousel top to info reel bottom (viewport coords work with non-fullPage)
      const y = Math.max(0, rects.cw.y);
      const bottom = rects.ir.bottom + 10;
      await page.screenshot({
        path: `${DIR}/test_${i}_photo.png`,
        clip: { x: 0, y, width: 390, height: bottom - y },
      });
      console.log(`  Photo: ${Math.round(bottom - y)}px`);
    } else if (rects.cw) {
      const y = Math.max(0, rects.cw.y);
      await page.screenshot({
        path: `${DIR}/test_${i}_photo.png`,
        clip: { x: 0, y, width: 390, height: rects.cw.h },
      });
      console.log('  Photo: carousel only (no info reel)');
    } else {
      console.log('  SKIP: no carousel found');
    }
  }

  await browser.close();
  console.log('\nDone! Check screenshots/test_*');
}

main().catch(console.error);
