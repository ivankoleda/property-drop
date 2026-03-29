import { TwitterApi } from 'twitter-api-v2';
import { config } from './config.js';
import type { Poster, QueueItemWithProperty } from './types.js';

function formatPoundsShort(pence: number): string {
  const pounds = Math.abs(pence / 100);
  if (pounds >= 1_000_000) return `${(pounds / 1_000_000).toFixed(1)}m`;
  if (pounds >= 1_000) return `${Math.round(pounds / 1_000)}k`;
  return String(Math.round(pounds));
}

function formatPoundsFull(pence: number): string {
  return `\u00A3${Math.round(pence / 100).toLocaleString('en-GB')}`;
}

function formatMonthYearShort(date: string | null): string {
  if (!date) return '';
  const d = new Date(date);
  const month = d.toLocaleString('en-GB', { month: 'short' });
  const year = d.getFullYear().toString().slice(-2);
  return `${month} ${year}`;
}

function formatYear(date: string | null): string {
  if (!date) return '';
  return new Date(date).getFullYear().toString();
}

export function buildTweet(item: QueueItemWithProperty): { main: string; reply: string | null } {
  const adjDropAmount = item.adj_drop_amount || item.drop_amount;

  // Calculate what the previous price is worth in today's money
  const adjPrevPriceRaw = item.curr_price + adjDropAmount;
  const adjPrevPrice = Math.round(adjPrevPriceRaw / 100000) * 100000; // round to nearest £1k in pence

  const prevYear = formatYear(item.prev_date);

  let line1: string;
  if (item.queue_type === 'listed') {
    line1 = `Currently listed for \u00A3${formatPoundsShort(item.curr_price)}`;
  } else {
    const currDateShort = formatMonthYearShort(item.curr_date);
    line1 = `Sold for \u00A3${formatPoundsShort(item.curr_price)}${currDateShort ? ` in ${currDateShort}` : ''}`;
  }

  const line2 = `Previously sold${prevYear ? ` in ${prevYear}` : ''} for \u00A3${formatPoundsShort(item.prev_price)} (\u00A3${formatPoundsShort(adjPrevPrice)} inflation adjusted)`;

  const url = item.listing_url || item.detail_url;
  const main = `${line1}\n${line2}\n\n${url}`;

  return { main, reply: null };
}

export class TwitterPoster implements Poster {
  private client: TwitterApi;

  constructor() {
    this.client = new TwitterApi({
      appKey: config.twitter.appKey,
      appSecret: config.twitter.appSecret,
      accessToken: config.twitter.accessToken,
      accessSecret: config.twitter.accessSecret,
    });
  }

  async post(item: QueueItemWithProperty, screenshots: Buffer[]): Promise<string> {
    const { main, reply } = buildTweet(item);

    // Upload media (up to 4 images per tweet)
    const mediaIds: string[] = [];
    for (const buf of screenshots.slice(0, 4)) {
      const mediaId = await this.client.v1.uploadMedia(buf, { mimeType: 'image/png' });
      mediaIds.push(mediaId);
    }

    // Post main tweet with images
    const tweet = await this.client.v2.tweet(main, {
      media: { media_ids: mediaIds as any },
    });

    const tweetId = tweet.data.id;

    // Self-reply with link (if provided)
    if (reply) {
      await this.client.v2.reply(reply, tweetId);
    }

    return tweetId;
  }
}
