import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  cf: {
    accountId: required('CF_ACCOUNT_ID'),
    apiToken: required('CF_API_TOKEN'),
    d1DatabaseId: required('CF_D1_DATABASE_ID'),
    r2BucketName: process.env.CF_R2_BUCKET_NAME || 'property-drop-bot',
  },
  twitter: {
    appKey: required('TWITTER_APP_KEY'),
    appSecret: required('TWITTER_APP_SECRET'),
    accessToken: required('TWITTER_ACCESS_TOKEN'),
    accessSecret: required('TWITTER_ACCESS_SECRET'),
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
    maxScreenshotsPerRun: 20,
    minDropPence: 10_000_00, // £10k in pence
    minDropPct: 3,
    maxDropPct: 60,
    minPricePence: 50_000_00, // £50k in pence
    minGapMonths: 3,
    minDiffPence: 1_000_00, // £1k in pence
    recencyMonths: 9,
  },
} as const;

export function randomDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}
