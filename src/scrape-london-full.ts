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

interface AreaConfig { slug: string; county: string; }

const AREAS: AreaConfig[] = [
  // London boroughs
  ...['barking-and-dagenham','barnet','bexley','brent','bromley',
    'camden','city-of-london','croydon','ealing','enfield',
    'greenwich','hackney','hammersmith-and-fulham','haringey','harrow',
    'havering','hillingdon','hounslow','islington','kensington-and-chelsea',
    'kingston-upon-thames','lambeth','lewisham','merton','newham',
    'redbridge','richmond-upon-thames','southwark','sutton',
    'tower-hamlets','waltham-forest','wandsworth','westminster',
  ].map(s => ({ slug: s, county: 'London' })),

  // Essex outcodes
  ...['CM1','CM2','CM3','CM11','CM12','CM13','CM14','CM15',
    'SS0','SS1','SS2','SS3','SS4','SS5','SS6','SS7','SS8','SS9','SS11','SS12','SS13','SS14','SS15','SS16','SS17',
    'RM1','RM2','RM3','RM4','RM5','RM6','RM7','RM8','RM9','RM10','RM11','RM12','RM13','RM14','RM15','RM16','RM17','RM18','RM19','RM20',
    'IG1','IG2','IG3','IG4','IG5','IG6','IG7','IG8','IG9','IG10','IG11',
  ].map(s => ({ slug: s, county: 'Essex' })),

  // Kent outcodes
  ...['DA1','DA2','DA3','DA4','DA5','DA6','DA7','DA8','DA9','DA10','DA11','DA12','DA13','DA14','DA15','DA16','DA17','DA18',
    'BR1','BR2','BR3','BR4','BR5','BR6','BR7','BR8',
    'ME1','ME2','ME3','ME4','ME5','ME6','ME7','ME8','ME14','ME15','ME16','ME17','ME18','ME19','ME20',
    'TN1','TN2','TN3','TN4','TN9','TN10','TN11','TN12','TN13','TN14','TN15',
    'CT1','CT2','CT5','CT6',
  ].map(s => ({ slug: s, county: 'Kent' })),

  // Surrey outcodes
  ...['CR0','CR2','CR3','CR4','CR5','CR6','CR7','CR8',
    'GU1','GU2','GU3','GU4','GU5','GU7','GU8','GU9','GU10','GU12','GU15','GU16','GU18','GU21','GU22','GU23','GU24','GU25','GU27',
    'KT1','KT2','KT3','KT4','KT5','KT6','KT7','KT8','KT9','KT10','KT11','KT12','KT13','KT14','KT15','KT16','KT17','KT18','KT19','KT20','KT21','KT22','KT23','KT24',
    'RH1','RH2','RH3','RH4','RH5','RH6','RH7','RH8','RH9',
    'SM1','SM2','SM3','SM4','SM5','SM6','SM7',
    'TW1','TW2','TW3','TW4','TW5','TW7','TW8','TW9','TW10','TW11','TW12','TW13','TW14','TW15','TW16','TW17','TW18','TW19','TW20',
  ].map(s => ({ slug: s, county: 'Surrey' })),

  // Hertfordshire outcodes
  ...['AL1','AL2','AL3','AL4','AL5','AL6','AL7','AL8','AL9','AL10',
    'EN6','EN7','EN8','EN10','EN11',
    'HP1','HP2','HP3','HP4',
    'SG1','SG2','SG3','SG4','SG5','SG6','SG7','SG8','SG12','SG13','SG14',
    'WD3','WD4','WD5','WD6','WD7','WD17','WD18','WD19','WD23','WD24','WD25',
  ].map(s => ({ slug: s, county: 'Hertfordshire' })),

  // Berkshire outcodes
  ...['RG1','RG2','RG4','RG5','RG6','RG7','RG8','RG9','RG10','RG12','RG14','RG30','RG31','RG40','RG41','RG42','RG45',
    'SL0','SL1','SL2','SL3','SL4','SL5','SL6','SL7','SL8','SL9',
  ].map(s => ({ slug: s, county: 'Berkshire' })),
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

async function ensureArea(name: string, slug: string, county: string = 'London'): Promise<number> {
  const D1_BASE = getD1Base();
  const headers = getD1Headers();

  await fetch(`${D1_BASE}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({
      sql: `INSERT OR IGNORE INTO areas (name, slug, rightmove_id, max_pages, county) VALUES (?, ?, ?, 9999, ?)`,
      params: [name, slug, slug, county],
    }),
  });

  const res = await fetch(`${D1_BASE}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({ sql: `SELECT id FROM areas WHERE slug = ?`, params: [slug] }),
  });
  const data = await res.json() as any;
  if (!data.success || !data.result?.[0]?.results?.[0]) {
    try { execSync('npx wrangler d1 execute property-drop-bot --remote --command="SELECT 1"', { stdio: 'ignore' }); } catch {}
    lastTokenRefresh = Date.now();

    const freshHeaders = getD1Headers();
    await fetch(`${D1_BASE}/query`, {
      method: 'POST', headers: freshHeaders,
      body: JSON.stringify({
        sql: `INSERT OR IGNORE INTO areas (name, slug, rightmove_id, max_pages, county) VALUES (?, ?, ?, 9999, ?)`,
        params: [name, slug, slug, county],
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

async function worker(workerId: number, areas: AreaConfig[]): Promise<number> {
  let total = 0;
  for (const { slug, county } of areas) {
    await ensureFreshToken();
    const name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const areaId = await ensureArea(name, slug, county);
    const saved = await scrapeArea(workerId, slug, areaId);
    console.log(`  [W${workerId}] ${slug} (${county}) done: ${saved} properties`);
    total += saved;
    await randomDelay(2000, 4000);
  }
  return total;
}

async function main() {
  // Filter by county if arg provided: npx tsx src/scrape-london-full.ts Essex
  const countyFilter = process.argv[2];
  const areas = countyFilter
    ? AREAS.filter(a => a.county.toLowerCase() === countyFilter.toLowerCase())
    : AREAS;

  if (areas.length === 0) {
    console.log(`No areas found for county: ${countyFilter}`);
    console.log(`Available: ${[...new Set(AREAS.map(a => a.county))].join(', ')}`);
    process.exit(1);
  }

  const counties = [...new Set(areas.map(a => a.county))];
  console.log(`=== Scraping ${areas.length} areas (${counties.join(', ')}), ${WORKERS} workers ===`);
  console.log(`Cutoff: ${CUTOFF_DATE}\n`);

  // Distribute across workers
  const workerAreas: AreaConfig[][] = Array.from({ length: WORKERS }, () => []);
  areas.forEach((a, i) => workerAreas[i % WORKERS].push(a));

  const counts = await Promise.all(
    workerAreas.map((batch, i) => worker(i + 1, batch))
  );

  const total = counts.reduce((a, b) => a + b, 0);
  console.log(`\n=== Done: ${total} properties scraped across ${areas.length} areas ===`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
