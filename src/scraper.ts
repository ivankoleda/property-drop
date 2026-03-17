import { chromium, type Page } from 'playwright';
import { config, randomDelay } from './config.js';
import { upsertProperty, upsertTransaction, updateAreaLastScraped, getEnabledAreas } from './db.js';
import type { Area, ScrapedProperty } from './types.js';

function parsePrice(text: string): number {
  // "£450,000" -> 45000000 (pence)
  const cleaned = text.replace(/[£,\s]/g, '');
  const pounds = parseInt(cleaned, 10);
  if (isNaN(pounds)) return 0;
  return pounds * 100;
}

function parseDate(text: string): string {
  // "12 Mar 2024" -> "2024-03-12"
  const months: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return text;
  const day = parts[0].padStart(2, '0');
  const month = months[parts[1]] || '01';
  const year = parts[2];
  return `${year}-${month}-${day}`;
}

function buildListUrl(rightmoveId: string, page: number): string {
  const index = (page - 1) * 25;
  return `https://www.rightmove.co.uk/house-prices/detail.html?country=england&locationIdentifier=POSTCODE%5E${rightmoveId}&searchLocation=&referrer=listChangeCriteria&index=${index}`;
}

async function scrapeListPage(page: Page, url: string): Promise<ScrapedProperty[]> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for the results to load
  await page.waitForSelector('.sold-prices-results', { timeout: 15000 }).catch(() => null);

  const properties = await page.evaluate(() => {
    const results: {
      uuid: string;
      address: string;
      propertyType: string | null;
      tenure: string | null;
      bedrooms: number | null;
      detailUrl: string;
      transactions: { price: string; dateSold: string; displayPrice: string }[];
    }[] = [];

    const cards = document.querySelectorAll('.sold-prices-result');

    for (const card of cards) {
      const linkEl = card.querySelector('a[href*="/house-prices/"]') as HTMLAnchorElement | null;
      if (!linkEl) continue;

      const href = linkEl.getAttribute('href') || '';
      const uuidMatch = href.match(/\/house-prices\/([^/]+)/);
      const uuid = uuidMatch ? uuidMatch[1] : '';
      if (!uuid) continue;

      const addressEl = card.querySelector('.sold-prices-result-address, .ksc_cardHeader');
      const address = addressEl?.textContent?.trim() || '';

      const typeEl = card.querySelector('.sold-prices-result-type, .ksc_cardBody .type');
      const propertyType = typeEl?.textContent?.trim() || null;

      const tenureEl = card.querySelector('.sold-prices-result-tenure, .ksc_cardBody .tenure');
      const tenure = tenureEl?.textContent?.trim() || null;

      const bedroomsEl = card.querySelector('.sold-prices-result-bedrooms, .ksc_cardBody .bedrooms');
      const bedroomsText = bedroomsEl?.textContent?.trim() || '';
      const bedroomsMatch = bedroomsText.match(/(\d+)/);
      const bedrooms = bedroomsMatch ? parseInt(bedroomsMatch[1], 10) : null;

      const txRows = card.querySelectorAll('.sold-prices-result-prices tr, .ksc_soldPriceHistory tr');
      const transactions: { price: string; dateSold: string; displayPrice: string }[] = [];

      for (const row of txRows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;
        const dateSold = cells[0]?.textContent?.trim() || '';
        const price = cells[1]?.textContent?.trim() || '';
        if (dateSold && price) {
          transactions.push({ price, dateSold, displayPrice: price });
        }
      }

      results.push({
        uuid,
        address,
        propertyType,
        tenure,
        bedrooms,
        detailUrl: `https://www.rightmove.co.uk${href}`,
        transactions,
      });
    }

    return results;
  });

  // Parse prices and dates
  return properties.map((p) => ({
    ...p,
    transactions: p.transactions.map((t) => ({
      price: parsePrice(t.price),
      dateSold: parseDate(t.dateSold),
      displayPrice: t.displayPrice,
    })),
  }));
}

function hasMorePages(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const next = document.querySelector('.pagination-next:not(.disabled), [data-test="pagination-next"]:not([disabled])');
    return !!next;
  });
}

export async function scrapeArea(area: Area): Promise<number> {
  console.log(`Scraping area: ${area.name} (${area.slug})`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  let totalProperties = 0;

  try {
    for (let pageNum = 1; pageNum <= area.max_pages; pageNum++) {
      const url = buildListUrl(area.rightmove_id, pageNum);
      console.log(`  Page ${pageNum}: ${url}`);

      const properties = await scrapeListPage(page, url);
      console.log(`  Found ${properties.length} properties`);

      if (properties.length === 0) break;

      for (const prop of properties) {
        const propertyId = await upsertProperty(
          prop.uuid,
          area.id,
          prop.address,
          prop.propertyType,
          prop.tenure,
          prop.bedrooms,
          prop.detailUrl
        );

        for (const tx of prop.transactions) {
          if (tx.price > 0) {
            await upsertTransaction(propertyId, tx.price, tx.dateSold, tx.displayPrice);
          }
        }
      }

      totalProperties += properties.length;

      const hasMore = await hasMorePages(page);
      if (!hasMore) {
        console.log(`  No more pages`);
        break;
      }

      await randomDelay(config.scraper.pageDelayMin, config.scraper.pageDelayMax);
    }

    await updateAreaLastScraped(area.id);
  } finally {
    await browser.close();
  }

  return totalProperties;
}

export async function scrapeAllAreas(): Promise<void> {
  const areas = await getEnabledAreas();
  console.log(`Found ${areas.length} enabled areas`);

  for (const area of areas) {
    try {
      const count = await scrapeArea(area);
      console.log(`  Total: ${count} properties from ${area.name}`);
    } catch (err) {
      console.error(`  Error scraping ${area.name}:`, err);
    }
    await randomDelay(config.scraper.pageDelayMin, config.scraper.pageDelayMax);
  }
}
