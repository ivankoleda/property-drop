import { chromium } from 'playwright';

async function main() {
  const url = process.argv[2] || 'https://www.rightmove.co.uk/properties/147926837';
  console.log(`Extracting PAGE_MODEL for: ${url}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 932 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const model = await page.evaluate(() => {
    const win = window as any;
    if (!win.PAGE_MODEL?.propertyData) return null;
    const pd = win.PAGE_MODEL.propertyData;
    return {
      id: pd.id,
      encId: pd.encId,
      address: pd.address,
      prices: pd.prices,
      listingHistory: pd.listingHistory,
      listingUpdate: pd.listingUpdate,
      firstVisibleDate: pd.firstVisibleDate,
      displayStatus: pd.displayStatus,
      addedOrReduced: pd.addedOrReduced,
      formattedDate: pd.formattedDate,
      customer: pd.customer?.brandPlusLogoUrl ? '(has agent)' : null,
      // Dump all top-level keys to see what's available
      keys: Object.keys(pd),
    };
  });

  console.log(JSON.stringify(model, null, 2));

  // Also check the full prices object
  const prices = await page.evaluate(() => {
    const pd = (window as any).PAGE_MODEL?.propertyData;
    return pd?.prices || null;
  });
  console.log('\nPrices:', JSON.stringify(prices, null, 2));

  // Check listingUpdate / listingHistory
  const listingInfo = await page.evaluate(() => {
    const pd = (window as any).PAGE_MODEL?.propertyData;
    return {
      listingUpdate: pd?.listingUpdate,
      listingHistory: pd?.listingHistory,
      sortDate: pd?.sortDate,
      firstVisibleDate: pd?.firstVisibleDate,
      addedOrReduced: pd?.addedOrReduced,
    };
  });
  console.log('\nListing info:', JSON.stringify(listingInfo, null, 2));

  await browser.close();
}

main().catch(console.error);
