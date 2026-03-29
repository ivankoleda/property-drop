import { config } from './config.js';
import { inflationAdjustedPrice } from './scorer.js';

const D1 = `https://api.cloudflare.com/client/v4/accounts/${config.cf.accountId}/d1/database/${config.cf.d1DatabaseId}`;
const headers = { 'Authorization': `Bearer ${config.cf.apiToken}`, 'Content-Type': 'application/json' };

async function query(sql: string, params: unknown[] = []) {
  const res = await fetch(`${D1}/query`, { method: 'POST', headers, body: JSON.stringify({ sql, params }) });
  const data = await res.json() as any;
  if (!data.success) throw new Error(`D1 error: ${JSON.stringify(data.errors)}`);
  return data.result[0].results;
}

async function main() {
  // Get all freehold properties in Croydon (CR) and East London (E postcodes) with 2+ transactions
  const properties = await query(`
    SELECT p.id, p.uuid, p.address, p.detail_url
    FROM properties p
    WHERE p.tenure = 'Freehold'
      AND (p.address LIKE '%CR0%' OR p.address LIKE '%CR2%' OR p.address LIKE '%CR7%' OR p.address LIKE '%CR9%'
        OR p.address LIKE '%, E1 %' OR p.address LIKE '%, E3 %' OR p.address LIKE '%, E4 %'
        OR p.address LIKE '%, E5 %' OR p.address LIKE '%, E6 %' OR p.address LIKE '%, E7 %'
        OR p.address LIKE '%, E8 %' OR p.address LIKE '%, E9 %'
        OR p.address LIKE '%E10 %' OR p.address LIKE '%E11 %' OR p.address LIKE '%E12 %'
        OR p.address LIKE '%E13 %' OR p.address LIKE '%E15 %' OR p.address LIKE '%E16 %' OR p.address LIKE '%E17 %')
      AND (SELECT COUNT(*) FROM transactions t WHERE t.property_id = p.id) >= 2
  `);

  console.log(`Found ${properties.length} freehold properties in Croydon/East London with 2+ sales\n`);

  // Get all their transactions
  const allTx = await query(`
    SELECT t.property_id, t.price, t.date_sold, t.display_price
    FROM transactions t
    WHERE t.property_id IN (${properties.map((p: any) => p.id).join(',')})
    ORDER BY t.property_id, t.date_sold DESC
  `);

  // Group by property
  const txByProp = new Map<number, any[]>();
  for (const tx of allTx as any[]) {
    if (!txByProp.has(tx.property_id)) txByProp.set(tx.property_id, []);
    txByProp.get(tx.property_id)!.push(tx);
  }

  // Find stagnant ones: minimal nominal growth OR inflation-adjusted loss
  interface Result {
    address: string;
    url: string;
    uuid: string;
    currPrice: number;
    prevPrice: number;
    currDate: string;
    prevDate: string;
    nominalGrowthPct: number;
    adjLossPct: number; // positive = loss in real terms
  }

  const results: Result[] = [];

  for (const prop of properties as any[]) {
    const txs = txByProp.get(prop.id);
    if (!txs || txs.length < 2) continue;

    const curr = txs[0]; // most recent
    const prev = txs[1]; // previous

    // Skip if most recent sale is before 2024
    if (curr.date_sold < '2024-01-01') continue;

    const nominalGrowth = ((curr.price - prev.price) / prev.price) * 100;

    // Inflation adjusted: what was prev price worth in today's money?
    const adjPrevPrice = inflationAdjustedPrice(prev.price, prev.date_sold, curr.date_sold);
    const adjLossPct = ((adjPrevPrice - curr.price) / adjPrevPrice) * 100;

    // Stagnant = less than 10% nominal growth (barely beat inflation, or didn't)
    if (nominalGrowth < 10) {
      results.push({
        address: prop.address,
        url: prop.detail_url,
        uuid: prop.uuid,
        currPrice: curr.price / 100,
        prevPrice: prev.price / 100,
        currDate: curr.date_sold,
        prevDate: prev.date_sold,
        nominalGrowthPct: Math.round(nominalGrowth * 10) / 10,
        adjLossPct: Math.round(adjLossPct * 10) / 10,
      });
    }
  }

  // Sort by inflation-adjusted loss (biggest real loss first)
  results.sort((a, b) => b.adjLossPct - a.adjLossPct);

  console.log(`Found ${results.length} stagnant/losing freeholds (sold 2024+, <10% nominal growth)\n`);
  console.log('=== NOMINAL DROPS (sold for less) ===\n');

  const drops = results.filter(r => r.nominalGrowthPct < 0);
  for (const r of drops) {
    console.log(`  £${r.currPrice.toLocaleString()} (${r.currDate}) vs £${r.prevPrice.toLocaleString()} (${r.prevDate})`);
    console.log(`  Nominal: ${r.nominalGrowthPct}% | Inflation-adj loss: ${r.adjLossPct}%`);
    console.log(`  ${r.address}`);
    console.log(`  ${r.url}\n`);
  }

  console.log(`\n=== INFLATION-ADJUSTED LOSSES (price up, but lost to inflation) ===\n`);

  const inflationLosses = results.filter(r => r.nominalGrowthPct >= 0 && r.adjLossPct > 0);
  for (const r of inflationLosses.slice(0, 30)) {
    console.log(`  £${r.currPrice.toLocaleString()} (${r.currDate}) vs £${r.prevPrice.toLocaleString()} (${r.prevDate})`);
    console.log(`  Nominal: +${r.nominalGrowthPct}% | Real loss: ${r.adjLossPct}%`);
    console.log(`  ${r.address}`);
    console.log(`  ${r.url}\n`);
  }

  console.log(`\nSummary: ${drops.length} nominal drops, ${inflationLosses.length} inflation-only losses`);
}

main().catch(console.error);
