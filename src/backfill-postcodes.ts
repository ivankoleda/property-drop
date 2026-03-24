import { config } from './config.js';

const UK_POSTCODE_RE = /([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\s*$/i;

async function main() {
  const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${config.cf.accountId}/d1/database/${config.cf.d1DatabaseId}`;
  const headers = {
    'Authorization': `Bearer ${config.cf.apiToken}`,
    'Content-Type': 'application/json',
  };

  // Get all properties without postcode
  const res = await fetch(`${D1_BASE}/query`, {
    method: 'POST', headers,
    body: JSON.stringify({
      sql: 'SELECT id, address FROM properties WHERE postcode IS NULL',
      params: [],
    }),
  });
  const data = await res.json() as any;
  const rows = data.result[0].results as { id: number; address: string }[];
  console.log(`Found ${rows.length} properties without postcode`);

  let updated = 0;
  for (const row of rows) {
    const match = row.address.match(UK_POSTCODE_RE);
    if (match) {
      const postcode = match[1].toUpperCase().replace(/\s+/g, ' ');
      await fetch(`${D1_BASE}/query`, {
        method: 'POST', headers,
        body: JSON.stringify({
          sql: 'UPDATE properties SET postcode = ? WHERE id = ?',
          params: [postcode, row.id],
        }),
      });
      updated++;
    }
  }

  console.log(`Updated ${updated} postcodes`);
}

main().catch(console.error);
