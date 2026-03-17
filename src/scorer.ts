import { config } from './config.js';
import { getTransactionsForProperty, upsertQueueItem } from './db.js';
import type { Property, Transaction } from './types.js';

interface DropResult {
  score: number;
  dropAmount: number;
  dropPct: number;
  prevPrice: number;
  currPrice: number;
  prevDate: string;
  currDate: string;
}

function monthsBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.abs((b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()));
}

function monthsSinceNow(date: string): number {
  const d = new Date(date);
  const now = new Date();
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
}

export function calculateDrop(transactions: Transaction[]): DropResult | null {
  if (transactions.length < 2) return null;

  // Sort by date descending (most recent first)
  const sorted = [...transactions].sort(
    (a, b) => new Date(b.date_sold).getTime() - new Date(a.date_sold).getTime()
  );

  const curr = sorted[0];
  const prev = sorted[1];

  // Must be a drop
  if (curr.price >= prev.price) return null;

  const dropAmount = prev.price - curr.price;
  const dropPct = (dropAmount / prev.price) * 100;

  // --- Noise filters ---

  // Recency: most recent sale must be within N months
  if (monthsSinceNow(curr.date_sold) > config.scraper.recencyMonths) return null;

  // Minimum drop thresholds
  if (dropAmount < config.scraper.minDropPence) return null;
  if (dropPct < config.scraper.minDropPct) return null;

  // Noise: suspiciously large drop (likely data error)
  if (dropPct > config.scraper.maxDropPct) return null;

  // Noise: very cheap property
  if (curr.price < config.scraper.minPricePence) return null;

  // Noise: too short between sales (likely related party transfer)
  if (monthsBetween(prev.date_sold, curr.date_sold) < config.scraper.minGapMonths) return null;

  // Noise: trivially small difference
  if (dropAmount < config.scraper.minDiffPence) return null;

  // --- Scoring ---
  // score = absoluteDrop * pctMultiplier * recencyMultiplier
  const pctMultiplier = 1 + dropPct / 10; // 10% drop = 2x, 30% drop = 4x
  const recencyMultiplier = Math.max(0.5, 1 - monthsSinceNow(curr.date_sold) / 24); // more recent = higher

  const score = (dropAmount / 100) * pctMultiplier * recencyMultiplier; // drop in pounds * multipliers

  return {
    score,
    dropAmount,
    dropPct: Math.round(dropPct * 10) / 10,
    prevPrice: prev.price,
    currPrice: curr.price,
    prevDate: prev.date_sold,
    currDate: curr.date_sold,
  };
}

export async function scoreProperty(property: Property): Promise<DropResult | null> {
  const transactions = await getTransactionsForProperty(property.id);
  const drop = calculateDrop(transactions);

  if (drop) {
    await upsertQueueItem(
      property.id,
      drop.score,
      drop.dropAmount,
      drop.dropPct,
      drop.prevPrice,
      drop.currPrice,
      drop.prevDate,
      drop.currDate
    );
  }

  return drop;
}
