import {
  decideRefetchUnchanged,
  isBulkRefetchCorrelationId,
  isPollerCorrelationId,
  parseRefetchUnchangedMode,
  rawBillDifferences,
  REFETCH_VOLATILE_PATHS,
  unchangedRawBill,
  type RefetchUnchangedInput,
} from "../handlers/fetchRawBill/refetchUnchanged";

// REL-57: a poller refetch whose result equals the stored raw bill (services/src/handlers/fetchRawBill/refetchUnchanged.ts).

const POLLER_ID = "2026-11-11T10:03:39.684Z:BILLS-119s3923";

/** A stored raw bill in the shape FetchRawBill writes, small but with every part the rule looks at. */
const storedBill = () => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2026-11-11T09:22:44.000Z",
  identifier: { congress: "119", billType: "s", billNumber: "3923" },
  metadata: {
    guid: "BILLS-119s3923",
    title: "A bill to do a thing.",
    pubDate: "2026-11-11T00:00:00.000Z",
    category: "Congress API",
    description: "Passed Senate with an amendment by Unanimous Consent.",
    legislationUrl: "https://www.congress.gov/bill/119th-congress/senate-bill/3923",
    fetchedAt: "2026-11-11T09:22:44.000Z",
  },
  content: {
    bill: {
      bill: {
        number: "3923",
        type: "S",
        congress: 119,
        title: "A bill to do a thing.",
        updateDate: "2026-11-11T08:38:33Z",
        updateDateIncludingText: "2026-11-11T08:48:54Z",
        latestAction: { actionDate: "2026-11-11", text: "Passed Senate with an amendment by Unanimous Consent." },
        cosponsors: { count: 2, countIncludingWithdrawnCosponsors: 2 },
      },
    },
    actions: { actions: [{ actionDate: "2026-11-11", text: "Passed Senate." }], pagination: { count: 1 } },
    titles: {
      titles: [
        { title: "A bill to do a thing.", titleType: "Official Title as Introduced" },
        { title: "Thing Act", titleType: "Short Title(s) as Introduced" },
      ],
      pagination: { count: 2 },
    },
    cosponsors: {
      cosponsors: [{ bioguideId: "A000001" }, { bioguideId: "B000002" }],
      pagination: { count: 2, countIncludingWithdrawnCosponsors: 2 },
    },
    text: { textVersions: [{ type: "Engrossed in Senate", formats: [{ type: "Formatted XML", url: "x.xml" }] }] },
    billXML: "<bill>Text</bill>",
    billXMLFetch: {
      outcome: "ok",
      versionStem: "BILLS-119s3923es",
      source: "GovInfo",
      statuses: { GovInfo: 200 },
      at: "2026-11-11T09:22:40.000Z",
    },
  },
});

/** The same bill fetched again 15 minutes later: only the fields every fetch rewrites moved. */
const refetched = () => {
  const bill = storedBill();
  bill.storedAt = "2026-11-11T09:37:50.000Z";
  bill.metadata.fetchedAt = "2026-11-11T09:37:50.000Z";
  // REL-45: the same text version is reused from the stored copy, without a request.
  bill.content.billXMLFetch = {
    outcome: "reused",
    versionStem: "BILLS-119s3923es",
    source: "GovInfo",
    statuses: {},
    at: "2026-11-11T09:37:49.000Z",
  } as ReturnType<typeof storedBill>["content"]["billXMLFetch"];
  return bill;
};

describe("parseRefetchUnchangedMode", () => {
  it.each([
    [undefined, "off"],
    ["", "off"],
    ["  ", "off"],
    ["off", "off"],
    ["watch", "watch"],
    ["on", "on"],
    [" ON ", "on"],
    ["Watch", "watch"],
  ])("%p is %p", (value, mode) => {
    expect(parseRefetchUnchangedMode(value)).toBe(mode);
  });

  it.each(["yes", "true", "enforce", "1"])("an unknown value (%p) is watch, which never skips a write", (value) => {
    expect(parseRefetchUnchangedMode(value)).toBe("watch");
  });
});

describe("isPollerCorrelationId", () => {
  it.each([
    ["2026-11-11T10:03:39.684Z:BILLS-119s3923", true],
    ["2026-03-01T12:00:00.000Z:BILLS-119hr77ih", true],
    ["2026-11-11T10:03:39.684Z:BILLS-120hconres1", true],
    ["rel56:2026-11-20T03:10:00.000Z:BILLS-119hr10953", false],
    ["refetch:2026-12-01T03:10:00.000Z:BILLS-119hr1", false],
    ["2026-11-11T10:03:39.684Z:6f1c2a8e-1111-4c0e-9c55-1234567890ab", false],
    ["2026-11-11T10:03:39Z:BILLS-119s3923", false],
    ["repair-official-votes-20261020:BILLS-119hr1", false],
    ["", false],
    [undefined, false],
  ])("%p is %p", (id, expected) => {
    expect(isPollerCorrelationId(id)).toBe(expected);
  });
});

describe("rawBillDifferences and unchangedRawBill (the REL-57 equality)", () => {
  it("names exactly four volatile paths: storedAt, metadata.fetchedAt, metadata.listedAt and content.billXMLFetch", () => {
    expect(REFETCH_VOLATILE_PATHS.map((path) => path.join("."))).toEqual([
      "storedAt",
      "metadata.fetchedAt",
      "metadata.listedAt",
      "content.billXMLFetch",
    ]);
  });

  it("ignores metadata.listedAt (REL-58): each listing dates it, and a copy stored under off has none", () => {
    const stored = { ...storedBill(), metadata: { ...storedBill().metadata, listedAt: "2026-11-11T09:08:39.684Z" } };
    const next = refetched();
    expect(
      rawBillDifferences(stored, { ...next, metadata: { ...next.metadata, listedAt: "2026-11-11T10:03:39.684Z" } }),
    ).toEqual([]);
    expect(rawBillDifferences(stored, next)).toEqual([]);
    expect(
      decideRefetchUnchanged({
        messageCorrelationId: POLLER_ID,
        textRetryAttempt: 0,
        noTextRetry: false,
        textRetryScheduled: false,
        textUnavailable: false,
        stored: { value: stored, metadata: { "correlation-id": "2026-11-11T09:08:39.684Z:BILLS-119s3923" } },
        next: { ...next, metadata: { ...next.metadata, listedAt: "2026-11-11T10:03:39.684Z" } },
      }),
    ).toMatchObject({ unchanged: true, volatileChanged: expect.arrayContaining(["metadata.listedAt"]) });
  });

  it("finds no difference when only the volatile fields moved (the text reused instead of fetched)", () => {
    expect(rawBillDifferences(storedBill(), refetched())).toEqual([]);
    expect(unchangedRawBill(storedBill(), refetched())).toBe(true);
  });

  it("ignores the whole billXMLFetch marker, but never the text itself", () => {
    const next = refetched();
    next.content.billXML = "<bill>Text, amended</bill>";
    expect(rawBillDifferences(storedBill(), next)).toEqual(["content.billXML"]);
  });

  it("keeps updateDateIncludingText as content: congress.gov's own update time, which the REL-56 tools read", () => {
    const next = refetched();
    next.content.bill.bill.updateDateIncludingText = "2026-11-11T09:48:51Z";
    expect(rawBillDifferences(storedBill(), next)).toEqual(["content.bill.bill.updateDateIncludingText"]);
    expect(unchangedRawBill(storedBill(), next)).toBe(false);
  });

  it("compares the fields taken from the poller's message (title, latest action text, pubDate)", () => {
    const next = refetched();
    next.metadata.title = "Thing Act";
    next.metadata.pubDate = "2026-11-12T00:00:00.000Z";
    expect(rawBillDifferences(storedBill(), next)).toEqual(["metadata.pubDate", "metadata.title"]);
  });

  it("finds a cosponsor that came in while the detail's count did not move (sub-endpoints run ahead)", () => {
    const next = refetched();
    next.content.cosponsors.cosponsors.push({ bioguideId: "C000003" });
    next.content.cosponsors.pagination.count = 3;
    expect(rawBillDifferences(storedBill(), next)).toEqual([
      "content.cosponsors.cosponsors",
      "content.cosponsors.pagination.count",
    ]);
  });

  it("finds an action text corrected in place, with every count unchanged", () => {
    const next = refetched();
    next.content.actions.actions[0].text = "Passed Senate with an amendment.";
    expect(rawBillDifferences(storedBill(), next)).toEqual(["content.actions.actions[0].text"]);
  });

  it("treats a new order of a list as a change", () => {
    const next = refetched();
    next.content.titles.titles.reverse();
    expect(rawBillDifferences(storedBill(), next)).toEqual([
      "content.titles.titles[0].title",
      "content.titles.titles[0].titleType",
      "content.titles.titles[1].title",
      "content.titles.titles[1].titleType",
    ]);
  });

  it("treats a key on one side only as a change, a null included", () => {
    const withVotes = { ...refetched(), content: { ...refetched().content, officialVotes: { house: null } } };
    expect(rawBillDifferences(storedBill(), withVotes)).toEqual(["content.officialVotes"]);
    const withNull = refetched() as unknown as { metadata: Record<string, unknown> };
    withNull.metadata.category = null;
    expect(rawBillDifferences(storedBill(), withNull)).toEqual(["metadata.category"]);
    // A key named like an Object.prototype member is still a key of the document only.
    const withConstructor = JSON.parse(JSON.stringify(refetched()).replace('"guid":', '"constructor":"x","guid":'));
    expect(rawBillDifferences(storedBill(), withConstructor)).toEqual(["metadata.constructor"]);
    expect(rawBillDifferences(withConstructor, storedBill())).toEqual(["metadata.constructor"]);
  });

  it("compares the stored JSON: an undefined field is absent, and key order does not matter", () => {
    const next = refetched() as unknown as { metadata: Record<string, unknown> };
    next.metadata.link = undefined;
    const reordered = Object.fromEntries(Object.entries(next).reverse());
    expect(rawBillDifferences(storedBill(), reordered)).toEqual([]);
  });

  it("ignores a volatile name only at its own path", () => {
    const stored = storedBill() as unknown as { content: Record<string, unknown> };
    stored.content.officialVotes = { lastSyncedAt: "2026-11-11T09:00:00.000Z", fetchedAt: "a" };
    const next = refetched() as unknown as { content: Record<string, unknown> };
    next.content.officialVotes = { lastSyncedAt: "2026-11-11T09:30:00.000Z", fetchedAt: "b" };
    expect(rawBillDifferences(stored, next)).toEqual([
      "content.officialVotes.fetchedAt",
      "content.officialVotes.lastSyncedAt",
    ]);
  });

  it("treats a stored copy that is not an object, or of another type at a path, as a change", () => {
    expect(rawBillDifferences(null, refetched())).toEqual([""]);
    expect(rawBillDifferences("{not json", refetched())).toEqual([""]);
    const next = refetched() as unknown as { content: { titles: unknown } };
    next.content.titles = [];
    expect(rawBillDifferences(storedBill(), next)).toEqual(["content.titles"]);
  });

  it("stops at the limit it is given", () => {
    const next = refetched();
    next.metadata.title = "Thing Act";
    next.content.billXML = "<bill/>";
    next.content.bill.bill.updateDate = "2026-11-11T12:08:53Z";
    expect(rawBillDifferences(storedBill(), next, 2)).toHaveLength(2);
    expect(rawBillDifferences(storedBill(), next)).toHaveLength(3);
  });

  it("does not modify either document", () => {
    const stored = storedBill();
    const next = refetched();
    rawBillDifferences(stored, next);
    expect(stored).toEqual(storedBill());
    expect(next).toEqual(refetched());
  });
});

describe("decideRefetchUnchanged", () => {
  const input = (overrides: Partial<RefetchUnchangedInput> = {}): RefetchUnchangedInput => ({
    messageCorrelationId: POLLER_ID,
    textRetryAttempt: 0,
    noTextRetry: false,
    textRetryScheduled: false,
    textUnavailable: false,
    stored: { value: storedBill(), metadata: { "correlation-id": "2026-11-11T09:13:39.777Z:BILLS-119s3923" } },
    next: refetched(),
    ...overrides,
  });

  it("is unchanged for a poller message whose refetch equals the stored copy, naming the volatile fields that moved", () => {
    expect(decideRefetchUnchanged(input())).toEqual({
      unchanged: true,
      reason: "unchanged",
      volatileChanged: ["storedAt", "metadata.fetchedAt", "content.billXMLFetch"],
    });
  });

  it("is changed when the content differs, with the first paths that differ (5 at most)", () => {
    const next = refetched();
    next.content.cosponsors.cosponsors.push({ bioguideId: "C000003" });
    expect(decideRefetchUnchanged(input({ next }))).toEqual({
      unchanged: false,
      reason: "changed",
      changedPaths: ["content.cosponsors.cosponsors"],
    });
    const many = refetched() as unknown as { metadata: Record<string, unknown> };
    for (const key of ["title", "description", "pubDate", "category", "legislationUrl", "guid"]) {
      many.metadata[key] = "x";
    }
    expect(decideRefetchUnchanged(input({ next: many })).changedPaths).toHaveLength(5);
  });

  it.each([
    ["no correlation id (FetchRawBill mints one; older poller builds, backfill:cosponsors, hand-sent)", undefined],
    ["a REL-56 backfill id", "rel56:2026-11-20T03:10:00.000Z:BILLS-119s3923"],
    ["a refetch:stale-bills id", "refetch:2026-12-01T03:10:00.000Z:BILLS-119s3923"],
    ["an id of another shape", "2026-11-11T10:03:39.684Z:6f1c2a8e-1111-4c0e-9c55-1234567890ab"],
  ])("never skips a message that is not the poller's: %s", (_label, messageCorrelationId) => {
    expect(decideRefetchUnchanged(input({ messageCorrelationId }))).toEqual({
      unchanged: false,
      reason: "not_poller_message",
    });
  });

  it("never skips a bulk refetch's message (noTextRetry), whatever its id", () => {
    expect(decideRefetchUnchanged(input({ noTextRetry: true }))).toEqual({ unchanged: false, reason: "bulk_message" });
  });

  it("never skips FetchRawBill's own delayed text retry", () => {
    expect(decideRefetchUnchanged(input({ textRetryAttempt: 1 }))).toEqual({
      unchanged: false,
      reason: "text_retry_message",
    });
  });

  it("never skips a refetch whose text step scheduled a retry or left the bill without text", () => {
    expect(decideRefetchUnchanged(input({ textRetryScheduled: true }))).toEqual({
      unchanged: false,
      reason: "text_retry_scheduled",
    });
    expect(decideRefetchUnchanged(input({ textUnavailable: true }))).toEqual({
      unchanged: false,
      reason: "text_unavailable",
    });
  });

  it("writes when there is no stored copy, or it could not be read", () => {
    expect(decideRefetchUnchanged(input({ stored: { value: null } }))).toEqual({
      unchanged: false,
      reason: "no_stored_copy",
    });
    expect(decideRefetchUnchanged(input({ stored: undefined }))).toEqual({
      unchanged: false,
      reason: "stored_copy_unreadable",
    });
  });

  it("writes again when this message stored the copy itself (a retry after a failed send, or a redrive)", () => {
    const stored = { value: storedBill(), metadata: { "correlation-id": POLLER_ID } };
    expect(decideRefetchUnchanged(input({ stored }))).toEqual({ unchanged: false, reason: "stored_by_this_message" });
  });

  // The covering invariant (REL-56): NotificationType skips the push of a rel56: version, so a store
  // with a rel56: (or refetch:) id must never cover a poller listing, or a real update it stored first would be
  // published under the backfill's id alone. Such a refetch is always written, even when it equals the stored copy.
  it.each([
    ["the REL-56 backfill", "rel56:2026-11-20T03:10:00.000Z:BILLS-119s3923"],
    ["refetch:stale-bills", "refetch:2026-12-01T03:10:00.000Z:BILLS-119s3923"],
  ])("always writes a poller refetch over a copy %s stored, however equal", (_label, storedId) => {
    const stored = { value: storedBill(), metadata: { "correlation-id": storedId } };
    expect(unchangedRawBill(stored.value, refetched())).toBe(true);
    expect(decideRefetchUnchanged(input({ stored }))).toEqual({ unchanged: false, reason: "stored_by_bulk_refetch" });
    // The same copy stored by an earlier poller run is skipped: only the stored id differs.
    expect(decideRefetchUnchanged(input()).reason).toBe("unchanged");
  });

  it("tells a bulk refetch's stored id from the poller's and others", () => {
    expect(isBulkRefetchCorrelationId("rel56:2026-11-20T03:10:00.000Z:BILLS-119s3923")).toBe(true);
    expect(isBulkRefetchCorrelationId("refetch:2026-12-01T03:10:00.000Z:BILLS-119s3923")).toBe(true);
    expect(isBulkRefetchCorrelationId(POLLER_ID)).toBe(false);
    expect(isBulkRefetchCorrelationId("2026-11-11T10:03:39.684Z:6f1c2a8e-1111-4c0e-9c55-1234567890ab")).toBe(false);
    expect(isBulkRefetchCorrelationId("xrel56:2026-11-20T03:10:00.000Z:BILLS-119s3923")).toBe(false);
    expect(isBulkRefetchCorrelationId(undefined)).toBe(false);
  });

  it("decides a stored copy without a correlation id (older writes) on its content", () => {
    expect(decideRefetchUnchanged(input({ stored: { value: storedBill() } })).reason).toBe("unchanged");
  });

  it("checks the message before the text step, the text step before the stored copy, and the copy before the content", () => {
    expect(
      decideRefetchUnchanged(
        input({ messageCorrelationId: undefined, noTextRetry: true, textRetryScheduled: true, stored: undefined }),
      ).reason,
    ).toBe("not_poller_message");
    expect(decideRefetchUnchanged(input({ noTextRetry: true, textRetryAttempt: 2 })).reason).toBe("bulk_message");
    expect(decideRefetchUnchanged(input({ textRetryAttempt: 2, textUnavailable: true })).reason).toBe(
      "text_retry_message",
    );
    expect(decideRefetchUnchanged(input({ textUnavailable: true, stored: undefined })).reason).toBe("text_unavailable");
    expect(
      decideRefetchUnchanged(
        input({ stored: { value: storedBill(), metadata: { "correlation-id": POLLER_ID } }, next: { other: true } }),
      ).reason,
    ).toBe("stored_by_this_message");
    expect(
      decideRefetchUnchanged(
        input({
          stored: {
            value: storedBill(),
            metadata: { "correlation-id": "rel56:2026-11-20T03:10:00.000Z:BILLS-119s3923" },
          },
          next: { other: true },
        }),
      ).reason,
    ).toBe("stored_by_bulk_refetch");
  });
});
