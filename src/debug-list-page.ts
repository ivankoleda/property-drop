import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    isMobile: true,
  });
  const page = await ctx.newPage();
  await page.goto('https://www.rightmove.co.uk/property-for-sale/find.html?useLocationIdentifier=true&locationIdentifier=OUTCODE%5E749&_includeSSTC=on&index=0&sortType=2&channel=BUY&transactionType=BUY', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const btn = await page.waitForSelector('button:has-text("Accept all")', { timeout: 5000 }).catch(() => null);
  if (btn) { await btn.click(); await page.waitForTimeout(1000); }

  const info = await page.evaluate(() => {
    // Find property cards by class pattern
    const cards = document.querySelectorAll('[class*="propertyCardContainer"]');
    const results: any[] = [];

    for (const card of Array.from(cards).slice(0, 3)) {
      // Find the property link
      const link = card.querySelector('a[href*="/properties/"]');
      const href = link?.getAttribute('href') || '';
      const idMatch = href.match(/\/properties\/(\d+)/);

      // Find address
      const address = card.querySelector('address, [data-testid="address"], h2, [class*="address"], [class*="Address"]')?.textContent?.trim();

      // Find price
      const priceEl = card.querySelector('[class*="price"], [class*="Price"], [data-testid="price"]');
      const price = priceEl?.textContent?.trim();

      // Find property type
      const typeEl = card.querySelector('[class*="propertyType"], [class*="PropertyType"]');
      const propType = typeEl?.textContent?.trim();

      // Find bedrooms
      const bedsText = card.textContent || '';
      const bedsMatch = bedsText.match(/(\d+)\s*bed/i);

      results.push({
        propertyId: idMatch?.[1],
        href: href.substring(0, 80),
        address,
        price,
        propType,
        bedrooms: bedsMatch?.[1],
        // Dump data-testid attributes in this card
        testIds: Array.from(card.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid')).slice(0, 10),
      });
    }

    // Also check pagination
    const pagination = document.querySelector('[class*="pagination"], [data-testid*="pagination"]');

    return {
      totalCards: cards.length,
      results,
      paginationText: pagination?.textContent?.trim()?.substring(0, 100),
      paginationTestIds: pagination ? Array.from(pagination.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid')) : [],
    };
  });

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
}

main().catch(console.error);
