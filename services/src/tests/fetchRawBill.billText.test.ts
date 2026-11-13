import {
  billTextRequests,
  billVersionStem,
  bodyExcerpt,
  classifyBillXmlResponse,
  clearRefusedHostCooldowns,
  fetchBillText,
  govInfoBillXmlUrl,
  inspectBillXmlBody,
  locateBillXmlUrl,
  parseBillXmlSources,
  timeBudget,
  type FetchBillTextOptions,
  type HttpTextResponse,
} from "../handlers/fetchRawBill/billText";
import { logLines } from "./logLines";

// REL-45: bill text from GovInfo and congress.gov (services/src/handlers/fetchRawBill/billText.ts).

const BILL_TYPES = ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"];
// GPO's bill text version codes (govinfo BILLS collection), the ones the 65 refused bills had first.
const VERSION_CODES = [
  "ih",
  "enr",
  "eh",
  "is",
  "ats",
  "pcs",
  "as",
  "ash",
  "ath",
  "cdh",
  "cds",
  "cph",
  "cps",
  "eah",
  "eas",
  "es",
  "fph",
  "fps",
  "hdh",
  "hds",
  "iph",
  "ips",
  "lth",
  "lts",
  "oph",
  "ops",
  "pap",
  "pav",
  "pch",
  "pp",
  "pwah",
  "rah",
  "ras",
  "rch",
  "rcs",
  "rdh",
  "rds",
  "re",
  "reah",
  "renr",
  "res",
  "rfh",
  "rfs",
  "rh",
  "rih",
  "ris",
  "rs",
  "rth",
  "rts",
  "sc",
];

const GPO_BILL_XML = [
  '<?xml version="1.0"?>',
  '<?xml-stylesheet type="text/xsl" href="billres.xsl"?>',
  '<!DOCTYPE bill PUBLIC "-//US Congress//DTDs/bill.dtd//EN" "bill.dtd">',
  '<bill bill-stage="Introduced-in-House" dms-id="H1" public-private="public"><legis-body/></bill>',
].join("\n");
const GPO_RESOLUTION_XML = '<resolution resolution-stage="Introduced-in-House"><legis-body/></resolution>';
const CHALLENGE_PAGE =
  '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>';

const CONGRESS_URL = "https://www.congress.gov/119/bills/hr2739/BILLS-119hr2739ih.xml";
const GOVINFO_URL = "https://www.govinfo.gov/content/pkg/BILLS-119hr2739ih/xml/BILLS-119hr2739ih.xml";

const answer = (statusCode: number, body = "", headers: Record<string, string | string[]> = {}): HttpTextResponse => ({
  statusCode,
  headers,
  body,
});

type Scripted = HttpTextResponse | Error;

/** A get() that answers each URL from its own script (the last answer repeats), and records every call. */
const scriptedGet = (scripts: Record<string, Scripted[]>) => {
  const calls: string[] = [];
  const used: Record<string, number> = {};
  const get = jest.fn(async (url: string) => {
    calls.push(url);
    const script = scripts[url];
    if (!script) throw new Error(`unexpected GET ${url}`);
    const index = Math.min(used[url] ?? 0, script.length - 1);
    used[url] = (used[url] ?? 0) + 1;
    const next = script[index];
    if (next instanceof Error) throw next;
    return next;
  });
  return { get, calls };
};

const options = (
  overrides: Partial<FetchBillTextOptions> & Pick<FetchBillTextOptions, "get">,
): FetchBillTextOptions => ({
  xmlUrl: CONGRESS_URL,
  order: ["GovInfo", "CongressGov"],
  maxRetries: 2,
  backoff: { baseMs: 0, maxMs: 0 },
  budget: { left: () => 40_000 },
  cooldownMs: 600_000,
  sleep: async () => undefined,
  ...overrides,
});

const metricNames = (metrics: Array<{ name: string; dimensions?: Record<string, string> }>) =>
  metrics.map((metric) =>
    metric.dimensions
      ? `${metric.name}{${Object.entries(metric.dimensions)
          .map(([name, value]) => `${name}=${value}`)
          .join(",")}}`
      : metric.name,
  );

beforeEach(() => {
  clearRefusedHostCooldowns();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("source URLs", () => {
  it("builds GovInfo's URL from the congress.gov file's package id for every bill type and text version code", () => {
    for (const billType of BILL_TYPES) {
      for (const code of VERSION_CODES) {
        const stem = `BILLS-119${billType}1234${code}`;
        const congressUrl = `https://www.congress.gov/119/bills/${billType}1234/${stem}.xml`;
        expect(billVersionStem(congressUrl)).toBe(stem);
        expect(billTextRequests(congressUrl, ["GovInfo", "CongressGov"])).toEqual([
          { source: "GovInfo", url: `https://www.govinfo.gov/content/pkg/${stem}/xml/${stem}.xml` },
          { source: "CongressGov", url: congressUrl },
        ]);
      }
    }
    expect(govInfoBillXmlUrl("BILLS-118sres443is")).toBe(
      "https://www.govinfo.gov/content/pkg/BILLS-118sres443is/xml/BILLS-118sres443is.xml",
    );
  });

  it("keeps the configured order, and congress.gov alone is the rollback switch", () => {
    expect(billTextRequests(CONGRESS_URL, ["CongressGov", "GovInfo"])).toEqual([
      { source: "CongressGov", url: CONGRESS_URL },
      { source: "GovInfo", url: GOVINFO_URL },
    ]);
    expect(billTextRequests(CONGRESS_URL, ["CongressGov"])).toEqual([{ source: "CongressGov", url: CONGRESS_URL }]);
  });

  it.each([
    "https://example.com/bill.xml",
    "https://www.congress.gov/119/bills/hr2739/BILLS-119hr2739.xml", // no version code
    "https://www.congress.gov/119/bills/hr2739/BILLS-119xx2739ih.xml", // unknown bill type
    "https://www.congress.gov/119/bills/hr2739/BILLS-119hr2739IH.xml", // upper case
    "https://www.congress.gov/119/bills/hr2739/BILLS-119hr2739ih.htm",
    "https://www.congress.gov/119/bills/hr2739/PLAW-119publ1.xml",
    "not a url",
  ])("uses congress.gov only for a URL of another shape: %s", (xmlUrl) => {
    expect(billVersionStem(xmlUrl)).toBeNull();
    expect(billTextRequests(xmlUrl, ["GovInfo", "CongressGov"])).toEqual([{ source: "CongressGov", url: xmlUrl }]);
  });

  it("reads BILL_XML_SOURCES in order, once each, and falls back to GovInfo then congress.gov", () => {
    expect(parseBillXmlSources(undefined)).toEqual(["GovInfo", "CongressGov"]);
    expect(parseBillXmlSources("govinfo,congress")).toEqual(["GovInfo", "CongressGov"]);
    expect(parseBillXmlSources(" Congress , GOVINFO ,congress")).toEqual(["CongressGov", "GovInfo"]);
    expect(parseBillXmlSources("congress")).toEqual(["CongressGov"]);
    expect(parseBillXmlSources("")).toEqual(["GovInfo", "CongressGov"]);
    expect(parseBillXmlSources("congres,gov")).toEqual(["GovInfo", "CongressGov"]);
  });

  it("finds the newest text version's Formatted XML, or says why there is none", () => {
    expect(
      locateBillXmlUrl({
        textVersions: [
          {
            formats: [
              { type: "PDF", url: "x.pdf" },
              { type: "Formatted XML", url: CONGRESS_URL },
            ],
          },
          { formats: [{ type: "Formatted XML", url: "older.xml" }] },
        ],
      }),
    ).toEqual({ url: CONGRESS_URL });
    expect(locateBillXmlUrl({ textVersions: [] })).toEqual({ missing: "no_text_version" });
    expect(locateBillXmlUrl(undefined)).toEqual({ missing: "no_text_version" });
    expect(locateBillXmlUrl({ textVersions: [{ formats: [{ type: "PDF", url: "x.pdf" }] }] })).toEqual({
      missing: "no_xml_format",
    });
  });
});

describe("classifying an answer", () => {
  it("accepts GPO bill and resolution XML, with a prolog, a stylesheet instruction, a DOCTYPE or a BOM", () => {
    expect(inspectBillXmlBody({}, GPO_BILL_XML)).toBe("ok");
    expect(inspectBillXmlBody({ "content-type": "application/xml" }, `\uFEFF\n  ${GPO_BILL_XML}`)).toBe("ok");
    expect(inspectBillXmlBody({}, GPO_RESOLUTION_XML)).toBe("ok");
    expect(inspectBillXmlBody({}, '<!DOCTYPE resolution PUBLIC "x" "res.dtd"><resolution/>')).toBe("ok");
    expect(inspectBillXmlBody({}, "<bill><legis-body/></bill>")).toBe("ok");
    expect(classifyBillXmlResponse(answer(200, GPO_BILL_XML, { "content-type": "text/xml" }))).toEqual({
      kind: "ok",
      status: 200,
      detail: "ok",
    });
  });

  it("refuses a challenge page, a cf-mitigated header and a text/html content type, even with a 200", () => {
    expect(classifyBillXmlResponse(answer(200, CHALLENGE_PAGE))).toEqual({
      kind: "refused",
      status: 200,
      detail: "challenge",
    });
    expect(classifyBillXmlResponse(answer(200, GPO_BILL_XML, { "cf-mitigated": "challenge" }))).toMatchObject({
      kind: "refused",
      detail: "challenge",
    });
    expect(
      classifyBillXmlResponse(answer(200, GPO_BILL_XML, { "content-type": "text/html; charset=UTF-8" })),
    ).toMatchObject({ kind: "refused", detail: "challenge" });
    expect(classifyBillXmlResponse(answer(503, CHALLENGE_PAGE, { "cf-mitigated": "challenge" }))).toMatchObject({
      kind: "refused",
      status: 503,
    });
  });

  it("calls an empty or non-XML 200 invalid", () => {
    expect(classifyBillXmlResponse(answer(200, ""))).toEqual({ kind: "invalid", status: 200, detail: "empty" });
    expect(classifyBillXmlResponse(answer(200, " \n\t "))).toMatchObject({ kind: "invalid", detail: "empty" });
    expect(classifyBillXmlResponse(answer(200, '{"error":"x"}'))).toMatchObject({ kind: "invalid", detail: "not_xml" });
  });

  it.each([
    [401, "refused", "forbidden"],
    [403, "refused", "forbidden"],
    [429, "refused", "throttled"],
    [404, "not_found", "not_found"],
    [410, "not_found", "not_found"],
    [500, "server_error", "server_error"],
    [503, "server_error", "server_error"],
    [301, "invalid", "redirect"],
    [302, "invalid", "redirect"],
    [400, "invalid", "unexpected_status"],
  ])("classifies HTTP %d as %s (%s)", (status, kind, detail) => {
    expect(classifyBillXmlResponse(answer(status, "x"))).toEqual({ kind, status, detail });
  });

  it("calls a redirect to an /error page not_found (GovInfo's miss), and any other redirect invalid", () => {
    // GovInfo's answer for a package it does not have, as seen live on 2026-10-17 (BILLS-119hr2739rh).
    expect(classifyBillXmlResponse(answer(302, "", { location: "https://www.govinfo.gov/error" }))).toEqual({
      kind: "not_found",
      status: 302,
      detail: "error_redirect",
    });
    expect(classifyBillXmlResponse(answer(301, "", { location: "/error/" }))).toMatchObject({ kind: "not_found" });
    expect(classifyBillXmlResponse(answer(302, "", { location: "/ERROR?code=404" }))).toMatchObject({
      kind: "not_found",
    });
    expect(
      classifyBillXmlResponse(answer(302, "", { location: "https://www.govinfo.gov/content/pkg/x/xml/x.xml" })),
    ).toEqual({ kind: "invalid", status: 302, detail: "redirect" });
    expect(classifyBillXmlResponse(answer(302, "", { location: "/errors" }))).toMatchObject({ detail: "redirect" });
    expect(classifyBillXmlResponse(answer(302, "", { location: "http://[" }))).toMatchObject({ detail: "redirect" });
    // A challenge stays a refusal whatever its status.
    expect(classifyBillXmlResponse(answer(302, "", { location: "/error", "cf-mitigated": "challenge" }))).toMatchObject(
      { kind: "refused", detail: "challenge" },
    );
  });
});

describe("fetching", () => {
  it("asks GovInfo first and stops at its text", async () => {
    const { get, calls } = scriptedGet({ [GOVINFO_URL]: [answer(200, GPO_BILL_XML)] });

    const fetched = await fetchBillText(options({ get }));

    expect(calls).toEqual([GOVINFO_URL]);
    expect(fetched).toMatchObject({ outcome: "ok", xml: GPO_BILL_XML, source: "GovInfo", statuses: { GovInfo: 200 } });
    expect(metricNames(fetched.metrics)).toEqual([
      "BillXmlFetchSuccess{Source=GovInfo,StatusCode=200}",
      "BillTextFetched",
    ]);
  });

  it("falls back to congress.gov after a GovInfo 404 and counts the fallback", async () => {
    const { get, calls } = scriptedGet({
      [GOVINFO_URL]: [answer(404, "Not Found")],
      [CONGRESS_URL]: [answer(200, GPO_BILL_XML)],
    });

    const fetched = await fetchBillText(options({ get }));

    expect(calls).toEqual([GOVINFO_URL, CONGRESS_URL]);
    expect(fetched).toMatchObject({
      outcome: "ok",
      source: "CongressGov",
      statuses: { GovInfo: 404, CongressGov: 200 },
    });
    expect(metricNames(fetched.metrics)).toEqual([
      "BillXmlFetchFailure{Source=GovInfo}",
      "BillXmlFetchFailure{Source=GovInfo,StatusCode=404}",
      "BillXmlFetchSuccess{Source=CongressGov,StatusCode=200}",
      "BillTextFetched",
      "BillXmlFallbackUsed{Source=CongressGov}",
    ]);
  });

  it("calls a version on neither source not_found: GovInfo's 302 to /error and congress.gov's 404 page", async () => {
    // What both answer for a text version listed before its file is published (GovInfo checked live on 2026-10-17).
    const { get, calls } = scriptedGet({
      [GOVINFO_URL]: [answer(302, "", { location: "https://www.govinfo.gov/error", server: "cloudflare" })],
      [CONGRESS_URL]: [
        answer(404, "<!DOCTYPE html><html><title>Not Found</title></html>", { "content-type": "text/html" }),
      ],
    });

    const fetched = await fetchBillText(options({ get }));

    expect(calls).toEqual([GOVINFO_URL, CONGRESS_URL]);
    expect(fetched).toMatchObject({ outcome: "not_found", statuses: { GovInfo: 302, CongressGov: 404 } });
    expect(fetched.results.map((result) => [result.kind, result.detail])).toEqual([
      ["not_found", "error_redirect"],
      ["not_found", "not_found"],
    ]);
    // A miss is a failure of that source, never a refusal.
    expect(metricNames(fetched.metrics)).toEqual([
      "BillXmlFetchFailure{Source=GovInfo}",
      "BillXmlFetchFailure{Source=GovInfo,StatusCode=302}",
      "BillXmlFetchFailure{Source=CongressGov}",
      "BillXmlFetchFailure{Source=CongressGov,StatusCode=404}",
    ]);
  });

  it("falls back to congress.gov when GovInfo does not have the version yet, without counting a refusal", async () => {
    const { get, calls } = scriptedGet({
      [GOVINFO_URL]: [answer(302, "", { location: "https://www.govinfo.gov/error" })],
      [CONGRESS_URL]: [answer(200, GPO_BILL_XML)],
    });

    const fetched = await fetchBillText(options({ get }));

    expect(calls).toEqual([GOVINFO_URL, CONGRESS_URL]);
    expect(fetched).toMatchObject({ outcome: "ok", source: "CongressGov", statuses: { GovInfo: 302 } });
    expect(metricNames(fetched.metrics)).not.toContain("BillXmlFetchRefused{Source=GovInfo}");
    // No cooldown: the next fetch asks GovInfo again.
    await fetchBillText(options({ get }));
    expect(calls.filter((url) => url === GOVINFO_URL)).toHaveLength(2);
  });

  it("never retries a 403 on the same host, and calls the text refused when both refuse", async () => {
    const { get, calls } = scriptedGet({ [GOVINFO_URL]: [answer(403, "")], [CONGRESS_URL]: [answer(403, "")] });

    const fetched = await fetchBillText(options({ get }));

    expect(calls).toEqual([GOVINFO_URL, CONGRESS_URL]);
    expect(fetched).toMatchObject({ outcome: "refused", statuses: { GovInfo: 403, CongressGov: 403 } });
    expect(fetched.xml).toBeUndefined();
    expect(metricNames(fetched.metrics)).toEqual([
      "BillXmlFetchFailure{Source=GovInfo}",
      "BillXmlFetchFailure{Source=GovInfo,StatusCode=403}",
      "BillXmlFetchRefused{Source=GovInfo}",
      "BillXmlFetchFailure{Source=CongressGov}",
      "BillXmlFetchFailure{Source=CongressGov,StatusCode=403}",
      "BillXmlFetchRefused{Source=CongressGov}",
    ]);
  });

  it("an empty 200 is invalid and counts no success", async () => {
    const { get } = scriptedGet({ [GOVINFO_URL]: [answer(200, "")], [CONGRESS_URL]: [answer(404, "")] });

    const fetched = await fetchBillText(options({ get }));

    expect(fetched.outcome).toBe("invalid");
    expect(metricNames(fetched.metrics)).not.toContain("BillXmlFetchSuccess{Source=GovInfo,StatusCode=200}");
    expect(metricNames(fetched.metrics)).toContain("BillXmlFetchFailure{Source=GovInfo,StatusCode=200}");
  });

  it("retries 5xx twice per source with backoff, then tries the next source", async () => {
    const sleeps: number[] = [];
    const { get, calls } = scriptedGet({ [GOVINFO_URL]: [answer(503, "")], [CONGRESS_URL]: [answer(503, "")] });

    const fetched = await fetchBillText(
      options({ get, backoff: { baseMs: 500, maxMs: 5000 }, sleep: async (ms) => void sleeps.push(ms) }),
    );

    expect(calls).toEqual([GOVINFO_URL, GOVINFO_URL, GOVINFO_URL, CONGRESS_URL, CONGRESS_URL, CONGRESS_URL]);
    expect(sleeps).toHaveLength(4);
    sleeps.forEach((ms, index) => expect(ms).toBeLessThanOrEqual(500 * 2 ** (index % 2)));
    expect(fetched.outcome).toBe("server_error");
  });

  it("handles network errors like 5xx, and names the worse failure when no source answered with text", async () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const { get, calls } = scriptedGet({ [GOVINFO_URL]: [reset], [CONGRESS_URL]: [answer(404, "")] });

    const fetched = await fetchBillText(options({ get }));

    expect(calls).toEqual([GOVINFO_URL, GOVINFO_URL, GOVINFO_URL, CONGRESS_URL]);
    expect(fetched).toMatchObject({ outcome: "network", statuses: { GovInfo: "network", CongressGov: 404 } });
    expect(metricNames(fetched.metrics)).toEqual([
      "BillXmlFetchFailure{Source=GovInfo}",
      "BillXmlFetchFailure{Source=CongressGov}",
      "BillXmlFetchFailure{Source=CongressGov,StatusCode=404}",
    ]);
  });

  it("counts a 429 still failing after its retries as refused (throttled)", async () => {
    const { get, calls } = scriptedGet({ [GOVINFO_URL]: [answer(429, "", { "retry-after": "1" })] });

    const fetched = await fetchBillText(options({ get, order: ["GovInfo"] }));

    expect(calls).toHaveLength(3);
    expect(fetched.results[0]).toMatchObject({ kind: "refused", detail: "throttled", status: 429 });
    expect(fetched.outcome).toBe("refused");
    expect(metricNames(fetched.metrics)).toContain("BillXmlFetchRefused{Source=GovInfo}");
  });

  it("skips a host that refused this environment for the cooldown, then tries it again", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-17T08:00:00.000Z") });
    const { get, calls } = scriptedGet({
      [GOVINFO_URL]: [answer(403, ""), answer(200, GPO_BILL_XML)],
      [CONGRESS_URL]: [answer(403, ""), answer(200, GPO_BILL_XML)],
    });

    const first = await fetchBillText(options({ get }));
    expect(first.outcome).toBe("refused");
    expect(calls).toHaveLength(2);

    jest.setSystemTime(new Date("2026-10-17T08:09:59.000Z"));
    const second = await fetchBillText(options({ get }));
    expect(calls).toHaveLength(2);
    expect(second).toMatchObject({ outcome: "refused", statuses: { GovInfo: "cooldown", CongressGov: "cooldown" } });
    expect(metricNames(second.metrics)).toEqual([
      "BillXmlSourceSkipped{Source=GovInfo}",
      "BillXmlSourceSkipped{Source=CongressGov}",
    ]);
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Skipping bill XML source GovInfo"),
        host: "www.govinfo.gov",
      }),
    );

    jest.setSystemTime(new Date("2026-10-17T08:10:01.000Z"));
    const third = await fetchBillText(options({ get }));
    expect(calls).toEqual([GOVINFO_URL, CONGRESS_URL, GOVINFO_URL]);
    expect(third).toMatchObject({ outcome: "ok", source: "GovInfo" });
  });

  it("puts no host in cooldown for a 404 or a 5xx", async () => {
    const { get, calls } = scriptedGet({ [GOVINFO_URL]: [answer(404, "")], [CONGRESS_URL]: [answer(500, "")] });

    await fetchBillText(options({ get }));
    await fetchBillText(options({ get }));

    expect(calls.filter((url) => url === GOVINFO_URL)).toHaveLength(2);
    expect(calls.filter((url) => url === CONGRESS_URL)).toHaveLength(6);
  });

  it("starts no request once the time budget is used up, and calls that refused", async () => {
    const { get, calls } = scriptedGet({
      [GOVINFO_URL]: [answer(404, "")],
      [CONGRESS_URL]: [answer(200, GPO_BILL_XML)],
    });
    const left = jest.fn().mockReturnValueOnce(30_000).mockReturnValue(0);

    const fetched = await fetchBillText(options({ get, budget: { left } }));

    expect(calls).toEqual([GOVINFO_URL]);
    expect(fetched).toMatchObject({ outcome: "refused", statuses: { GovInfo: 404, CongressGov: "budget" } });
    expect(metricNames(fetched.metrics)).toContain("BillXmlSourceSkipped{Source=CongressGov}");
  });

  it("stops a source's retries when the next wait would pass the budget", async () => {
    const { get, calls } = scriptedGet({ [GOVINFO_URL]: [answer(503, "")] });
    const left = jest.fn().mockReturnValueOnce(30_000).mockReturnValue(100);

    // The backoff is full jitter (0 to 5000 ms). A fixed draw makes the wait 2500 ms, more than the 100 ms left;
    // unpinned, about 2% of runs drew a wait under 100 ms and retried. afterEach restores Math.random.
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    const fetched = await fetchBillText(
      options({ get, order: ["GovInfo"], backoff: { baseMs: 5000, maxMs: 5000 }, budget: { left } }),
    );

    expect(calls).toEqual([GOVINFO_URL]);
    expect(fetched.results[0]).toMatchObject({ kind: "refused", detail: "budget", status: 503, requests: 1 });
    // Running out of time is not the source refusing us.
    expect(metricNames(fetched.metrics)).toEqual([
      "BillXmlFetchFailure{Source=GovInfo}",
      "BillXmlFetchFailure{Source=GovInfo,StatusCode=503}",
    ]);
  });

  it("bounds the budget by BILL_XML_FETCH_BUDGET_MS and by the Lambda's remaining time less 15 s", () => {
    let now = 1_000;
    const remaining = jest.fn().mockReturnValue(90_000);
    const budget = timeBudget({ budgetMs: 40_000, remainingMs: remaining, now: () => now });
    expect(budget.left()).toBe(40_000);
    now += 10_000;
    expect(budget.left()).toBe(30_000);
    remaining.mockReturnValue(20_000);
    expect(budget.left()).toBe(5_000);
    expect(timeBudget({ budgetMs: 40_000, now: () => now }).left()).toBe(40_000);
  });

  it("logs a refusal's server, cf-ray, cf-mitigated, content-type, retry-after and 300 body characters, never a cookie or key", async () => {
    const body = `${CHALLENGE_PAGE} <a href="https://api.congress.gov/v3/bill?api_key=SECRET-KEY-123">x</a> ${"padding ".repeat(80)}`;
    const { get } = scriptedGet({
      [GOVINFO_URL]: [
        answer(403, body, {
          server: "cloudflare",
          "cf-ray": "8d1f2a3b4c5d6e7f-IAD",
          "cf-mitigated": "challenge",
          "content-type": "text/html; charset=UTF-8",
          "retry-after": "120",
          "set-cookie": ["__cf_bm=SESSION-COOKIE-VALUE; path=/"],
        }),
      ],
    });

    await fetchBillText(options({ get, order: ["GovInfo"] }));

    const [line] = logLines(console.warn).filter(
      (entry) => entry.message === "Failed to fetch bill XML from GovInfo: status 403",
    );
    expect(line).toMatchObject({
      source: "GovInfo",
      url: GOVINFO_URL,
      statusCode: 403,
      result: "refused",
      detail: "challenge",
      willRetry: false,
      headers: {
        server: "cloudflare",
        "cf-ray": "8d1f2a3b4c5d6e7f-IAD",
        "cf-mitigated": "challenge",
        "content-type": "text/html; charset=UTF-8",
        "retry-after": "120",
      },
    });
    const excerpt = line.bodyExcerpt as string;
    expect(excerpt.length).toBeLessThanOrEqual(300);
    expect(excerpt).toContain("Just a moment...");
    const everything = JSON.stringify((console.warn as jest.Mock).mock.calls);
    expect(everything).not.toMatch(/set-cookie|SESSION-COOKIE-VALUE|__cf_bm/i);
    expect(everything).not.toContain("SECRET-KEY-123");
    expect(bodyExcerpt("see ?api_key=SECRET-KEY-123&x=1")).toBe("see ?api_key=REDACTED&x=1");
  });
});
