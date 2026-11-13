export const BILL_PRIORITY_TABLE_NAME = "BillPriority";
export const BILL_PRIORITY_TABLE_PARTITION_KEY = "guid";
export const BILL_PRIORITY_ACTIVE_INDEX_NAME = "PriorityStatusIndex";
export const BILL_PRIORITY_STATUS_ATTRIBUTE = "status";
export const BILL_PRIORITY_SORT_KEY_ATTRIBUTE = "prioritySortKey";
export const BILL_PRIORITY_ACTIVE_STATUS = "ACTIVE";

// LLM-11: room for one Bedrock call (aborted at BILL_PRIORITY_BEDROCK_CALL_TIMEOUT_MS) after the feed and
// manifest reads, plus throttle retries. Nothing waits on the run: it is scheduled, with no queue.
export const BILL_PRIORITY_RESOLVER_TIMEOUT_SECONDS = 120;
export const BILL_PRIORITY_BEDROCK_CALL_TIMEOUT_MS = 75000;
export const BILL_PRIORITY_RESOLVER_MEMORY_MB = 512;
export const BILL_PRIORITY_RESOLVER_SCHEDULE_EXPRESSION = "cron(0 6-23 ? * * *)";
export const BILL_PRIORITY_RESOLVER_SCHEDULE_TIMEZONE = "America/New_York";

export const BILL_PRIORITY_LOOKBACK_DAYS = 7;
export const BILL_PRIORITY_MAX_CANDIDATE_BILLS = 50;
export const BILL_PRIORITY_MAX_HEADLINES = 30;
export const BILL_PRIORITY_MAX_PRIORITY_RESULTS = 8;
// On Haiku 5.5 thinking counts toward it, and its tokenizer counts about 30% more tokens for the same text.
export const BILL_PRIORITY_MAX_OUTPUT_TOKENS = 4096;
export const BILL_PRIORITY_HEADLINE_MAX_AGE_HOURS = 48;
export const BILL_PRIORITY_DEFAULT_DURATION_HOURS = 12;
export const BILL_PRIORITY_MIN_SCORE = 75;
export const BILL_PRIORITY_MIN_CONFIDENCE = 0.55;

// REL-51: the resolver reads the short and official titles of the week's bills from their raw bills (raw-bills/ in
// the bill store), at most this many a run, most likely first, and starts no read after the budget (each read is
// also cut at 5 s), so the lookups leave the Bedrock call its 75 s inside the 120 s timeout. At about 17 bill changes
// a day (2026-10-29) a week's window holds about 120 rows of every type; past 200, the rest of a busier week is
// matched by Billboard's headline only. Reads run this many at a time, a raw bill over 2 MB alone (the resolver's
// TITLE_LARGE_BODY_BYTES), so a week of defense and omnibus texts stays inside BILL_PRIORITY_RESOLVER_MEMORY_MB; lower
// it if a run's Max Memory Used nears that (docs/RUNBOOK.md 22.6).
export const BILL_PRIORITY_MAX_TITLE_LOOKUPS = 200;
export const BILL_PRIORITY_TITLE_LOOKUP_BUDGET_MS = 15000;
export const BILL_PRIORITY_TITLE_LOOKUP_CONCURRENCY = 6;

const buildGoogleNewsSearchFeed = (query: string): string =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;

// LLM-09 (decision 2, feed A): one generic search of general Congress coverage. The second feed, a hard-coded
// search for government funding, shutdown, debt ceiling and immigration, was an editorial choice of topics
// and is gone; the resolver's prompt and thresholds are unchanged.
export const BILL_PRIORITY_NEWS_FEED_QUERIES: readonly string[] = [
  '(site:apnews.com OR site:reuters.com OR site:npr.org) (Congress OR House OR Senate) bill',
];

export const BILL_PRIORITY_NEWS_FEED_URLS: readonly string[] = BILL_PRIORITY_NEWS_FEED_QUERIES.map(buildGoogleNewsSearchFeed);
