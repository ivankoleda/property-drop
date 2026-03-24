import { chromium, type Page, type Browser } from 'playwright';
import { randomDelay } from './config.js';
import { upsertProperty, upsertTransaction } from './db.js';

const WORKERS = 4;
const CUTOFF_DATE = '2025-01-01';
const BASE_URL = 'https://www.rightmove.co.uk/house-prices/london.html';

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

interface ScrapedProp {
  uuid: string;
  address: string;
  propertyType: string | null;
  tenure: string | null;
  bedrooms: number | null;
  hasImages: boolean;
  detailUrl: string;
  transactions: { price: number; dateSold: string; displayPrice: string }[];
}

async function scrapePage(page: Page, pageNum: number): Promise<{ properties: ScrapedProp[]; hitCutoff: boolean }> {
  const url = `${BASE_URL}?pageNumber=${pageNum}&sortBy=DEED_DATE&sortOrder=DESC`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('a[href*="/house-prices/details/"]', { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(1500);

  const rawProps = await page.evaluate(() => {
    const results: {
      uuid: string; address: string; propertyType: string | null;
      tenure: string | null; bedrooms: number | null; detailUrl: string;
      hasImages: boolean;
      transactions: { price: string; dateSold: string }[];
    }[] = [];

    const links = document.querySelectorAll('a[href*="/house-prices/details/"]:not([href*="track=true"])');
    const propTypes = ['Flat', 'Detached', 'Semi-Detached', 'Semi Detached', 'Terraced', 'Other'];
    const tenureTypes = ['Leasehold', 'Freehold'];

    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const uuid = href.match(/\/details\/([a-f0-9-]+)/)?.[1] || '';
      if (!uuid) continue;

      const address = link.querySelector('h2')?.textContent?.trim() || '';
      if (!address) continue;

      const chips = link.querySelectorAll('div[class*="_propertyCategory_"]');
      let propertyType: string | null = null;
      let tenure: string | null = null;
      let bedrooms: number | null = null;

      for (const chip of chips) {
        const t = chip.textContent?.trim() || '';
        if (propTypes.includes(t)) propertyType = t;
        else if (tenureTypes.includes(t)) tenure = t;
        else if (/^\d+$/.test(t)) bedrooms = parseInt(t, 10);
      }

      // Check if property has images (the images chip shows photo count)
      const hasImages = !!link.querySelector('div[class*="_imagesChip_"], img[class*="_image_"]:not([class*="_pin_"])');

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

      results.push({
        uuid, address, propertyType, tenure, bedrooms, hasImages,
        detailUrl: href.startsWith('http') ? href : `https://www.rightmove.co.uk${href}`,
        transactions: txs,
      });
    }
    return results;
  });

  const properties: ScrapedProp[] = rawProps.map(p => ({
    ...p,
    transactions: p.transactions.map(t => ({
      price: parsePrice(t.price),
      dateSold: parseDate(t.dateSold),
      displayPrice: t.price,
    })),
  }));

  // Check if any property has its most recent transaction before cutoff
  let hitCutoff = false;
  for (const prop of properties) {
    if (prop.transactions.length > 0) {
      const mostRecent = prop.transactions[0].dateSold;
      if (mostRecent < CUTOFF_DATE) {
        hitCutoff = true;
        break;
      }
    }
  }

  return { properties, hitCutoff };
}

// Get or create the "London" area in D1
async function ensureLondonArea(): Promise<number> {
  const { config } = await import('./config.js');
  const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${config.cf.accountId}/d1/database/${config.cf.d1DatabaseId}`;

  const headers = {
    'Authorization': `Bearer ${config.cf.apiToken}`,
    'Content-Type': 'application/json',
  };

  // Insert London area if not exists
  await fetch(`${D1_BASE}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({
      sql: "INSERT OR IGNORE INTO areas (name, slug, rightmove_id, max_pages) VALUES ('London', 'london', 'london', 9999)",
      params: [],
    }),
  });

  const res = await fetch(`${D1_BASE}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({ sql: "SELECT id FROM areas WHERE slug = 'london'", params: [] }),
  });
  const data = await res.json() as any;
  return data.result[0].results[0].id;
}

async function saveBatch(properties: ScrapedProp[], areaId: number): Promise<number> {
  let saved = 0;
  for (const prop of properties) {
    try {
      const propertyId = await upsertProperty(
        prop.uuid, areaId, prop.address,
        prop.propertyType, prop.tenure, prop.bedrooms, prop.detailUrl, prop.hasImages
      );
      for (const tx of prop.transactions) {
        if (tx.price > 0) {
          await upsertTransaction(propertyId, tx.price, tx.dateSold, tx.displayPrice);
        }
      }
      saved++;
    } catch (err: any) {
      console.error(`    Error saving ${prop.address}: ${err.message}`);
    }
  }
  return saved;
}

async function worker(
  workerId: number,
  pages: number[],
  areaId: number,
  results: Map<number, { props: number; hitCutoff: boolean }>
): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    for (const pageNum of pages) {
      try {
        const { properties, hitCutoff } = await scrapePage(page, pageNum);
        const saved = await saveBatch(properties, areaId);
        console.log(`  [W${workerId}] Page ${pageNum}: ${properties.length} props, ${saved} saved${hitCutoff ? ' (HIT CUTOFF)' : ''}`);
        results.set(pageNum, { props: saved, hitCutoff });

        if (hitCutoff) break;
        await randomDelay(2000, 4000);
      } catch (err: any) {
        console.error(`  [W${workerId}] Page ${pageNum} error: ${err.message}`);
        results.set(pageNum, { props: 0, hitCutoff: false });
      }
    }
  } finally {
    await browser.close();
  }
}

async function getTotalPages(browser: Browser): Promise<number> {
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}?pageNumber=1&sortBy=DEED_DATE&sortOrder=DESC`, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(2000);

  const totalPages = await page.evaluate(() => {
    const text = document.querySelector('.dsrm_pagination')?.textContent || '';
    const match = text.match(/of\s+(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  });

  const totalResults = await page.evaluate(() => {
    const el = document.querySelector('[class*="numberOfResults"]');
    return el?.textContent?.trim() || '?';
  });

  await page.close();
  return totalPages;
}

async function main() {
  console.log('=== London full scrape (parallel, 4 workers) ===');
  console.log(`Cutoff: ${CUTOFF_DATE}`);

  // Get total pages
  const probe = await chromium.launch({ headless: true });
  const totalPages = await getTotalPages(probe);
  await probe.close();
  console.log(`Total pages: ${totalPages}`);

  const areaId = await ensureLondonArea();
  console.log(`Area ID: ${areaId}`);

  // Process in batches to check for cutoff
  const BATCH_SIZE = 20; // 20 pages per batch (5 per worker)
  const results = new Map<number, { props: number; hitCutoff: boolean }>();
  let totalSaved = 0;
  let reachedCutoff = false;

  for (let batchStart = 1; batchStart <= totalPages && !reachedCutoff; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, totalPages);
    const batchPages = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

    // Distribute pages across workers
    const workerPages: number[][] = Array.from({ length: WORKERS }, () => []);
    batchPages.forEach((p, i) => workerPages[i % WORKERS].push(p));

    console.log(`\nBatch: pages ${batchStart}-${batchEnd}`);

    await Promise.all(
      workerPages
        .filter(pages => pages.length > 0)
        .map((pages, i) => worker(i + 1, pages, areaId, results))
    );

    // Check results
    let batchSaved = 0;
    for (const pageNum of batchPages) {
      const r = results.get(pageNum);
      if (r) {
        batchSaved += r.props;
        if (r.hitCutoff) reachedCutoff = true;
      }
    }
    totalSaved += batchSaved;
    console.log(`Batch done: ${batchSaved} props saved (total: ${totalSaved})`);
  }

  console.log(`\n=== Scrape complete: ${totalSaved} properties saved ===`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
