import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

function parsePrice(text: string): number {
  const cleaned = text.replace(/[£,\s.]/g, '');
  const pounds = parseInt(cleaned, 10);
  return isNaN(pounds) ? 0 : pounds * 100;
}

function parseDate(text: string): string {
  const months: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return text;
  return `${parts[2]}-${months[parts[1]] || '01'}-${parts[0].padStart(2, '0')}`;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await page.goto('https://www.rightmove.co.uk/house-prices/royal-wharf-94313.html?pageNumber=1&sortBy=DEED_DATE&sortOrder=DESC', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForSelector('a[href*="/house-prices/details/"]', { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(2000);

  const rawProperties = await page.evaluate(() => {
    const results: any[] = [];
    const cardLinks = document.querySelectorAll('a[href*="/house-prices/details/"]:not([href*="track=true"])');

    for (const link of cardLinks) {
      const href = link.getAttribute('href') || '';
      const uuid = href.match(/\/details\/([a-f0-9-]+)/)?.[1] || '';
      if (!uuid) continue;

      const address = link.querySelector('h2')?.textContent?.trim() || '';
      if (!address) continue;

      const chips = link.querySelectorAll('div[class*="_propertyCategory_"]');
      let propertyType: string | null = null;
      let tenure: string | null = null;
      let bedrooms: number | null = null;

      const propTypes = ['Flat', 'Detached', 'Semi-Detached', 'Semi Detached', 'Terraced', 'Other'];
      const tenureTypes = ['Leasehold', 'Freehold'];

      for (const chip of chips) {
        const text = chip.textContent?.trim() || '';
        if (propTypes.includes(text)) propertyType = text;
        else if (tenureTypes.includes(text)) tenure = text;
        else if (/^\d+$/.test(text)) bedrooms = parseInt(text, 10);
      }

      const table = link.querySelector('table');
      const txs: { price: string; dateSold: string }[] = [];
      if (table) {
        for (const row of table.querySelectorAll('tr')) {
          const cells = row.querySelectorAll('td');
          if (cells.length < 2) continue;
          const dateText = cells[0]?.textContent?.trim() || '';
          if (dateText === 'Today') continue;
          const priceDiv = cells[1]?.querySelector('div[aria-label]');
          const price = priceDiv?.getAttribute('aria-label')?.replace('.', '') || cells[1]?.textContent?.trim() || '';
          if (dateText && price.startsWith('£')) txs.push({ price, dateSold: dateText });
        }
      }

      results.push({ uuid, address, propertyType, tenure, bedrooms, detailUrl: href, transactions: txs });
    }
    return results;
  });

  // Parse and display
  const properties = rawProperties.map((p: any) => ({
    ...p,
    transactions: p.transactions.map((t: any) => ({
      pricePence: parsePrice(t.price),
      displayPrice: t.price,
      dateSold: parseDate(t.dateSold),
    })),
  }));

  console.log(`\nScraped ${properties.length} properties from page 1:\n`);

  let dropsFound = 0;
  for (const p of properties) {
    const txs = p.transactions;
    const hasDrop = txs.length >= 2 && txs[0].pricePence < txs[1].pricePence;
    const dropInfo = hasDrop
      ? ` *** DROP: ${txs[1].displayPrice} -> ${txs[0].displayPrice} (-£${((txs[1].pricePence - txs[0].pricePence) / 100).toLocaleString()})`
      : '';
    if (hasDrop) dropsFound++;

    console.log(`${p.address}`);
    console.log(`  ${p.propertyType || '?'} | ${p.tenure || '?'} | ${p.bedrooms ? p.bedrooms + ' bed' : '?'}`);
    for (const tx of txs) {
      console.log(`  ${tx.dateSold}: ${tx.displayPrice}`);
    }
    if (dropInfo) console.log(`  ${dropInfo}`);
    console.log('');
  }

  console.log(`Total: ${properties.length} properties, ${dropsFound} with price drops`);

  // Check pagination
  const hasNext = await page.evaluate(() => {
    const buttons = document.querySelectorAll('.dsrm_pagination button');
    for (const btn of buttons) {
      if (btn.textContent?.includes('Next') && !btn.hasAttribute('disabled')) return true;
    }
    return false;
  });
  console.log(`Has next page: ${hasNext}`);

  writeFileSync('test-results.json', JSON.stringify(properties, null, 2));
  console.log('Saved to test-results.json');

  await browser.close();
}

main().catch(console.error);
