import { applyTestEnv } from "./fixtures/env";
import { logLines, logLinesWithMessage } from "./logLines";

export {};

const originalEnv = { ...process.env };

const mockSSMSend = jest.fn();
const mockSecretsSend = jest.fn();
const mockSQSSend = jest.fn();
const mockCloudWatchSend = jest.fn();
const mockFetch = jest.fn();

global.fetch = mockFetch as unknown as typeof fetch;

jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn(() => ({ send: mockSSMSend })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ input, __type: "GetParameterCommand" })),
  PutParameterCommand: jest.fn().mockImplementation((input) => ({ input, __type: "PutParameterCommand" })),
}));

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSQSSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn(() => ({ send: mockCloudWatchSend })),
  PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

type HandlerReturn = Promise<{ status: string; processed: number; discovered: number; initialized: boolean }>;
type PollerContext = { awsRequestId?: string; getRemainingTimeInMillis: () => number };
let handler: (event?: unknown, context?: PollerContext) => HandlerReturn;
let restoreEnv: (() => void) | undefined;

type PersistedBacklog = { to: string; offset: number; count?: number };

// REL-56: a cursor written before it has only lastUpdateAt and lastSeenKey.
type PersistedCursor = {
  lastUpdateAt: string;
  lastSeenKey: string;
  watermark?: string;
  listed?: boolean;
  backlog?: PersistedBacklog;
};

// The cursor the poller writes at `watermark` (REL-56). lastUpdateAt and lastSeenKey are for code from before it (a
// rollback): the midnight that starts the next window, the watermark less 120 seconds.
const cursorAtWatermark = (watermark: string, listed = true, backlog?: PersistedBacklog): PersistedCursor => {
  const day = `${new Date(Date.parse(watermark) - 120_000).toISOString().slice(0, 10)}T00:00:00.000Z`;
  return { lastUpdateAt: day, lastSeenKey: `${day}#`, watermark, listed, ...(backlog ? { backlog } : {}) };
};

let persistedState: {
  schemaVersion: 1;
  congress: string;
  lastRunAt: string;
  // Written by every run since the outage change; absent in older states (read as lastRunAt).
  lastPolledAt?: string;
  cursors: Record<string, PersistedCursor>;
  // REL-56: the late-row probe, kept by the first run of an hour.
  probe?: { billType: string; from: string; to: string; numbers: string[] };
};

beforeEach(() => {
  jest.resetModules();
  jest.useRealTimers();
  mockSSMSend.mockReset();
  mockSecretsSend.mockReset();
  mockSQSSend.mockReset();
  mockCloudWatchSend.mockReset();
  mockFetch.mockReset();

  persistedState = {
    schemaVersion: 1,
    congress: "119",
    lastRunAt: "2026-03-01T00:00:00.000Z",
    cursors: {
      hr: {
        lastUpdateAt: "2026-03-01T00:00:00.000Z",
        lastSeenKey: "2026-03-01T00:00:00.000Z#",
      },
    },
  };

  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();

  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      SECRET_NAME: "test-secret",
      STATE_PARAMETER_NAME: "/test/bills/state",
      QUEUE_URL: "https://example.com/queue",
      QUEUE_BATCH_SIZE: "10",
      POLL_CONGRESS: "119",
      BILL_TYPES: "hr",
      MAX_PAGES_PER_BILL_TYPE: "20",
      CONGRESS_API_MAX_RETRIES: "2",
      CONGRESS_API_BASE_DELAY_MS: "0",
      CONGRESS_API_MAX_DELAY_MS: "0",
      CONGRESS_API_BASE_URL: "https://api.congress.gov/v3",
      // REL-56: the hourly filter check adds a request to the first run of each hour; its own tests turn it on.
      FILTER_PRECISION_CHECK: "off",
    },
    { replace: true, base: originalEnv },
  );

  mockSSMSend.mockImplementation(async (command: { __type?: string }) => {
    if (command.__type === "GetParameterCommand") {
      return { Parameter: { Value: JSON.stringify(persistedState) } };
    }
    if (command.__type === "PutParameterCommand") {
      persistedState = JSON.parse((command as unknown as { input: { Value: string } }).input.Value);
      return {};
    }
    throw new Error("Unexpected SSM command");
  });
  mockSecretsSend.mockResolvedValue({
    SecretString: JSON.stringify({ congressApiKey: "test-key" }),
  });
  mockSQSSend.mockImplementation((cmd) =>
    Promise.resolve({
      Successful: (cmd.input?.Entries ?? []).map((_: unknown, idx: number) => ({ Id: `msg-${idx}` })),
    }),
  );
  mockCloudWatchSend.mockResolvedValue({});

  const mod = require("../handlers/billsApiPoller");
  handler = mod.handler;
});

afterEach(() => {
  restoreEnv?.();
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("billsApiPoller handler", () => {
  const findMetricValue = (metricName: string): number | undefined => {
    for (const [cmd] of mockCloudWatchSend.mock.calls) {
      const metric = cmd?.input?.MetricData?.find((item: { MetricName?: string }) => item.MetricName === metricName);
      if (metric) {
        return metric.Value;
      }
    }
    return undefined;
  };

  it("retries transient 503 errors and succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: {
          get: () => null,
        },
        text: () => Promise.resolve("Service Unavailable"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              bills: [
                {
                  congress: "119",
                  type: "hr",
                  number: "1",
                  title: "Test Bill",
                  updateDate: "2026-03-03T00:00:00Z",
                },
              ],
              pagination: {},
            }),
          ),
      });

    const result = await handler();

    expect(result).toEqual({
      status: "ok",
      processed: 1,
      discovered: 1,
      initialized: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("ends the run without an error once 520 responses outlast the retry budget", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 520,
      headers: {
        get: () => null,
      },
      text: () => Promise.resolve("Unknown Error"),
    });

    await expect(handler()).resolves.toEqual({
      status: "congress_api_unavailable",
      processed: 0,
      discovered: 0,
      initialized: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(findMetricValue("CongressApiUnavailable")).toBe(1);
  });

  it("emits the lag after its poll, the run's own duration, not the time since the run before", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-03-09T19:42:44.101Z"));

    persistedState.lastRunAt = "2026-03-09T19:37:44.101Z";
    persistedState.cursors.hr.lastUpdateAt = "2026-03-09T19:37:44.101Z";
    persistedState.cursors.hr.lastSeenKey = "2026-03-09T19:37:44.101Z#";

    // The request takes 2.5 seconds.
    mockFetch.mockImplementation(async () => {
      jest.setSystemTime(Date.now() + 2_500);
      return okEmptyPage();
    });

    const result = await handler();

    expect(result).toEqual({
      status: "ok",
      processed: 0,
      discovered: 0,
      initialized: false,
    });
    expect(findMetricValue("BillPollerLagSeconds")).toBe(2);
    expect(persistedState.lastPolledAt).toBe("2026-03-09T19:42:44.101Z");
  });

  it("measures an outage run's lag from lastRunAt when the state has no lastPolledAt yet", async () => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick"] });
    jest.setSystemTime(new Date("2026-03-09T19:42:44.101Z"));

    persistedState.lastRunAt = "2026-03-09T19:37:44.101Z";
    mockFetch.mockResolvedValue(statusResponse(503));

    await expect(handler()).resolves.toMatchObject({ status: "congress_api_unavailable" });

    expect(findMetricValue("BillPollerLagSeconds")).toBe(300);
    expect(persistedState.lastPolledAt).toBe("2026-03-09T19:37:44.101Z");
  });

  // REL-56: congress.gov's list rows carry updateDate as a date only, as here. Before REL-56 this row (dated the
  // cursor's day, below its key) was dropped without a trace; it is in the window, so it is enqueued.
  it("does not derive poller lag from bill update timestamps, and enqueues the date-only row in its window", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-03-09T19:42:44.101Z"));

    persistedState.lastRunAt = "2026-03-09T19:40:44.101Z";
    persistedState.cursors.hr.lastUpdateAt = "2026-03-09T19:40:44.101Z";
    persistedState.cursors.hr.lastSeenKey = "2026-03-09T19:40:44.101Z#";

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            bills: [
              {
                congress: "119",
                type: "hr",
                number: "7856",
                title: "Test Bill",
                updateDate: "2026-03-09",
              },
            ],
            pagination: {},
          }),
        ),
    });

    await handler();

    // Seconds since this run's poll began (no time passes here), not since the bill's updateDate (2026-03-09, about
    // 19.7 hours earlier) or the previous run (120 seconds).
    expect(findMetricValue("BillPollerLagSeconds")).toBe(0);
    expect(persistedState.lastPolledAt).toBe("2026-03-09T19:42:44.101Z");
    // The cursor floors to the midnight of its own date: the window starts at 2026-03-08T23:58:00Z.
    expect(new URL(String(mockFetch.mock.calls[0][0])).searchParams.get("fromDateTime")).toBe("2026-03-08T23:58:00Z");
    expect(enqueuedGuids()).toEqual(["BILLS-119hr7856"]);
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-03-09T19:42:44.000Z"));
  });
});

// A bill on congress.gov's list. `at` is its update time as congress.gov keeps it: the list filters and sorts on it,
// but its rows show updateDate as a date only (REL-56, RUNBOOK 6).
type ListedBill = { number: string; at: string; action?: { actionDate: string; text: string } };

type ListOptions = {
  // Rows show `at` in full instead of the date (the older fixtures here).
  showFullTime?: boolean;
  // "date" or "hour": the filter matches whole days or hours, as the REL-56 check guards against.
  precision?: "second" | "hour" | "date";
  // Runs before each answer, so a test can update bills between page requests.
  beforePage?: (url: URL) => void;
  // Reorders the matching rows of one request (newest first by default), as an order among rows with the same time
  // that changes from one request to the next would.
  reorder?: (rows: ListedBill[], url: URL) => ListedBill[];
  // Answers without pagination.count.
  noCount?: boolean;
};

// A stand-in for congress.gov's /bill/{congress}/{type} list as production answers it: honours fromDateTime and
// toDateTime (inclusive, to the second unless `precision` says otherwise), limit and offset; newest first by `at` (then
// the higher number); pagination.count and, while rows remain, pagination.next.
const serveBillList =
  (bills: ListedBill[], options: ListOptions = {}) =>
  async (url: string) => {
    const requested = new URL(url);
    options.beforePage?.(requested);
    const [, , , congress, type] = requested.pathname.split("/");
    const from = requested.searchParams.get("fromDateTime");
    const to = requested.searchParams.get("toDateTime");
    const offset = Number(requested.searchParams.get("offset") ?? "0");
    // congress.gov serves 250 rows a page at most.
    const limit = Math.min(Number(requested.searchParams.get("limit") ?? "20"), 250);
    const grain = { date: 86_400_000, hour: 3_600_000, second: 1 }[options.precision ?? "second"];
    const time = (iso: string) => Math.floor(Date.parse(iso) / grain) * grain;
    const sorted = bills
      .filter((bill) => (!from || time(bill.at) >= time(from)) && (!to || time(bill.at) <= time(to)))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || Number(b.number) - Number(a.number));
    const matching = options.reorder ? options.reorder(sorted, requested) : sorted;
    const page = matching.slice(offset, offset + limit);

    let next: string | undefined;
    if (offset + limit < matching.length) {
      const nextUrl = new URL(url);
      nextUrl.searchParams.delete("api_key");
      nextUrl.searchParams.set("offset", String(offset + limit));
      next = nextUrl.toString();
    }

    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          bills: page.map((bill) => ({
            congress: Number(congress),
            type: type.toUpperCase(),
            number: bill.number,
            title: `${type} ${bill.number}`,
            updateDate: options.showFullTime ? bill.at : bill.at.slice(0, 10),
            ...(bill.action ? { latestAction: bill.action } : {}),
          })),
          pagination: { ...(options.noCount ? {} : { count: matching.length }), ...(next ? { next } : {}) },
        }),
    };
  };

type FakeBill = { number: string; updateDate: string };

// The older fixtures: rows that show their full update time. Reads `bills` on every request, so a test can add some.
const serveCongressList = (bills: FakeBill[]) => async (url: string) =>
  serveBillList(
    bills.map((bill) => ({ number: bill.number, at: bill.updateDate })),
    { showFullTime: true },
  )(url);

// `n` bills `stepSeconds` apart from `startIso`, numbered from `first`.
const billsEvery = (n: number, startIso: string, stepSeconds: number, first = 1): ListedBill[] =>
  Array.from({ length: n }, (_, index) => ({
    number: String(first + index),
    at: new Date(Date.parse(startIso) + index * stepSeconds * 1000).toISOString(),
  }));

const guidsOf = (bills: Array<{ number: string }>): string[] => bills.map((bill) => `BILLS-119hr${bill.number}`);

const enqueuedGuids = (): string[] =>
  mockSQSSend.mock.calls.flatMap(([cmd]) =>
    (cmd.input.Entries as Array<{ MessageBody: string }>).map((entry) => JSON.parse(entry.MessageBody).guid as string),
  );

const metricData = (metricName: string): Array<{ MetricName: string; Dimensions?: unknown; Value: number }> =>
  mockCloudWatchSend.mock.calls.flatMap(([cmd]) =>
    (cmd.input.MetricData ?? []).filter((datum: { MetricName?: string }) => datum.MetricName === metricName),
  );

const okEmptyPage = () => ({
  ok: true,
  status: 200,
  text: () => Promise.resolve(JSON.stringify({ bills: [], pagination: {} })),
});

const statusResponse = (status: number) => ({
  ok: false,
  status,
  headers: { get: () => null },
  text: () => Promise.resolve(`status ${status}`),
});

const reloadHandler = (env: Record<string, string>) => {
  jest.resetModules();
  Object.assign(process.env, env);
  handler = require("../handlers/billsApiPoller").handler;
};

const requestUrls = (): URL[] => mockFetch.mock.calls.map(([url]) => new URL(String(url)));

// Runs the handler at `iso` and returns the guids that run enqueued.
const runAt = async (iso: string, context?: PollerContext): Promise<string[]> => {
  jest.setSystemTime(new Date(iso));
  mockSQSSend.mockClear();
  await handler(undefined, context);
  return enqueuedGuids();
};

// REL-06 and REL-56: a window that takes more than one run (the page cap, the soft stop) is read in full over the next
// runs, with the same top, before the watermark moves; nothing in it is skipped.
describe("billsApiPoller windows across runs (REL-06, REL-56)", () => {
  const cursorIso = "2026-03-01T00:00:00.000Z";
  // 600 updates after the cursor, one a minute from 2026-03-02T00:00Z, newest first: more than two pages.
  const backlogBills = () => billsEvery(600, "2026-03-02T00:00:00.000Z", 60);

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick"] });
    jest.setSystemTime(new Date("2026-03-02T10:00:00.000Z"));
  });

  it("enqueues every row in the window, its overlap included, and none before it", async () => {
    const bills: FakeBill[] = [
      ...[7, 6, 5].map((n) => ({ number: String(n), updateDate: `2026-03-02T0${n}:00:00Z` })),
      // Inside the 120 s overlap before the cursor: enqueued again (at least once, never skipped).
      { number: "900", updateDate: "2026-02-28T23:59:00Z" },
      { number: "901", updateDate: "2026-02-28T23:58:00Z" },
      // Before the window.
      { number: "902", updateDate: "2026-02-28T23:57:59Z" },
    ];
    mockFetch.mockImplementation(serveCongressList(bills));

    const result = await handler();

    expect(result.discovered).toBe(5);
    expect(enqueuedGuids()).toEqual(guidsOf([7, 6, 5, 900, 901].map((n) => ({ number: String(n) }))));
    const url = requestUrls()[0];
    expect(url.searchParams.get("fromDateTime")).toBe("2026-02-28T23:58:00Z");
    expect(url.searchParams.get("toDateTime")).toBe("2026-03-02T10:00:00Z");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("limit")).toBe("250");
    // Newest first: the offsets, the overlap and the drift checks rely on this order.
    expect(url.searchParams.get("sort")).toBe("updateDate+desc");
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-03-02T10:00:00.000Z"));
    // The fields code from before REL-56 reads: the midnight that starts the next window.
    expect(persistedState.cursors.hr).toMatchObject({
      lastUpdateAt: "2026-03-02T00:00:00.000Z",
      lastSeenKey: "2026-03-02T00:00:00.000Z#",
    });
  });

  it("keeps the watermark when MAX_PAGES_PER_BILL_TYPE stops the scan, and reads the rest of the same window next run", async () => {
    reloadHandler({ MAX_PAGES_PER_BILL_TYPE: "2" });
    const bills = backlogBills();
    mockFetch.mockImplementation(serveBillList(bills));

    // Run 1 reads offsets 0 and 225 (each page reads the last 25 rows of the one before again), then hits the cap.
    const run1 = await runAt("2026-03-02T10:00:00.000Z");
    expect(new Set(run1)).toEqual(new Set(guidsOf(bills.slice(125))));
    expect(persistedState.cursors.hr).toEqual(
      cursorAtWatermark("2026-03-01T00:00:00.000Z", true, {
        to: "2026-03-02T10:00:00.000Z",
        offset: 450,
        count: 600,
      }),
    );
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Bill-type scan incomplete"),
        billType: "hr",
        reason: "max_pages",
      }),
    );

    // Updates while the backlog is read: one bill already read and one not yet read leave the window (their new
    // time is after its top), and a new bill arrives. None is lost.
    const readEarlier = bills[599];
    const notReadYet = bills[0];
    readEarlier.at = "2026-03-02T10:01:00.000Z";
    notReadYet.at = "2026-03-02T10:02:00.000Z";
    bills.push({ number: "9000", at: "2026-03-02T10:03:00.000Z" });

    // Run 2 reads the same window, same top, from offset 450, and finishes it: the watermark moves to its top.
    mockFetch.mockClear();
    const run2 = await runAt("2026-03-02T10:05:00.000Z");
    const resumed = requestUrls()[0];
    expect(resumed.searchParams.get("fromDateTime")).toBe("2026-02-28T23:58:00Z");
    expect(resumed.searchParams.get("toDateTime")).toBe("2026-03-02T10:00:00Z");
    expect(resumed.searchParams.get("offset")).toBe("450");
    expect(run2).not.toContain("BILLS-119hr9000");
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-03-02T10:00:00.000Z"));

    // Run 3 lists the next window: the three updates made during the backlog, and the rows of its 120 s overlap.
    const run3 = await runAt("2026-03-02T10:10:00.000Z");
    expect(run3).toEqual(
      expect.arrayContaining([
        "BILLS-119hr9000",
        `BILLS-119hr${notReadYet.number}`,
        `BILLS-119hr${readEarlier.number}`,
      ]),
    );
    expect(new Set([...run1, ...run2, ...run3])).toEqual(new Set([...guidsOf(bills)]));

    // Run 4 finds only its overlap.
    expect(await runAt("2026-03-02T10:15:00.000Z")).toEqual([]);
  });

  it("covers every bill across runs whatever the page cap", async () => {
    for (const maxPages of ["1", "2", "3"]) {
      reloadHandler({ MAX_PAGES_PER_BILL_TYPE: maxPages });
      persistedState.cursors = { hr: { lastUpdateAt: cursorIso, lastSeenKey: `${cursorIso}#` } };
      const bills = backlogBills();
      mockFetch.mockImplementation(serveBillList(bills));

      const seen = new Set<string>();
      let minute = 0;
      do {
        for (const guid of await runAt(
          new Date(Date.parse("2026-03-02T10:00:00.000Z") + minute * 60_000).toISOString(),
        )) {
          seen.add(guid);
        }
        minute += 5;
      } while (persistedState.cursors.hr.backlog && minute < 60);

      expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-03-02T10:00:00.000Z"));
      expect(seen).toEqual(new Set(guidsOf(bills)));
    }
  });

  it("keeps the watermark when the soft stop interrupts a scan, then reads the rest of the window", async () => {
    const bills = backlogBills();
    mockFetch.mockImplementation(serveBillList(bills));
    // Plenty of time for the first page, then below the reserve for one more request.
    const context = { getRemainingTimeInMillis: () => (mockFetch.mock.calls.length >= 1 ? 1_000 : 60_000) };

    const run1 = await runAt("2026-03-02T10:00:00.000Z", context);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(new Set(run1)).toEqual(new Set(guidsOf(bills.slice(350))));
    expect(persistedState.cursors.hr).toEqual(
      cursorAtWatermark("2026-03-01T00:00:00.000Z", true, {
        to: "2026-03-02T10:00:00.000Z",
        offset: 225,
        count: 600,
      }),
    );

    const run2 = await runAt("2026-03-02T10:05:00.000Z");

    expect(new Set(run2)).toEqual(new Set(guidsOf(bills.slice(0, 375))));
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-03-02T10:00:00.000Z"));
  });
});

describe("billsApiPoller enqueue timing", () => {
  const bills = billsEvery(600, "2026-03-02T00:00:00.000Z", 60);

  it("sends each page's bills before requesting the next page", async () => {
    mockFetch.mockImplementation(serveBillList(bills));

    const result = await handler();

    expect(result.processed).toBe(600);
    expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["0", "225", "450"]);
    // Fetch, send, fetch, send, ...: page N's sends happen before page N+1 is requested.
    const fetchOrder = mockFetch.mock.invocationCallOrder;
    const sendOrder = mockSQSSend.mock.invocationCallOrder;
    expect(sendOrder[0]).toBeGreaterThan(fetchOrder[0]);
    expect(sendOrder[0]).toBeLessThan(fetchOrder[1]);
    expect(new Set(enqueuedGuids()).size).toBe(600);
  });

  it("keeps sent pages and the backlog when a soft stop comes mid-window", async () => {
    mockFetch.mockImplementation(serveBillList(bills));
    const context = { getRemainingTimeInMillis: () => (mockFetch.mock.calls.length >= 2 ? 1_000 : 60_000) };

    const result = await handler(undefined, context);

    expect(result.processed).toBe(475);
    expect(new Set(enqueuedGuids())).toEqual(new Set(guidsOf(bills.slice(125))));
    expect(persistedState.cursors.hr.backlog).toMatchObject({ offset: 450, count: 600 });
  });

  it("reserves time to enqueue a full page one message at a time when QUEUE_BATCH_SIZE is 1", async () => {
    reloadHandler({ QUEUE_BATCH_SIZE: "1" });
    mockFetch.mockImplementation(serveBillList(bills));
    // 20 s covers a request plus the soft-stop margin (12 s) but not 250 single-message sends as well.
    const context = { getRemainingTimeInMillis: () => 20_000 };

    const result = await handler(undefined, context);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(persistedState.cursors.hr).toEqual({
      lastUpdateAt: "2026-03-01T00:00:00.000Z",
      lastSeenKey: "2026-03-01T00:00:00.000Z#",
    });
  });
});

describe("billsApiPoller congress.gov request handling", () => {
  it("raises the default request timeout to 10 s and applies it as a fetch deadline (REL-25)", async () => {
    mockFetch.mockResolvedValue(okEmptyPage());

    await handler();

    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Starting bills API poll", requestTimeoutMs: 10000 }),
    );
    expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.anything() }));
  });

  it("logs a timed-out request that recovers on retry at INFO without a stack, not as an error (REL-25)", async () => {
    mockFetch
      .mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
      .mockResolvedValueOnce(okEmptyPage());

    const result = await handler();

    expect(result.status).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(console.error).not.toHaveBeenCalled();
    // A retry of an unavailable congress.gov is routine: the outage warning reports it if it never recovers.
    expect(logLinesWithMessage(console.log, "Congress API request will be retried")).toEqual([
      expect.objectContaining({ level: "INFO", reason: "timed out after 10000ms", attempt: 1 }),
    ]);
    expect(logLines(console.warn)).toEqual([]);
    for (const line of logLines(console.log)) {
      expect(JSON.stringify(line)).not.toContain('"stack"');
    }
  });

  it.each([
    [429, "status 429"],
    [501, "status 501"],
  ])("still warns, without a stack, when it retries a %i", async (status, reason) => {
    mockFetch.mockResolvedValueOnce(statusResponse(status)).mockResolvedValueOnce(okEmptyPage());

    await expect(handler()).resolves.toMatchObject({ status: "ok" });

    expect(logLinesWithMessage(console.warn, "Congress API request will be retried")).toEqual([
      expect.objectContaining({ level: "WARN", reason, attempt: 1 }),
    ]);
    expect(logLinesWithMessage(console.log, "Congress API request will be retried")).toEqual([]);
    expect(JSON.stringify(logLines(console.warn))).not.toContain('"stack"');
  });

  it("gives up on a timing-out request only after the final retry, keeping the cursor", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    mockFetch.mockRejectedValue(timeout);

    await expect(handler()).resolves.toMatchObject({ status: "congress_api_unavailable" });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(persistedState.cursors.hr.lastSeenKey).toBe("2026-03-01T00:00:00.000Z#");
  });

  it("stops cleanly, keeping the cursor, when there is no Lambda time left to retry (REL-25)", async () => {
    mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    // Enough for the first attempt, then less than one request timeout plus the soft-stop margin.
    const context = { getRemainingTimeInMillis: () => (mockFetch.mock.calls.length >= 1 ? 5_000 : 60_000) };

    const result = await handler(undefined, context);

    // The last answer was a timeout, so the run counts as an outage rather than a poll.
    expect(result).toEqual({ status: "congress_api_unavailable", processed: 0, discovered: 0, initialized: false });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(persistedState.cursors.hr.lastSeenKey).toBe("2026-03-01T00:00:00.000Z#");
    expect(console.error).not.toHaveBeenCalled();
    expect(logLinesWithMessage(console.warn, /^congress\.gov unavailable/)).toEqual([
      expect.objectContaining({ reason: "timed out after 10000ms; no Lambda time left to retry", attempts: 1 }),
    ]);
  });

  it("still soft-stops, as a poll, when a 429 leaves no Lambda time to retry", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: () => null },
      text: () => Promise.resolve(""),
    });
    const context = { getRemainingTimeInMillis: () => (mockFetch.mock.calls.length >= 1 ? 5_000 : 60_000) };

    const result = await handler(undefined, context);

    expect(result.status).toBe("ok");
    expect(metricData("CongressApiUnavailable")).toEqual([]);
    expect(persistedState.cursors.hr.lastSeenKey).toBe("2026-03-01T00:00:00.000Z#");
  });

  it("emits CongressApi429 with no dimensions when congress.gov throttles (OBS-05)", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null }, text: () => Promise.resolve("") })
      .mockResolvedValueOnce(okEmptyPage());

    await handler();

    const throttled = metricData("CongressApi429");
    expect(throttled).toEqual([{ MetricName: "CongressApi429", Unit: "Count", Value: 1 }]);
    const namespaces = mockCloudWatchSend.mock.calls
      .filter(([cmd]) =>
        cmd.input.MetricData.some((datum: { MetricName: string }) => datum.MetricName === "CongressApi429"),
      )
      .map(([cmd]) => cmd.input.Namespace);
    expect(namespaces).toEqual(["BillBoard/BillIngestion"]);
  });

  it("re-reads the API key and retries once when congress.gov returns 401 (REL-13)", async () => {
    mockSecretsSend
      .mockResolvedValueOnce({ SecretString: JSON.stringify({ congressApiKey: "old-key" }) })
      .mockResolvedValueOnce({ SecretString: JSON.stringify({ congressApiKey: "new-key" }) });
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 401, headers: { get: () => null }, text: () => Promise.resolve("") })
      .mockResolvedValueOnce(okEmptyPage());

    const result = await handler();

    expect(result.status).toBe("ok");
    expect(mockSecretsSend).toHaveBeenCalledTimes(2);
    expect(new URL(String(mockFetch.mock.calls[0][0])).searchParams.get("api_key")).toBe("old-key");
    expect(new URL(String(mockFetch.mock.calls[1][0])).searchParams.get("api_key")).toBe("new-key");
    expect(metricData("CongressApiAuthFailure")).toEqual([]);
  });

  it("emits CongressApiAuthFailure and fails when the re-read key is also rejected (REL-13)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: () => Promise.resolve("Forbidden"),
    });

    await expect(handler()).rejects.toMatchObject({ name: "CongressApiError", status: 403 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockSecretsSend).toHaveBeenCalledTimes(2);
    expect(metricData("CongressApiAuthFailure")).toEqual([
      { MetricName: "CongressApiAuthFailure", Unit: "Count", Value: 1 },
    ]);
  });

  it("does not put the API key in errors for unparseable responses", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("<html>") });

    await expect(handler()).rejects.toThrow(/api_key=REDACTED/);
    await expect(handler()).rejects.not.toThrow(/test-key/);
  });
});

describe("billsApiPoller congress.gov outages", () => {
  const cursorIso = "2026-03-01T00:00:00.000Z";
  const untouchedCursor = { lastUpdateAt: cursorIso, lastSeenKey: `${cursorIso}#` };
  const OUTAGE_MESSAGE = "congress.gov unavailable; run ended early with every cursor kept";
  const outageWarnings = () => logLinesWithMessage(console.warn, OUTAGE_MESSAGE);
  const unavailableMetric = [{ MetricName: "CongressApiUnavailable", Unit: "Count", Value: 1 }];

  // The poller's own retries (CONGRESS_API_MAX_RETRIES=2) come first: 3 requests for the page.
  const expectOutageRun = (
    result: Awaited<HandlerReturn>,
    warning: { billType?: string; status: number | null; reason: string },
  ) => {
    expect(result).toEqual({ status: "congress_api_unavailable", processed: 0, discovered: 0, initialized: false });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(persistedState.cursors.hr).toEqual(untouchedCursor);
    expect(metricData("CongressApiUnavailable")).toEqual(unavailableMetric);
    const namespaces = mockCloudWatchSend.mock.calls
      .filter(([cmd]) =>
        cmd.input.MetricData.some((datum: { MetricName: string }) => datum.MetricName === "CongressApiUnavailable"),
      )
      .map(([cmd]) => cmd.input.Namespace);
    expect(namespaces).toEqual(["BillBoard/BillIngestion"]);
    // One warning, for the outcome; the two routine retries before it are at INFO. Nothing at error level, no stack.
    expect(logLines(console.warn).map((line) => line.message)).toEqual([OUTAGE_MESSAGE]);
    expect(logLinesWithMessage(console.log, "Congress API request will be retried")).toEqual([
      expect.objectContaining({ level: "INFO", reason: warning.reason, attempt: 1 }),
      expect.objectContaining({ level: "INFO", reason: warning.reason, attempt: 2 }),
    ]);
    expect(outageWarnings()).toEqual([
      expect.objectContaining({
        billType: warning.billType ?? "hr",
        path: "/v3/bill/119/hr",
        status: warning.status,
        reason: warning.reason,
        attempts: 3,
        pagesScanned: 0,
        cursor: untouchedCursor,
      }),
    ]);
    expect(JSON.stringify(outageWarnings())).not.toContain('"stack"');
    expect(console.error).not.toHaveBeenCalled();
  };

  it.each([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530])(
    "ends the run without an error, cursor kept, when congress.gov still answers %i after the retries",
    async (status) => {
      mockFetch.mockResolvedValue(statusResponse(status));

      expectOutageRun(await handler(), { status, reason: `status ${status}` });
    },
  );

  const networkError = (message: string, code: string) =>
    Object.assign(new TypeError(message), { cause: Object.assign(new Error(`${message} (${code})`), { code }) });

  it.each([
    [
      "a request timeout",
      () => new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      "timed out after 10000ms",
    ],
    [
      "a refused connection",
      () => networkError("fetch failed", "ECONNREFUSED"),
      "TypeError: fetch failed (ECONNREFUSED)",
    ],
    ["a DNS failure", () => networkError("fetch failed", "ENOTFOUND"), "TypeError: fetch failed (ENOTFOUND)"],
    [
      "a dropped connection",
      () => networkError("fetch failed", "UND_ERR_SOCKET"),
      "TypeError: fetch failed (UND_ERR_SOCKET)",
    ],
  ])("ends the run without an error, cursor kept, on %s after the retries", async (_label, makeError, reason) => {
    mockFetch.mockImplementation(async () => {
      throw makeError();
    });

    expectOutageRun(await handler(), { status: null, reason });
  });

  it("ends the run without an error when the body is cut off mid-read after the retries", async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(networkError("terminated", "UND_ERR_SOCKET")),
    }));

    expectOutageRun(await handler(), { status: null, reason: "TypeError: terminated (UND_ERR_SOCKET)" });
  });

  it.each([
    [400, 1],
    [401, 2],
    [403, 2],
    [404, 1],
    [429, 3],
    [501, 3],
    [505, 3],
  ])("still fails the run on %i (%i requests), with no outage metric", async (status, requests) => {
    mockFetch.mockResolvedValue(statusResponse(status));

    await expect(handler()).rejects.toMatchObject({ name: "CongressApiError", status });
    expect(mockFetch).toHaveBeenCalledTimes(requests);
    expect(persistedState.cursors.hr).toEqual(untouchedCursor);
    expect(metricData("CongressApiUnavailable")).toEqual([]);
    expect(outageWarnings()).toEqual([]);
  });

  it("still fails the run on an error of our own from fetch", async () => {
    const bug = new TypeError("Headers.append: invalid header value");
    mockFetch.mockRejectedValue(bug);

    await expect(handler()).rejects.toBe(bug);
    expect(metricData("CongressApiUnavailable")).toEqual([]);
  });

  // undici's "fetch failed" with no connection-failure code on its cause: a blocked port, a redirect loop or a
  // redirect to another scheme, headers too large, a TLS failure. A bad URL or a runtime change can cause these.
  it.each([
    ["a blocked port", new Error("bad port")],
    ["a redirect loop", new Error("redirect count exceeded")],
    ["headers too large", Object.assign(new Error("Headers Overflow Error"), { code: "UND_ERR_HEADERS_OVERFLOW" })],
    ["an expired certificate", Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" })],
  ])("still fails the run, after the retries, when fetch fails with %s", async (_label, cause) => {
    const failure = Object.assign(new TypeError("fetch failed"), { cause });
    mockFetch.mockRejectedValue(failure);

    await expect(handler()).rejects.toBe(failure);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(persistedState.cursors.hr).toEqual(untouchedCursor);
    expect(metricData("CongressApiUnavailable")).toEqual([]);
    expect(outageWarnings()).toEqual([]);
    // Its retries still warn: they are not an outage.
    expect(logLinesWithMessage(console.warn, "Congress API request will be retried")).toHaveLength(2);
  });

  it("still fails the run on a malformed body", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("<html>Service Unavailable") });

    await expect(handler()).rejects.toThrow(/not valid JSON/);
    expect(metricData("CongressApiUnavailable")).toEqual([]);
  });

  // REL-56: read as an empty list, such an answer would move the watermark past a window nobody listed.
  it.each([
    ["no list at all", "{}", /holds no bill list/],
    ["a null list", '{"bills":null,"pagination":{"count":3}}', /holds no bill list/],
    ["an error object", '{"error":{"code":"API_KEY_MISSING"}}', /holds no bill list/],
    ["no rows where it counts some", '{"bills":[],"pagination":{"count":39}}', /no bill at offset 0 but counts 39/],
  ])("fails the run and keeps the cursor on a 200 answer with %s", async (_label, body, message) => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick"] });
    jest.setSystemTime(new Date("2026-03-02T10:00:00.000Z"));
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(body) });

    const error = await handler().then(
      () => null,
      (failure: Error) => failure,
    );

    expect(error?.message).toMatch(message);
    expect(error?.message).not.toContain("test-key");
    expect(persistedState.cursors.hr).toEqual(untouchedCursor);
    expect(metricData("CongressApiUnavailable")).toEqual([]);
  });

  it("reads an answer with no list that counts no rows as an empty list", async () => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick"] });
    jest.setSystemTime(new Date("2026-03-02T10:00:00.000Z"));
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{"pagination":{"count":0}}') });

    await expect(handler()).resolves.toMatchObject({ status: "ok", processed: 0 });
    // Its cursor never named a bill, and this list has none: not listed yet.
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-03-02T10:00:00.000Z", false));
  });

  it.each([
    [
      "an SQS send",
      () => mockSQSSend.mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })),
    ],
    [
      "reading the API key",
      () => mockSecretsSend.mockRejectedValue(Object.assign(new Error("Socket timed out"), { name: "TimeoutError" })),
    ],
    [
      "reading the state",
      () => mockSSMSend.mockRejectedValue(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })),
    ],
  ])("still fails the run when AWS fails (%s), even with a network-looking error", async (_label, breakIt) => {
    mockFetch.mockImplementation(serveCongressList([{ number: "5", updateDate: "2026-03-02T05:00:00Z" }]));
    breakIt();

    await expect(handler()).rejects.toThrow();
    expect(metricData("CongressApiUnavailable")).toEqual([]);
  });

  it("keeps the bill types finished before the outage and leaves the rest where they were", async () => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick"] });
    jest.setSystemTime(new Date("2026-03-02T10:00:00.000Z"));
    reloadHandler({ BILL_TYPES: "hr,s,hjres" });
    persistedState.cursors.s = { ...untouchedCursor };
    persistedState.cursors.hjres = { ...untouchedCursor };
    const serveHr = serveCongressList([{ number: "5", updateDate: "2026-03-02T05:00:00Z" }]);
    mockFetch.mockImplementation(async (url: string) =>
      new URL(url).pathname.endsWith("/hr") ? serveHr(url) : statusResponse(503),
    );

    const result = await handler();

    expect(result).toEqual({ status: "congress_api_unavailable", processed: 1, discovered: 1, initialized: false });
    expect(mockFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/v3/bill/119/hr",
      "/v3/bill/119/s",
      "/v3/bill/119/s",
      "/v3/bill/119/s",
    ]);
    // The types not reached keep their cursors as they were, in the shape from before REL-56.
    expect(persistedState.cursors).toEqual({
      hr: cursorAtWatermark("2026-03-02T10:00:00.000Z"),
      s: untouchedCursor,
      hjres: untouchedCursor,
    });
    expect(outageWarnings()).toEqual([
      expect.objectContaining({ billType: "s", status: 503, billTypesNotPolled: ["hjres"], cursor: untouchedCursor }),
    ]);
    // Not a poll: the lag keeps counting from the last one (here the old lastRunAt), though the run saved state.
    expect(persistedState.lastPolledAt).toBe(cursorIso);
    expect(persistedState.lastRunAt).not.toBe(cursorIso);
  });

  it("keeps the watermark, and the pages read as a backlog, when the outage comes mid-window; the next run misses nothing", async () => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick"] });
    jest.setSystemTime(new Date("2026-03-02T10:00:00.000Z"));
    const bills = billsEvery(600, "2026-03-02T00:00:00.000Z", 60);
    const serve = serveBillList(bills);
    let down = true;
    mockFetch.mockImplementation(async (url: string) =>
      down && new URL(url).searchParams.get("offset") !== "0" ? statusResponse(503) : serve(url),
    );

    const result = await handler();

    expect(result).toMatchObject({ status: "congress_api_unavailable", processed: 250 });
    expect(new Set(enqueuedGuids())).toEqual(new Set(guidsOf(bills.slice(350))));
    // The watermark does not move past the unread pages; the page already read is the backlog's offset.
    const backlogCursor = cursorAtWatermark(cursorIso, true, {
      to: "2026-03-02T10:00:00.000Z",
      offset: 225,
      count: 600,
    });
    expect(persistedState.cursors.hr).toEqual(backlogCursor);
    expect(outageWarnings()).toEqual([expect.objectContaining({ pagesScanned: 1, cursor: backlogCursor })]);
    expect(logLinesWithMessage(console.warn, /Bill-type scan incomplete/)).toEqual([]);

    down = false;
    jest.setSystemTime(new Date("2026-03-02T10:05:00.000Z"));
    mockSQSSend.mockClear();
    await expect(handler()).resolves.toMatchObject({ status: "ok" });

    expect(new Set(enqueuedGuids())).toEqual(new Set(guidsOf(bills.slice(0, 375))));
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-03-02T10:00:00.000Z"));
  });

  it("keeps the lag growing from the last poll through an outage, so it reaches the alarm after an hour, and drops it on the run that polls again", async () => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick"] });
    const at = (minutes: number) => new Date(Date.parse("2026-03-02T10:00:00.000Z") + minutes * 60_000);
    // Billboard-Ingestion-BillPollerLag: 3600 seconds or more (BILL_POLLER_LAG_ALARM_THRESHOLD_SECONDS).
    const LAG_ALARM_SECONDS = 3600;
    let down = false;
    // Each request takes 4 seconds: an outage run makes 3 (12 s), a run that polls 1 (BILL_TYPES=hr).
    mockFetch.mockImplementation(async () => {
      jest.setSystemTime(Date.now() + 4_000);
      return down ? statusResponse(503) : okEmptyPage();
    });
    const runAt = async (minutes: number) => {
      mockCloudWatchSend.mockClear();
      jest.setSystemTime(at(minutes));
      const result = await handler();
      return {
        status: result.status,
        lag: metricData("BillPollerLagSeconds")
          .filter((datum) => !datum.Dimensions)
          .map((datum) => datum.Value),
      };
    };
    const outage = async (lastPoll: number, runs: Array<[number, number]>) => {
      for (const [minutes, lag] of runs) {
        expect(await runAt(minutes)).toEqual({ status: "congress_api_unavailable", lag: [lag] });
        expect(persistedState.lastPolledAt).toBe(at(lastPoll).toISOString());
        expect(persistedState.lastRunAt).toBe(new Date(at(minutes).getTime() + 12_000).toISOString());
      }
    };

    expect(await runAt(0)).toEqual({ status: "ok", lag: [4] });
    expect(persistedState.lastPolledAt).toBe(at(0).toISOString());

    // An outage of under an hour: congress.gov answers again at minute 60. The run that polls then reports a fresh
    // poll, not the hour of staleness it started from, so it does not fire the alarm on its own.
    down = true;
    await outage(0, [
      [5, 312],
      [30, 1812],
      [55, 3312],
    ]);
    down = false;
    expect(await runAt(60)).toEqual({ status: "ok", lag: [4] });
    expect(persistedState.lastPolledAt).toBe(at(60).toISOString());

    // A longer one: the lag reaches the alarm with the first run an hour after that poll, and keeps growing.
    down = true;
    await outage(60, [
      [65, 312],
      [90, 1812],
      [115, 3312],
      [120, LAG_ALARM_SECONDS + 12],
      [125, 3912],
    ]);

    // The first run that gets answers drops it at once.
    down = false;
    expect(await runAt(130)).toEqual({ status: "ok", lag: [4] });
    expect(persistedState.lastPolledAt).toBe(at(130).toISOString());
    expect(await runAt(135)).toEqual({ status: "ok", lag: [4] });
  });
});

describe("billsApiPoller state logging (OBS-18)", () => {
  it("logs the cursor state it persisted", async () => {
    mockFetch.mockImplementation(serveCongressList([{ number: "5", updateDate: "2026-03-02T05:00:00Z" }]));

    await handler();

    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Saved bill poller cursor",
        billType: "hr",
        advanced: true,
        cursor: persistedState.cursors.hr,
      }),
    );
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Saved bill poller state",
        lastRunAt: persistedState.lastRunAt,
        cursors: persistedState.cursors,
      }),
    );
  });
});

describe("billsApiPoller correlation id (OBS-10)", () => {
  it("mints <runStartedAt>:<guid> per enqueued bill, sends it as the correlationId attribute and logs it", async () => {
    const runStartedAt = "2026-03-02T10:00:00.000Z";
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick"] });
    jest.setSystemTime(new Date(runStartedAt));
    mockFetch.mockImplementation(
      serveCongressList([
        { number: "5", updateDate: "2026-03-02T05:00:00Z" },
        { number: "6", updateDate: "2026-03-02T06:00:00Z" },
      ]),
    );

    await handler(undefined, { awsRequestId: "req-1", getRemainingTimeInMillis: () => 60_000 } as PollerContext);

    const entries = mockSQSSend.mock.calls.flatMap(([cmd]) => cmd.input.Entries);
    expect(
      entries.map((entry: { MessageAttributes: unknown; MessageBody: string }) => [
        JSON.parse(entry.MessageBody).guid,
        entry.MessageAttributes,
      ]),
    ).toEqual([
      ["BILLS-119hr6", { correlationId: { DataType: "String", StringValue: `${runStartedAt}:BILLS-119hr6` } }],
      ["BILLS-119hr5", { correlationId: { DataType: "String", StringValue: `${runStartedAt}:BILLS-119hr5` } }],
    ]);
    expect(logLinesWithMessage(console.log, "Enqueued bill")).toEqual([
      expect.objectContaining({
        guid: "BILLS-119hr6",
        correlationId: `${runStartedAt}:BILLS-119hr6`,
        awsRequestId: "req-1",
      }),
      expect.objectContaining({
        guid: "BILLS-119hr5",
        correlationId: `${runStartedAt}:BILLS-119hr5`,
        awsRequestId: "req-1",
      }),
    ]);
  });
});

describe("billsApiPoller BACKFILL_FROM_ISO (REC-05)", () => {
  const stateMissing = () => {
    mockSSMSend.mockImplementation(async (command: { __type?: string; input?: { Value: string } }) => {
      if (command.__type === "GetParameterCommand") {
        throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
      }
      persistedState = JSON.parse(command.input!.Value);
      return {};
    });
  };

  it("starts cursors at now when unset (forward-only default)", async () => {
    stateMissing();
    const before = Date.now();

    const result = await handler();

    expect(result.initialized).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(new Date(persistedState.cursors.hr.watermark!).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(persistedState.cursors.hr.listed).toBe(false);
  });

  it("starts cursors at BACKFILL_FROM_ISO after the state is lost, and the next run scans from there", async () => {
    reloadHandler({ BACKFILL_FROM_ISO: "2026-09-01T00:00:00Z" });
    stateMissing();

    const result = await handler();

    expect(result.initialized).toBe(true);
    expect(persistedState.cursors.hr).toEqual({
      lastUpdateAt: "2026-08-31T00:00:00.000Z",
      lastSeenKey: "2026-08-31T00:00:00.000Z#",
      watermark: "2026-09-01T00:00:00.000Z",
      listed: false,
    });

    mockSSMSend.mockImplementation(async (command: { __type?: string; input?: { Value: string } }) => {
      if (command.__type === "GetParameterCommand") return { Parameter: { Value: JSON.stringify(persistedState) } };
      persistedState = JSON.parse(command.input!.Value);
      return {};
    });
    mockFetch.mockResolvedValue(okEmptyPage());
    await handler();
    expect(new URL(String(mockFetch.mock.calls[0][0])).searchParams.get("fromDateTime")).toBe("2026-08-31T23:58:00Z");
  });

  it("only applies to cursors being created; existing cursors are untouched", async () => {
    reloadHandler({ BACKFILL_FROM_ISO: "2026-09-01T00:00:00Z", BILL_TYPES: "hr,s" });
    mockFetch.mockResolvedValue(okEmptyPage());

    await handler();

    // hr's window starts from its own cursor; s, new, from BACKFILL_FROM_ISO.
    expect(requestUrls().map((url) => [url.pathname, url.searchParams.get("fromDateTime")])).toEqual([
      ["/v3/bill/119/hr", "2026-02-28T23:58:00Z"],
      ["/v3/bill/119/s", "2026-08-31T23:58:00Z"],
    ]);
    expect(persistedState.cursors.s.lastUpdateAt).toBe(persistedState.cursors.hr.lastUpdateAt);
  });

  it("drains a backfill over several runs, every bill once at least, and then lists from the backfill's top", async () => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick"] });
    reloadHandler({ BACKFILL_FROM_ISO: "2026-11-01T00:00:00Z", MAX_PAGES_PER_BILL_TYPE: "2" });
    stateMissing();
    jest.setSystemTime(new Date("2026-11-07T12:00:00.000Z"));
    await expect(handler()).resolves.toMatchObject({ initialized: true });
    mockSSMSend.mockImplementation(async (command: { __type?: string; input?: { Value: string } }) => {
      if (command.__type === "GetParameterCommand") return { Parameter: { Value: JSON.stringify(persistedState) } };
      persistedState = JSON.parse(command.input!.Value);
      return {};
    });
    // 1,500 updates since 2026-11-01, date-only rows: four runs of two pages each.
    const bills = billsEvery(1500, "2026-11-01T00:00:00.000Z", 360);
    mockFetch.mockImplementation(serveBillList(bills));

    const seen = new Set<string>();
    const runs: string[] = [];
    for (let minute = 5; minute <= 60 && (runs.length === 0 || persistedState.cursors.hr.backlog); minute += 5) {
      const iso = new Date(Date.parse("2026-11-07T12:00:00.000Z") + minute * 60_000).toISOString();
      runs.push(iso);
      for (const guid of await runAt(iso)) seen.add(guid);
    }

    expect(runs).toHaveLength(4);
    expect(seen).toEqual(new Set(guidsOf(bills)));
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-11-07T12:05:00.000Z"));
    mockFetch.mockClear();
    await runAt("2026-11-07T12:25:00.000Z");
    expect(requestUrls()[0].searchParams.get("fromDateTime")).toBe("2026-11-07T12:03:00Z");
  });

  it.each(["not-a-date", "2999-01-01T00:00:00Z"])("rejects an invalid or future value (%s)", async (value) => {
    reloadHandler({ BACKFILL_FROM_ISO: value });

    await expect(handler()).rejects.toThrow("Invalid env var BACKFILL_FROM_ISO");
  });
});

describe("billsApiPoller monotonic state save (REL-06 defense in depth)", () => {
  const cursorIso = "2026-03-01T00:00:00.000Z";
  const nowIso = "2026-03-02T10:00:00.000Z";
  // This run lists its whole window, so on its own it would save this cursor.
  const ownHrCursor = cursorAtWatermark(nowIso);

  // Makes the stored parameter read back as `raw` (null: deleted) until this run writes it again.
  const replaceStoredParameter = (raw: string | null) => {
    let current = raw;
    mockSSMSend.mockImplementation(async (command: { __type?: string; input?: { Value: string } }) => {
      if (command.__type === "GetParameterCommand") {
        if (current === null) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
        return { Parameter: { Value: current } };
      }
      current = command.input!.Value;
      persistedState = JSON.parse(current);
      return {};
    });
  };

  // Serves `bills`; on the first list request another poller run saves state (`write`) while this
  // run is still scanning, after this run loaded its state and before it saves.
  const serveWithOverlappingWrite = (bills: ListedBill[], write: () => void) => {
    const serve = serveBillList(bills);
    let written = false;
    mockFetch.mockImplementation(async (url: string) => {
      if (!written) {
        written = true;
        write();
      }
      return serve(url);
    });
  };

  const overlappingRunState = (cursors: Record<string, PersistedCursor>, lastRunAt: string) =>
    JSON.stringify({ schemaVersion: 1, congress: "119", lastRunAt, cursors });

  const mergeWarnings = () => logLinesWithMessage(console.warn, /overlapping run/);

  const oneBill: ListedBill[] = [{ number: "5", at: "2026-03-02T05:00:00Z" }];

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick"] });
    jest.setSystemTime(new Date(nowIso));
  });

  it.each([
    ["a later watermark", cursorAtWatermark("2026-03-02T10:00:30.000Z")],
    [
      "the same watermark and a backlog",
      cursorAtWatermark(nowIso, true, { to: "2026-03-02T10:05:00.000Z", offset: 450, count: 600 }),
    ],
  ])("keeps a newer cursor saved by an overlapping run that finished first (%s)", async (_label, newerCursor) => {
    serveWithOverlappingWrite(oneBill, () =>
      replaceStoredParameter(
        overlappingRunState(
          { hr: newerCursor, hres: cursorAtWatermark("2026-03-02T08:00:00.000Z") },
          // It saved a moment after this run stamped its own state.
          "2026-03-02T10:00:01.000Z",
        ),
      ),
    );

    const result = await handler();

    // The bill this run found is still sent; only the cursor is protected.
    expect(result.processed).toBe(1);
    expect(enqueuedGuids()).toEqual(["BILLS-119hr5"]);
    expect(persistedState.cursors.hr).toEqual(newerCursor);
    // A bill type this run does not poll is kept, not erased.
    expect(persistedState.cursors.hres).toEqual(cursorAtWatermark("2026-03-02T08:00:00.000Z"));
    expect(persistedState.lastRunAt).toBe("2026-03-02T10:00:01.000Z");
    expect(mergeWarnings()[0]).toEqual(
      expect.objectContaining({
        keptStoredCursors: [{ billType: "hr", stored: newerCursor, own: ownHrCursor }],
        keptStoredOnlyBillTypes: ["hres"],
        lastRunAt: { stored: "2026-03-02T10:00:01.000Z", own: nowIso },
      }),
    );
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Saved bill poller cursor", billType: "hr", cursor: newerCursor }),
    );
  });

  it("scans a later bill type from the cursor an overlapping run already advanced", async () => {
    reloadHandler({ BILL_TYPES: "hr,s" });
    persistedState.cursors.s = { lastUpdateAt: cursorIso, lastSeenKey: `${cursorIso}#` };
    const newerS = cursorAtWatermark("2026-03-02T09:00:00.000Z");
    serveWithOverlappingWrite(oneBill, () =>
      replaceStoredParameter(
        overlappingRunState({ hr: persistedState.cursors.hr, s: newerS }, "2026-03-02T09:59:00.000Z"),
      ),
    );

    await handler();

    expect(requestUrls()[1].pathname).toBe("/v3/bill/119/s");
    expect(requestUrls()[1].searchParams.get("fromDateTime")).toBe("2026-03-02T08:58:00Z");
    expect(persistedState.cursors).toEqual({ hr: ownHrCursor, s: ownHrCursor });
    expect(persistedState.lastRunAt).toBe(nowIso);
    // Reported once, by the save that found it, not again by the final save.
    expect(mergeWarnings()).toHaveLength(1);
  });

  it("does not scan a bill type an overlapping run has already listed past this run's start", async () => {
    reloadHandler({ BILL_TYPES: "hr,s" });
    persistedState.cursors.s = { lastUpdateAt: cursorIso, lastSeenKey: `${cursorIso}#` };
    const aheadS = cursorAtWatermark("2026-03-02T10:00:30.000Z");
    serveWithOverlappingWrite(oneBill, () =>
      replaceStoredParameter(
        overlappingRunState({ hr: persistedState.cursors.hr, s: aheadS }, "2026-03-02T10:00:31.000Z"),
      ),
    );

    await handler();

    expect(requestUrls().map((url) => url.pathname)).toEqual(["/v3/bill/119/hr"]);
    expect(persistedState.cursors.s).toEqual(aheadS);
  });

  it("keeps the later lastPolledAt of an overlapping run that polled while this run met an outage, without a warning", async () => {
    reloadHandler({ CONGRESS_API_MAX_RETRIES: "0" });
    let written = false;
    mockFetch.mockImplementation(async () => {
      if (!written) {
        written = true;
        replaceStoredParameter(
          JSON.stringify({
            schemaVersion: 1,
            congress: "119",
            lastRunAt: "2026-03-02T09:59:30.000Z",
            lastPolledAt: "2026-03-02T09:59:00.000Z",
            cursors: { hr: persistedState.cursors.hr },
          }),
        );
      }
      return statusResponse(503);
    });

    await expect(handler()).resolves.toMatchObject({ status: "congress_api_unavailable" });

    expect(persistedState.lastPolledAt).toBe("2026-03-02T09:59:00.000Z");
    expect(persistedState.lastRunAt).toBe(nowIso);
    expect(mergeWarnings()).toEqual([]);
  });

  it.each([
    ["an older watermark", cursorAtWatermark("2026-03-02T09:55:00.000Z")],
    // Before REL-56: its watermark is the midnight of its date, whatever its key.
    [
      "a cursor from before REL-56 dated today",
      { lastUpdateAt: "2026-03-02T09:00:00.000Z", lastSeenKey: "2026-03-02T09:00:00.000Z#BILLS-119hr9" },
    ],
    [
      "an older watermark with a backlog",
      cursorAtWatermark(cursorIso, true, { to: "2026-03-02T09:55:00.000Z", offset: 450, count: 600 }),
    ],
  ])("advances an older stored cursor (%s)", async (_label, olderCursor) => {
    serveWithOverlappingWrite(oneBill, () =>
      replaceStoredParameter(overlappingRunState({ hr: olderCursor }, "2026-03-02T09:00:00.000Z")),
    );

    await handler();

    expect(persistedState.cursors.hr).toEqual(ownHrCursor);
    expect(persistedState.lastRunAt).toBe(nowIso);
    expect(mergeWarnings()).toEqual([]);
  });

  // REL-56: which of two cursors on the same watermark is further along. This run reads one page of 300 rows
  // (MAX_PAGES_PER_BILL_TYPE=1), so it saves a backlog at offset 225 on the watermark 2026-03-01T00:00:00Z: 75 rows
  // left below its offset. Between two backlogs of one window, fewer rows left is further along (the window only loses
  // rows, and a later page sees the rest moved up by as many), then the later reading (the lower count).
  describe("on the same watermark", () => {
    const own = cursorAtWatermark(cursorIso, true, { to: nowIso, offset: 225, count: 300 });

    it.each([
      [
        "fewer rows left in the same window",
        cursorAtWatermark(cursorIso, true, { to: nowIso, offset: 450, count: 500 }),
        "stored",
      ],
      [
        "more rows left in the same window",
        cursorAtWatermark(cursorIso, true, { to: nowIso, offset: 100, count: 300 }),
        "own",
      ],
      [
        "a higher offset but more rows left",
        cursorAtWatermark(cursorIso, true, { to: nowIso, offset: 300, count: 400 }),
        "own",
      ],
      // A scan that stepped back for 100 rows that left the window: as far along, and read later.
      [
        "as many rows left, read later",
        cursorAtWatermark(cursorIso, true, { to: nowIso, offset: 125, count: 200 }),
        "stored",
      ],
      [
        "as many rows left, read earlier",
        cursorAtWatermark(cursorIso, true, { to: nowIso, offset: 325, count: 400 }),
        "own",
      ],
      // Without a count a backlog is read from its window's top again (parseBacklog), whatever its offset.
      ["a higher offset without a count", cursorAtWatermark(cursorIso, true, { to: nowIso, offset: 450 }), "own"],
      [
        "an earlier window top",
        cursorAtWatermark(cursorIso, true, { to: "2026-03-02T09:55:00.000Z", offset: 450, count: 300 }),
        "own",
      ],
      [
        "a later window top",
        cursorAtWatermark(cursorIso, true, { to: "2026-03-02T10:00:01.000Z", offset: 0, count: 300 }),
        "stored",
      ],
      ["no backlog", cursorAtWatermark(cursorIso, true), "own"],
      [
        "the same backlog, for a type not listed yet",
        cursorAtWatermark(cursorIso, false, { to: nowIso, offset: 225, count: 300 }),
        "own",
      ],
      // A cursor from before REL-56 on that day has no backlog.
      ["a cursor from before REL-56", { lastUpdateAt: cursorIso, lastSeenKey: `${cursorIso}#BILLS-119hr9` }, "own"],
      ["a later watermark", cursorAtWatermark("2026-03-01T00:00:01.000Z", false), "stored"],
    ])("keeps the further along of this run's backlog and %s", async (_label, storedCursor, kept) => {
      reloadHandler({ MAX_PAGES_PER_BILL_TYPE: "1" });
      serveWithOverlappingWrite(billsEvery(300, "2026-03-02T00:00:00.000Z", 60), () =>
        replaceStoredParameter(overlappingRunState({ hr: storedCursor }, "2026-03-02T09:00:00.000Z")),
      );

      await handler();

      expect(persistedState.cursors.hr).toEqual(kept === "own" ? own : storedCursor);
      expect(mergeWarnings()).toHaveLength(kept === "own" ? 0 : 1);
    });
  });

  it.each([
    ["deleted", null],
    ["not JSON", "{not json"],
    [
      "an unknown schema version",
      JSON.stringify({ schemaVersion: 2, congress: "119", lastRunAt: nowIso, cursors: {} }),
    ],
  ])("falls back to the run's own state when the stored value is %s", async (_label, raw) => {
    serveWithOverlappingWrite(oneBill, () => replaceStoredParameter(raw));

    await handler();

    expect(persistedState).toEqual({
      schemaVersion: 1,
      congress: "119",
      lastRunAt: nowIso,
      lastPolledAt: nowIso,
      cursors: { hr: ownHrCursor },
    });
    expect(mergeWarnings()).toEqual([]);
  });

  // REL-46: with POLL_TARGETS a state stored for another congress is never overwritten, even one written while the run
  // was scanning. Without POLL_TARGETS the run replaces it, as before.
  const otherCongressState = JSON.stringify({
    schemaVersion: 1,
    congress: "118",
    lastRunAt: "2026-03-02T10:00:01.000Z",
    cursors: {
      hr: { lastUpdateAt: "2026-03-02T09:00:00.000Z", lastSeenKey: "2026-03-02T09:00:00.000Z#BILLS-118hr9" },
    },
  });

  // Legacy only: billsApiPollerTargets.test.ts reruns this file with POLL_TARGETS set, where that state is never replaced.
  (originalEnv.POLL_TARGETS ? it.skip : it)(
    "replaces a state stored for another congress mid-run when POLL_TARGETS is unset, as before",
    async () => {
      serveWithOverlappingWrite(oneBill, () => replaceStoredParameter(otherCongressState));

      await handler();

      expect(persistedState).toEqual({
        schemaVersion: 1,
        congress: "119",
        lastRunAt: nowIso,
        lastPolledAt: nowIso,
        cursors: { hr: ownHrCursor },
      });
      expect(mergeWarnings()).toEqual([]);
    },
  );

  it("never overwrites a state stored for another congress mid-run when POLL_TARGETS is set (REL-46)", async () => {
    reloadHandler({ POLL_TARGETS: "119=/test/bills/state" });
    let puts = 0;
    serveWithOverlappingWrite(oneBill, () => {
      replaceStoredParameter(otherCongressState);
      const replaced = mockSSMSend.getMockImplementation()!;
      mockSSMSend.mockImplementation(async (command: { __type?: string }) => {
        if (command.__type === "PutParameterCommand") puts += 1;
        return replaced(command);
      });
    });

    await handler();

    expect(puts).toBe(0);
    // The bill found before the save is still sent; only the stored state is protected.
    expect(enqueuedGuids()).toEqual(["BILLS-119hr5"]);
    expect(logLinesWithMessage(console.error, /stored for another congress/)).toEqual([
      expect.objectContaining({ congress: "119", storedCongress: "118", stateParameter: "/test/bills/state" }),
    ]);
    // With a Congress dimension, and without one for Billboard-Ingestion-BillPollerStateMismatch.
    expect(metricData("BillPollerStateMismatch")).toEqual(
      expect.arrayContaining([
        {
          MetricName: "BillPollerStateMismatch",
          Dimensions: [{ Name: "Congress", Value: "119" }],
          Unit: "Count",
          Value: 1,
        },
        { MetricName: "BillPollerStateMismatch", Unit: "Count", Value: 1 },
      ]),
    );
  });
});

describe("billsApiPoller several Congresses (REL-46)", () => {
  const STATE_119 = "/test/bills/state";
  const STATE_120 = "/test/bills/state-120";
  const POLL_TARGETS = `119=${STATE_119},120=${STATE_120}`;
  const START_120 = "2027-01-03T17:00:00.000Z";

  type Row = { number: string; updateDate: string; actionDate?: string; action?: string };

  let parameters: Record<string, string>;
  let ssmCalls: Array<{ op: "get" | "put"; name: string }>;

  // Every cursor at `watermark`; at the 120th's start no bill type has been listed yet.
  const stateFor = (congress: string, watermark: string, types = ["hr", "s"], listed = watermark !== START_120) =>
    JSON.stringify({
      schemaVersion: 1,
      congress,
      lastRunAt: watermark,
      lastPolledAt: watermark,
      cursors: Object.fromEntries(types.map((type) => [type, cursorAtWatermark(watermark, listed)])),
    });
  const stored = (name: string) => JSON.parse(parameters[name]);
  const putsTo = (name: string) => ssmCalls.filter((call) => call.op === "put" && call.name === name).length;
  const requestedPaths = () => mockFetch.mock.calls.map(([url]) => new URL(String(url)).pathname);

  // congress.gov's /bill/{congress}/{type}, keyed "<congress>/<type>": honours fromDateTime and toDateTime, newest
  // first, one page. `failing` answers a status instead, for a path or a whole Congress ("120").
  const serveCongresses =
    (rows: Record<string, Row[]>, failing: Record<string, number> = {}) =>
    async (url: string) => {
      const requested = new URL(url);
      const key = requested.pathname.replace(/^\/v3\/bill\//, "");
      const [congress, type] = key.split("/");
      const status = failing[key] ?? failing[congress];
      if (status) return statusResponse(status);
      const from = requested.searchParams.get("fromDateTime");
      const to = requested.searchParams.get("toDateTime");
      const page = (rows[key] ?? [])
        .filter((row) => (!from || row.updateDate >= from) && (!to || row.updateDate <= to))
        .sort((a, b) => b.updateDate.localeCompare(a.updateDate));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            bills: page.map((row) => ({
              congress: Number(congress),
              type: type.toUpperCase(),
              number: row.number,
              title: `${type} ${row.number}`,
              updateDate: row.updateDate,
              ...(row.action ? { latestAction: { actionDate: row.actionDate, text: row.action } } : {}),
            })),
            pagination: {},
          }),
      };
    };

  const at = (iso: string) => jest.setSystemTime(new Date(iso));
  const lagData = () =>
    metricData("BillPollerLagSeconds").map((datum) => ({
      congress: (datum.Dimensions as Array<{ Value: string }> | undefined)?.[0]?.Value ?? null,
      value: datum.Value,
    }));
  const congressMetric = (metricName: string, congress: string) =>
    metricData(metricName)
      .filter((datum) => JSON.stringify(datum.Dimensions) === JSON.stringify([{ Name: "Congress", Value: congress }]))
      .map((datum) => datum.Value);

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick"] });
    reloadHandler({ POLL_TARGETS, BILL_TYPES: "hr,s" });
    parameters = {};
    ssmCalls = [];
    mockSSMSend.mockImplementation(async (command: { __type?: string; input: { Name: string; Value?: string } }) => {
      const { Name, Value } = command.input;
      if (command.__type === "GetParameterCommand") {
        ssmCalls.push({ op: "get", name: Name });
        if (!(Name in parameters)) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
        return { Parameter: { Value: parameters[Name] } };
      }
      ssmCalls.push({ op: "put", name: Name });
      parameters[Name] = Value!;
      return {};
    });
    mockFetch.mockImplementation(serveCongresses({}));
  });

  it("initializes the 120th at its start, keeps polling the 119th, and polls the 120th from the next run", async () => {
    at("2027-01-04T12:00:00.000Z");
    parameters[STATE_119] = stateFor("119", "2027-01-04T11:55:00.000Z");
    parameters[STATE_120] = "UNINITIALIZED";

    const first = await handler();

    expect(first).toMatchObject({ status: "ok", initialized: true });
    expect(stored(STATE_120)).toEqual({
      schemaVersion: 1,
      congress: "120",
      lastRunAt: "2027-01-04T12:00:00.000Z",
      lastPolledAt: "2027-01-04T12:00:00.000Z",
      // REL-56: the watermark at the start; the fields for code from before REL-56 at that day's midnight.
      cursors: {
        hr: cursorAtWatermark(START_120, false),
        s: cursorAtWatermark(START_120, false),
      },
    });
    expect(stored(STATE_120).cursors.hr.lastSeenKey).toBe("2027-01-03T00:00:00.000Z#");
    expect(requestedPaths()).toEqual(["/v3/bill/119/hr", "/v3/bill/119/s"]);
    expect(stored(STATE_119).congress).toBe("119");
    expect(logLinesWithMessage(console.log, /^Initialized bill poller state/)).toEqual([
      expect.objectContaining({ congress: "120", stateParameter: STATE_120, cursorsStartAt: START_120 }),
    ]);

    mockFetch.mockClear();
    at("2027-01-04T12:05:00.000Z");
    await handler();

    expect(requestedPaths()).toEqual(["/v3/bill/120/hr", "/v3/bill/120/s", "/v3/bill/119/hr", "/v3/bill/119/s"]);
    const firstUrl = new URL(String(mockFetch.mock.calls[0][0]));
    expect(firstUrl.searchParams.get("fromDateTime")).toBe("2027-01-03T16:58:00Z");
    expect(firstUrl.searchParams.get("toDateTime")).toBe("2027-01-04T12:05:00Z");
    // Every write to the 119th parameter kept congress 119.
    expect(stored(STATE_119).congress).toBe("119");
    expect(stored(STATE_120).congress).toBe("120");
  });

  it("does not touch the 120th before noon ET on 2027-01-03, then turns it on by itself", async () => {
    parameters[STATE_119] = stateFor("119", "2026-12-20T11:55:00.000Z");
    parameters[STATE_120] = "UNINITIALIZED";

    for (const iso of ["2026-12-20T12:00:00.000Z", "2027-01-03T16:59:59.000Z"]) {
      at(iso);
      mockFetch.mockClear();
      await expect(handler()).resolves.toMatchObject({ status: "ok", initialized: false });
      expect(requestedPaths()).toEqual(["/v3/bill/119/hr", "/v3/bill/119/s"]);
    }
    expect(ssmCalls.filter((call) => call.name !== STATE_119)).toEqual([]);
    expect(parameters[STATE_120]).toBe("UNINITIALIZED");

    at("2027-01-03T17:00:00.000Z");
    await expect(handler()).resolves.toMatchObject({ status: "ok", initialized: true });
    expect(stored(STATE_120).cursors.hr).toEqual(cursorAtWatermark(START_120, false));
  });

  it("starts a Congress that began 14 days ago or more at now, as before, not at its start", async () => {
    at("2027-01-17T17:00:00.000Z");
    parameters[STATE_119] = stateFor("119", "2027-01-17T16:55:00.000Z");

    await handler();

    expect(stored(STATE_120).cursors.hr.watermark).toBe("2027-01-17T17:00:00.000Z");
  });

  it("skips a parameter that holds another congress, never overwrites it, and still polls the others", async () => {
    at("2027-01-04T12:00:00.000Z");
    const congress118 = stateFor("118", "2025-01-03T00:00:00.000Z");
    parameters[STATE_119] = congress118;
    parameters[STATE_120] = stateFor("120", "2027-01-04T11:55:00.000Z");

    await expect(handler()).resolves.toMatchObject({ status: "ok" });

    expect(parameters[STATE_119]).toBe(congress118);
    expect(putsTo(STATE_119)).toBe(0);
    expect(requestedPaths()).toEqual(["/v3/bill/120/hr", "/v3/bill/120/s"]);
    expect(stored(STATE_120).lastPolledAt).toBe("2027-01-04T12:00:00.000Z");
    expect(logLinesWithMessage(console.error, /stored for another congress/)).toEqual([
      expect.objectContaining({ congress: "119", storedCongress: "118", stateParameter: STATE_119 }),
    ]);
    expect(congressMetric("BillPollerStateMismatch", "119")).toEqual([1]);
  });

  it("emits no primary lag when the primary's parameter holds another congress", async () => {
    at("2026-12-01T12:00:00.000Z");
    parameters[STATE_119] = stateFor("118", "2025-01-03T00:00:00.000Z");

    await expect(handler()).resolves.toMatchObject({ status: "ok", processed: 0 });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(putsTo(STATE_119)).toBe(0);
    expect(lagData()).toEqual([]);
  });

  // The 120th's cursors are past its start: its bill types have had bills, so a 404 is an error (see below for one
  // with no bill yet).
  it("keeps polling the 119th when the 120th answers 404, and does not fail the run", async () => {
    at("2027-01-04T12:00:00.000Z");
    const cursor120 = stateFor("120", "2027-01-04T11:55:00.000Z");
    parameters[STATE_120] = cursor120;
    parameters[STATE_119] = stateFor("119", "2027-01-04T11:55:00.000Z");
    mockFetch.mockImplementation(
      serveCongresses(
        {
          "119/hr": [
            {
              number: "7",
              updateDate: "2027-01-04T11:58:00Z",
              actionDate: "2027-01-04",
              action: "Presented to President.",
            },
          ],
        },
        { "120": 404 },
      ),
    );

    await expect(handler()).resolves.toMatchObject({ status: "ok", processed: 1 });

    expect(requestedPaths()).toEqual(["/v3/bill/120/hr", "/v3/bill/119/hr", "/v3/bill/119/s"]);
    expect(parameters[STATE_120]).toBe(cursor120);
    expect(stored(STATE_119).cursors.hr).toEqual(cursorAtWatermark("2027-01-04T12:00:00.000Z"));
    expect(stored(STATE_119).lastPolledAt).toBe("2027-01-04T12:00:00.000Z");
    expect(enqueuedGuids()).toEqual(["BILLS-119hr7"]);
    expect(logLinesWithMessage(console.error, /^Bill poller failed for a congress/)).toEqual([
      expect.objectContaining({ congress: "120", stateParameter: STATE_120 }),
    ]);
    expect(congressMetric("BillPollerTargetError", "120")).toEqual([1]);
    // The primary failed: no lag without a dimension, so Billboard-Heartbeat-BillsApiPoller sees missing data.
    expect(lagData()).toEqual([{ congress: "119", value: 0 }]);
  });

  it("fails the run when every polled Congress failed", async () => {
    at("2027-01-04T12:00:00.000Z");
    parameters[STATE_120] = stateFor("120", "2027-01-04T11:55:00.000Z");
    parameters[STATE_119] = stateFor("119", "2027-01-04T11:55:00.000Z");
    mockFetch.mockImplementation(serveCongresses({}, { "120": 404, "119": 404 }));

    await expect(handler()).rejects.toMatchObject({ name: "CongressApiError", status: 404 });

    expect(requestedPaths()).toEqual(["/v3/bill/120/hr", "/v3/bill/119/hr"]);
    expect(congressMetric("BillPollerTargetError", "120")).toEqual([1]);
    expect(congressMetric("BillPollerTargetError", "119")).toEqual([1]);
  });

  // congress.gov may answer 404 or 400 for the list of a bill type that has no bill yet in a new Congress (sjres,
  // hconres and sconres can have none for weeks). A 400 the filtered scan falls back on is tried unfiltered first.
  it.each([
    ["404", 404, statusResponse(404), 1],
    ["400", 400, statusResponse(400), 1],
    ["422", 422, statusResponse(422), 1],
    ["400 the scan falls back on", 400, { ...statusResponse(400), text: async () => "Unknown parameter: congress" }, 2],
  ])(
    "reads a %s for a 120th bill type with no bill yet as an empty list, and polls the types after it",
    async (_label, status, answer, requests) => {
      at("2027-01-04T12:00:00.000Z");
      reloadHandler({ BILL_TYPES: "hr,sjres,s" });
      parameters[STATE_120] = stateFor("120", START_120, ["hr", "sjres", "s"]);
      parameters[STATE_119] = stateFor("119", "2027-01-04T11:55:00.000Z", ["hr", "sjres", "s"]);
      const serve = serveCongresses({
        "120/hr": [{ number: "1", updateDate: "2027-01-04T10:00:00Z" }],
        "120/s": [{ number: "2", updateDate: "2027-01-04T11:00:00Z" }],
      });
      mockFetch.mockImplementation(async (url: string) =>
        new URL(url).pathname === "/v3/bill/120/sjres" ? answer : serve(url),
      );

      await expect(handler()).resolves.toMatchObject({ status: "ok", processed: 2 });

      expect(requestedPaths()).toEqual([
        "/v3/bill/120/hr",
        ...Array(requests).fill("/v3/bill/120/sjres"),
        "/v3/bill/120/s",
        "/v3/bill/119/hr",
        "/v3/bill/119/sjres",
        "/v3/bill/119/s",
      ]);
      expect(enqueuedGuids()).toEqual(["BILLS-120hr1", "BILLS-120s2"]);
      const state120 = stored(STATE_120);
      // The answer read as empty keeps sjres's watermark at the start.
      expect(state120.cursors).toEqual({
        hr: cursorAtWatermark("2027-01-04T12:00:00.000Z"),
        sjres: cursorAtWatermark(START_120, false),
        s: cursorAtWatermark("2027-01-04T12:00:00.000Z"),
      });
      expect(state120.lastPolledAt).toBe("2027-01-04T12:00:00.000Z");
      // At WARN, with a metric per Congress, so a dead bill type cannot hide at INFO.
      expect(logLinesWithMessage(console.warn, /^congress\.gov answered .* no bill yet/)).toEqual([
        expect.objectContaining({ congress: "120", billType: "sjres", status }),
      ]);
      expect(logLinesWithMessage(console.log, /^congress\.gov answered .* no bill yet/)).toEqual([]);
      expect(congressMetric("BillPollerNoBillYetAnswer", "120")).toEqual([1]);
      expect(logLinesWithMessage(console.error, /^Bill poller failed for a congress/)).toEqual([]);
      expect(metricData("BillPollerTargetError")).toEqual([]);
      // The primary was polled: its lag goes out without a dimension, so Billboard-Ingestion-BillPollerLag stays OK.
      expect(lagData()).toEqual(expect.arrayContaining([{ congress: null, value: 0 }]));
    },
  );

  // The same holds for a 200 with no bill list and no count: read as empty, it keeps the watermark, so nothing is
  // skipped, and the types after it are polled. For a type already listed such an answer fails the run (REL-56).
  it.each([
    ["{}", {}],
    ['{"bills": null}', { bills: null }],
  ])("reads a 200 of %s for a 120th bill type with no bill yet as an empty list", async (_label, body) => {
    at("2027-01-04T12:00:00.000Z");
    reloadHandler({ BILL_TYPES: "hr,sjres,s" });
    parameters[STATE_120] = stateFor("120", START_120, ["hr", "sjres", "s"]);
    parameters[STATE_119] = stateFor("119", "2027-01-04T11:55:00.000Z", ["hr", "sjres", "s"]);
    const serve = serveCongresses({
      "120/hr": [{ number: "1", updateDate: "2027-01-04T10:00:00Z" }],
      "120/s": [{ number: "2", updateDate: "2027-01-04T11:00:00Z" }],
    });
    mockFetch.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/v3/bill/120/sjres"
        ? { ok: true, status: 200, text: async () => JSON.stringify(body) }
        : serve(url),
    );

    await expect(handler()).resolves.toMatchObject({ status: "ok", processed: 2 });

    expect(enqueuedGuids()).toEqual(["BILLS-120hr1", "BILLS-120s2"]);
    expect(stored(STATE_120).cursors.sjres).toEqual(cursorAtWatermark(START_120, false));
    // RUNBOOK 24.2 lists the types answered this way with this filter, by status.
    expect(logLinesWithMessage(console.warn, /no bill yet; read as an empty list/)).toEqual([
      expect.objectContaining({
        message:
          "congress.gov answered a 200 with no bill list for a bill type with no bill yet; read as an empty list",
        congress: "120",
        billType: "sjres",
        status: 200,
        filtered: true,
      }),
    ]);
    expect(congressMetric("BillPollerNoBillYetAnswer", "120")).toEqual([1]);
    expect(metricData("BillPollerTargetError")).toEqual([]);
    expect(logLinesWithMessage(console.log, "Saved bill poller cursor")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ billType: "sjres", advanced: false }),
        expect.objectContaining({ billType: "s", advanced: true }),
      ]),
    );
  });

  // Not a 200 with a count, nor one after a first page that listed bills: those are broken answers, and the 120th
  // stops at that type with its cursor kept (BillPollerTargetError), as for a type already listed.
  it.each([
    ["a count but no bill list", (): unknown => ({ bills: null, pagination: { count: 3 } })],
    [
      "no bill list after a full first page",
      (offset: string | null): unknown =>
        offset === "0"
          ? {
              bills: Array.from({ length: 250 }, (_, index) => ({
                congress: 120,
                type: "SJRES",
                number: String(index + 1),
                updateDate: "2027-01-04",
              })),
              pagination: { count: 300 },
            }
          : {},
    ],
  ])("does not read a 200 with %s for a 120th bill type with no bill yet as empty", async (_label, answer) => {
    at("2027-01-04T12:00:00.000Z");
    reloadHandler({ BILL_TYPES: "hr,sjres,s" });
    parameters[STATE_120] = stateFor("120", START_120, ["hr", "sjres", "s"]);
    parameters[STATE_119] = stateFor("119", "2027-01-04T11:55:00.000Z", ["hr", "sjres", "s"]);
    const serve = serveCongresses({ "120/hr": [{ number: "1", updateDate: "2027-01-04T10:00:00Z" }] });
    mockFetch.mockImplementation(async (url: string) => {
      const requested = new URL(url);
      return requested.pathname === "/v3/bill/120/sjres"
        ? { ok: true, status: 200, text: async () => JSON.stringify(answer(requested.searchParams.get("offset"))) }
        : serve(url);
    });

    await expect(handler()).resolves.toMatchObject({ status: "ok" });

    expect(logLinesWithMessage(console.error, /^Bill poller failed for a congress/)).toEqual([
      expect.objectContaining({
        congress: "120",
        error: expect.objectContaining({ message: expect.stringMatching(/holds no bill list/) }),
      }),
    ]);
    expect(congressMetric("BillPollerTargetError", "120")).toEqual([1]);
    expect(metricData("BillPollerNoBillYetAnswer")).toEqual([]);
    expect(stored(STATE_120).cursors.sjres).toEqual(cursorAtWatermark(START_120, false));
    expect(stored(STATE_120).cursors.s).toEqual(cursorAtWatermark(START_120, false));
  });

  // The rule holds for 30 days after the Congress starts; after that the same answer is a per-Congress error
  // (BillPollerTargetError), so Billboard-Heartbeat-BillsApiPoller fires: the 120th is the primary and its lag goes
  // missing. The watermark stays at the start either way.
  it.each([
    ["just inside the 30-day window", "2027-02-02T16:59:00.000Z", true],
    ["at the end of the 30-day window", "2027-02-02T17:00:00.000Z", false],
    ["long after the window", "2027-04-01T12:00:00.000Z", false],
  ])("handles a 404 for a 120th bill type at its start %s", async (_label, now, asEmpty) => {
    at(now);
    reloadHandler({ BILL_TYPES: "hr" });
    const unchanged = stateFor("120", START_120, ["hr"]);
    parameters[STATE_120] = unchanged;
    parameters[STATE_119] = stateFor("119", "2027-01-04T11:55:00.000Z", ["hr"]);
    mockFetch.mockImplementation(serveCongresses({}, { "120/hr": 404 }));

    await expect(handler()).resolves.toMatchObject({ status: "ok" });

    expect(stored(STATE_120).cursors.hr).toEqual(cursorAtWatermark(START_120, false));
    expect(congressMetric("BillPollerNoBillYetAnswer", "120")).toEqual(asEmpty ? [1] : []);
    expect(congressMetric("BillPollerTargetError", "120")).toEqual(asEmpty ? [] : [1]);
    expect(logLinesWithMessage(console.warn, /no bill yet/)).toHaveLength(asEmpty ? 1 : 0);
    if (!asEmpty) expect(parameters[STATE_120]).toBe(unchanged);
  });

  it.each([500, 503])("does not read a %s for a bill type with no bill yet as empty", async (status) => {
    at("2027-01-04T12:00:00.000Z");
    reloadHandler({ BILL_TYPES: "hr" });
    parameters[STATE_120] = stateFor("120", START_120, ["hr"]);
    parameters[STATE_119] = stateFor("119", "2027-01-04T11:55:00.000Z", ["hr"]);
    mockFetch.mockImplementation(serveCongresses({}, { "120/hr": status }));

    await expect(handler()).resolves.toMatchObject({ status: "congress_api_unavailable" });

    expect(metricData("BillPollerNoBillYetAnswer")).toEqual([]);
  });

  // A backlog means an earlier scan of the type was cut short in a window (REL-56): its 404 is an error, and the rest of
  // that window is not skipped.
  it("still fails a 120th bill type at its start with a backlog when it answers 404", async () => {
    at("2027-01-04T12:00:00.000Z");
    reloadHandler({ BILL_TYPES: "hr" });
    const resumed = JSON.stringify({
      ...JSON.parse(stateFor("120", START_120, ["hr"])),
      cursors: {
        hr: cursorAtWatermark(START_120, false, { to: "2027-01-04T11:55:00.000Z", offset: 225, count: 300 }),
      },
    });
    parameters[STATE_120] = resumed;
    parameters[STATE_119] = stateFor("119", "2027-01-04T11:55:00.000Z", ["hr"]);
    mockFetch.mockImplementation(serveCongresses({}, { "120/hr": 404 }));

    await expect(handler()).resolves.toMatchObject({ status: "ok" });

    expect(parameters[STATE_120]).toBe(resumed);
    expect(congressMetric("BillPollerTargetError", "120")).toEqual([1]);
  });

  it("ends the whole run on an outage of the primary, keeping both Congresses' cursors", async () => {
    at("2027-01-04T12:00:00.000Z");
    const state119 = stateFor("119", "2027-01-04T11:55:00.000Z");
    parameters[STATE_120] = stateFor("120", START_120);
    parameters[STATE_119] = state119;
    mockFetch.mockImplementation(serveCongresses({}, { "120": 503 }));

    await expect(handler()).resolves.toMatchObject({ status: "congress_api_unavailable" });

    expect(requestedPaths()).toEqual(["/v3/bill/120/hr", "/v3/bill/120/hr", "/v3/bill/120/hr"]);
    expect(stored(STATE_120).cursors).toEqual(JSON.parse(stateFor("120", START_120)).cursors);
    expect(stored(STATE_120).lastPolledAt).toBe(START_120);
    expect(parameters[STATE_119]).toBe(state119);
    expect(ssmCalls.filter((call) => call.name === STATE_119)).toEqual([]);
    expect(metricData("CongressApiUnavailable")).toEqual([
      { MetricName: "CongressApiUnavailable", Unit: "Count", Value: 1 },
    ]);
  });

  it("emits the primary's lag as soon as its poll finishes, once, before the trailing Congress is polled", async () => {
    at("2027-01-04T12:00:00.000Z");
    reloadHandler({ BILL_TYPES: "hr" });
    parameters[STATE_120] = stateFor("120", "2027-01-04T11:55:00.000Z", ["hr"]);
    parameters[STATE_119] = stateFor("119", "2027-01-04T11:55:00.000Z", ["hr"]);
    const serve = serveCongresses({});
    const plainLagBeforeTrailing: boolean[] = [];
    mockFetch.mockImplementation(async (url: string) => {
      if (new URL(url).pathname.startsWith("/v3/bill/119/")) {
        plainLagBeforeTrailing.push(lagData().some((datum) => datum.congress === null));
      }
      return serve(url);
    });

    await handler();

    expect(plainLagBeforeTrailing).toEqual([true]);
    expect(lagData().filter((datum) => datum.congress === null)).toHaveLength(1);
  });

  // A trailing Congress that soft stops before every bill type was reached has not been polled: it keeps its earlier
  // lastPolledAt, so its lag grows and Billboard-Ingestion-BillPollerLag119 can fire. The primary is unchanged.
  it("keeps a trailing Congress's lastPolledAt when a soft stop left a bill type unpolled", async () => {
    at("2027-01-04T12:00:00.000Z");
    parameters[STATE_120] = stateFor("120", "2027-01-04T11:55:00.000Z");
    parameters[STATE_119] = stateFor("119", "2027-01-04T11:50:00.000Z");
    // Three requests (120 hr, 120 s, 119 hr) fit; then no Lambda time is left for 119 s.
    const context = { getRemainingTimeInMillis: () => (mockFetch.mock.calls.length >= 3 ? 1_000 : 600_000) };

    await handler(undefined, context);

    expect(requestedPaths()).toEqual(["/v3/bill/120/hr", "/v3/bill/120/s", "/v3/bill/119/hr"]);
    expect(stored(STATE_120).lastPolledAt).toBe("2027-01-04T12:00:00.000Z");
    expect(stored(STATE_119).lastPolledAt).toBe("2027-01-04T11:50:00.000Z");
    expect(congressMetric("BillPollerLagSeconds", "120")).toEqual([0]);
    expect(congressMetric("BillPollerLagSeconds", "119")).toEqual([600]);
  });

  it("still advances the primary's lastPolledAt only as before when a soft stop cut it short", async () => {
    at("2027-01-04T12:00:00.000Z");
    parameters[STATE_120] = stateFor("120", "2027-01-04T11:55:00.000Z");
    const context = { getRemainingTimeInMillis: () => (mockFetch.mock.calls.length >= 1 ? 1_000 : 600_000) };

    await handler(undefined, context);

    expect(stored(STATE_120).lastPolledAt).toBe("2027-01-04T12:00:00.000Z");
  });

  it("reports the primary's lag without a dimension and each Congress's lag with one", async () => {
    at("2027-01-04T12:00:00.000Z");
    parameters[STATE_120] = stateFor("120", "2027-01-04T11:55:00.000Z", ["hr"]);
    parameters[STATE_119] = stateFor("119", "2027-01-04T11:55:00.000Z", ["hr"]);
    reloadHandler({ BILL_TYPES: "hr" });
    // Each request takes 2 seconds.
    mockFetch.mockImplementation(async (url: string) => {
      jest.setSystemTime(Date.now() + 2_000);
      return serveCongresses({})(url);
    });

    await handler();

    expect(lagData()).toEqual(
      expect.arrayContaining([
        { congress: null, value: 2 },
        { congress: "120", value: 2 },
        { congress: "119", value: 4 },
      ]),
    );
    expect(lagData()).toHaveLength(3);
  });

  describe("the trailing Congress's outcome gate", () => {
    const rows119: Row[] = [
      // Newest: an old passage on a bill congress.gov touched again. Skipped, but the cursor moves past it.
      {
        number: "2",
        updateDate: "2027-01-06T15:00:00Z",
        actionDate: "2026-06-10",
        action: "Passed/agreed to in House: On passage Passed by recorded vote: 220 - 210.",
      },
      {
        number: "1",
        updateDate: "2027-01-06T14:00:00Z",
        actionDate: "2027-01-06",
        action: "Became Public Law No: 119-301.",
      },
      {
        number: "3",
        updateDate: "2027-01-06T13:00:00Z",
        actionDate: "2027-01-02",
        action: "Referred to the Committee on Ways and Means.",
      },
    ];
    const rows120: Row[] = [
      {
        number: "5",
        updateDate: "2027-01-06T12:00:00Z",
        actionDate: "2027-01-06",
        action: "Referred to the Committee on Ways and Means.",
      },
    ];

    beforeEach(() => {
      at("2027-01-07T12:00:00.000Z");
      reloadHandler({ BILL_TYPES: "hr" });
      parameters[STATE_120] = stateFor("120", "2027-01-05T00:00:00.000Z", ["hr"]);
      parameters[STATE_119] = stateFor("119", "2027-01-05T00:00:00.000Z", ["hr"]);
      mockFetch.mockImplementation(serveCongresses({ "119/hr": rows119, "120/hr": rows120 }));
    });

    it("enqueues only recent outcomes for the trailing Congress, never filters the primary, and moves past every row", async () => {
      await expect(handler()).resolves.toMatchObject({ status: "ok", processed: 2, discovered: 4 });

      expect(enqueuedGuids()).toEqual(["BILLS-120hr5", "BILLS-119hr1"]);
      expect(stored(STATE_119).cursors.hr).toEqual(cursorAtWatermark("2027-01-07T12:00:00.000Z"));
      expect(stored(STATE_120).cursors.hr).toEqual(cursorAtWatermark("2027-01-07T12:00:00.000Z"));
      expect(congressMetric("BillPollerTrailingEnqueued", "119")).toEqual([1]);
      expect(congressMetric("BillPollerTrailingSkipped", "119")).toEqual([2]);
      expect(congressMetric("BillPollerTrailingSkipped", "120")).toEqual([]);
      expect(logLinesWithMessage(console.log, /outcome gate/)).toEqual([
        expect.objectContaining({
          congress: "119",
          skipped: 2,
          enqueued: 1,
          actionCutoff: "2026-12-01",
          sample: [
            {
              guid: "BILLS-119hr2",
              actionDate: "2026-06-10",
              action: "Passed/agreed to in House: On passage Passed by recorded vote: 220 - 210.",
            },
            { guid: "BILLS-119hr3", actionDate: "2027-01-02", action: "Referred to the Committee on Ways and Means." },
          ],
        }),
      ]);
    });

    it.each([
      "Received in the Senate and Read twice and referred to the Committee on Finance.",
      "Held at the desk.",
      "Message on Senate action sent to the House.",
      "Cleared for White House.",
    ])(
      "enqueues a recent trailing row with the post-vote wording %j, and holds it back before the cutoff",
      async (text) => {
        const row = (number: string, actionDate: string, updateDate: string): Row => ({
          number,
          updateDate,
          actionDate,
          action: text,
        });
        mockFetch.mockImplementation(
          serveCongresses({
            "119/hr": [row("8", "2027-01-06", "2027-01-06T14:00:00Z"), row("9", "2026-06-10", "2027-01-06T13:00:00Z")],
          }),
        );

        await handler();

        expect(enqueuedGuids()).toEqual(["BILLS-119hr8"]);
        expect(congressMetric("BillPollerTrailingSkipped", "119")).toEqual([1]);
      },
    );

    it("enqueues every trailing row with TRAILING_ENQUEUE=all", async () => {
      reloadHandler({ TRAILING_ENQUEUE: "all" });

      await expect(handler()).resolves.toMatchObject({ processed: 4 });

      expect(enqueuedGuids().sort()).toEqual(["BILLS-119hr1", "BILLS-119hr2", "BILLS-119hr3", "BILLS-120hr5"]);
      expect(metricData("BillPollerTrailingSkipped")).toEqual([]);
    });

    it("takes the action date cutoff from TRAILING_ACTION_CUTOFF", async () => {
      reloadHandler({ TRAILING_ACTION_CUTOFF: "2026-06-01" });

      await handler();

      expect(enqueuedGuids()).toEqual(["BILLS-120hr5", "BILLS-119hr2", "BILLS-119hr1"]);
    });
  });

  // REL-56: before it, the 120th's cursors started at "2027-01-03T17:00:00.000Z#", below the key of every row dated
  // 2027-01-03 (its updateDate is a date only), so the first day's rows were dropped.
  it("enqueues the 120th's rows dated its first day, still reads a 404 for a type with no bill yet as empty, and gates the 119th", async () => {
    reloadHandler({ BILL_TYPES: "hr,sjres,s" });
    parameters[STATE_119] = stateFor("119", "2027-01-03T16:55:00.000Z", ["hr", "sjres", "s"]);
    parameters[STATE_120] = "UNINITIALIZED";
    const lists: Record<string, ListedBill[]> = {};
    const answers: Record<string, number> = { "120/sjres": 404 };
    mockFetch.mockImplementation(async (url: string) => {
      const key = new URL(url).pathname.replace(/^\/v3\/bill\//, "");
      return answers[key] ? statusResponse(answers[key]) : serveBillList(lists[key] ?? [])(url);
    });
    const run = async (iso: string) => {
      at(iso);
      mockFetch.mockClear();
      mockSQSSend.mockClear();
      mockCloudWatchSend.mockClear();
      return handler();
    };

    await expect(run(START_120)).resolves.toMatchObject({ initialized: true });

    lists["120/hr"] = [{ number: "1", at: "2027-01-03T17:02:00Z" }];
    lists["119/hr"] = [
      {
        number: "7",
        at: "2027-01-03T17:01:00Z",
        action: { actionDate: "2027-01-03", text: "Became Public Law No: 119-301." },
      },
      {
        number: "8",
        at: "2027-01-03T17:03:00Z",
        action: { actionDate: "2026-06-10", text: "Passed/agreed to in House: On passage Passed by voice vote." },
      },
    ];
    await run("2027-01-03T17:05:00.000Z");

    expect(enqueuedGuids()).toEqual(["BILLS-120hr1", "BILLS-119hr7"]);
    expect(requestUrls()[0].pathname).toBe("/v3/bill/120/hr");
    expect(requestUrls()[0].searchParams.get("fromDateTime")).toBe("2027-01-03T16:58:00Z");
    expect(stored(STATE_120).cursors).toEqual({
      hr: cursorAtWatermark("2027-01-03T17:05:00.000Z"),
      // Read as empty: the watermark stays at the start.
      sjres: cursorAtWatermark(START_120, false),
      // An empty list: the watermark moves on, and the type is still not listed.
      s: cursorAtWatermark("2027-01-03T17:05:00.000Z", false),
    });
    expect(congressMetric("BillPollerTrailingSkipped", "119")).toEqual([1]);

    // s answers 404 now, its watermark past the start: still read as empty, since none of it has been listed.
    answers["120/s"] = 404;
    await run("2027-01-03T17:10:00.000Z");
    expect(congressMetric("BillPollerNoBillYetAnswer", "120")).toEqual([1, 1]);
    expect(metricData("BillPollerTargetError")).toEqual([]);

    // hr has been listed: a 404 for it is an error.
    answers["120/hr"] = 404;
    await run("2027-01-03T17:15:00.000Z");
    expect(congressMetric("BillPollerTargetError", "120")).toEqual([1]);
  });

  // REL-56: after every Congress's poll, so a slow check takes no time from the trailing one. The filter check counts
  // the first polled Congress with enough hr rows the day before (the 120th has 1 on 2027-01-03); the late-row probe is
  // the primary's.
  it("makes the hourly checks after every Congress's poll, on the first with enough rows the day before (REL-56)", async () => {
    at("2027-01-04T12:00:00.000Z");
    reloadHandler({ FILTER_PRECISION_CHECK: "hourly" });
    parameters[STATE_120] = stateFor("120", "2027-01-04T11:55:00.000Z");
    parameters[STATE_119] = stateFor("119", "2027-01-04T11:55:00.000Z");
    const lists: Record<string, ListedBill[]> = {
      "120/hr": [{ number: "1", at: "2027-01-03T17:30:00Z" }],
      "119/hr": billsEvery(5, "2027-01-03T15:00:00.000Z", 60, 9000),
    };
    mockFetch.mockImplementation(async (url: string) =>
      serveBillList(lists[new URL(url).pathname.replace(/^\/v3\/bill\//, "")] ?? [])(url),
    );

    await handler();

    expect(requestedPaths()).toEqual([
      "/v3/bill/120/hr",
      "/v3/bill/120/s",
      "/v3/bill/119/hr",
      "/v3/bill/119/s",
      "/v3/bill/120/hr",
      "/v3/bill/119/hr",
      "/v3/bill/119/hr",
    ]);
    expect(
      requestUrls()
        .slice(4)
        .map((url) => [url.searchParams.get("limit"), url.searchParams.get("fromDateTime")]),
    ).toEqual([
      ["1", "2027-01-03T00:00:00Z"],
      ["1", "2027-01-03T00:00:00Z"],
      ["1", "2027-01-03T18:00:00Z"],
    ]);
    expect(logLinesWithMessage(console.log, "Checked congress.gov's list filter")).toEqual([
      expect.objectContaining({ congress: "119", dayRows: 5, secondRows: 0 }),
    ]);
    // The primary's hr window, empty, is its probe; the 119th's state keeps none.
    expect(stored(STATE_120).probe).toEqual({
      billType: "hr",
      from: "2027-01-04T11:53:00.000Z",
      to: "2027-01-04T11:58:00.000Z",
      numbers: [],
    });
    expect(stored(STATE_119).probe).toBeUndefined();
  });

  it.each([
    ["no mapping", "119"],
    ["a congress that is not a number", "x=/a"],
    ["no parameter name", "119="],
    ["the same congress twice", "119=/a,119=/b"],
    ["the same parameter twice", "119=/a,120=/a"],
  ])("rejects POLL_TARGETS with %s", async (_label, value) => {
    reloadHandler({ POLL_TARGETS: value });

    await expect(handler()).rejects.toThrow("Invalid env var POLL_TARGETS");
    expect(mockSSMSend).not.toHaveBeenCalled();
  });

  it.each([
    ["TRAILING_ENQUEUE", "some"],
    ["TRAILING_ACTION_CUTOFF", "December"],
  ])("rejects an invalid %s", async (name, value) => {
    reloadHandler({ [name]: value });

    await expect(handler()).rejects.toThrow(`Invalid env var ${name}`);
  });
});

// REL-56: congress.gov's list rows show updateDate as a date only, while its fromDateTime/toDateTime filter and its sort
// use a full update time (checked 2026-11-08: 2026-11-05 counted 39 hr rows, its two halves 2 and 37). Before REL-56
// the poller keyed each row on "<date>#<guid>" and dropped every row at or below its cursor's key, so after a type's
// first update of the day it skipped that day's later updates to bills whose guid sorts lower, new bills among them.
// These run against serveBillList, which filters and sorts on the hidden time and shows the date.
describe("billsApiPoller same-day updates and the watermark (REL-56)", () => {
  let bills: ListedBill[];
  // Updates bill `number` at `at`, or adds it.
  const touch = (number: string, at: string) => {
    const bill = bills.find((candidate) => candidate.number === number);
    if (bill) bill.at = at;
    else bills.push({ number, at });
  };
  const hr = (...numbers: string[]) => numbers.map((number) => `BILLS-119hr${number}`);
  // `list` in congress.gov's order, newest first.
  const newestFirst = (list: ListedBill[]) =>
    [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || Number(b.number) - Number(a.number));
  const driftWarnings = () => logLinesWithMessage(console.warn, /^congress\.gov's list moved between two pages/);

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["setTimeout", "setImmediate", "nextTick"] });
    bills = [];
    persistedState = {
      schemaVersion: 1,
      congress: "119",
      lastRunAt: "2026-11-07T09:00:00.000Z",
      lastPolledAt: "2026-11-07T09:00:00.000Z",
      cursors: { hr: cursorAtWatermark("2026-11-07T09:00:00.000Z") },
    };
    mockFetch.mockImplementation(serveBillList(bills));
  });

  it("enqueues later updates the same day whatever their guid: a lower one, the same bill again and new bills", async () => {
    touch("9821", "2026-11-07T13:00:00Z");
    touch("500", "2026-11-07T10:00:00Z");
    expect(await runAt("2026-11-07T14:00:00.000Z")).toEqual(hr("9821", "500"));

    // Before REL-56 the cursor was now 2026-11-07T00:00:00.000Z#BILLS-119hr9821, and of these only hr9900 got through.
    touch("100", "2026-11-07T14:01:00Z");
    touch("9900", "2026-11-07T14:02:00Z");
    touch("9821", "2026-11-07T14:03:00Z");
    touch("10953", "2026-11-07T14:04:00Z");
    expect(await runAt("2026-11-07T14:05:00.000Z")).toEqual(hr("10953", "9821", "9900", "100"));
    const url = requestUrls().at(-1)!;
    expect(url.searchParams.get("fromDateTime")).toBe("2026-11-07T13:58:00Z");
    expect(url.searchParams.get("toDateTime")).toBe("2026-11-07T14:05:00Z");
  });

  it("enqueues an update at 23:58:30Z with the first run of the next day", async () => {
    persistedState.cursors.hr = cursorAtWatermark("2026-11-07T23:56:00.000Z");
    touch("200", "2026-11-07T23:58:30Z");

    expect(await runAt("2026-11-08T00:01:00.000Z")).toEqual(hr("200"));
    // The next window starts at 23:59:00Z, so the fields for code from before REL-56 name the day before.
    expect(persistedState.cursors.hr).toEqual({
      lastUpdateAt: "2026-11-07T00:00:00.000Z",
      lastSeenKey: "2026-11-07T00:00:00.000Z#",
      watermark: "2026-11-08T00:01:00.000Z",
      listed: true,
    });
  });

  // At least once: the 120 s overlap costs a second enqueue of the rows in it (FetchRawBill refetches them; no
  // Bedrock call when nothing changed).
  it("enqueues a row inside the overlap with both runs, and one just before it with the first only", async () => {
    touch("1", "2026-11-07T14:04:30Z");
    touch("2", "2026-11-07T14:02:59Z");

    expect(await runAt("2026-11-07T14:05:00.000Z")).toEqual(hr("1", "2"));
    expect(await runAt("2026-11-07T14:10:00.000Z")).toEqual(hr("1"));
    expect(await runAt("2026-11-07T14:15:00.000Z")).toEqual([]);
  });

  // Every row congress.gov lists in the window is enqueued, so one without an updateDate is too; it is still counted.
  it("enqueues a row in the window that has no updateDate, and counts BillPollerMissingUpdateDate", async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          bills: [
            { congress: 119, type: "HR", number: "7", title: "H.R. 7", updateDate: "2026-11-07" },
            { congress: 119, type: "HR", number: "8", title: "H.R. 8" },
          ],
          pagination: { count: 2 },
        }),
    }));

    expect(await runAt("2026-11-07T14:00:00.000Z")).toEqual(hr("7", "8"));
    const bodies = mockSQSSend.mock.calls.flatMap(([cmd]) =>
      (cmd.input.Entries as Array<{ MessageBody: string }>).map((entry) => JSON.parse(entry.MessageBody)),
    );
    expect(bodies[1]).toMatchObject({ guid: "BILLS-119hr8", pubDate: "" });
    expect(bodies[1].updateDate).toBeUndefined();
    expect(metricData("BillPollerMissingUpdateDate")).toEqual([
      { MetricName: "BillPollerMissingUpdateDate", Unit: "Count", Value: 1 },
    ]);
  });

  it("reads a 600-row window one page a run, with rows updated between runs, and enqueues every bill", async () => {
    reloadHandler({ MAX_PAGES_PER_BILL_TYPE: "1" });
    bills.push(...billsEvery(600, "2026-11-07T09:00:00.000Z", 30, 10000));
    const runs: Record<string, string[]> = {};
    const cursors: PersistedCursor[] = [];
    const run = async (iso: string) => {
      runs[iso] = await runAt(iso);
      cursors.push(persistedState.cursors.hr);
    };

    await run("2026-11-07T14:00:00.000Z");
    // Updated again after the window's top: five rows the first run read, and five it has not reached.
    const order = newestFirst(bills);
    const updated = [...order.slice(0, 5), ...order.slice(595)];
    updated.forEach((bill, index) => {
      bill.at = new Date(Date.parse("2026-11-07T14:01:00.000Z") + index * 10_000).toISOString();
    });
    await run("2026-11-07T14:05:00.000Z");
    await run("2026-11-07T14:10:00.000Z");
    await run("2026-11-07T14:15:00.000Z");

    const top = "2026-11-07T14:00:00.000Z";
    expect(cursors).toEqual([
      cursorAtWatermark("2026-11-07T09:00:00.000Z", true, { to: top, offset: 225, count: 600 }),
      // The window lost 10 rows since the first page: the next page starts 10 rows earlier again.
      cursorAtWatermark("2026-11-07T09:00:00.000Z", true, { to: top, offset: 440, count: 590 }),
      cursorAtWatermark(top),
      cursorAtWatermark("2026-11-07T14:15:00.000Z"),
    ]);
    expect(new Set(Object.values(runs).flat())).toEqual(new Set(guidsOf(bills)));
    // The run after the window lists the ten updates with the next one.
    expect(runs["2026-11-07T14:15:00.000Z"]).toEqual(expect.arrayContaining(guidsOf(updated)));
    expect(metricData("BillPollerPageDrift")).toEqual([]);
  });

  it("does not skip the row at a page boundary when a row above it leaves the window mid-scan", async () => {
    bills.push(...billsEvery(600, "2026-11-07T09:00:00.000Z", 30, 10000));
    const order = newestFirst(bills);
    let moved = false;
    mockFetch.mockImplementation(
      serveBillList(bills, {
        beforePage: (url) => {
          if (url.searchParams.get("offset") !== "0" && !moved) {
            moved = true;
            order[9].at = "2026-11-07T14:00:30.000Z";
          }
        },
      }),
    );

    const guids = await runAt("2026-11-07T14:00:00.000Z");

    // The row that was 251st is now 250th; the next page starts 25 rows back, and one more for the row that left.
    expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["0", "225", "449"]);
    expect(guids).toContain(`BILLS-119hr${order[250].number}`);
    expect(new Set(guids)).toEqual(new Set(guidsOf(bills)));
    expect(metricData("BillPollerPageDrift")).toEqual([]);
  });

  it("steps back a page when more rows leave the window between two pages than the overlap covers", async () => {
    bills.push(...billsEvery(600, "2026-11-07T09:00:00.000Z", 30, 10000));
    const order = newestFirst(bills);
    let moved = false;
    mockFetch.mockImplementation(
      serveBillList(bills, {
        beforePage: (url) => {
          if (url.searchParams.get("offset") !== "0" && !moved) {
            moved = true;
            // 40 rows of the first page updated again: the rest move up 40, past the 25-row overlap.
            order.slice(10, 50).forEach((bill) => {
              bill.at = "2026-11-07T14:00:30.000Z";
            });
          }
        },
      }),
    );

    const guids = await runAt("2026-11-07T14:00:00.000Z");

    // Page 2 shares no row with the end of page 1, so the scan reads again from offset 0.
    expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["0", "225", "0", "225", "450"]);
    expect(new Set(guids)).toEqual(new Set(guidsOf(bills)));
    expect(metricData("BillPollerPageDrift")).toEqual([{ MetricName: "BillPollerPageDrift", Unit: "Count", Value: 1 }]);
    expect(driftWarnings()).toEqual([expect.objectContaining({ billType: "hr", offset: 225, stepBack: 1 })]);
  });

  it("steps back when a backlog's window lost more rows above its offset between runs than the overlap covers", async () => {
    bills.push(...billsEvery(600, "2026-11-07T09:00:00.000Z", 30, 10000));
    const order = newestFirst(bills);
    // The run before read the window's first page (offset 0) and stopped.
    persistedState.cursors.hr = cursorAtWatermark("2026-11-07T08:00:00.000Z", true, {
      to: "2026-11-07T14:00:00.000Z",
      offset: 225,
      count: 600,
    });
    // Since then 60 rows on that page left the window: the rows from position 250 on moved up 60.
    order.slice(100, 160).forEach((bill) => {
      bill.at = "2026-11-07T14:02:00.000Z";
    });

    const guids = await runAt("2026-11-07T14:05:00.000Z");

    // Back 60 rows, to read what moved above offset 225.
    expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["225", "165", "390"]);
    expect(guids).toEqual(expect.arrayContaining(guidsOf(order.slice(250))));
    expect(metricData("BillPollerPageDrift")).toEqual([{ MetricName: "BillPollerPageDrift", Unit: "Count", Value: 1 }]);
    expect(driftWarnings()).toEqual([expect.objectContaining({ offset: 225, lostSinceBacklog: 60, stepBack: 1 })]);
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-11-07T14:00:00.000Z"));
  });

  it("keeps a backlog's offset through an outage, and the progress of a run cut short by one", async () => {
    bills.push(...billsEvery(900, "2026-11-07T06:00:00.000Z", 30, 10000));
    const order = newestFirst(bills);
    const top = "2026-11-07T14:00:00.000Z";
    const backlogAt = (offset: number) =>
      cursorAtWatermark("2026-11-07T05:00:00.000Z", true, { to: top, offset, count: 900 });
    persistedState.cursors.hr = backlogAt(450);
    const serve = serveBillList(bills);
    let failing: string | null = "450";
    mockFetch.mockImplementation(async (url: string) =>
      new URL(url).searchParams.get("offset") === failing ? statusResponse(503) : serve(url),
    );

    await runAt("2026-11-07T14:05:00.000Z");
    expect(persistedState.cursors.hr).toEqual(backlogAt(450));

    failing = "675";
    const second = await runAt("2026-11-07T14:10:00.000Z");
    expect(persistedState.cursors.hr).toEqual(backlogAt(675));

    failing = null;
    const third = await runAt("2026-11-07T14:15:00.000Z");
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark(top));
    expect(new Set([...second, ...third])).toEqual(new Set(guidsOf(order.slice(450))));
  });

  // The 119th's state as stored on 2026-11-08, before REL-56: each cursor at the midnight of its date and the
  // highest guid listed that day.
  const storedBeforeRel56 = {
    schemaVersion: 1 as const,
    congress: "119",
    lastRunAt: "2026-11-08T22:23:57.654Z",
    lastPolledAt: "2026-11-08T22:18:39.676Z",
    cursors: {
      hr: { lastUpdateAt: "2026-11-07T00:00:00.000Z", lastSeenKey: "2026-11-07T00:00:00.000Z#BILLS-119hr9821" },
      s: { lastUpdateAt: "2026-11-07T00:00:00.000Z", lastSeenKey: "2026-11-07T00:00:00.000Z#BILLS-119s3984" },
      hjres: { lastUpdateAt: "2026-11-06T00:00:00.000Z", lastSeenKey: "2026-11-06T00:00:00.000Z#BILLS-119hjres122" },
      sjres: { lastUpdateAt: "2026-10-31T00:00:00.000Z", lastSeenKey: "2026-10-31T00:00:00.000Z#BILLS-119sjres32" },
      hconres: {
        lastUpdateAt: "2026-11-05T00:00:00.000Z",
        lastSeenKey: "2026-11-05T00:00:00.000Z#BILLS-119hconres81",
      },
      sconres: { lastUpdateAt: "2026-10-29T00:00:00.000Z", lastSeenKey: "2026-10-29T00:00:00.000Z#BILLS-119sconres6" },
      hres: { lastUpdateAt: "2026-11-06T00:00:00.000Z", lastSeenKey: "2026-11-06T00:00:00.000Z#BILLS-119hres317" },
      sres: { lastUpdateAt: "2026-11-06T00:00:00.000Z", lastSeenKey: "2026-11-06T00:00:00.000Z#BILLS-119sres818" },
    },
  };
  const ALL_TYPES = "hr,s,hjres,sjres,hconres,sconres,hres,sres";

  it("migrates a state from before REL-56: each window starts at the midnight of its cursor's date, less the overlap", async () => {
    reloadHandler({ BILL_TYPES: ALL_TYPES });
    persistedState = structuredClone(storedBeforeRel56);
    const lists: Record<string, ListedBill[]> = {
      hr: [
        { number: "10953", at: "2026-11-08T08:05:00Z" },
        // Dated the cursor's day and below its key: skipped before REL-56.
        { number: "100", at: "2026-11-07T15:00:00Z" },
        { number: "9821", at: "2026-11-07T09:00:00Z" },
        // Before the window.
        { number: "50", at: "2026-11-06T12:00:00Z" },
      ],
      sjres: [{ number: "1", at: "2026-10-31T10:00:00Z" }],
    };
    mockFetch.mockImplementation(async (url: string) => {
      const type = new URL(url).pathname.split("/").at(-1)!;
      return serveBillList(lists[type] ?? [])(url);
    });

    const guids = await runAt("2026-11-08T22:25:00.000Z");

    const windows = Object.fromEntries(
      requestUrls().map((url) => [url.pathname.split("/").at(-1), url.searchParams.get("fromDateTime")]),
    );
    expect(windows).toEqual({
      hr: "2026-11-06T23:58:00Z",
      s: "2026-11-06T23:58:00Z",
      hjres: "2026-11-05T23:58:00Z",
      sjres: "2026-10-30T23:58:00Z",
      hconres: "2026-11-04T23:58:00Z",
      sconres: "2026-10-28T23:58:00Z",
      hres: "2026-11-05T23:58:00Z",
      sres: "2026-11-05T23:58:00Z",
    });
    expect(requestUrls().every((url) => url.searchParams.get("toDateTime") === "2026-11-08T22:25:00Z")).toBe(true);
    expect(guids).toEqual(["BILLS-119hr10953", "BILLS-119hr100", "BILLS-119hr9821", "BILLS-119sjres1"]);
    expect(persistedState.cursors.hr).toEqual({
      lastUpdateAt: "2026-11-08T00:00:00.000Z",
      lastSeenKey: "2026-11-08T00:00:00.000Z#",
      watermark: "2026-11-08T22:25:00.000Z",
      listed: true,
    });
    // Every type was listed before, so each stays listed; schemaVersion 1 stays.
    expect(persistedState.schemaVersion).toBe(1);
    for (const cursor of Object.values(persistedState.cursors)) {
      expect(cursor).toEqual(cursorAtWatermark("2026-11-08T22:25:00.000Z"));
    }
  });

  it("drops a pending REL-06 resume point from a state from before REL-56 and lists the cursor's whole window", async () => {
    persistedState.cursors.hr = {
      lastUpdateAt: "2026-11-07T00:00:00.000Z",
      lastSeenKey: "2026-11-07T00:00:00.000Z#BILLS-119hr9821",
      resume: { toDateTime: "2026-11-07T00:00:01.000Z", highKey: "2026-11-07T00:00:00.000Z#BILLS-119hr9900" },
    } as PersistedCursor;
    touch("100", "2026-11-07T15:00:00Z");

    expect(await runAt("2026-11-07T16:00:00.000Z")).toEqual(hr("100"));
    expect(requestUrls()[0].searchParams.get("toDateTime")).toBe("2026-11-07T16:00:00Z");
    expect(JSON.stringify(persistedState)).not.toContain("resume");
  });

  // A rollback to code from before REL-56 reads lastUpdateAt and lastSeenKey: it lists from lastUpdateAt less 120 s and
  // drops each row whose "<updateDate>#<guid>" (the row's date, as an ISO time) is at or below lastSeenKey. This is a
  // copy of that rule.
  const enqueuedBeforeRel56 = (cursor: PersistedCursor, bill: ListedBill): boolean =>
    Date.parse(bill.at) >= Date.parse(cursor.lastUpdateAt) - 120_000 &&
    `${new Date(bill.at.slice(0, 10)).toISOString()}#BILLS-119hr${bill.number}` > cursor.lastSeenKey;

  it.each(["2026-11-08T00:01:00.000Z", "2026-11-08T00:02:00.000Z", "2026-11-08T22:25:00.000Z"])(
    "writes a cursor that code from before REL-56 reads without skipping a row (run at %s)",
    async (runIso) => {
      persistedState.cursors.hr = cursorAtWatermark(new Date(Date.parse(runIso) - 300_000).toISOString());
      await runAt(runIso);
      const cursor = persistedState.cursors.hr;
      const next = Date.parse(cursor.watermark!) - 120_000;

      // Every row this code's next window would list, low guid or high, that code lists and enqueues too.
      for (const offsetMs of [0, 1_000, 119_000, 120_000, 121_000, 3_600_000]) {
        for (const number of ["1", "99999"]) {
          const at = new Date(next + offsetMs).toISOString();
          expect([at, enqueuedBeforeRel56(cursor, { number, at })]).toEqual([at, true]);
        }
      }
      // And the rest of that day again (once), from its midnight.
      const day = Date.parse(cursor.lastUpdateAt);
      expect(next).toBeGreaterThanOrEqual(day);
      expect(enqueuedBeforeRel56(cursor, { number: "1", at: new Date(day).toISOString() })).toBe(true);
    },
  );

  // The parameter is Standard tier, 4 KB at most: a larger write fails. Pinned, so a new field is a choice.
  it("never writes a state over 3,500 bytes for 8 bill types, each with the largest backlog, and the largest probe", async () => {
    reloadHandler({ BILL_TYPES: ALL_TYPES, MAX_PAGES_PER_BILL_TYPE: "1" });
    // The largest state: every type mid-window, at an offset and count past any Congress's bills, and a late-row probe
    // of 20 bills with 5-digit numbers.
    const backlog = { to: "2026-11-08T22:25:00.000Z", offset: 999_000, count: 999_999 };
    const probe = {
      billType: "hconres",
      from: "2026-11-08T21:58:00.000Z",
      to: "2026-11-08T22:03:00.000Z",
      numbers: Array.from({ length: 20 }, (_, index) => String(10_000 + index)),
    };
    persistedState = {
      ...structuredClone(storedBeforeRel56),
      cursors: Object.fromEntries(
        ALL_TYPES.split(",").map((type) => [type, cursorAtWatermark("2026-11-08T22:20:00.000Z", true, backlog)]),
      ),
      probe,
    };
    // A full page for whatever is asked, of a list that counts 999,999 rows.
    mockFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          bills: Array.from({ length: 250 }, (_, index) => ({
            congress: 119,
            type: new URL(url).pathname.split("/").at(-1)!.toUpperCase(),
            number: String(index + 1),
            updateDate: "2026-11-08",
          })),
          pagination: { count: 999_999 },
        }),
    }));

    await runAt("2026-11-08T22:30:00.000Z");

    const puts = mockSSMSend.mock.calls.filter(([command]) => command.__type === "PutParameterCommand");
    const written: string = puts.at(-1)![0].input.Value;
    expect(JSON.parse(written).cursors.sres.backlog).toEqual({ ...backlog, offset: 999_225 });
    // Runs between the hourly checks keep the probe as it is.
    expect(JSON.parse(written).probe).toEqual(probe);
    expect(Buffer.byteLength(written)).toBeLessThan(3_500);
    expect(Buffer.byteLength(written)).toBe(2169);
  });

  // A run that steps back for rows that left the window, then stops before it is past the offset it resumed from, saves
  // the stepped-back backlog: the stored one is the one it loaded, so no other run is further along.
  it("keeps a backlog that stepped back for rows that left the window when the run stops right after", async () => {
    reloadHandler({ MAX_PAGES_PER_BILL_TYPE: "1" });
    bills.push(...billsEvery(300, "2026-11-07T09:00:00.000Z", 30, 10000));
    const order = newestFirst(bills);
    const top = "2026-11-07T14:00:00.000Z";
    const backlogAt = (offset: number, count: number) =>
      cursorAtWatermark("2026-11-07T08:00:00.000Z", true, { to: top, offset, count });
    // The run before read the window's first page (offset 0). Since then the 100 newest rows were updated again (they
    // left the window), and a new bill came.
    persistedState.cursors.hr = backlogAt(225, 300);
    order.slice(0, 100).forEach((bill) => {
      bill.at = "2026-11-07T14:01:00.000Z";
    });
    touch("9000", "2026-11-07T14:03:00Z");

    // Offset 225 of the 200 rows left: nothing, and 100 rows lost, so back 100; then the page cap.
    expect(await runAt("2026-11-07T14:05:00.000Z")).toEqual([]);
    expect(persistedState.cursors.hr).toEqual(backlogAt(125, 200));
    expect(metricData("BillPollerPageDrift")).toHaveLength(1);
    expect(logLinesWithMessage(console.warn, /overlapping run/)).toEqual([]);

    // The rows the run before had not reached moved up to 125..199.
    const second = await runAt("2026-11-07T14:10:00.000Z");
    expect(new Set(second)).toEqual(new Set(guidsOf(order.slice(225))));
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark(top));
    expect(await runAt("2026-11-07T14:15:00.000Z")).toEqual(
      expect.arrayContaining([...hr("9000"), ...guidsOf(order.slice(0, 100))]),
    );
  });

  // REL-56: without a count the next run cannot tell how far rows moved since a page, so a backlog keeps no offset.
  it("reads a backlog's window again from its top when congress.gov gives no count, and keeps no offset without one", async () => {
    reloadHandler({ MAX_PAGES_PER_BILL_TYPE: "2" });
    bills.push(...billsEvery(300, "2026-11-07T09:00:00.000Z", 30, 10000));
    const top = "2026-11-07T14:00:00.000Z";
    persistedState.cursors.hr = cursorAtWatermark("2026-11-07T08:00:00.000Z", true, {
      to: top,
      offset: 225,
      count: 300,
    });
    mockFetch.mockImplementation(serveBillList(bills, { noCount: true }));

    const first = await runAt("2026-11-07T14:05:00.000Z");

    expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["225", "0"]);
    expect(logLinesWithMessage(console.warn, /^congress\.gov gave no count to check a backlog against/)).toEqual([
      expect.objectContaining({ billType: "hr", offset: 225 }),
    ]);
    expect(persistedState.cursors.hr).toEqual(
      cursorAtWatermark("2026-11-07T08:00:00.000Z", true, { to: top, offset: 0 }),
    );
    expect(logLinesWithMessage(console.warn, /overlapping run/)).toEqual([]);

    mockFetch.mockClear();
    const second = await runAt("2026-11-07T14:10:00.000Z");
    expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["0", "225"]);
    expect(new Set([...first, ...second])).toEqual(new Set(guidsOf(bills)));
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark(top));
  });

  // A row with no bill number cannot be enqueued, but it was listed: the count check does not read the window again.
  it("counts a row with no bill number as listed when it checks a window against its count", async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          bills: [
            { congress: 119, type: "HR", number: "7", updateDate: "2026-11-07" },
            { congress: 119, type: "HR", updateDate: "2026-11-07" },
          ],
          pagination: { count: 2 },
        }),
    }));

    expect(await runAt("2026-11-07T14:00:00.000Z")).toEqual(hr("7"));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(metricData("BillPollerPageDrift")).toEqual([]);
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-11-07T14:00:00.000Z"));
  });

  it("reads a window longer than a page without pagination.count until a page comes back short", async () => {
    bills.push(...billsEvery(300, "2026-11-07T09:00:00.000Z", 30, 10000));
    mockFetch.mockImplementation(serveBillList(bills, { noCount: true }));

    const guids = await runAt("2026-11-07T14:00:00.000Z");

    expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["0", "225"]);
    expect(new Set(guids)).toEqual(new Set(guidsOf(bills)));
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-11-07T14:00:00.000Z"));
  });

  it("logs an error and reads on after two step-backs in one scan when the list keeps moving", async () => {
    bills.push(...billsEvery(600, "2026-11-07T09:00:00.000Z", 30, 10000));
    const top = Date.parse("2026-11-07T14:00:00.000Z");
    let moves = 0;
    mockFetch.mockImplementation(
      serveBillList(bills, {
        beforePage: (url) => {
          if (url.searchParams.get("offset") !== "225" || moves === 3) return;
          moves += 1;
          // Before each second page the 40 newest rows in the window are updated again: the rest move up past the
          // 25-row overlap.
          newestFirst(bills.filter((bill) => Date.parse(bill.at) <= top))
            .slice(0, 40)
            .forEach((bill, index) => {
              bill.at = new Date(top + moves * 60_000 + index * 1000).toISOString();
            });
        },
      }),
    );

    const guids = await runAt("2026-11-07T14:00:00.000Z");

    expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual([
      "0",
      "225",
      "0",
      "225",
      "0",
      "225",
      "410",
    ]);
    expect(metricData("BillPollerPageDrift")).toHaveLength(3);
    expect(driftWarnings()).toHaveLength(2);
    expect(logLinesWithMessage(console.error, /^congress\.gov's list kept moving between pages/)).toEqual([
      expect.objectContaining({ billType: "hr", offset: 225, stepBacks: 2 }),
    ]);
    expect(new Set(guids)).toEqual(new Set(guidsOf(bills)));
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-11-07T14:00:00.000Z"));
  });

  // A bill that shows in the list while its window is read raises the count above what the scan listed. That is no
  // page drift (no metric), but the window is read again once, for a bill that came long after its time; one that
  // showed within 120 s of its time is in the next window's overlap too.
  it("reads a window again without counting page drift when bills showed while it was read", async () => {
    bills.push(...billsEvery(600, "2026-11-07T09:00:00.000Z", 30, 10000));
    const showing = new Map([
      ["225", ["7", "2026-11-07T13:59:30Z"]],
      ["450", ["8", "2026-11-07T13:59:40Z"]],
    ]);
    mockFetch.mockImplementation(
      serveBillList(bills, {
        beforePage: (url) => {
          // hr7 shows as the first reading asks for page 2, hr8 as it asks for page 3: at the top, above those pages.
          const offset = url.searchParams.get("offset") ?? "";
          const next = showing.get(offset);
          showing.delete(offset);
          if (next) touch(next[0], next[1]);
        },
      }),
    );

    const guids = await runAt("2026-11-07T14:00:00.000Z");

    expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["0", "225", "450", "0", "225", "450"]);
    expect(new Set(guids)).toEqual(new Set(guidsOf(bills)));
    expect(logLinesWithMessage(console.warn, /^Rows showed in congress\.gov's list while the window was read/)).toEqual(
      [expect.objectContaining({ billType: "hr", readFrom: 0, listedRows: 600, count: 602, risen: 2, reread: 1 })],
    );
    expect(logLinesWithMessage(console.warn, /^Rows still showed in congress\.gov's list/)).toEqual([]);
    expect(metricData("BillPollerPageDrift")).toEqual([]);
    expect(logLinesWithMessage(console.error, /^congress\.gov's list still counted more rows/)).toEqual([]);
  });

  // Bills that still show while the window is read again cannot be told from bills that came more than 120 s after
  // their time, which no later window lists: that counts BillPollerPageDrift, with a warning that names the window.
  it("counts page drift and names the window when bills still show while it is read again", async () => {
    bills.push(...billsEvery(300, "2026-11-07T09:00:00.000Z", 30, 10000));
    const showing = [
      ["7", "2026-11-07T13:59:30Z"],
      ["8", "2026-11-07T13:59:40Z"],
    ];
    mockFetch.mockImplementation(
      serveBillList(bills, {
        beforePage: (url) => {
          // hr7 shows only as the first reading asks for page 2, hr8 as the second reading does: above that page.
          const next = url.searchParams.get("offset") === "225" ? showing.shift() : undefined;
          if (next) touch(next[0], next[1]);
        },
      }),
    );

    const first = await runAt("2026-11-07T14:00:00.000Z");

    expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["0", "225", "0", "225"]);
    expect(new Set(first)).toEqual(new Set([...guidsOf(bills.filter((bill) => bill.number !== "8"))]));
    expect(logLinesWithMessage(console.warn, /^Rows showed in congress\.gov's list while the window was read/)).toEqual(
      [expect.objectContaining({ billType: "hr", readFrom: 0, listedRows: 300, count: 301, risen: 1, reread: 1 })],
    );
    // Only the rise while it was read again counts then: hr7 was listed by that reading.
    expect(
      logLinesWithMessage(
        console.warn,
        "Rows still showed in congress.gov's list while the window was read; rows that came more than 120 s late may not have been read",
      ),
    ).toEqual([
      expect.objectContaining({
        billType: "hr",
        from: "2026-11-07T08:58:00.000Z",
        to: "2026-11-07T14:00:00.000Z",
        readFrom: 0,
        listedRows: 301,
        count: 302,
        risen: 1,
      }),
    ]);
    expect(metricData("BillPollerPageDrift")).toHaveLength(1);
    expect(logLinesWithMessage(console.error, /^congress\.gov's list still counted more rows/)).toEqual([]);

    expect(await runAt("2026-11-07T14:05:00.000Z")).toEqual(hr("8", "7"));
  });

  // A backlog's window has a top in the past, an earlier run's start: a bill that shows in it now came late, so what
  // the scan lacks there is drift, whatever the count rose by.
  it("counts page drift and logs the error for a backlog's window when bills showed while it was read", async () => {
    bills.push(...billsEvery(600, "2026-11-07T09:00:00.000Z", 30, 10000));
    const top = "2026-11-07T14:00:00.000Z";
    persistedState.cursors.hr = cursorAtWatermark("2026-11-07T08:00:00.000Z", true, {
      to: top,
      offset: 225,
      count: 600,
    });
    const showing = [
      ["9001", "2026-11-07T13:59:40Z"],
      ["9002", "2026-11-07T13:59:50Z"],
    ];
    mockFetch.mockImplementation(
      serveBillList(bills, {
        beforePage: (url) => {
          // hr9001 shows as the first reading asks for its second page, hr9002 as the second reading does.
          const next = url.searchParams.get("offset") === "450" ? showing.shift() : undefined;
          if (next) touch(next[0], next[1]);
        },
      }),
    );

    await runAt("2026-11-07T14:05:00.000Z");

    expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["225", "450", "225", "450"]);
    expect(logLinesWithMessage(console.warn, /^Rows (still )?showed in congress\.gov's list/)).toEqual([]);
    expect(logLinesWithMessage(console.warn, /^congress\.gov's list counted more rows than the scan listed/)).toEqual([
      expect.objectContaining({ readFrom: 225, listedRows: 375, count: 601, risen: 0, reread: 1 }),
    ]);
    expect(logLinesWithMessage(console.error, /^congress\.gov's list still counted more rows/)).toEqual([
      expect.objectContaining({
        from: "2026-11-07T07:58:00.000Z",
        to: top,
        readFrom: 225,
        listedRows: 376,
        count: 602,
        risen: 0,
      }),
    ]);
    expect(metricData("BillPollerPageDrift")).toHaveLength(2);
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark(top));
  });

  // REL-56: 300 bills updated in the same second (a congress.gov batch), and 20 before them. Among rows with the same
  // time congress.gov may answer in another order from one request to the next. Here the second page comes in an order
  // with the 50 lowest numbers moved to the top: it still holds the 25 rows of its overlap with page 1, so no drift
  // shows, but those 50 are on neither page. The window counts 320 rows; the scan listed 270.
  describe("a window that lists fewer rows than congress.gov counts", () => {
    const batchAt = "2026-11-07T13:30:00.000Z";
    const lowestFirst = (rows: ListedBill[]) => {
      const batch = rows.filter((row) => row.at === batchAt);
      return [...batch.slice(250), ...batch.slice(0, 250), ...rows.filter((row) => row.at !== batchAt)];
    };
    const countWarnings = () =>
      logLinesWithMessage(console.warn, /^congress\.gov's list counted more rows than the scan listed/);
    const countErrors = () => logLinesWithMessage(console.error, /^congress\.gov's list still counted more rows/);

    beforeEach(() => {
      bills.push(
        ...Array.from({ length: 300 }, (_, index) => ({ number: String(1001 + index), at: batchAt })),
        ...billsEvery(20, "2026-11-07T12:00:00.000Z", 1, 1),
      );
    });

    it("reads the window again, and enqueues the bills the changing order hid", async () => {
      let requests = 0;
      mockFetch.mockImplementation(
        serveBillList(bills, {
          reorder: (rows) => {
            requests += 1;
            return requests === 1 ? rows : lowestFirst(rows);
          },
        }),
      );

      const guids = await runAt("2026-11-07T14:00:00.000Z");

      expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["0", "225", "0", "225"]);
      expect(new Set(guids)).toEqual(new Set(guidsOf(bills)));
      expect(countWarnings()).toEqual([
        expect.objectContaining({ billType: "hr", readFrom: 0, listedRows: 270, count: 320, reread: 1 }),
      ]);
      expect(countErrors()).toEqual([]);
      expect(metricData("BillPollerPageDrift")).toHaveLength(1);
      expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-11-07T14:00:00.000Z"));
    });

    // An order that depends on the offset asked for answers the same pages again: the error says which window to
    // refetch, and the watermark moves on rather than stop the bill type.
    it("logs an error naming the window when reading it again does not help, and moves on", async () => {
      mockFetch.mockImplementation(
        serveBillList(bills, {
          reorder: (rows, url) => (url.searchParams.get("offset") === "0" ? rows : lowestFirst(rows)),
        }),
      );

      const guids = await runAt("2026-11-07T14:00:00.000Z");

      expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["0", "225", "0", "225"]);
      expect(new Set(guids).size).toBe(270);
      expect(guids).not.toContain("BILLS-119hr1001");
      expect(countErrors()).toEqual([
        expect.objectContaining({
          billType: "hr",
          from: "2026-11-07T08:58:00.000Z",
          to: "2026-11-07T14:00:00.000Z",
          listedRows: 270,
          count: 320,
        }),
      ]);
      expect(metricData("BillPollerPageDrift")).toHaveLength(2);
      expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-11-07T14:00:00.000Z"));
    });

    // Bills that showed while the window was read are listed when it is read again, so they cannot account for what
    // that reading lacks: here a row the changing order steps over both times.
    it("logs the error for a row stepped over in both readings when bills showed during the first", async () => {
      let shown = false;
      // Pages after the first come with hr1200 and hr1040 (the same time) swapped: hr1040 moves up into the part of
      // the list only the first page reads.
      const swapped = (rows: ListedBill[]) =>
        rows.map((row) =>
          row.number === "1200"
            ? rows.find((other) => other.number === "1040")!
            : row.number === "1040"
              ? rows.find((other) => other.number === "1200")!
              : row,
        );
      mockFetch.mockImplementation(
        serveBillList(bills, {
          beforePage: (url) => {
            // Two bills show at the top as the first reading asks for page 2, above that page.
            if (shown || url.searchParams.get("offset") !== "225") return;
            shown = true;
            touch("9001", "2026-11-07T13:59:30Z");
            touch("9002", "2026-11-07T13:59:40Z");
          },
          reorder: (rows, url) => (url.searchParams.get("offset") === "0" ? rows : swapped(rows)),
        }),
      );

      const guids = await runAt("2026-11-07T14:00:00.000Z");

      expect(requestUrls().map((url) => url.searchParams.get("offset"))).toEqual(["0", "225", "0", "225"]);
      expect(new Set(guids)).toEqual(new Set(guidsOf(bills.filter((bill) => bill.number !== "1040"))));
      expect(countWarnings()).toEqual([expect.objectContaining({ listedRows: 319, count: 322, risen: 2, reread: 1 })]);
      expect(logLinesWithMessage(console.warn, /^Rows (still )?showed in congress\.gov's list/)).toEqual([]);
      expect(countErrors()).toEqual([expect.objectContaining({ readFrom: 0, listedRows: 321, count: 322, risen: 0 })]);
      expect(metricData("BillPollerPageDrift")).toHaveLength(2);
    });
  });

  // REL-56: congress.gov rejecting fromDateTime (an API change) turns on the unfiltered fallback. Its rows show the date
  // only, so it lists every row dated on or after the day the window starts, every run: the whole day each time
  // (Billboard-Ingestion-BillPollerFallback).
  it("falls back to the unfiltered list when congress.gov rejects the filter, down to the day its window starts", async () => {
    persistedState.cursors.hr = cursorAtWatermark("2026-11-07T23:59:00.000Z");
    touch("3", "2026-11-08T08:00:00Z");
    touch("2", "2026-11-07T20:00:00Z");
    // Dated before the window's day: the fallback stops here.
    touch("1", "2026-11-06T12:00:00Z");
    touch("0", "2026-11-05T12:00:00Z");
    const serve = serveBillList(bills);
    mockFetch.mockImplementation(async (url: string) =>
      new URL(url).searchParams.has("fromDateTime")
        ? { ...statusResponse(400), text: () => Promise.resolve("Unknown parameter: fromDateTime") }
        : serve(url),
    );

    expect(await runAt("2026-11-08T09:00:00.000Z")).toEqual(hr("3", "2"));

    expect(requestUrls().map((url) => [url.searchParams.has("fromDateTime"), url.searchParams.get("offset")])).toEqual([
      [true, "0"],
      [false, "0"],
    ]);
    expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-11-08T09:00:00.000Z"));
    expect(metricData("BillPollerFallbackTypeCount")).toEqual([
      { MetricName: "BillPollerFallbackTypeCount", Unit: "Count", Value: 1 },
    ]);
    // The next run's window starts the same day: it lists that day's rows again.
    expect(await runAt("2026-11-08T09:05:00.000Z")).toEqual(hr("3"));
  });

  // REL-56: the first run of each hour checks congress.gov's list filter, then lists again a window read an hour before.
  describe("the hourly checks", () => {
    const filterUrls = () => requestUrls().filter((url) => url.searchParams.get("limit") === "1");
    const imprecise = [{ MetricName: "BillPollerFilterImprecise", Unit: "Count", Value: 1 }];
    const filterErrors = () => logLinesWithMessage(console.error, /congress\.gov's list filter/);

    beforeEach(() => {
      reloadHandler({ FILTER_PRECISION_CHECK: "hourly" });
      persistedState.cursors.hr = cursorAtWatermark("2026-11-07T14:55:00.000Z");
      touch("1", "2026-11-07T10:00:00Z");
      touch("2", "2026-11-07T14:58:00Z");
      // The day before: 30 rows a second apart from 17:59:50Z, so 2 in 18:00:00Z to 18:00:01Z.
      bills.push(...billsEvery(30, "2026-11-06T17:59:50.000Z", 1, 100));
    });

    describe("of congress.gov's list filter", () => {
      it("counts hr rows over the whole day before and over one second of it, after the poll, and finds the filter precise", async () => {
        expect(await runAt("2026-11-07T15:00:00.000Z")).toEqual(hr("2"));

        const [day, second] = filterUrls();
        expect(filterUrls()).toHaveLength(2);
        expect([day.pathname, second.pathname]).toEqual(["/v3/bill/119/hr", "/v3/bill/119/hr"]);
        expect(Object.fromEntries(day.searchParams)).toMatchObject({
          limit: "1",
          offset: "0",
          fromDateTime: "2026-11-06T00:00:00Z",
          toDateTime: "2026-11-06T23:59:59Z",
        });
        expect(Object.fromEntries(second.searchParams)).toMatchObject({
          fromDateTime: "2026-11-06T18:00:00Z",
          toDateTime: "2026-11-06T18:00:01Z",
        });
        // After the poll.
        expect(requestUrls().slice(-2)).toEqual([day, second]);
        expect(logLinesWithMessage(console.log, "Checked congress.gov's list filter")).toEqual([
          expect.objectContaining({ congress: "119", day: "2026-11-06", dayRows: 30, secondRows: 2 }),
        ]);
        expect(metricData("BillPollerFilterImprecise")).toEqual([]);

        mockFetch.mockClear();
        await runAt("2026-11-07T15:05:00.000Z");
        expect(filterUrls()).toEqual([]);
      });

      it.each([
        ["whole days", "date" as const, 30],
        ["whole hours", "hour" as const, 20],
      ])(
        "logs an error and counts BillPollerFilterImprecise when the filter matches %s, and still skips nothing",
        async (_label, precision, secondRows) => {
          mockFetch.mockImplementation(serveBillList(bills, { precision }));

          // Every row dated that day (or hour): a superset of the window.
          expect(await runAt("2026-11-07T15:00:00.000Z")).toEqual(expect.arrayContaining(hr("2")));

          expect(metricData("BillPollerFilterImprecise")).toEqual(imprecise);
          expect(filterErrors()).toEqual([expect.objectContaining({ dayRows: 30, secondRows, maxSecondRows: 10 })]);
        },
      );

      it("counts BillPollerFilterImprecise on a quiet day when one second counts as many rows as the whole day", async () => {
        // 5 hr rows the day before, none at 18:00Z: a filter that matches whole days counts all 5 in that second.
        bills.splice(0, bills.length, ...bills.filter((bill) => !bill.at.startsWith("2026-11-06")));
        bills.push(...billsEvery(5, "2026-11-06T09:00:00.000Z", 3600, 100));
        mockFetch.mockImplementation(serveBillList(bills, { precision: "date" }));

        await runAt("2026-11-07T15:00:00.000Z");

        expect(metricData("BillPollerFilterImprecise")).toEqual(imprecise);
        expect(filterErrors()).toEqual([expect.objectContaining({ dayRows: 5, secondRows: 5, maxSecondRows: 10 })]);
      });

      it.each([["no pagination.count", { noCount: true }, /has no pagination\.count/]])(
        "logs an error and counts BillPollerFilterImprecise when an answer has %s",
        async (_label, options, message) => {
          mockFetch.mockImplementation(serveBillList(bills, options));

          await runAt("2026-11-07T15:00:00.000Z");

          expect(metricData("BillPollerFilterImprecise")).toEqual(imprecise);
          expect(filterErrors()).toEqual([expect.objectContaining({ message: expect.stringMatching(message) })]);
          expect(filterUrls()).toHaveLength(1);
        },
      );

      it("logs an error and counts BillPollerFilterImprecise when congress.gov rejects the check's filter", async () => {
        const serve = serveBillList(bills);
        mockFetch.mockImplementation(async (url: string) =>
          new URL(url).searchParams.get("limit") === "1"
            ? { ...statusResponse(400), text: () => Promise.resolve("Invalid parameter: toDateTime") }
            : serve(url),
        );

        await runAt("2026-11-07T15:00:00.000Z");

        expect(metricData("BillPollerFilterImprecise")).toEqual(imprecise);
        expect(filterErrors()).toEqual([expect.objectContaining({ status: 400, day: "2026-11-06" })]);
      });

      it("only warns, after one attempt, when the check meets a 503, and the run still counts as a poll", async () => {
        const serve = serveBillList(bills);
        mockFetch.mockImplementation(async (url: string) =>
          new URL(url).searchParams.get("limit") === "1" ? statusResponse(503) : serve(url),
        );

        jest.setSystemTime(new Date("2026-11-07T15:00:00.000Z"));
        await expect(handler()).resolves.toMatchObject({ status: "ok", processed: 1 });

        expect(filterUrls()).toHaveLength(1);
        expect(logLinesWithMessage(console.warn, /^Could not check congress\.gov's list filter/)).toEqual([
          expect.objectContaining({ congress: "119", reason: expect.stringContaining("503") }),
        ]);
        expect(metricData("BillPollerFilterImprecise")).toEqual([]);
        expect(metricData("CongressApiUnavailable")).toEqual([]);
        expect(persistedState.lastPolledAt).toBe("2026-11-07T15:00:00.000Z");
      });

      it("logs that it cannot tell when the day before has fewer than 3 hr rows", async () => {
        bills.splice(0, bills.length, ...bills.filter((bill) => !bill.at.startsWith("2026-11-06")));
        touch("100", "2026-11-06T18:00:00Z");
        touch("101", "2026-11-06T18:00:01Z");

        await runAt("2026-11-07T15:00:00.000Z");

        expect(filterUrls()).toHaveLength(1);
        expect(logLinesWithMessage(console.log, /^Too few rows the day before to check/)).toEqual([
          expect.objectContaining({ congresses: ["119"], day: "2026-11-06", minDayRows: 3 }),
        ]);
        expect(metricData("BillPollerFilterImprecise")).toEqual([]);
      });

      it("is made by default, but not after an outage, or with FILTER_PRECISION_CHECK=off", async () => {
        delete process.env.FILTER_PRECISION_CHECK;
        reloadHandler({});
        await runAt("2026-11-07T15:00:00.000Z");
        expect(filterUrls()).toHaveLength(2);

        mockFetch.mockReset();
        mockFetch.mockResolvedValue(statusResponse(503));
        await runAt("2026-11-07T16:00:00.000Z");
        expect(filterUrls()).toEqual([]);

        reloadHandler({ FILTER_PRECISION_CHECK: "off" });
        mockFetch.mockReset();
        mockFetch.mockImplementation(serveBillList(bills));
        await runAt("2026-11-07T17:00:00.000Z");
        expect(filterUrls()).toEqual([]);
      });

      it("rejects an invalid FILTER_PRECISION_CHECK", async () => {
        reloadHandler({ FILTER_PRECISION_CHECK: "daily" });

        await expect(handler()).rejects.toThrow("Invalid env var FILTER_PRECISION_CHECK");
      });
    });

    // A bill that shows in the list more than 120 s after its time is in no window. The first run of each hour keeps
    // its hr window when it is small (the probe), and the next hour's first run lists it again.
    describe("for bills that showed in the list late", () => {
      const probeUrls = () =>
        requestUrls().filter(
          (url) =>
            url.searchParams.get("limit") === "250" && url.searchParams.get("fromDateTime") === "2026-11-07T14:53:00Z",
        );
      const probeAt15 = {
        billType: "hr",
        from: "2026-11-07T14:53:00.000Z",
        to: "2026-11-07T14:58:00.000Z",
        numbers: ["2"],
      };

      it("enqueues a bill that came into a window after it was read, counts BillPollerLateRows and keeps a new probe", async () => {
        expect(await runAt("2026-11-07T15:00:00.000Z")).toEqual(hr("2"));
        // The part of the window no later window lists (its top less 120 s), with the bills listed in all of it.
        expect(persistedState.probe).toEqual(probeAt15);

        // hr7, updated at 14:56:00Z, shows in the list only now: no window lists it from here on.
        touch("7", "2026-11-07T14:56:00Z");
        mockFetch.mockClear();
        const guids = await runAt("2026-11-07T16:00:00.000Z");

        expect(guids).toEqual(hr("2", "7"));
        expect(probeUrls()).toHaveLength(1);
        expect(metricData("BillPollerLateRows")).toEqual([
          { MetricName: "BillPollerLateRows", Unit: "Count", Value: 1 },
        ]);
        expect(
          logLinesWithMessage(console.warn, /^Bills showed in congress\.gov's list after their window was read/),
        ).toEqual([expect.objectContaining({ congress: "119", billType: "hr", late: 1, guids: ["BILLS-119hr7"] })]);
        expect(persistedState.probe).toEqual({
          billType: "hr",
          from: "2026-11-07T14:58:00.000Z",
          to: "2026-11-07T15:58:00.000Z",
          numbers: ["2"],
        });
        expect(persistedState.cursors.hr).toEqual(cursorAtWatermark("2026-11-07T16:00:00.000Z"));
      });

      it("finds nothing late when every bill showed in time, and keeps the state's probe through the runs between", async () => {
        await runAt("2026-11-07T15:00:00.000Z");
        await runAt("2026-11-07T15:05:00.000Z");
        expect(persistedState.probe).toEqual(probeAt15);

        await runAt("2026-11-07T16:00:00.000Z");

        expect(metricData("BillPollerLateRows")).toEqual([]);
        expect(logLinesWithMessage(console.log, /^Listed a window read an hour ago again/)).toEqual([
          expect.objectContaining({ from: probeAt15.from, to: probeAt15.to, listedThen: 1 }),
        ]);
      });

      it("keeps the old probe for the next hour when listing it again fails", async () => {
        await runAt("2026-11-07T15:00:00.000Z");
        mockFetch.mockClear();
        const serve = serveBillList(bills);
        mockFetch.mockImplementation(async (url: string) =>
          new URL(url).searchParams.get("fromDateTime") === "2026-11-07T14:53:00Z" ? statusResponse(503) : serve(url),
        );

        await runAt("2026-11-07T16:00:00.000Z");

        expect(probeUrls()).toHaveLength(1);
        expect(logLinesWithMessage(console.warn, /^Could not list a window read an hour ago again/)).toEqual([
          expect.objectContaining({ from: probeAt15.from, reason: expect.stringContaining("503") }),
        ]);
        expect(persistedState.probe).toEqual(probeAt15);
      });

      it("keeps no probe of a window with more than 20 bills", async () => {
        bills.push(...billsEvery(21, "2026-11-07T14:54:00.000Z", 1, 500));

        await runAt("2026-11-07T15:00:00.000Z");

        expect(persistedState.probe).toBeUndefined();
      });
    });
  });
});
