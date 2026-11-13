import type { IncomingHttpHeaders } from "http";
import { redactUrl } from "../../shared/http";
import { logger } from "../../shared/logger";
import { isRetryableStatus, retryDelayMs, sleep as defaultSleep } from "../../shared/retry";

/**
 * Bill text XML from more than one source (REL-45).
 *
 * The api.congress.gov /text response names the newest text version's "Formatted XML" file on www.congress.gov.
 * Some FetchRawBill execution environments were refused (HTTP 403) on every such request while others got 200 on
 * every one, so the same file is also read from GovInfo, which publishes it under the same package id:
 *   https://www.congress.gov/119/bills/hr2739/BILLS-119hr2739ih.xml
 *   https://www.govinfo.gov/content/pkg/BILLS-119hr2739ih/xml/BILLS-119hr2739ih.xml
 * The order comes from BILL_XML_SOURCES ("govinfo,congress" by default; "congress" alone is the rollback switch).
 *
 * Each answer is classified:
 * - ok: a 200 whose body is bill XML (see inspectBillXmlBody) and that carries no cf-mitigated header;
 * - refused: 401 or 403, a challenge (cf-mitigated, or an HTML page, even with a 200), a 429 still failing after the
 *   in-process retries (detail "throttled"), a host in its refused cooldown, or the time budget used up;
 * - not_found: 404 or 410, or a redirect to an /error page: GovInfo answers a package it does not have (yet) with
 *   302 to https://www.govinfo.gov/error, not 404 (checked live on 2026-10-17);
 * - server_error: 5xx after the in-process retries;
 * - network: a network error or socket timeout after the in-process retries;
 * - invalid: an empty or non-XML 200, any other redirect (never followed), or any other status.
 * 429, 5xx and network errors get CONGRESS_API_MAX_RETRIES retries with full-jitter backoff; a refusal is never
 * retried on the same host, and a host that refused is skipped by this execution environment for the cooldown
 * (the refusals seen so far were sticky per environment, which is per egress IP).
 */

export type BillTextSource = "GovInfo" | "CongressGov";

export type SourceResultKind = "ok" | "refused" | "not_found" | "server_error" | "network" | "invalid";

/** What a stored raw bill's content.billXMLFetch says about its text. */
export type BillTextOutcome = SourceResultKind | "reused" | "carried" | "no_text_version" | "no_xml_format";

/** content.billXMLFetch on a raw bill: inert downstream (readers use billXML and the title only). */
export interface BillXmlFetchMarker {
  outcome: BillTextOutcome;
  /** The text version's package id (BILLS-119hr2739ih), or null when the URL has another shape. */
  versionStem: string | null;
  /** The source the stored text came from, when known. */
  source?: BillTextSource;
  /** Per source tried: the last HTTP status, or network, cooldown, budget. */
  statuses: Partial<Record<BillTextSource, number | string>>;
  at: string;
  /** With outcome "carried": what the fetch itself ended as. */
  fetchOutcome?: SourceResultKind;
  /** The delayed retry this fetch was (1 to BILL_TEXT_MAX_RETRIES); absent on the first fetch. */
  retryAttempt?: number;
  /** A delayed retry is sent after this copy is stored. */
  retryScheduled?: boolean;
}

export interface HttpTextResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface MetricDatum {
  name: string;
  value: number;
  dimensions?: Record<string, string>;
}

const SOURCE_NAMES: Readonly<Record<string, BillTextSource>> = { govinfo: "GovInfo", congress: "CongressGov" };
export const DEFAULT_BILL_XML_SOURCES: readonly BillTextSource[] = ["GovInfo", "CongressGov"];

/** BILL_XML_SOURCES ("govinfo,congress"): known names in order, once each; nothing usable means the default. */
export const parseBillXmlSources = (value: string | undefined): BillTextSource[] => {
  const sources: BillTextSource[] = [];
  for (const part of (value ?? "").split(",")) {
    const source = SOURCE_NAMES[part.trim().toLowerCase()];
    if (source && !sources.includes(source)) sources.push(source);
  }
  return sources.length > 0 ? sources : [...DEFAULT_BILL_XML_SOURCES];
};

/** A GPO bill text package id: congress, bill type, number and text version code (ih, enr, eh, is, ats, pcs...). */
export const BILL_VERSION_STEM_PATTERN = /^BILLS-\d{2,3}(?:hr|s|hjres|sjres|hconres|sconres|hres|sres)\d+[a-z]+$/;

/** The package id in a Formatted XML URL's file name (BILLS-119hr2739ih), or null for any other shape. */
export const billVersionStem = (xmlUrl: string): string | null => {
  let url: URL;
  try {
    url = new URL(xmlUrl);
  } catch {
    return null;
  }
  const basename = url.pathname.split("/").pop() ?? "";
  if (!basename.endsWith(".xml")) return null;
  const stem = basename.slice(0, -".xml".length);
  return BILL_VERSION_STEM_PATTERN.test(stem) ? stem : null;
};

export const govInfoBillXmlUrl = (stem: string): string =>
  `https://www.govinfo.gov/content/pkg/${stem}/xml/${stem}.xml`;

export interface BillTextRequest {
  source: BillTextSource;
  url: string;
}

/**
 * The requests for one text version, in `order`. The congress.gov URL is used as the API gave it; GovInfo's is built
 * from its package id. A URL of another shape is fetched from congress.gov only, as before.
 */
export const billTextRequests = (xmlUrl: string, order: readonly BillTextSource[]): BillTextRequest[] => {
  const stem = billVersionStem(xmlUrl);
  if (!stem) return [{ source: "CongressGov", url: xmlUrl }];
  return order.map((source) => ({ source, url: source === "GovInfo" ? govInfoBillXmlUrl(stem) : xmlUrl }));
};

/** The "Formatted XML" URL of the newest text version in a /text response, or why there is none. */
export const locateBillXmlUrl = (
  textData: unknown,
): { url: string } | { url?: undefined; missing: "no_text_version" | "no_xml_format" } => {
  const versions = (textData as { textVersions?: unknown } | null | undefined)?.textVersions;
  if (!Array.isArray(versions) || versions.length === 0) return { missing: "no_text_version" };
  const formats = (versions[0] as { formats?: unknown } | null)?.formats;
  const xmlFormat = Array.isArray(formats)
    ? (formats as Array<Record<string, unknown>>).find((format) => format?.type === "Formatted XML")
    : undefined;
  return typeof xmlFormat?.url === "string" && xmlFormat.url.length > 0
    ? { url: xmlFormat.url }
    : { missing: "no_xml_format" };
};

// ─── Classification ──────────────────────────────────────────────────────────

const headerValue = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : undefined;
};

const XML_STARTS = ["<?xml", "<!doctype", "<bill", "<resolution", "<amendment-doc"];

/**
 * What a 200's body is: "ok" for bill XML (after a BOM and whitespace it starts with <?xml, <!DOCTYPE, <bill,
 * <resolution or <amendment-doc, and has no <html in its first 2 KB), "challenge" for an HTML or challenge page
 * (a cf-mitigated header, a text/html content type or <html), "empty", or "not_xml".
 */
export const inspectBillXmlBody = (
  headers: IncomingHttpHeaders,
  body: string,
): "ok" | "challenge" | "empty" | "not_xml" => {
  if (headerValue(headers, "cf-mitigated")) return "challenge";
  if (/text\/html/i.test(headerValue(headers, "content-type") ?? "")) return "challenge";
  const text = body.replace(/^\uFEFF/, "").trimStart();
  if (text.trim().length === 0) return "empty";
  if (/<html[\s>]/i.test(text.slice(0, 2048))) return "challenge";
  const start = text.slice(0, 16).toLowerCase();
  return XML_STARTS.some((prefix) => start.startsWith(prefix)) ? "ok" : "not_xml";
};

export interface ClassifiedAnswer {
  kind: SourceResultKind;
  status: number;
  /**
   * ok, forbidden, challenge, throttled, not_found, error_redirect, server_error, empty, not_xml, redirect,
   * unexpected_status
   */
  detail: string;
}

/** A redirect whose Location (absolute or relative) has the path /error: GovInfo's answer for a missing package. */
const isErrorPageRedirect = (headers: IncomingHttpHeaders): boolean => {
  const location = headerValue(headers, "location");
  if (!location) return false;
  try {
    return /^\/error\/?$/i.test(new URL(location, "https://redirect.invalid").pathname);
  } catch {
    return false;
  }
};

/** The class of a final HTTP answer (after any in-process retries). */
export const classifyBillXmlResponse = (response: HttpTextResponse): ClassifiedAnswer => {
  const status = response.statusCode;
  if (status === 200) {
    const body = inspectBillXmlBody(response.headers, response.body);
    if (body === "ok") return { kind: "ok", status, detail: "ok" };
    if (body === "challenge") return { kind: "refused", status, detail: "challenge" };
    return { kind: "invalid", status, detail: body };
  }
  if (headerValue(response.headers, "cf-mitigated")) return { kind: "refused", status, detail: "challenge" };
  if (status === 401 || status === 403) return { kind: "refused", status, detail: "forbidden" };
  if (status === 429) return { kind: "refused", status, detail: "throttled" };
  if (status === 404 || status === 410) return { kind: "not_found", status, detail: "not_found" };
  if (status >= 500 && status <= 599) return { kind: "server_error", status, detail: "server_error" };
  if (status >= 300 && status <= 399) {
    // REL-45: GovInfo's miss, so a version on neither source ends not_found, not invalid (see FINAL_PRECEDENCE).
    if (isErrorPageRedirect(response.headers)) return { kind: "not_found", status, detail: "error_redirect" };
    return { kind: "invalid", status, detail: "redirect" };
  }
  return { kind: "invalid", status, detail: "unexpected_status" };
};

/** 429 and 5xx are retried in process, unless the answer is a challenge (those are sticky). */
const isRetryableAnswer = (response: HttpTextResponse): boolean =>
  isRetryableStatus(response.statusCode) && !headerValue(response.headers, "cf-mitigated");

// ─── Diagnostics ─────────────────────────────────────────────────────────────

const DIAGNOSTIC_HEADERS = ["server", "cf-ray", "cf-mitigated", "content-type", "retry-after"] as const;
const BODY_EXCERPT_CHARS = 300;
const SECRET_IN_TEXT = /\b(api_key|apikey|key|token|access_token)=[^&\s"'<>]*/gi;

/** The first 300 characters of a body, whitespace collapsed, with anything shaped like a key masked. */
export const bodyExcerpt = (body: string): string =>
  body
    .slice(0, 4 * BODY_EXCERPT_CHARS)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, BODY_EXCERPT_CHARS)
    .replace(SECRET_IN_TEXT, "$1=REDACTED");

/** The response headers worth logging on a refusal; never cookies. */
export const diagnosticHeaders = (headers: IncomingHttpHeaders): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADERS) {
    const value = headerValue(headers, name);
    if (value !== undefined) picked[name] = value;
  }
  return picked;
};

// ─── Time budget and the refused-host cooldown ───────────────────────────────

export interface TimeBudget {
  /** Milliseconds left; at or below 0 no new request starts. */
  left(): number;
}

/** Remaining Lambda time kept free of bill text requests. */
export const LAMBDA_TIME_MARGIN_MS = 15_000;

/** BILL_XML_FETCH_BUDGET_MS from now, and never closer than LAMBDA_TIME_MARGIN_MS to the Lambda's own timeout. */
export const timeBudget = ({
  budgetMs,
  remainingMs,
  now = Date.now,
}: {
  budgetMs: number;
  remainingMs?: () => number;
  now?: () => number;
}): TimeBudget => {
  const startedAt = now();
  return {
    left: () => {
      const own = budgetMs - (now() - startedAt);
      const lambda = remainingMs ? remainingMs() - LAMBDA_TIME_MARGIN_MS : Number.POSITIVE_INFINITY;
      return Number.isNaN(lambda) ? own : Math.min(own, lambda);
    },
  };
};

// Per execution environment (module instance): host -> the time its cooldown ends.
const refusedHostsUntil = new Map<string, number>();

/** Forgets every cooldown (tests). */
export const clearRefusedHostCooldowns = (): void => refusedHostsUntil.clear();

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
};

// ─── The fetch ───────────────────────────────────────────────────────────────

export interface SourceResult {
  source: BillTextSource;
  url: string;
  kind: SourceResultKind;
  /** The last HTTP status, or network, cooldown, budget. */
  status: number | string;
  detail: string;
  /** Requests made to this source. */
  requests: number;
  /** The body, when kind is ok. */
  xml?: string;
}

export interface BillTextFetch {
  outcome: SourceResultKind;
  xml?: string;
  source?: BillTextSource;
  results: SourceResult[];
  statuses: Partial<Record<BillTextSource, number | string>>;
  /**
   * BillXmlFetchSuccess, BillXmlFetchFailure, BillXmlFetchRefused, BillXmlSourceSkipped, BillXmlFallbackUsed and
   * BillTextFetched.
   */
  metrics: MetricDatum[];
}

export interface FetchBillTextOptions {
  xmlUrl: string;
  order: readonly BillTextSource[];
  /** One GET; resolves for any HTTP status, rejects on a network error. */
  get: (url: string) => Promise<HttpTextResponse>;
  maxRetries: number;
  backoff: { baseMs: number; maxMs: number };
  budget: TimeBudget;
  cooldownMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** When no source answered with text: refused first (a retry later can help), then the rest by severity. */
const FINAL_PRECEDENCE: readonly SourceResultKind[] = ["refused", "server_error", "network", "invalid", "not_found"];

const fetchFromSource = async (
  request: BillTextRequest,
  options: FetchBillTextOptions,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<SourceResult> => {
  const { source, url } = request;
  const host = hostOf(url);
  const loggedUrl = redactUrl(url);
  const result = (kind: SourceResultKind, status: number | string, detail: string, requests: number) => ({
    source,
    url,
    kind,
    status,
    detail,
    requests,
  });

  const until = refusedHostsUntil.get(host);
  if (until !== undefined && now() < until) {
    logger.warn(`Skipping bill XML source ${source}: it refused this environment recently`, {
      source,
      host,
      url: loggedUrl,
      cooldownEndsAt: new Date(until).toISOString(),
    });
    return result("refused", "cooldown", "cooldown", 0);
  }

  // The last answer before the budget ran out: an HTTP status, "network", or "budget" when nothing was asked.
  let lastStatus: number | string = "budget";
  const budgetUsedUp = (requests: number): SourceResult => {
    logger.warn(`Bill XML time budget used up before ${source} answered with text`, {
      source,
      url: loggedUrl,
      requests,
      lastStatus,
    });
    return result("refused", lastStatus, "budget", requests);
  };

  for (let attempt = 0; ; attempt += 1) {
    if (options.budget.left() <= 0) return budgetUsedUp(attempt);
    let response: HttpTextResponse;
    try {
      response = await options.get(url);
    } catch (error) {
      lastStatus = "network";
      if (attempt < options.maxRetries) {
        const delayMs = retryDelayMs(attempt, options.backoff);
        logger.warn(
          `Bill XML network error from ${source}. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${options.maxRetries})`,
          {
            source,
            url: loggedUrl,
            delayMs,
            attempt: attempt + 1,
            maxRetries: options.maxRetries,
            reason: errorText(error),
          },
        );
        if (delayMs >= options.budget.left()) return budgetUsedUp(attempt + 1);
        await sleep(delayMs);
        continue;
      }
      logger.warn(`Error fetching bill XML from ${source} after ${options.maxRetries} retries`, {
        source,
        url: loggedUrl,
        reason: errorText(error),
      });
      return result("network", "network", "network", attempt + 1);
    }

    lastStatus = response.statusCode;
    const answer = classifyBillXmlResponse(response);
    if (answer.kind === "ok") {
      logger.debug("Fetched bill XML response", { source, url: loggedUrl, characters: response.body.length });
      return { ...result("ok", answer.status, answer.detail, attempt + 1), xml: response.body };
    }
    const willRetry = isRetryableAnswer(response) && attempt < options.maxRetries;
    // REL-45: what tells a WAF or challenge from a real outage; never a cookie or a key.
    logger.warn(`Failed to fetch bill XML from ${source}: status ${response.statusCode}`, {
      source,
      url: loggedUrl,
      statusCode: response.statusCode,
      result: answer.kind,
      detail: answer.detail,
      attempt: attempt + 1,
      willRetry,
      headers: diagnosticHeaders(response.headers),
      bodyExcerpt: bodyExcerpt(response.body),
    });
    if (willRetry) {
      const delayMs = retryDelayMs(attempt, options.backoff, response.headers["retry-after"]);
      if (delayMs >= options.budget.left()) return budgetUsedUp(attempt + 1);
      await sleep(delayMs);
      continue;
    }
    if (answer.kind === "refused") refusedHostsUntil.set(host, now() + options.cooldownMs);
    return result(answer.kind, answer.status, answer.detail, attempt + 1);
  }
};

/**
 * Tries each source in turn until one answers with bill XML. Never throws for an HTTP or network failure. The
 * caller emits `metrics` (one PutMetricData call) and decides what to store and whether to retry later.
 */
export const fetchBillText = async (options: FetchBillTextOptions): Promise<BillTextFetch> => {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const requests = billTextRequests(options.xmlUrl, options.order);
  const results: SourceResult[] = [];
  const metrics: MetricDatum[] = [];

  for (const request of requests) {
    const sourceResult = await fetchFromSource(request, options, now, sleep);
    results.push(sourceResult);
    const Source = sourceResult.source;
    if (sourceResult.kind === "ok") {
      metrics.push({ name: "BillXmlFetchSuccess", value: 1, dimensions: { Source, StatusCode: "200" } });
      break;
    }
    if (sourceResult.requests === 0) {
      // In its refused cooldown, or no time left to ask it.
      metrics.push({ name: "BillXmlSourceSkipped", value: 1, dimensions: { Source } });
      continue;
    }
    metrics.push({ name: "BillXmlFetchFailure", value: 1, dimensions: { Source } });
    if (typeof sourceResult.status === "number") {
      metrics.push({
        name: "BillXmlFetchFailure",
        value: 1,
        dimensions: { Source, StatusCode: String(sourceResult.status) },
      });
    }
    // The source turned this environment away (401, 403, a challenge, a 429 after retries): what the post-deploy
    // check and the BILL_XML_SOURCES switch read. BillXmlFetchFailure also counts misses (GovInfo's 302 for a
    // version it does not have yet), outages and a used-up time budget, none of which says the source refuses us.
    if (sourceResult.kind === "refused" && sourceResult.detail !== "budget") {
      metrics.push({ name: "BillXmlFetchRefused", value: 1, dimensions: { Source } });
    }
  }

  const statuses: Partial<Record<BillTextSource, number | string>> = {};
  for (const sourceResult of results) statuses[sourceResult.source] = sourceResult.status;

  const ok = results.find((sourceResult) => sourceResult.kind === "ok");
  if (ok) {
    metrics.push({ name: "BillTextFetched", value: 1 });
    if (ok !== results[0]) {
      metrics.push({ name: "BillXmlFallbackUsed", value: 1, dimensions: { Source: ok.source } });
    }
    return { outcome: "ok", xml: ok.xml, source: ok.source, results, statuses, metrics };
  }
  const outcome =
    FINAL_PRECEDENCE.find((kind) => results.some((sourceResult) => sourceResult.kind === kind)) ?? "invalid";
  return { outcome, results, statuses, metrics };
};
