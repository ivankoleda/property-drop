import { config } from './config.js';

const D1 = `https://api.cloudflare.com/client/v4/accounts/${config.cf.accountId}/d1/database/${config.cf.d1DatabaseId}`;
const headers = { 'Authorization': `Bearer ${config.cf.apiToken}`, 'Content-Type': 'application/json' };

const CPI: Record<string, number> = {
  '2000':71.9,'2001':73.0,'2002':74.4,'2003':75.5,'2004':76.4,'2005':78.1,
  '2006':79.9,'2007':81.8,'2008':85.2,'2009':86.7,'2010':89.5,'2011':93.3,
  '2012':95.5,'2013':98.3,'2014':100.2,'2015':100.2,'2016':100.6,'2017':103.3,
  '2018':105.8,'2019':107.9,'2020':108.6,'2021':111.3,'2022':121.8,'2023':131.5,
  '2024':134.1,'2025':138.9,'2026':139.5
};

async function main() {
  const res = await fetch(`${D1}/query`, { method: 'POST', headers, body: JSON.stringify({
    sql: `SELECT p.id, t.price, t.date_sold FROM properties p
          JOIN transactions t ON t.property_id = p.id
          WHERE p.tenure = 'Freehold'
          AND (SELECT COUNT(*) FROM transactions t2 WHERE t2.property_id = p.id) >= 2
          ORDER BY p.id, t.date_sold DESC`
  })});
  const data = await res.json() as any;
  const rows = data.result[0].results;

  const byProp = new Map<number, any[]>();
  for (const r of rows) {
    if (!byProp.has(r.id)) byProp.set(r.id, []);
    byProp.get(r.id)!.push(r);
  }

  let nominalDrops = 0;
  let inflationDrops = 0;
  let inflationOnlyDrops = 0; // no nominal drop but inflation-adjusted drop

  for (const [, txs] of byProp) {
    if (txs.length < 2) continue;
    const curr = txs[0];
    const prev = txs[1];

    const isNominalDrop = curr.price < prev.price;
    if (isNominalDrop) nominalDrops++;

    const prevY = new Date(prev.date_sold).getFullYear().toString();
    const currY = new Date(curr.date_sold).getFullYear().toString();
    const adjPrevPrice = prev.price * ((CPI[currY] || 139.5) / (CPI[prevY] || 139.5));

    if (curr.price < adjPrevPrice) {
      inflationDrops++;
      if (!isNominalDrop) inflationOnlyDrops++;
    }
  }

  console.log(`Freehold properties with 2+ transactions: ${byProp.size}`);
  console.log(`Nominal drops (sold for less):            ${nominalDrops}`);
  console.log(`Inflation-adjusted drops (lost real value):${inflationDrops}`);
  console.log(`Inflation-only drops (price up but lost to inflation): ${inflationOnlyDrops}`);
}

main().catch(console.error);
