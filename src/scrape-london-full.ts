import { chromium, type Page } from 'playwright';
import { execSync } from 'child_process';
import { randomDelay } from './config.js';
import { upsertProperty, upsertTransaction } from './db.js';
import { config } from './config.js';

// Wrangler OAuth tokens expire every hour. This refreshes it by running a trivial wrangler command.
let lastTokenRefresh = Date.now();
async function ensureFreshToken() {
  if (Date.now() - lastTokenRefresh > 45 * 60 * 1000) { // refresh every 45 min
    try {
      execSync('npx wrangler d1 execute property-drop-bot --remote --command="SELECT 1"', { stdio: 'ignore' });
      lastTokenRefresh = Date.now();
      console.log('  [token] Refreshed wrangler OAuth token');
    } catch { /* ignore */ }
  }
}

const WORKERS = 4;
const CUTOFF_DATE = '2025-01-01';

// London boroughs/areas to search — breaks the 1000 result limit
const LONDON_AREAS = [
  'barking-and-dagenham', 'barnet', 'bexley', 'brent', 'bromley',
  'camden', 'city-of-london', 'croydon', 'ealing', 'enfield',
  'greenwich', 'hackney', 'hammersmith-and-fulham', 'haringey', 'harrow',
  'havering', 'hillingdon', 'hounslow', 'islington', 'kensington-and-chelsea',
  'kingston-upon-thames', 'lambeth', 'lewisham', 'merton', 'newham',
  'redbridge', 'richmond-upon-thames', 'southwark', 'sutton',
  'tower-hamlets', 'waltham-forest', 'wandsworth', 'westminster',
];

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
  uuid: string; address: string; propertyType: string | null;
  tenure: string | null; bedrooms: number | null; hasImages: boolean;
  detailUrl: string;
  transactions: { price: number; dateSold: string; displayPrice: string }[];
}

async function scrapePage(page: Page, url: string): Promise<{ properties: ScrapedProp[]; hitCutoff: boolean }> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('a[href*="/house-prices/details/"]', { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(1500);

  const rawProps = await page.evaluate(() => {
    const results: any[] = [];
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
      let propertyType: string | null = null, tenure: string | null = null, bedrooms: number | null = null;
      for (const chip of chips) {
        const t = chip.textContent?.trim() || '';
        if (propTypes.includes(t)) propertyType = t;
        else if (tenureTypes.includes(t)) tenure = t;
        else if (/^\d+$/.test(t)) bedrooms = parseInt(t, 10);
      }

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

  const properties: ScrapedProp[] = rawProps.map((p: any) => ({
    ...p,
    transactions: p.transactions.map((t: any) => ({
      price: parsePrice(t.price),
      dateSold: parseDate(t.dateSold),
      displayPrice: t.price,
    })),
  }));

  let hitCutoff = false;
  for (const prop of properties) {
    if (prop.transactions.length > 0 && prop.transactions[0].dateSold < CUTOFF_DATE) {
      hitCutoff = true;
      break;
    }
  }

  return { properties, hitCutoff };
}

async function getAreaPageCount(page: Page, area: string): Promise<number> {
  const url = `https://www.rightmove.co.uk/house-prices/${area}.html?pageNumber=1&sortBy=DEED_DATE&sortOrder=DESC`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const totalPages = await page.evaluate(() => {
    const text = document.querySelector('.dsrm_pagination')?.textContent || '';
    const match = text.match(/of\s+(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  });
  return totalPages;
}

function getD1Headers() {
  return { 'Authorization': `Bearer ${config.cf.apiToken}`, 'Content-Type': 'application/json' };
}

function getD1Base() {
  return `https://api.cloudflare.com/client/v4/accounts/${config.cf.accountId}/d1/database/${config.cf.d1DatabaseId}`;
}

async function ensureArea(name: string, slug: string): Promise<number> {
  const D1_BASE = getD1Base();
  const headers = getD1Headers();

  await fetch(`${D1_BASE}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({
      sql: `INSERT OR IGNORE INTO areas (name, slug, rightmove_id, max_pages) VALUES (?, ?, ?, 9999)`,
      params: [name, slug, slug],
    }),
  });

  const res = await fetch(`${D1_BASE}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({ sql: `SELECT id FROM areas WHERE slug = ?`, params: [slug] }),
  });
  const data = await res.json() as any;
  if (!data.success || !data.result?.[0]?.results?.[0]) {
    // Token may have expired — force refresh and retry
    try { execSync('npx wrangler d1 execute property-drop-bot --remote --command="SELECT 1"', { stdio: 'ignore' }); } catch {}
    lastTokenRefresh = Date.now();

    const freshHeaders = getD1Headers();
    await fetch(`${D1_BASE}/query`, {
      method: 'POST', headers: freshHeaders,
      body: JSON.stringify({
        sql: `INSERT OR IGNORE INTO areas (name, slug, rightmove_id, max_pages) VALUES (?, ?, ?, 9999)`,
        params: [name, slug, slug],
      }),
    });
    const retry = await fetch(`${D1_BASE}/query`, {
      method: 'POST', headers: freshHeaders,
      body: JSON.stringify({ sql: `SELECT id FROM areas WHERE slug = ?`, params: [slug] }),
    });
    const retryData = await retry.json() as any;
    return retryData.result[0].results[0].id;
  }
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
        if (tx.price > 0) await upsertTransaction(propertyId, tx.price, tx.dateSold, tx.displayPrice);
      }
      saved++;
    } catch (err: any) {
      // skip silently
    }
  }
  return saved;
}

async function scrapeArea(workerId: number, area: string, areaId: number): Promise<number> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  const totalPages = await getAreaPageCount(page, area);
  console.log(`  [W${workerId}] ${area}: ${totalPages} pages`);

  let totalSaved = 0;
  const maxPages = Math.min(totalPages, 42); // cap at 42 (rightmove limit)

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    try {
      const url = `https://www.rightmove.co.uk/house-prices/${area}.html?pageNumber=${pageNum}&sortBy=DEED_DATE&sortOrder=DESC`;
      const { properties, hitCutoff } = await scrapePage(page, url);

      if (properties.length === 0) break;

      const saved = await saveBatch(properties, areaId);
      totalSaved += saved;

      if (pageNum % 5 === 0 || hitCutoff) {
        console.log(`  [W${workerId}] ${area} p${pageNum}: +${saved} (total ${totalSaved})${hitCutoff ? ' CUTOFF' : ''}`);
      }

      if (hitCutoff) break;
      await randomDelay(1500, 3000);
    } catch (err: any) {
      console.error(`  [W${workerId}] ${area} p${pageNum} error: ${err.message?.substring(0, 60)}`);
    }
  }

  await browser.close();
  return totalSaved;
}

async function worker(workerId: number, areas: string[]): Promise<number> {
  let total = 0;
  for (const area of areas) {
    await ensureFreshToken();
    const name = area.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const areaId = await ensureArea(name, area);
    const saved = await scrapeArea(workerId, area, areaId);
    console.log(`  [W${workerId}] ${area} done: ${saved} properties`);
    total += saved;
    await randomDelay(2000, 4000);
  }
  return total;
}

async function main() {
  console.log(`=== London full scrape by borough (${LONDON_AREAS.length} boroughs, ${WORKERS} workers) ===`);
  console.log(`Cutoff: ${CUTOFF_DATE}\n`);

  // Distribute boroughs across workers
  const workerAreas: string[][] = Array.from({ length: WORKERS }, () => []);
  LONDON_AREAS.forEach((a, i) => workerAreas[i % WORKERS].push(a));

  const counts = await Promise.all(
    workerAreas.map((areas, i) => worker(i + 1, areas))
  );

  const total = counts.reduce((a, b) => a + b, 0);
  console.log(`\n=== Done: ${total} properties scraped across ${LONDON_AREAS.length} boroughs ===`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
