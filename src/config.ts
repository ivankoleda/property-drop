import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function getWranglerOAuthToken(): string {
  // Read fresh token from wrangler's config (auto-refreshed by wrangler CLI)
  const configPath = join(homedir(), 'Library/Preferences/.wrangler/config/default.toml');
  if (!existsSync(configPath)) {
    return required('CF_API_TOKEN');
  }
  const content = readFileSync(configPath, 'utf-8');
  const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!match) {
    return required('CF_API_TOKEN');
  }
  return match[1];
}

export const config = {
  cf: {
    accountId: process.env.CF_ACCOUNT_ID || '4f604612919b2e9aafa45eb97eba5c2c',
    get apiToken() { return getWranglerOAuthToken(); },
    d1DatabaseId: process.env.CF_D1_DATABASE_ID || '3544ef05-37ec-440a-aace-0d4f97387aa2',
    r2BucketName: process.env.CF_R2_BUCKET_NAME || 'property-drop-bot',
  },
  twitter: {
    get appKey() { return required('TWITTER_APP_KEY'); },
    get appSecret() { return required('TWITTER_APP_SECRET'); },
    get accessToken() { return required('TWITTER_ACCESS_TOKEN'); },
    get accessSecret() { return required('TWITTER_ACCESS_SECRET'); },
  },
  bot: {
    postSchedule: process.env.POST_SCHEDULE || '0 8,18 * * *',
    dailyPostCap: parseInt(process.env.DAILY_POST_CAP || '10', 10),
  },
  scraper: {
    pageDelayMin: 2000,
    pageDelayMax: 5000,
    screenshotDelayMin: 3000,
    screenshotDelayMax: 8000,
    maxScreenshotsPerRun: 9999,
  },
} as const;

export function randomDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}
