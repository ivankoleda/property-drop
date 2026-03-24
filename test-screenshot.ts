import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
  });

  // Step 1: Dismiss cookies
  console.log('Dismissing cookie banner...');
  const cookiePage = await context.newPage();
  await cookiePage.goto('https://www.rightmove.co.uk/house-prices.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const acceptBtn = await cookiePage.waitForSelector('button:has-text("Accept all")', { timeout: 5000 }).catch(() => null);
  if (acceptBtn) {
    await acceptBtn.click();
    await cookiePage.waitForTimeout(1000);
    console.log('Cookie banner dismissed');
  }
  await cookiePage.close();

  // Step 2: Screenshot the detail page
  const page = await context.newPage();
  const url = 'https://www.rightmove.co.uk/house-prices/details/4e6963f7-3523-4f9f-840b-0c46110d0526';
  console.log('Loading:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Find the transaction history section
  const historyLocator = page.locator('div[class*="transaction"], div[class*="Transaction"]').filter({ has: page.locator('table') });

  if (await historyLocator.count() > 0) {
    console.log('Found history section, screenshotting...');
    await historyLocator.first().screenshot({ path: 'test-screenshot-history.png' });
    console.log('Saved: test-screenshot-history.png');
  } else {
    const table = page.locator('table').first();
    if (await table.count() > 0) {
      console.log('Found table, screenshotting...');
      await table.screenshot({ path: 'test-screenshot-table.png' });
      console.log('Saved: test-screenshot-table.png');
    }
  }

  // Full page for reference
  await page.screenshot({ path: 'test-screenshot-full.png' });
  console.log('Saved: test-screenshot-full.png');

  await browser.close();
}

main().catch(console.error);
