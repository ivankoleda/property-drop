import type { Property, Transaction } from './types.js';

const SCORING_DEFAULTS = {
  minDropPence: 30_000_00, // £30k minimum nominal drop
  minDropPct: 5,           // 5% minimum nominal drop
  maxDropPct: 45, // >45% nominal drop is almost always conversion/data error
  minPricePence: 200_000_00, // £200k min last sale price
  minGapMonths: 3,
  minDiffPence: 1_000_00,
  recencyMonths: 9,
};

// Freehold: lower thresholds — smaller drops are still newsworthy for houses
const FREEHOLD_DEFAULTS = {
  ...SCORING_DEFAULTS,
  minDropPence: 5_000_00, // £5k minimum
  minDropPct: 1,          // 1% minimum
};

// ONS monthly CPI index values (D7BT series, 2015=100)
// Source: https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/d7bt/mm23
const CPI_MONTHLY: Record<string, number> = {
  '2000-01':71.9,'2000-02':72.2,'2000-03':72.3,'2000-04':72.6,'2000-05':72.8,'2000-06':72.9,'2000-07':72.5,'2000-08':72.5,'2000-09':73.1,'2000-10':73.1,'2000-11':73.2,'2000-12':73.2,
  '2001-01':72.6,'2001-02':72.7,'2001-03':73.0,'2001-04':73.4,'2001-05':74.0,'2001-06':74.1,'2001-07':73.6,'2001-08':73.9,'2001-09':74.1,'2001-10':73.9,'2001-11':73.8,'2001-12':74.0,
  '2002-01':73.7,'2002-02':73.8,'2002-03':74.1,'2002-04':74.4,'2002-05':74.6,'2002-06':74.6,'2002-07':74.4,'2002-08':74.6,'2002-09':74.8,'2002-10':74.9,'2002-11':74.9,'2002-12':75.2,
  '2003-01':74.7,'2003-02':75.0,'2003-03':75.3,'2003-04':75.5,'2003-05':75.5,'2003-06':75.4,'2003-07':75.3,'2003-08':75.6,'2003-09':75.9,'2003-10':76.0,'2003-11':75.9,'2003-12':76.2,
  '2004-01':75.8,'2004-02':76.0,'2004-03':76.1,'2004-04':76.4,'2004-05':76.6,'2004-06':76.6,'2004-07':76.4,'2004-08':76.6,'2004-09':76.7,'2004-10':76.9,'2004-11':77.0,'2004-12':77.4,
  '2005-01':77.0,'2005-02':77.2,'2005-03':77.5,'2005-04':77.8,'2005-05':78.1,'2005-06':78.1,'2005-07':78.2,'2005-08':78.4,'2005-09':78.6,'2005-10':78.7,'2005-11':78.7,'2005-12':78.9,
  '2006-01':78.5,'2006-02':78.8,'2006-03':78.9,'2006-04':79.4,'2006-05':79.9,'2006-06':80.1,'2006-07':80.0,'2006-08':80.4,'2006-09':80.5,'2006-10':80.6,'2006-11':80.8,'2006-12':81.3,
  '2007-01':80.6,'2007-02':81.0,'2007-03':81.4,'2007-04':81.6,'2007-05':81.8,'2007-06':82.0,'2007-07':81.5,'2007-08':81.8,'2007-09':81.9,'2007-10':82.3,'2007-11':82.5,'2007-12':83.0,
  '2008-01':82.4,'2008-02':83.0,'2008-03':83.4,'2008-04':84.0,'2008-05':84.6,'2008-06':85.2,'2008-07':85.1,'2008-08':85.7,'2008-09':86.1,'2008-10':85.9,'2008-11':85.8,'2008-12':85.5,
  '2009-01':84.9,'2009-02':85.6,'2009-03':85.8,'2009-04':86.0,'2009-05':86.4,'2009-06':86.7,'2009-07':86.7,'2009-08':87.0,'2009-09':87.1,'2009-10':87.2,'2009-11':87.5,'2009-12':88.0,
  '2010-01':87.8,'2010-02':88.2,'2010-03':88.7,'2010-04':89.2,'2010-05':89.4,'2010-06':89.5,'2010-07':89.3,'2010-08':89.8,'2010-09':89.8,'2010-10':90.0,'2010-11':90.3,'2010-12':91.2,
  '2011-01':91.3,'2011-02':92.0,'2011-03':92.2,'2011-04':93.2,'2011-05':93.4,'2011-06':93.3,'2011-07':93.3,'2011-08':93.8,'2011-09':94.4,'2011-10':94.5,'2011-11':94.6,'2011-12':95.1,
  '2012-01':94.6,'2012-02':95.1,'2012-03':95.4,'2012-04':96.0,'2012-05':95.9,'2012-06':95.5,'2012-07':95.6,'2012-08':96.1,'2012-09':96.5,'2012-10':97.0,'2012-11':97.2,'2012-12':97.6,
  '2013-01':97.1,'2013-02':97.8,'2013-03':98.1,'2013-04':98.3,'2013-05':98.5,'2013-06':98.3,'2013-07':98.3,'2013-08':98.7,'2013-09':99.1,'2013-10':99.1,'2013-11':99.2,'2013-12':99.6,
  '2014-01':99.0,'2014-02':99.5,'2014-03':99.7,'2014-04':100.1,'2014-05':100.0,'2014-06':100.2,'2014-07':99.9,'2014-08':100.2,'2014-09':100.3,'2014-10':100.4,'2014-11':100.1,'2014-12':100.1,
  '2015-01':99.3,'2015-02':99.5,'2015-03':99.7,'2015-04':99.9,'2015-05':100.1,'2015-06':100.2,'2015-07':100.0,'2015-08':100.3,'2015-09':100.2,'2015-10':100.3,'2015-11':100.3,'2015-12':100.3,
  '2016-01':99.5,'2016-02':99.8,'2016-03':100.2,'2016-04':100.2,'2016-05':100.4,'2016-06':100.6,'2016-07':100.6,'2016-08':100.9,'2016-09':101.1,'2016-10':101.2,'2016-11':101.4,'2016-12':101.9,
  '2017-01':101.4,'2017-02':102.1,'2017-03':102.5,'2017-04':102.9,'2017-05':103.3,'2017-06':103.3,'2017-07':103.2,'2017-08':103.8,'2017-09':104.1,'2017-10':104.2,'2017-11':104.6,'2017-12':104.9,
  '2018-01':104.4,'2018-02':104.9,'2018-03':105.0,'2018-04':105.4,'2018-05':105.8,'2018-06':105.8,'2018-07':105.8,'2018-08':106.5,'2018-09':106.6,'2018-10':106.7,'2018-11':107.0,'2018-12':107.1,
  '2019-01':106.3,'2019-02':106.8,'2019-03':107.0,'2019-04':107.6,'2019-05':107.9,'2019-06':107.9,'2019-07':107.9,'2019-08':108.4,'2019-09':108.5,'2019-10':108.3,'2019-11':108.5,'2019-12':108.5,
  '2020-01':108.2,'2020-02':108.6,'2020-03':108.6,'2020-04':108.5,'2020-05':108.5,'2020-06':108.6,'2020-07':109.1,'2020-08':108.6,'2020-09':109.1,'2020-10':109.1,'2020-11':108.9,'2020-12':109.2,
  '2021-01':109.0,'2021-02':109.1,'2021-03':109.4,'2021-04':110.1,'2021-05':110.8,'2021-06':111.3,'2021-07':111.3,'2021-08':112.1,'2021-09':112.4,'2021-10':113.6,'2021-11':114.5,'2021-12':115.1,
  '2022-01':114.9,'2022-02':115.8,'2022-03':117.1,'2022-04':120.0,'2022-05':120.8,'2022-06':121.8,'2022-07':122.5,'2022-08':123.1,'2022-09':123.8,'2022-10':126.2,'2022-11':126.7,'2022-12':127.2,
  '2023-01':126.4,'2023-02':127.9,'2023-03':128.9,'2023-04':130.4,'2023-05':131.3,'2023-06':131.5,'2023-07':130.9,'2023-08':131.3,'2023-09':132.0,'2023-10':132.0,'2023-11':131.7,'2023-12':132.2,
  '2024-01':131.5,'2024-02':132.3,'2024-03':133.0,'2024-04':133.5,'2024-05':133.9,'2024-06':134.1,'2024-07':133.8,'2024-08':134.3,'2024-09':134.2,'2024-10':135.0,'2024-11':135.1,'2024-12':135.6,
  '2025-01':135.4,'2025-02':136.0,'2025-03':136.5,'2025-04':138.2,'2025-05':138.4,'2025-06':138.9,'2025-07':139.0,'2025-08':139.3,'2025-09':139.3,'2025-10':139.8,'2025-11':139.5,'2025-12':140.1,
  '2026-01':139.5,
};

function getCPIIndex(date: string): number {
  const d = new Date(date);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (CPI_MONTHLY[key]) return CPI_MONTHLY[key];
  // Fallback: use latest available
  return CPI_MONTHLY['2026-01'];
}

/**
 * Adjust a price from one date to another using exact ONS monthly CPI index.
 * Returns what `pricePence` at `fromDate` is worth in `toDate` money.
 */
export function inflationAdjustedPrice(pricePence: number, fromDate: string, toDate: string): number {
  const fromCPI = getCPIIndex(fromDate);
  const toCPI = getCPIIndex(toDate);
  if (fromCPI === 0) return pricePence;
  return Math.round(pricePence * (toCPI / fromCPI));
}

export interface DropResult {
  score: number;
  dropAmount: number;       // nominal drop in pence
  dropPct: number;          // nominal drop %
  adjDropAmount: number;    // inflation-adjusted drop in pence
  adjDropPct: number;       // inflation-adjusted drop %
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

export function calculateDrop(transactions: Transaction[], tenure?: string | null): DropResult | null {
  if (transactions.length < 2) return null;

  // --- Anomaly detection: filter out suspicious transaction histories ---

  // Too many transactions = commercial/investment churn, not genuine residential
  if (transactions.length > 5) return null;

  // Sort by date descending (most recent first)
  const sorted = [...transactions].sort(
    (a, b) => new Date(b.date_sold).getTime() - new Date(a.date_sold).getTime()
  );

  // Multiple sales within 2 years = likely entity transfers, not real sales
  const recentTxCount = sorted.filter(t => monthsSinceNow(t.date_sold) <= 24).length;
  if (recentTxCount > 2) return null;

  // Wild price volatility: if any consecutive pair swings >50% up then >30% down (or vice versa)
  // this suggests commercial trading, not residential market
  if (sorted.length >= 3) {
    for (let i = 0; i < sorted.length - 2; i++) {
      const a = sorted[i].price;
      const b = sorted[i + 1].price;
      const c = sorted[i + 2].price;
      const change1 = Math.abs(a - b) / Math.max(a, b);
      const change2 = Math.abs(b - c) / Math.max(b, c);
      // Both consecutive changes > 40% = erratic, not residential
      if (change1 > 0.4 && change2 > 0.4) return null;
    }
  }

  const curr = sorted[0];
  const prev = sorted[1];

  // Must be a drop
  if (curr.price >= prev.price) return null;

  const dropAmount = prev.price - curr.price;
  const dropPct = (dropAmount / prev.price) * 100;

  // --- Noise filters ---
  const thresholds = tenure === 'Freehold' ? FREEHOLD_DEFAULTS : SCORING_DEFAULTS;

  // Recency: most recent sale must be within N months
  if (monthsSinceNow(curr.date_sold) > thresholds.recencyMonths) return null;

  // Minimum drop thresholds
  if (dropAmount < thresholds.minDropPence) return null;
  if (dropPct < thresholds.minDropPct) return null;

  // Noise: suspiciously large drop (likely data error)
  if (dropPct > thresholds.maxDropPct) return null;

  // Noise: very cheap property
  if (curr.price < thresholds.minPricePence) return null;

  // Noise: too short between sales (likely entity transfer / commercial churn)
  // Minimum 2 years between sales for genuine residential transaction
  if (monthsBetween(prev.date_sold, curr.date_sold) < 24) return null;

  // Noise: trivially small difference
  if (dropAmount < SCORING_DEFAULTS.minDiffPence) return null;

  // --- Inflation adjustment ---
  // What the previous price would be worth in today's money
  const adjPrevPrice = inflationAdjustedPrice(prev.price, prev.date_sold, curr.date_sold);
  const adjDropAmount = adjPrevPrice - curr.price;
  const adjDropPct = (adjDropAmount / adjPrevPrice) * 100;

  // --- Scoring ---
  // Balance absolute drop and percentage so expensive properties don't dominate.
  // sqrt(dropAmount) dampens the absolute component — £1M drop scores ~3x a £100k drop (not 10x).
  // dropPct² heavily rewards high-percentage drops (30% scores 9x vs 10% at 1x).
  // Relatability: boost £300k-£800k (most Londoners' range), taper above £1.5M.
  //   £500k = 1.0x, £1M = 0.9x, £1.5M = 0.75x, £3M = 0.5x (floor)
  //
  // Score = sqrt(drop_pounds) * (dropPct/10)^2 * relatability * inflation_bonus * recency
  const pctWeight = (dropPct / 10) ** 2;
  const currPounds = curr.price / 100;
  const relatability = currPounds <= 800_000
    ? 1.0
    : Math.max(0.5, 1 - (currPounds - 800_000) / 4_000_000);
  const inflationBonus = 1 + Math.min(adjDropPct - dropPct, 30) / 100; // cap at +30% bonus
  const recencyMultiplier = Math.max(0.5, 1 - monthsSinceNow(curr.date_sold) / 24);
  const score = Math.sqrt(dropAmount / 100) * pctWeight * relatability * inflationBonus * recencyMultiplier;

  return {
    score,
    dropAmount,
    dropPct: Math.round(dropPct * 10) / 10,
    adjDropAmount,
    adjDropPct: Math.round(adjDropPct * 10) / 10,
    prevPrice: prev.price,
    currPrice: curr.price,
    prevDate: prev.date_sold,
    currDate: curr.date_sold,
  };
}

export async function scoreProperty(property: Property): Promise<DropResult | null> {
  const { getTransactionsForProperty, upsertQueueItem } = await import('./db.js');

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
      drop.currDate,
      drop.adjDropAmount,
      drop.adjDropPct
    );
  }

  return drop;
}

/**
 * Score a currently-listed property against its last sold price.
 * Simpler than calculateDrop — no recency filter (listing is current),
 * relaxed gap check, but same min thresholds and inflation adjustment.
 */
export function calculateListingDrop(
  listingPricePence: number,
  lastSoldPricePence: number,
  lastSoldDate: string,
): DropResult | null {
  if (listingPricePence >= lastSoldPricePence) return null;

  const dropAmount = lastSoldPricePence - listingPricePence;
  const dropPct = (dropAmount / lastSoldPricePence) * 100;

  // Min thresholds
  if (dropAmount < SCORING_DEFAULTS.minDropPence) return null;
  if (dropPct < SCORING_DEFAULTS.minDropPct) return null;
  if (dropPct > SCORING_DEFAULTS.maxDropPct) return null;
  if (listingPricePence < SCORING_DEFAULTS.minPricePence) return null;

  // Inflation adjustment: what was the sold price worth in today's money?
  const today = new Date().toISOString().slice(0, 10);
  const adjPrevPrice = inflationAdjustedPrice(lastSoldPricePence, lastSoldDate, today);
  const adjDropAmount = adjPrevPrice - listingPricePence;
  const adjDropPct = (adjDropAmount / adjPrevPrice) * 100;

  // Scoring — same formula as sold properties
  const pctWeight = (dropPct / 10) ** 2;
  const currPounds = listingPricePence / 100;
  const relatability = currPounds <= 800_000
    ? 1.0
    : Math.max(0.5, 1 - (currPounds - 800_000) / 4_000_000);
  const inflationBonus = 1 + Math.min(Math.max(adjDropPct - dropPct, 0), 30) / 100;
  // No recency decay — listings are current
  const score = Math.sqrt(dropAmount / 100) * pctWeight * relatability * inflationBonus;

  return {
    score,
    dropAmount,
    dropPct: Math.round(dropPct * 10) / 10,
    adjDropAmount,
    adjDropPct: Math.round(adjDropPct * 10) / 10,
    prevPrice: lastSoldPricePence,
    currPrice: listingPricePence,
    prevDate: lastSoldDate,
    currDate: today,
  };
}
