import { config } from './config.js';

const R2_BASE = `https://api.cloudflare.com/client/v4/accounts/${config.cf.accountId}/r2/buckets/${config.cf.r2BucketName}/objects`;

export async function uploadScreenshot(key: string, data: Buffer): Promise<void> {
  const res = await fetch(`${R2_BASE}/${key}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${config.cf.apiToken}`,
      'Content-Type': 'image/png',
    },
    body: new Uint8Array(data),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 upload failed (${res.status}): ${text}`);
  }
}

export async function getScreenshot(key: string): Promise<Buffer> {
  const res = await fetch(`${R2_BASE}/${key}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${config.cf.apiToken}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 fetch failed (${res.status}): ${text}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
