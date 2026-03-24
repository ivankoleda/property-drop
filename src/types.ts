export interface Area {
  id: number;
  name: string;
  slug: string;
  rightmove_id: string;
  enabled: number;
  last_scraped: string | null;
  max_pages: number;
}

export interface Property {
  id: number;
  uuid: string;
  area_id: number;
  address: string;
  property_type: string | null;
  tenure: string | null;
  bedrooms: number | null;
  detail_url: string;
  visited: number;
  screenshot_key: string | null;
  created_at: string;
}

export interface Transaction {
  id: number;
  property_id: number;
  price: number; // pence
  date_sold: string; // YYYY-MM-DD
  display_price: string | null;
  source: string;
  created_at: string;
}

export interface QueueItem {
  id: number;
  property_id: number;
  score: number;
  drop_amount: number; // pence (nominal)
  drop_pct: number;    // nominal
  adj_drop_amount: number; // pence (inflation-adjusted)
  adj_drop_pct: number;    // inflation-adjusted
  prev_price: number; // pence
  curr_price: number; // pence
  prev_date: string | null;
  curr_date: string | null;
  status: string;
  tweet_id: string | null;
  posted_at: string | null;
  created_at: string;
}

export interface QueueItemWithProperty extends QueueItem {
  address: string;
  property_type: string | null;
  tenure: string | null;
  detail_url: string;
  screenshot_key: string | null;
  postcode: string | null;
}

export interface ScrapedProperty {
  uuid: string;
  address: string;
  propertyType: string | null;
  tenure: string | null;
  bedrooms: number | null;
  detailUrl: string;
  transactions: ScrapedTransaction[];
}

export interface ScrapedTransaction {
  price: number; // pence
  dateSold: string; // YYYY-MM-DD
  displayPrice: string;
}

export interface Poster {
  post(item: QueueItemWithProperty, screenshots: Buffer[]): Promise<string>; // returns tweet_id
}
