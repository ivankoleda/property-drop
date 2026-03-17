import { TwitterApi } from 'twitter-api-v2';
import { config } from './config.js';
import type { Poster, QueueItemWithProperty } from './types.js';

function formatPounds(pence: number): string {
  return `\u00A3${(pence / 100).toLocaleString('en-GB')}`;
}

function formatDate(date: string | null): string {
  if (!date) return 'Unknown';
  const d = new Date(date);
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

export function buildTweet(item: QueueItemWithProperty): { main: string; reply: string } {
  const parts = [
    `\u{1F4C9} ${item.address}`,
  ];

  const meta: string[] = [];
  if (item.property_type) meta.push(item.property_type);
  if (item.tenure) meta.push(item.tenure);
  if (meta.length > 0) parts.push(meta.join(' \u00B7 '));

  parts.push('');
  parts.push(`Sold: ${formatPounds(item.curr_price)} (${formatDate(item.curr_date)})`);
  parts.push(`Was: ${formatPounds(item.prev_price)} (${formatDate(item.prev_date)})`);
  parts.push(`Drop: ${item.drop_pct}% (-${formatPounds(item.drop_amount)})`);
  parts.push('');
  parts.push('#PropertyDrop #London #NewBuild');

  const main = parts.join('\n');
  const reply = `Full sale history: ${item.detail_url}`;

  return { main, reply };
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

  async post(item: QueueItemWithProperty, screenshot: Buffer): Promise<string> {
    const { main, reply } = buildTweet(item);

    // Upload media
    const mediaId = await this.client.v1.uploadMedia(screenshot, { mimeType: 'image/png' });

    // Post main tweet with image
    const tweet = await this.client.v2.tweet(main, {
      media: { media_ids: [mediaId] },
    });

    const tweetId = tweet.data.id;

    // Self-reply with link
    await this.client.v2.reply(reply, tweetId);

    return tweetId;
  }
}
