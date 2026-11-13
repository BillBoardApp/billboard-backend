import { fetchWithTimeout, redactUrl } from "./http";
import type { SenateClass, SenateSeat } from "./senateTerms";

/**
 * REL-52: the Senate's own list of the 100 current senators, the one source that says which class each senator's seat
 * is in (congress.gov does not). One <member> per senator, with <state> (postal code), <class> ("Class I", "Class II"
 * or "Class III") and <bioguide_id>. CongressMemberSummarizer reads it once per execution environment for a few hours
 * (cachedLoader) and merges a current senator's terms by it (senateTerms.ts).
 */
export const SENATORS_XML_URL = "https://www.senate.gov/general/contact_information/senators_cfm.xml";

const DEFAULT_USER_AGENT = "BillBoardFetcher/1.0 (+https://billboard-project.com/privacy.html)";
const DEFAULT_TIMEOUT_MS = 4000;

const CLASS_BY_ROMAN: Readonly<Record<string, SenateClass>> = { I: 1, II: 2, III: 3 };

const decodeXmlText = (value: string): string =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();

const elementText = (block: string, name: string): string | null => {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match ? decodeXmlText(match[1]) : null;
};

/**
 * Seats by bioguide ID from the list's XML. A <member> without a bioguide ID, a two-letter state or a class of I, II or
 * III is skipped.
 */
export const parseSenatorsXml = (xml: string): Map<string, SenateSeat> => {
  const seats = new Map<string, SenateSeat>();
  for (const match of xml.matchAll(/<member(?:\s[^>]*)?>([\s\S]*?)<\/member>/gi)) {
    const block = match[1];
    const bioguideId = elementText(block, "bioguide_id")?.toUpperCase() ?? "";
    const stateCode = elementText(block, "state")?.toUpperCase() ?? "";
    const roman = elementText(block, "class")
      ?.match(/^class\s+(I{1,3})$/i)?.[1]
      ?.toUpperCase();
    const senateClass = roman ? CLASS_BY_ROMAN[roman] : undefined;
    if (!/^[A-Z]\d{6}$/.test(bioguideId) || !/^[A-Z]{2}$/.test(stateCode) || !senateClass) continue;
    seats.set(bioguideId, { senateClass, stateCode });
  }
  return seats;
};

export interface FetchSenateSeatsOptions {
  url?: string;
  timeoutMs?: number;
}

/** Reads and parses the list. Throws on a network error, a timeout, a status other than 2xx, or a list with no seat. */
export const fetchSenateSeats = async ({
  url = SENATORS_XML_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: FetchSenateSeatsOptions = {}): Promise<Map<string, SenateSeat>> => {
  // The timeout covers the body too, so it is read inside it.
  const response = await fetchWithTimeout(
    url,
    { method: "GET", headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "application/xml, text/xml" } },
    timeoutMs,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The Senate's list of senators answered ${response.status} (${redactUrl(url)})`);
  }
  const seats = parseSenatorsXml(await response.text());
  if (seats.size === 0) throw new Error(`The Senate's list of senators held no seat (${redactUrl(url)})`);
  return seats;
};

export interface CachedLoaderOptions {
  /** How long a list that was read is used. */
  ttlMs: number;
  /** How long after a failed read the next one is tried; meanwhile callers get null at once. */
  retryAfterMs: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

/**
 * Wraps `load` so concurrent and later callers share one read: a list is kept for `ttlMs`, and a failed read resolves
 * to null (never rejects) and is not tried again for `retryAfterMs`.
 */
export const cachedLoader = <T>(
  load: () => Promise<T>,
  { ttlMs, retryAfterMs, now = Date.now, onError }: CachedLoaderOptions,
): (() => Promise<T | null>) => {
  let cached: { promise: Promise<T | null>; expiresAt: number } | null = null;
  return () => {
    const startedAt = now();
    if (cached && cached.expiresAt > startedAt) return cached.promise;
    const promise: Promise<T | null> = load().catch((error: unknown) => {
      if (cached?.promise === promise) cached.expiresAt = now() + retryAfterMs;
      onError?.(error);
      return null;
    });
    cached = { promise, expiresAt: startedAt + ttlMs };
    return promise;
  };
};
