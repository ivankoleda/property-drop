import { chromium, type Page } from 'playwright';
import { config, randomDelay } from './config.js';
import { upsertProperty, upsertTransaction, updateAreaLastScraped, getEnabledAreas } from './db.js';
import type { Area, ScrapedProperty } from './types.js';

function parsePrice(text: string): number {
  // "£450,000" -> 45000000 (pence)
  const cleaned = text.replace(/[£,\s.]/g, '');
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

function buildListUrl(slug: string, pageNumber: number): string {
  return `https://www.rightmove.co.uk/house-prices/${slug}.html?pageNumber=${pageNumber}&sortBy=DEED_DATE&sortOrder=DESC`;
}

async function scrapeListPage(page: Page, url: string): Promise<ScrapedProperty[]> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for property cards to load
  await page.waitForSelector('a[href*="/house-prices/details/"]', { timeout: 15000 }).catch(() => null);
  // Extra wait for dynamic rendering
  await page.waitForTimeout(2000);

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

    // Each property card is an <a> linking to /house-prices/details/{uuid}
    // Exclude "track=true" links (the "See what it's worth now" links)
    const cardLinks = document.querySelectorAll('a[href*="/house-prices/details/"]:not([href*="track=true"])');

    for (const link of cardLinks) {
      const href = link.getAttribute('href') || '';
      const uuidMatch = href.match(/\/details\/([a-f0-9-]+)/);
      const uuid = uuidMatch ? uuidMatch[1] : '';
      if (!uuid) continue;

      // Address is in the H2 element
      const address = link.querySelector('h2')?.textContent?.trim() || '';
      if (!address) continue;

      // Property category chips: div[class*="_propertyCategory_"]
      // These contain values like "Flat", "1" (bedrooms), "Leasehold", "Freehold", "Detached", etc.
      const chips = link.querySelectorAll('div[class*="_propertyCategory_"]');
      let propertyType: string | null = null;
      let tenure: string | null = null;
      let bedrooms: number | null = null;

      const propertyTypes = ['Flat', 'Detached', 'Semi-Detached', 'Semi Detached', 'Terraced', 'Other'];
      const tenureTypes = ['Leasehold', 'Freehold'];

      for (const chip of chips) {
        const text = chip.textContent?.trim() || '';
        if (propertyTypes.includes(text)) {
          propertyType = text;
        } else if (tenureTypes.includes(text)) {
          tenure = text;
        } else if (/^\d+$/.test(text)) {
          bedrooms = parseInt(text, 10);
        }
      }

      // Transactions from the table within THIS card link
      const table = link.querySelector('table');
      const transactions: { price: string; dateSold: string; displayPrice: string }[] = [];

      if (table) {
        const rows = table.querySelectorAll('tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length < 2) continue;

          const dateText = cells[0]?.textContent?.trim() || '';
          // Skip the "Today" row which has the "See what it's worth now" link
          if (dateText === 'Today') continue;

          // Price is in a div with aria-label, or just the cell text
          const priceDiv = cells[1]?.querySelector('div[aria-label]');
          const priceText = priceDiv
            ? priceDiv.getAttribute('aria-label')?.replace('.', '') || ''
            : cells[1]?.textContent?.trim() || '';

          if (dateText && priceText.startsWith('£')) {
            transactions.push({ price: priceText, dateSold: dateText, displayPrice: priceText });
          }
        }
      }

      // Detail URL - use the href directly (it's already absolute from Rightmove)
      const detailUrl = href.startsWith('http') ? href : `https://www.rightmove.co.uk${href}`;

      results.push({
        uuid,
        address,
        propertyType,
        tenure,
        bedrooms,
        detailUrl,
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
    // The pagination uses dsrm_pagination class with a "Next" button
    const nextBtn = document.querySelector('.dsrm_pagination button');
    if (!nextBtn) return false;
    // Find the button that says "Next" and is not disabled
    const buttons = document.querySelectorAll('.dsrm_pagination button');
    for (const btn of buttons) {
      if (btn.textContent?.includes('Next') && !btn.hasAttribute('disabled')) {
        return true;
      }
    }
    return false;
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
      const url = buildListUrl(area.slug, pageNum);
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
