import { readFileSync } from 'fs';
import { calculateDrop } from './src/scorer.js';
import type { Transaction } from './src/types.js';

const data = JSON.parse(readFileSync('test-results.json', 'utf-8'));

console.log('=== Scoring test results ===\n');

let queued = 0;
for (const prop of data) {
  if (prop.transactions.length < 2) continue;

  // Convert to Transaction format
  const transactions: Transaction[] = prop.transactions.map((t: any, i: number) => ({
    id: i,
    property_id: 0,
    price: t.pricePence,
    date_sold: t.dateSold,
    display_price: t.displayPrice,
    source: 'list',
    created_at: '',
  }));

  const drop = calculateDrop(transactions);
  if (drop) {
    queued++;
    console.log(`${prop.address}`);
    console.log(`  ${prop.propertyType || '?'} | ${prop.tenure || '?'}`);
    console.log(`  ${drop.prevDate}: £${(drop.prevPrice / 100).toLocaleString()}`);
    console.log(`  ${drop.currDate}: £${(drop.currPrice / 100).toLocaleString()}`);
    console.log(`  Drop: ${drop.dropPct}% (-£${(drop.dropAmount / 100).toLocaleString()})`);
    console.log(`  Score: ${drop.score.toFixed(1)}`);
    console.log('');
  }
}

console.log(`Total: ${queued} properties would be queued for posting`);
