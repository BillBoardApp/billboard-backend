import { TimeoutError } from "../shared/http";
import {
  BillEndpointError,
  classifyRecordFailure,
  CongressApiFailure,
  congressFailureKindOfStatus,
  decideRetry,
  isBulkMessage,
  listingTimeOfCorrelationId,
  listingToStore,
  MAX_VISIBILITY_SECONDS,
  messageListedAtMs,
  messageListing,
  parseFetchRetryBackoffMode,
  parseRetryLadder,
  queueUrlFromArn,
  storedListingIsNewer,
  storedListingTimeMs,
  withStoredListingFields,
  type MessageListing,
  type RetryLadder,
} from "../handlers/fetchRawBill/retryLadder";
import type { RawBill } from "../models/bill";

// REL-58: FetchRawBill's retry ladder (services/src/handlers/fetchRawBill/retryLadder.ts).

/** The ladder infra ships: 3, 5, 10, 20 and 30 minutes, then an hour 5 times; 11 receives. */
const SHIPPED_STEPS = [180, 300, 600, 1200, 1800, 3600, 3600, 3600, 3600, 3600];
const LADDER: RetryLadder = { steps: SHIPPED_STEPS, otherSeconds: 60, notFoundReceives: 4, maxReceives: 11 };
const NO_JITTER = () => 0;

describe("parseFetchRetryBackoffMode", () => {
  it.each([
    ["on", "on"],
    [" ON ", "on"],
    ["off", "off"],
    [undefined, "off"],
    ["", "off"],
    ["watch", "off"],
    ["true", "off"],
  ])("%p is %p (anything but on is today's behaviour)", (value, mode) => {
    expect(parseFetchRetryBackoffMode(value)).toBe(mode);
  });
});

describe("parseRetryLadder", () => {
  const env = {
    FETCH_RETRY_LADDER_SECONDS: SHIPPED_STEPS.join(","),
    FETCH_RETRY_OTHER_SECONDS: "60",
    FETCH_RETRY_NOT_FOUND_RECEIVES: "4",
    FETCH_RETRY_MAX_RECEIVES: "11",
  };

  it("reads the shipped ladder", () => {
    expect(parseRetryLadder(env)).toEqual({ ladder: LADDER });
  });

  it("allows spaces around the steps", () => {
    expect(parseRetryLadder({ ...env, FETCH_RETRY_LADDER_SECONDS: " 180, 300 ,600" })).toEqual({
      ladder: { ...LADDER, steps: [180, 300, 600] },
    });
  });

  it.each<[string, Partial<typeof env>]>([
    ["no ladder", { FETCH_RETRY_LADDER_SECONDS: undefined }],
    ["an empty ladder", { FETCH_RETRY_LADDER_SECONDS: "" }],
    ["a step that is not a number", { FETCH_RETRY_LADDER_SECONDS: "180,soon,600" }],
    ["a step of 0", { FETCH_RETRY_LADDER_SECONDS: "180,0,600" }],
    ["a step over 12 hours", { FETCH_RETRY_LADDER_SECONDS: "180,43201" }],
    ["a fractional step", { FETCH_RETRY_LADDER_SECONDS: "180,300.5" }],
    ["no other seconds", { FETCH_RETRY_OTHER_SECONDS: undefined }],
    ["other seconds of 0", { FETCH_RETRY_OTHER_SECONDS: "0" }],
    ["no max receives", { FETCH_RETRY_MAX_RECEIVES: undefined }],
    ["max receives of 0", { FETCH_RETRY_MAX_RECEIVES: "0" }],
    ["not-found receives not a number", { FETCH_RETRY_NOT_FOUND_RECEIVES: "x" }],
    ["not-found receives of max receives or more", { FETCH_RETRY_NOT_FOUND_RECEIVES: "11" }],
  ])("refuses %s", (_name, overrides) => {
    const parsed = parseRetryLadder({ ...env, ...overrides });
    expect(parsed).toEqual({ error: expect.any(String) });
  });
});

describe("congressFailureKindOfStatus", () => {
  it.each([
    [429, "throttled"],
    [500, "unavailable"],
    [502, "unavailable"],
    [503, "unavailable"],
    [504, "unavailable"],
    [520, "unavailable"],
    [530, "unavailable"],
    [404, "not_found"],
    [400, null],
    [401, null],
    [403, null],
    [501, null],
    [505, null],
    [200, null],
  ])("status %p is %p", (status, kind) => {
    expect(congressFailureKindOfStatus(status)).toBe(kind);
  });
});

describe("classifyRecordFailure", () => {
  const endpointError = (endpoint: string, cause: unknown) =>
    new BillEndpointError(endpoint, `Failed to fetch ${endpoint} endpoint`, { cause });

  it("finds the congress.gov failure under the endpoint's wrapper", () => {
    const failure = new CongressApiFailure("unavailable", null, "Network error fetching ... after 2 retries");
    expect(classifyRecordFailure(endpointError("relatedBills", failure))).toEqual({
      kind: "unavailable",
      status: null,
      endpoint: "relatedBills",
    });
  });

  it("keeps a throttled answer's status", () => {
    const failure = new CongressApiFailure("throttled", 429, "status 429");
    expect(classifyRecordFailure(endpointError("titles", failure))).toEqual({
      kind: "throttled",
      status: 429,
      endpoint: "titles",
    });
  });

  it("takes a 404 on the bill endpoint as not_found: congress.gov's detail can lag its list", () => {
    const failure = new CongressApiFailure("not_found", 404, "status 404");
    expect(classifyRecordFailure(endpointError("bill", failure))).toEqual({
      kind: "not_found",
      status: 404,
      endpoint: "bill",
    });
  });

  it.each(["actions", "relatedBills", "cosponsors", "text"])("takes a 404 on %s as other", (endpoint) => {
    const failure = new CongressApiFailure("not_found", 404, "status 404");
    expect(classifyRecordFailure(endpointError(endpoint, failure))).toEqual({ kind: "other", status: 404, endpoint });
  });

  it("takes a 404 with no endpoint as other", () => {
    expect(classifyRecordFailure(new CongressApiFailure("not_found", 404, "status 404"))).toMatchObject({
      kind: "other",
    });
  });

  it.each<[string, unknown]>([
    ["a plain Error (a 401 after the key re-read, a 501, a TLS failure)", new Error("status 401")],
    ["an S3 refusal", Object.assign(new Error("Access Denied"), { name: "AccessDenied" })],
    ["a body that is not JSON", new SyntaxError("Unexpected token")],
    ["a socket timeout not wrapped as a congress.gov failure", new TimeoutError("timed out", 10_000)],
    ["a string", "boom"],
    ["nothing", undefined],
  ])("takes %s as other", (_name, error) => {
    expect(classifyRecordFailure(error)).toEqual({ kind: "other", status: null, endpoint: null });
  });

  it("stops after a few causes (a cycle does not loop)", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(classifyRecordFailure(a)).toEqual({ kind: "other", status: null, endpoint: null });
  });
});

describe("decideRetry", () => {
  it.each(SHIPPED_STEPS.map((seconds, index) => [index + 1, seconds]))(
    "an unavailable failure on receive %p comes back after %p s",
    (receiveCount, seconds) => {
      expect(decideRetry({ kind: "unavailable", receiveCount, bulk: false, random: NO_JITTER }, LADDER)).toEqual({
        kind: "unavailable",
        retryInSeconds: seconds,
        step: "ladder",
        final: false,
      });
    },
  );

  it("waits about 6 hours over the 10 retries", () => {
    const total = SHIPPED_STEPS.reduce((sum, seconds) => sum + seconds, 0);
    expect(total).toBe(22_080);
  });

  it("puts a throttled failure on the ladder too", () => {
    expect(decideRetry({ kind: "throttled", receiveCount: 3, bulk: false, random: NO_JITTER }, LADDER)).toMatchObject({
      kind: "throttled",
      retryInSeconds: 600,
      step: "ladder",
    });
  });

  it("puts a not_found on the ladder for its first 4 receives (about 38 minutes), then counts it as other", () => {
    const decisions = [1, 2, 3, 4, 5, 6].map((receiveCount) =>
      decideRetry({ kind: "not_found", receiveCount, bulk: false, random: NO_JITTER }, LADDER),
    );
    expect(decisions.map((decision) => [decision.kind, decision.retryInSeconds, decision.step])).toEqual([
      ["not_found", 180, "ladder"],
      ["not_found", 300, "ladder"],
      ["not_found", 600, "ladder"],
      ["not_found", 1200, "ladder"],
      ["other", 60, "other"],
      ["other", 60, "other"],
    ]);
  });

  it("retries any other failure after 60 s, so a poison message dead-letters in about 11 minutes", () => {
    expect(decideRetry({ kind: "other", receiveCount: 1, bulk: false, random: NO_JITTER }, LADDER)).toEqual({
      kind: "other",
      retryInSeconds: 60,
      step: "other",
      final: false,
    });
  });

  it("retries a bulk message after 60 s whatever the failure", () => {
    for (const kind of ["unavailable", "throttled", "not_found", "other"] as const) {
      expect(decideRetry({ kind, receiveCount: 5, bulk: true, random: NO_JITTER }, LADDER)).toMatchObject({
        retryInSeconds: 60,
        step: kind === "not_found" ? "other" : kind === "other" ? "other" : "bulk",
      });
    }
  });

  it("never uses 0 on the final receive: 60 s, then SQS dead-letters it at its next receive", () => {
    expect(decideRetry({ kind: "unavailable", receiveCount: 11, bulk: false, random: NO_JITTER }, LADDER)).toEqual({
      kind: "unavailable",
      retryInSeconds: 60,
      step: "final",
      final: true,
    });
    // A queue whose maxReceiveCount was raised by hand past this copy: still 60 s each, never 0 (no hot loop).
    expect(
      decideRetry({ kind: "unavailable", receiveCount: 14, bulk: false, random: NO_JITTER }, LADDER),
    ).toMatchObject({
      retryInSeconds: 60,
      final: true,
    });
  });

  it("keeps the last step for receives past the ladder but before the final one", () => {
    const short: RetryLadder = { ...LADDER, steps: [180, 300] };
    expect(decideRetry({ kind: "unavailable", receiveCount: 6, bulk: false, random: NO_JITTER }, short)).toMatchObject({
      retryInSeconds: 300,
      step: "ladder",
    });
  });

  it("reads a missing or odd receive count as the first", () => {
    for (const receiveCount of [0, -1, Number.NaN]) {
      expect(decideRetry({ kind: "unavailable", receiveCount, bulk: false, random: NO_JITTER }, LADDER)).toMatchObject({
        retryInSeconds: 180,
        final: false,
      });
    }
  });

  it("adds up to 10% jitter, so a batch that failed together does not come back together", () => {
    expect(
      decideRetry({ kind: "unavailable", receiveCount: 6, bulk: false, random: () => 0.999 }, LADDER).retryInSeconds,
    ).toBe(3960);
    expect(
      decideRetry({ kind: "unavailable", receiveCount: 6, bulk: false, random: () => 0.5 }, LADDER).retryInSeconds,
    ).toBe(3780);
    expect(
      decideRetry({ kind: "other", receiveCount: 1, bulk: false, random: () => 0.999 }, LADDER).retryInSeconds,
    ).toBe(66);
  });

  it("caps a step at SQS's 12 hours", () => {
    const long: RetryLadder = { ...LADDER, steps: [MAX_VISIBILITY_SECONDS] };
    expect(
      decideRetry({ kind: "unavailable", receiveCount: 1, bulk: false, random: () => 0.999 }, long).retryInSeconds,
    ).toBe(MAX_VISIBILITY_SECONDS);
  });
});

describe("isBulkMessage", () => {
  const POLLER_ID = "2026-11-10T17:28:39.657Z:BILLS-119hr10963";

  it.each<[string, unknown, string | undefined, boolean]>([
    ["a poller message", { guid: "BILLS-119hr1" }, POLLER_ID, false],
    ["a text retry", { guid: "BILLS-119hr1", textRetryAttempt: 1 }, POLLER_ID, false],
    ["noTextRetry (refetch:stale-bills)", { guid: "BILLS-119hr1", noTextRetry: true }, POLLER_ID, true],
    ["bulk (backfill:cosponsors)", { guid: "BILLS-119hr1", bulk: true }, undefined, true],
    ["a rel56: id", { guid: "BILLS-119hr1" }, "rel56:2026-11-12T02:15:00.000Z:BILLS-119hr1", true],
    ["a refetch: id", { guid: "BILLS-119hr1" }, "refetch:2026-11-12T02:15:00.000Z:BILLS-119hr1", true],
    ["no id and no flag", { guid: "BILLS-119hr1" }, undefined, false],
    ["noTextRetry that is not true", { guid: "BILLS-119hr1", noTextRetry: "yes" }, undefined, false],
    ["a body that is not an object", "not json", undefined, false],
  ])("%s: %p", (_name, body, correlationId, bulk) => {
    expect(isBulkMessage(body, correlationId)).toBe(bulk);
  });
});

describe("listing times", () => {
  it.each<[string | undefined, number | null]>([
    ["2026-11-10T17:28:39.657Z:BILLS-119hr10963", Date.parse("2026-11-10T17:28:39.657Z")],
    ["rel56:2026-11-12T02:15:00.000Z:BILLS-119hr1", Date.parse("2026-11-12T02:15:00.000Z")],
    ["refetch:2026-11-12T02:15:00.000Z:BILLS-119hr1", Date.parse("2026-11-12T02:15:00.000Z")],
    ["2026-11-10T17:28:39.657Z:3b241101-e2bb-4255-8caf-4136c566a962", null],
    ["repair:2026-11-12T02:15:00.000Z:BILLS-119hr1", null],
    ["2026-13-45T99:99:99.999Z:BILLS-119hr1", null],
    [undefined, null],
  ])("the time in %p is %p", (id, time) => {
    expect(listingTimeOfCorrelationId(id)).toBe(time);
  });

  it("dates a message by its id's time when it has one (a redrive keeps the id, not always the sent time)", () => {
    expect(messageListedAtMs("2026-11-10T17:28:39.657Z:BILLS-119hr10963", "1794356580000")).toBe(
      Date.parse("2026-11-10T17:28:39.657Z"),
    );
  });

  it("else by its SentTimestamp", () => {
    expect(messageListedAtMs(undefined, "1794356580000")).toBe(1794356580000);
    expect(messageListedAtMs(undefined, "not a time")).toBeNull();
    expect(messageListedAtMs(undefined, undefined)).toBeNull();
  });
});

describe("storedListingIsNewer and withStoredListingFields (overtaking)", () => {
  const LISTED = Date.parse("2026-11-10T17:28:39.657Z");
  const stored = (fetchedAt: string | undefined, correlationId?: string) => ({
    value: {
      metadata: {
        guid: "BILLS-119hr10963",
        title: "Newer title",
        description: "Newer action",
        pubDate: "2026-11-11",
        ...(fetchedAt ? { fetchedAt } : {}),
      },
    },
    ...(correlationId ? { metadata: { "correlation-id": correlationId } } : {}),
  });

  it("keeps the stored listing when its copy was fetched after this message was listed", () => {
    expect(
      storedListingIsNewer(LISTED, stored("2026-11-11T09:08:54.000Z", "2026-11-11T09:08:39.684Z:BILLS-119hr10963")),
    ).toBe(true);
  });

  it("keeps it when the stored copy's id cannot be dated (a hand-sent message)", () => {
    expect(storedListingIsNewer(LISTED, stored("2026-11-11T09:08:54.000Z"))).toBe(true);
  });

  it("not when the stored copy was fetched before this message was listed", () => {
    expect(storedListingIsNewer(LISTED, stored("2026-11-10T14:30:15.000Z"))).toBe(false);
  });

  it("not when the stored copy came from an older listing that was retried later", () => {
    expect(
      storedListingIsNewer(LISTED, stored("2026-11-10T18:00:00.000Z", "2026-11-10T16:13:39.000Z:BILLS-119hr10963")),
    ).toBe(false);
  });

  it("dates the stored copy by its metadata.listedAt, not by its correlation id", () => {
    const withListedAt = (fetchedAt: string, listedAt: string, correlationId: string) => {
      const copy = stored(fetchedAt, correlationId);
      return { ...copy, value: { metadata: { ...copy.value.metadata, listedAt } } };
    };
    // A copy that kept a later listing under an older message's id is still the later listing.
    expect(
      storedListingIsNewer(
        LISTED,
        withListedAt(
          "2026-11-11T10:00:00.000Z",
          "2026-11-11T09:08:39.684Z",
          "2026-11-10T16:13:39.000Z:BILLS-119hr10963",
        ),
      ),
    ).toBe(true);
    // A REL-56 copy: the snapshot's listing (before this message's), stored under a later run start.
    expect(
      storedListingIsNewer(
        LISTED,
        withListedAt(
          "2026-11-10T20:01:00.000Z",
          "2026-11-10T12:00:00.000Z",
          "rel56:2026-11-10T20:00:00.000Z:BILLS-119hr10963",
        ),
      ),
    ).toBe(false);
  });

  it("not when there is no stored copy, no fetchedAt, or no listing time", () => {
    expect(storedListingIsNewer(LISTED, { value: null })).toBe(false);
    expect(storedListingIsNewer(LISTED, undefined)).toBe(false);
    expect(storedListingIsNewer(LISTED, stored(undefined))).toBe(false);
    expect(storedListingIsNewer(null, stored("2026-11-11T09:08:54.000Z"))).toBe(false);
  });

  it("copies the stored title, description and pubDate into the document and says which changed", () => {
    const next = {
      schemaVersion: 1,
      kind: "raw",
      storedAt: "2026-11-11T10:00:00.000Z",
      identifier: { congress: "119", billType: "hr", billNumber: "10963" },
      metadata: {
        guid: "BILLS-119hr10963",
        title: "Older title",
        description: "Older action",
        pubDate: "2026-11-11",
        fetchedAt: "2026-11-11T10:00:00.000Z",
      },
      content: { bill: { number: "10963" } },
    } as unknown as RawBill;
    const { document, kept } = withStoredListingFields(
      next,
      stored("2026-11-11T09:08:54.000Z").value as unknown as RawBill,
    );
    expect(kept).toEqual(["title", "description"]);
    expect(document.metadata).toEqual({ ...next.metadata, title: "Newer title", description: "Newer action" });
    // The content is this fetch's, and the input is not modified.
    expect(document.content).toBe(next.content);
    expect(next.metadata.title).toBe("Older title");
  });

  it("drops a description the stored copy does not have", () => {
    const next = {
      metadata: { guid: "g", title: "t", pubDate: "p", description: "d", fetchedAt: "f" },
    } as unknown as RawBill;
    const storedBill = { metadata: { guid: "g", title: "t", pubDate: "p" } } as unknown as RawBill;
    const { document, kept } = withStoredListingFields(next, storedBill);
    expect(kept).toEqual(["description"]);
    expect("description" in document.metadata).toBe(false);
  });
});

describe("messageListing (where a message's title, description and pubDate come from)", () => {
  const RUN_START = "2026-11-10T20:00:00.000Z";
  const SENT = String(Date.parse("2026-11-10T20:05:00.000Z"));

  it.each<[string, unknown, string | undefined, string | undefined, MessageListing | null]>([
    [
      "a poller message: listed at its id's run start",
      { guid: "BILLS-119hr77" },
      "2026-11-10T17:28:39.657Z:BILLS-119hr77",
      SENT,
      { kind: "listed", atMs: Date.parse("2026-11-10T17:28:39.657Z") },
    ],
    [
      "a message without an id: listed at its SentTimestamp",
      { guid: "BILLS-119hr77" },
      undefined,
      SENT,
      { kind: "listed", atMs: Number(SENT) },
    ],
    [
      "refetch:stale-bills: the stored copy's own, sent back",
      { guid: "BILLS-119hr77", noTextRetry: true },
      `refetch:${RUN_START}:BILLS-119hr77`,
      SENT,
      { kind: "stored_copy" },
    ],
    [
      "backfill:cosponsors (bulk, no id): the stored copy's own",
      { guid: "BILLS-119hr77", bulk: true },
      undefined,
      SENT,
      { kind: "stored_copy" },
    ],
    [
      "the REL-56 backfill: listed at its body's listedAt (the snapshot's), not its run start",
      { guid: "BILLS-119hr77", noTextRetry: true, listedAt: "2026-11-10T12:00:00.000Z" },
      `rel56:${RUN_START}:BILLS-119hr77`,
      SENT,
      { kind: "listed", atMs: Date.parse("2026-11-10T12:00:00.000Z") },
    ],
    [
      "a REL-56 message without listedAt (an older tool build): listed at its run start, as before",
      { guid: "BILLS-119hr77", noTextRetry: true },
      `rel56:${RUN_START}:BILLS-119hr77`,
      SENT,
      { kind: "listed", atMs: Date.parse(RUN_START) },
    ],
    [
      "a listedAt that is not a time is ignored",
      { guid: "BILLS-119hr77", noTextRetry: true, listedAt: "soon" },
      `rel56:${RUN_START}:BILLS-119hr77`,
      SENT,
      { kind: "listed", atMs: Date.parse(RUN_START) },
    ],
    ["nothing that dates it", { guid: "BILLS-119hr77" }, undefined, undefined, null],
    ["a body that is not an object", "not json", undefined, undefined, null],
  ])("%s", (_name, body, correlationId, sentTimestamp, expected) => {
    expect(messageListing(body, correlationId, sentTimestamp)).toEqual(expected);
  });
});

describe("storedListingTimeMs (when the stored title, description and pubDate were listed)", () => {
  const copy = (metadata: Record<string, unknown>, correlationId?: string) => ({
    value: { metadata: { guid: "BILLS-119hr77", title: "t", pubDate: "p", ...metadata } },
    ...(correlationId ? { metadata: { "correlation-id": correlationId } } : {}),
  });

  it("reads metadata.listedAt first: a copy that kept a later listing under an older message's id", () => {
    expect(
      storedListingTimeMs(
        copy(
          { listedAt: "2026-11-10T15:00:00.000Z", fetchedAt: "2026-11-10T16:00:00.000Z" },
          "2026-11-10T13:00:00.000Z:BILLS-119hr77",
        ),
      ),
    ).toBe(Date.parse("2026-11-10T15:00:00.000Z"));
  });

  it("else the run start in its correlation id (a copy stored before the switch went on)", () => {
    expect(
      storedListingTimeMs(copy({ fetchedAt: "2026-11-10T16:00:00.000Z" }, "2026-11-10T13:00:00.000Z:BILLS-119hr77")),
    ).toBe(Date.parse("2026-11-10T13:00:00.000Z"));
  });

  it("else its fetchedAt: a listing is never later than its fetch", () => {
    expect(storedListingTimeMs(copy({ fetchedAt: "2026-11-10T16:00:00.000Z" }))).toBe(
      Date.parse("2026-11-10T16:00:00.000Z"),
    );
    expect(storedListingTimeMs(copy({ listedAt: "soon", fetchedAt: "2026-11-10T16:00:00.000Z" }))).toBe(
      Date.parse("2026-11-10T16:00:00.000Z"),
    );
  });

  it("null when nothing dates it, or there is no stored copy", () => {
    expect(storedListingTimeMs(copy({}))).toBeNull();
    expect(storedListingTimeMs({ value: null })).toBeNull();
    expect(storedListingTimeMs(undefined)).toBeNull();
  });
});

describe("listingToStore (the overtaking rule, with the listing time it records)", () => {
  const next = (title: string, fetchedAt = "2026-11-10T21:00:00.000Z"): RawBill =>
    ({
      schemaVersion: 1,
      kind: "raw",
      storedAt: fetchedAt,
      identifier: { congress: "119", billType: "hr", billNumber: "77" },
      metadata: {
        guid: "BILLS-119hr77",
        title,
        description: `${title} action`,
        pubDate: `pub ${title}`,
        fetchedAt,
      },
      content: { fetched: title },
    }) as unknown as RawBill;
  const stored = (document: RawBill, correlationId?: string) => ({
    value: document,
    ...(correlationId ? { metadata: { "correlation-id": correlationId } } : {}),
  });
  const listed = (iso: string): MessageListing => ({ kind: "listed", atMs: Date.parse(iso) });
  const listingFields = (document: RawBill) => {
    const { title, description, pubDate, listedAt } = document.metadata as RawBill["metadata"] & { listedAt?: string };
    return { title, description, pubDate, listedAt };
  };

  it("stores a listed message's own title, description and pubDate, dated by its listing", () => {
    const result = listingToStore(next("B"), { value: null }, listed("2026-11-10T14:00:00.000Z"));
    expect(listingFields(result.document)).toEqual({
      title: "B",
      description: "B action",
      pubDate: "pub B",
      listedAt: "2026-11-10T14:00:00.000Z",
    });
    expect(result).toMatchObject({ kept: [], from: "message", listedAtMs: Date.parse("2026-11-10T14:00:00.000Z") });
  });

  it("keeps a newer stored listing and its listing time, and stores this fetch's content", () => {
    const newer = listingToStore(next("C", "2026-11-10T15:00:30.000Z"), undefined, listed("2026-11-10T15:00:00.000Z"));
    const result = listingToStore(
      next("A"),
      stored(newer.document, "2026-11-10T15:00:00.000Z:BILLS-119hr77"),
      listed("2026-11-10T13:00:00.000Z"),
    );
    expect(listingFields(result.document)).toEqual({
      title: "C",
      description: "C action",
      pubDate: "pub C",
      listedAt: "2026-11-10T15:00:00.000Z",
    });
    expect(result.document.content).toEqual({ fetched: "A" });
    expect(result).toMatchObject({ kept: ["title", "description", "pubDate"], from: "stored" });
  });

  it("keeps the newest listing through any order of retries: C, then A, then B (each stored under its own id)", () => {
    // Three poller listings T1 < T2 < T3 (titles A, B, C), processed C, A, B; each store carries its message's id.
    let copy: { value: RawBill | null; metadata?: Record<string, string> } = { value: null };
    for (const [title, at, fetchedAt] of [
      ["C", "2026-11-10T15:00:00.000Z", "2026-11-10T15:00:30.000Z"],
      ["A", "2026-11-10T13:00:00.000Z", "2026-11-10T16:00:00.000Z"],
      ["B", "2026-11-10T14:00:00.000Z", "2026-11-10T17:00:00.000Z"],
    ]) {
      const result = listingToStore(next(title, fetchedAt), copy, listed(at));
      copy = stored(result.document, `${at}:BILLS-119hr77`);
    }
    expect(listingFields(copy.value!)).toMatchObject({ title: "C", listedAt: "2026-11-10T15:00:00.000Z" });
    expect(copy.value!.content).toEqual({ fetched: "B" });
  });

  it("stores a later listing over a bulk copy of an older one", () => {
    // OLD, listed 2026-05-01; a refetch: run (20:00) sends it back; then a poller listing of 19:00 retries.
    const old = stored(next("OLD", "2026-05-01T00:01:00.000Z"), "2026-05-01T00:00:00.000Z:BILLS-119hr77");
    const bulk = listingToStore(next("OLD"), old, { kind: "stored_copy" });
    expect(listingFields(bulk.document)).toMatchObject({ title: "OLD", listedAt: "2026-05-01T00:00:00.000Z" });
    const retry = listingToStore(
      next("NEW", "2026-11-10T21:30:00.000Z"),
      stored(bulk.document, "refetch:2026-11-10T20:00:00.000Z:BILLS-119hr77"),
      listed("2026-11-10T19:00:00.000Z"),
    );
    expect(listingFields(retry.document)).toMatchObject({ title: "NEW", listedAt: "2026-11-10T19:00:00.000Z" });
    expect(retry.from).toBe("message");
  });

  it("gives a bulk copy the stored title even when the stored copy changed since the run read it", () => {
    const changed = stored(
      listingToStore(next("Newer", "2026-11-10T19:31:00.000Z"), undefined, listed("2026-11-10T19:30:00.000Z")).document,
      "2026-11-10T19:30:00.000Z:BILLS-119hr77",
    );
    const result = listingToStore(next("Older"), changed, { kind: "stored_copy" });
    expect(listingFields(result.document)).toMatchObject({ title: "Newer", listedAt: "2026-11-10T19:30:00.000Z" });
    expect(result).toMatchObject({ kept: ["title", "description", "pubDate"], from: "stored" });
  });

  it("dates a bulk copy of a copy nothing dates by nothing, and a bulk message with no stored copy by nothing", () => {
    const undated = { value: { ...next("S"), metadata: { guid: "BILLS-119hr77", title: "S", pubDate: "p" } } };
    const kept = listingToStore(next("S"), undated as never, { kind: "stored_copy" });
    expect(listingFields(kept.document)).toMatchObject({ title: "S", listedAt: undefined });
    expect(kept.listedAtMs).toBeNull();
    const alone = listingToStore(next("X"), { value: null }, { kind: "stored_copy" });
    expect(listingFields(alone.document)).toMatchObject({ title: "X", listedAt: undefined });
    expect(alone).toMatchObject({ kept: [], from: "message", listedAtMs: null });
  });

  it("changes nothing without a listing (off, or a message nothing dates)", () => {
    const document = next("A");
    const result = listingToStore(
      document,
      stored(next("C", "2026-11-10T23:00:00.000Z"), "2026-11-10T22:00:00.000Z:BILLS-119hr77"),
      null,
    );
    expect(result.document).toBe(document);
    expect(result).toMatchObject({ kept: [], from: "message", listedAtMs: null });
    expect("listedAt" in result.document.metadata).toBe(false);
  });

  it("modifies neither argument", () => {
    const document = next("A");
    const copy = stored(next("C", "2026-11-10T23:00:00.000Z"), "2026-11-10T22:00:00.000Z:BILLS-119hr77");
    const before = JSON.stringify([document, copy]);
    listingToStore(document, copy, listed("2026-11-10T13:00:00.000Z"));
    listingToStore(document, copy, { kind: "stored_copy" });
    expect(JSON.stringify([document, copy])).toBe(before);
  });
});

describe("queueUrlFromArn", () => {
  it("builds the queue URL from the record's eventSourceARN", () => {
    expect(queueUrlFromArn("arn:aws:sqs:us-east-1:123456789012:UpdatedBillsQueue")).toBe(
      "https://sqs.us-east-1.amazonaws.com/123456789012/UpdatedBillsQueue",
    );
  });

  it.each([undefined, "", "arn:aws:s3:::bucket", "not an arn"])("gives null for %p", (arn) => {
    expect(queueUrlFromArn(arn)).toBeNull();
  });
});
