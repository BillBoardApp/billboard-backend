// The text version check (shared/textVersionEvidence.ts; project decision 2026-11-17, docs/RUNBOOK.md 4.9 and 16.1
// step 6): a manifest date moves for the text alone only when congress.gov listed a new text version or retitled the
// bill between the raw copy the row's summary text came from and the raw copy the new summary came from.
import { FakeVersionedS3, type FakeS3Command } from "./fakeVersionedS3";

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

import { S3Client } from "@aws-sdk/client-s3";
import { BillStorage } from "../adapters/billStorage";
import type { RawBill } from "../models/bill";
import { extractRawBillTitle, sourceTextHash } from "../shared/billSourceReconcile";
import { textVersionDigest } from "../shared/billVersionChange";
import {
  TEXT_VERSION_BASE_MAX_GETS,
  compareRawTextVersions,
  rawTextVersionKeys,
  readTextVersionEvidence,
} from "../shared/textVersionEvidence";
import {
  RAW_COPY_STORED,
  fromReducedCopy,
  rawCopy,
  textVersionPairs,
  type CopyName,
  type FixtureGuid,
} from "./fixtures/rel56TextVersions";
import { logLines, logLinesWithMessage } from "./logLines";

/** The parts of a raw copy these tests change. */
type RawParts = { metadata: Record<string, unknown>; content: Record<string, unknown> };

const parts = (raw: RawBill): RawParts => raw as unknown as RawParts;

/** A raw copy with only a title and a text-version list (and, when given, bill XML). */
const listing = (textVersions: unknown, { title = "Time to Heal Act", xml = "" } = {}): RawBill =>
  ({
    metadata: { title },
    content: { bill: { bill: { title } }, text: { textVersions }, ...(xml ? { billXML: xml } : {}) },
  }) as unknown as RawBill;

/** `raw` with its content changed. */
const withContent = (raw: RawBill, change: (content: Record<string, unknown>) => void): RawBill => {
  const copy = structuredClone(raw);
  change(parts(copy).content);
  return copy;
};

const textVersionsOf = (raw: RawBill): Array<Record<string, unknown>> =>
  (parts(raw).content.text as { textVersions: Array<Record<string, unknown>> }).textVersions;

/** The text version a date basis holds for the text of `raw`. */
const textOf = (raw: RawBill): string => textVersionDigest(sourceTextHash(raw));

describe("rawTextVersionKeys", () => {
  it("knows hr7349's one text version by its type and day", () => {
    expect(rawTextVersionKeys(rawCopy("BILLS-119hr7349", "run"))).toEqual(["introduced in house|2026-02-04"]);
    expect(rawTextVersionKeys(rawCopy("BILLS-119hr7349", "pre"))).toEqual(["introduced in house|2026-02-04"]);
  });

  it("gives s4631's two copies the same keys although the same-day entries swapped at the head", () => {
    const pre = rawCopy("BILLS-119s4631", "pre");
    const run = rawCopy("BILLS-119s4631", "run");
    expect(textVersionsOf(pre).map((version) => version.type)).toEqual([
      "Engrossed in Senate",
      "Considered and Passed Senate",
    ]);
    expect(textVersionsOf(run).map((version) => version.type)).toEqual([
      "Considered and Passed Senate",
      "Engrossed in Senate",
    ]);
    expect(rawTextVersionKeys(run)).toEqual(rawTextVersionKeys(pre));
    expect(rawTextVersionKeys(run)).toEqual([
      "considered and passed senate|2026-05-21",
      "engrossed in senate|2026-05-21",
    ]);
  });

  it("collapses spaces, trims and lower-cases a type, and keeps one key for repeats", () => {
    const raw = listing([
      { type: "  Engrossed   in House ", date: "2026-07-21T04:00:00Z" },
      { type: "engrossed in house", date: "2026-07-21" },
      { type: "Engrossed\tin\nHouse", date: " 2026-07-21T23:59:59Z " },
    ]);
    expect(rawTextVersionKeys(raw)).toEqual(["engrossed in house|2026-07-21"]);
  });

  it("gives a null, missing or non-string date an empty day (congress.gov's Enrolled Bill)", () => {
    expect(rawTextVersionKeys(listing([{ type: "Enrolled Bill", date: null }]))).toEqual(["enrolled bill|"]);
    expect(rawTextVersionKeys(listing([{ type: "Enrolled Bill" }]))).toEqual(["enrolled bill|"]);
    expect(rawTextVersionKeys(listing([{ type: "Enrolled Bill", date: 20260721 }]))).toEqual(["enrolled bill|"]);
  });

  it("keeps a date that is not ISO as its trimmed text, and a type that is not a string as empty", () => {
    expect(rawTextVersionKeys(listing([{ type: "Public Law", date: "  July 30, 2026 " }]))).toEqual([
      "public law|July 30, 2026",
    ]);
    expect(rawTextVersionKeys(listing([{ type: 7, date: "2026-07-30" }, { date: "2026-07-31" }]))).toEqual([
      "|2026-07-30",
      "|2026-07-31",
    ]);
  });

  it("sorts the keys", () => {
    const raw = listing([
      { type: "Reported in House", date: "2026-07-20T04:00:00Z" },
      { type: "Engrossed in House", date: "2026-07-21T04:00:00Z" },
    ]);
    expect(rawTextVersionKeys(raw)).toEqual(["engrossed in house|2026-07-21", "reported in house|2026-07-20"]);
  });

  it("gives an empty list no keys", () => {
    expect(rawTextVersionKeys(listing([]))).toEqual([]);
    expect(rawTextVersionKeys(rawCopy("BILLS-119s4903", "pre"))).toEqual([]);
  });

  it.each([
    ["no content", { metadata: { title: "Time to Heal Act" } }],
    ["no content.text", { content: { bill: {} } }],
    ["no textVersions", { content: { text: { pagination: { count: 0 } } } }],
    ["textVersions that are not an array", { content: { text: { textVersions: { count: 1 } } } }],
    ["an entry that is null", { content: { text: { textVersions: [{ type: "Introduced in House" }, null] } } }],
    ["an entry that is a string", { content: { text: { textVersions: ["Introduced in House"] } } }],
    ["an entry that is an array", { content: { text: { textVersions: [["Introduced in House"]] } } }],
    ["a raw copy that is not an object", null],
  ])("gives no usable list for %s", (_case, raw) => {
    expect(rawTextVersionKeys(raw as unknown as RawBill)).toBeNull();
  });
});

describe("compareRawTextVersions", () => {
  it.each<[FixtureGuid, ReturnType<typeof compareRawTextVersions>]>([
    ["BILLS-119hr7349", "same_text_versions"],
    ["BILLS-119s4631", "same_text_versions"],
    ["BILLS-119hr6890", "same_text_versions"],
    ["BILLS-119s4903", "new_text_version"],
    ["BILLS-119hres1438", "new_text_version"],
    ["BILLS-119s3909", "retitled"],
  ])("compares %s's copy before the run with the run's: %s", (guid, verdict) => {
    expect(compareRawTextVersions(rawCopy(guid, "pre"), rawCopy(guid, "run"))).toBe(verdict);
  });

  it("reads hr6890's title as the hash does: its pre copy has no metadata.title, so content.bill.bill.title", () => {
    const pre = rawCopy("BILLS-119hr6890", "pre");
    const run = rawCopy("BILLS-119hr6890", "run");
    expect(parts(pre).metadata.title).toBeUndefined();
    expect(parts(run).metadata.title).toBe("PROTECT Immigration Act of 2025");
    expect(extractRawBillTitle(pre)).toBe(extractRawBillTitle(run));
  });

  it("checks the title first: s3909's XML is the same, its title is not", () => {
    const pre = rawCopy("BILLS-119s3909", "pre");
    const run = rawCopy("BILLS-119s3909", "run");
    expect(parts(run).content.billXML).toBe(parts(pre).content.billXML);
    expect(extractRawBillTitle(run)).toBe("Stop Illegal Alien Cops Act");
    // A retitle is a retitle even when neither copy has a usable list.
    const unlisted = (raw: RawBill) => withContent(raw, (content) => delete content.text);
    expect(compareRawTextVersions(unlisted(pre), unlisted(run))).toBe("retitled");
  });

  const INTRODUCED = {
    type: "Introduced in House",
    date: "2026-02-04T05:00:00Z",
    formats: [{ type: "Formatted XML", url: "https://www.congress.gov/119/bills/hr7349/BILLS-119hr7349ih.xml" }],
  };
  const REPORTED = { type: "Reported in House", date: "2026-06-11T04:00:00Z", formats: [] };

  it.each([
    [
      "a format added",
      [INTRODUCED],
      [
        {
          ...INTRODUCED,
          formats: [...INTRODUCED.formats, { type: "United States Legislative Markup", url: "https://example.org/x" }],
        },
      ],
    ],
    ["an entry removed", [REPORTED, INTRODUCED], [INTRODUCED]],
    ["a time of day changed", [INTRODUCED], [{ ...INTRODUCED, date: "2026-02-04T23:00:00Z" }]],
    ["the order changed", [INTRODUCED, REPORTED], [REPORTED, INTRODUCED]],
    ["the type's spacing and case changed", [INTRODUCED], [{ ...INTRODUCED, type: " introduced  IN house" }]],
  ])("is same_text_versions for %s", (_case, base, next) => {
    expect(compareRawTextVersions(listing(base), listing(next))).toBe("same_text_versions");
  });

  it.each([
    ["a version added", [INTRODUCED], [REPORTED, INTRODUCED]],
    ["a version's day changed", [INTRODUCED], [{ ...INTRODUCED, date: "2026-02-05T05:00:00Z" }]],
    ["a first version listed", [], [INTRODUCED]],
  ])("is new_text_version for %s", (_case, base, next) => {
    expect(compareRawTextVersions(listing(base), listing(next))).toBe("new_text_version");
  });

  it("is no_text_version_list when either copy has no usable list", () => {
    const listed = rawCopy("BILLS-119hr7349", "run");
    const unlisted = withContent(rawCopy("BILLS-119hr7349", "pre"), (content) => delete content.text);
    expect(compareRawTextVersions(unlisted, listed)).toBe("no_text_version_list");
    expect(compareRawTextVersions(listed, unlisted)).toBe("no_text_version_list");
    const broken = withContent(
      listed,
      (content) => ((content.text as { textVersions: unknown[] }).textVersions = [42]),
    );
    expect(compareRawTextVersions(listed, broken)).toBe("no_text_version_list");
  });
});

describe("the fixtures are the copies production hashed", () => {
  it("golden: hr7349's copies give the source-text-hashes its patch and summary were stored with", () => {
    expect(sourceTextHash(rawCopy("BILLS-119hr7349", "pre"))).toBe(
      "v1:3d5e5266166c17010b544001f334ec2efdb95b01af1dcda7569abcecfc8e5947",
    );
    expect(sourceTextHash(rawCopy("BILLS-119hr7349", "run"))).toBe(
      "v1:d2519d9c3e20b7845d391eac0a55044f4ded1bc07d5880b89bb8202f2155eb65",
    );
  });
});

describe("the 113 textVersion lines of 2026-11-16/17", () => {
  const pairs = textVersionPairs();

  it.each(pairs.map((pair) => [pair.guid, pair.expected, pair] as const))("%s: %s", (_guid, expected, pair) => {
    expect(compareRawTextVersions(fromReducedCopy(pair.pre), fromReducedCopy(pair.run))).toBe(expected);
  });

  it("gives 32 keeps and 81 moves (41 new text versions, 40 retitles)", () => {
    const count = (oldXml?: "empty" | "present") => {
      const totals: Record<string, number> = { same_text_versions: 0, new_text_version: 0, retitled: 0 };
      for (const pair of pairs.filter((entry) => oldXml === undefined || entry.oldXml === oldXml)) {
        totals[compareRawTextVersions(fromReducedCopy(pair.pre), fromReducedCopy(pair.run))] += 1;
      }
      return totals;
    };
    expect(pairs).toHaveLength(113);
    expect(new Set(pairs.map((pair) => pair.guid)).size).toBe(113);
    expect(count()).toEqual({ same_text_versions: 32, new_text_version: 41, retitled: 40 });
    expect(count("empty")).toEqual({ same_text_versions: 31, new_text_version: 22, retitled: 24 });
    expect(count("present")).toEqual({ same_text_versions: 1, new_text_version: 19, retitled: 16 });
  });

  it("reduces a copy to what the comparison reads", () => {
    for (const guid of ["BILLS-119hr7349", "BILLS-119hr6890", "BILLS-119s4631", "BILLS-119s3909"] as const) {
      const pair = pairs.find((entry) => entry.guid === guid)!;
      for (const copy of ["pre", "run"] as const) {
        const reduced = fromReducedCopy(pair[copy]);
        expect(extractRawBillTitle(reduced)).toBe(extractRawBillTitle(rawCopy(guid, copy)));
        expect(rawTextVersionKeys(reduced)).toEqual(rawTextVersionKeys(rawCopy(guid, copy)));
      }
    }
  });
});

describe("readTextVersionEvidence", () => {
  const GUID: FixtureGuid = "BILLS-119hr7349";
  const RAW_KEY = `raw-bills/${GUID}.json`;
  const PRE = rawCopy(GUID, "pre");
  const RUN = rawCopy(GUID, "run");
  const MESSAGE = "Could not read the raw copies to confirm a text version move; it moves as before";

  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  const storage = () => new BillStorage(new S3Client({}), "test-bucket");
  const check = (newRawVersion: string | undefined, baseTextVersion = textOf(PRE)) =>
    readTextVersionEvidence(storage(), RAW_KEY, { newRawVersion, baseTextVersion });
  /** Stores a fixture copy of hr7349 at its real LastModified. */
  const store = (copy: CopyName) => mockS3.putAt(RAW_KEY, rawCopy(GUID, copy), RAW_COPY_STORED[GUID][copy]);
  /** The S3 calls made, as `<command> <VersionId>`. */
  const calls = () =>
    mockS3.calls.map((call: FakeS3Command) =>
      call.__cmd === "GetObject" ? `GetObject ${call.input.VersionId}` : `${call.__cmd} ${call.input.Prefix}`,
    );
  /** Removes a version from the bucket (it expired). */
  const expire = (versionId: string) =>
    mockS3.objects.set(
      RAW_KEY,
      mockS3.versions(RAW_KEY).filter((version) => version.versionId !== versionId),
    );
  /** Runs `after` once, after the next answer to a command of this kind. */
  const afterSend = (kind: FakeS3Command["__cmd"], after: () => void) => {
    const send = mockS3.send.bind(mockS3);
    let done = false;
    jest.spyOn(mockS3, "send").mockImplementation(async (command: FakeS3Command) => {
      const response = await send(command);
      if (!done && command.__cmd === kind) {
        done = true;
        after();
      }
      return response;
    });
  };
  const internalError = () =>
    Object.assign(new Error("We encountered an internal error. Please try again."), {
      name: "InternalError",
      $metadata: { httpStatusCode: 500 },
    });

  beforeEach(() => {
    mockS3 = new FakeVersionedS3("2026-11-17T00:00:00.000Z");
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("golden: hr7349 [run, pre] finds the copy before the run by its text and keeps the date", async () => {
    const pre = store("pre");
    const run = store("run");

    const evidence = await check(run);

    expect(evidence).toEqual({
      verdict: "same_text_versions",
      reason: null,
      newRawVersion: run,
      baseRawVersion: pre,
      gets: 2,
      skipped: 0,
    });
    // The Logs Insights parse of the dated line relies on this order (RUNBOOK 4.9).
    expect(Object.keys(evidence)).toEqual(["verdict", "reason", "newRawVersion", "baseRawVersion", "gets", "skipped"]);
    expect(calls()).toEqual([`ListObjectVersions ${RAW_KEY}`, `GetObject ${run}`, `GetObject ${pre}`]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("skips a copy with other text: the sjres181 shape [textless base, run 1, run 2], new = run 2", async () => {
    const base = store("pre");
    const first = store("run");
    const second = mockS3.putAt(
      RAW_KEY,
      { ...RUN, metadata: { ...parts(RUN).metadata, fetchedAt: "2026-11-17T02:10:41.000Z" } },
      "2026-11-17T02:10:42.000Z",
    );

    expect(await check(second)).toEqual({
      verdict: "same_text_versions",
      reason: null,
      newRawVersion: second,
      baseRawVersion: base,
      gets: 3,
      skipped: 1,
    });
    expect(calls()).toEqual([
      `ListObjectVersions ${RAW_KEY}`,
      `GetObject ${second}`,
      `GetObject ${first}`,
      `GetObject ${base}`,
    ]);
  });

  it("moves for a version listed on a textless copy between the two texts (normal operation)", async () => {
    // T1 lists Reported in House with its XML; a fetch lists Engrossed in House at the head before its XML is out;
    // T2 has the Engrossed XML. The base is T1, matched by its text, so the new version counts.
    const key = "raw-bills/BILLS-119hres1438.json";
    const t1 = rawCopy("BILLS-119hres1438", "pre");
    const t2 = rawCopy("BILLS-119hres1438", "run");
    const textless = withContent(t2, (content) => delete content.billXML);
    const t1Version = mockS3.putAt(key, t1, "2026-10-31T18:18:52.000Z");
    mockS3.putAt(key, textless, "2026-11-16T12:00:01.000Z");
    const t2Version = mockS3.putAt(key, t2, "2026-11-16T18:23:37.000Z");

    expect(
      await readTextVersionEvidence(storage(), key, { newRawVersion: t2Version, baseTextVersion: textOf(t1) }),
    ).toEqual({
      verdict: "new_text_version",
      reason: null,
      newRawVersion: t2Version,
      baseRawVersion: t1Version,
      gets: 3,
      skipped: 1,
    });
  });

  it("reports a retitle between the two copies", async () => {
    const key = "raw-bills/BILLS-119s3909.json";
    const pre = mockS3.putAt(key, rawCopy("BILLS-119s3909", "pre"), RAW_COPY_STORED["BILLS-119s3909"].pre);
    const run = mockS3.putAt(key, rawCopy("BILLS-119s3909", "run"), RAW_COPY_STORED["BILLS-119s3909"].run);

    expect(
      await readTextVersionEvidence(storage(), key, {
        newRawVersion: run,
        baseTextVersion: textOf(rawCopy("BILLS-119s3909", "pre")),
      }),
    ).toMatchObject({ verdict: "retitled", reason: null, baseRawVersion: pre, gets: 2, skipped: 0 });
  });

  it("is base_raw_not_found when the copy holding the row's text is gone (it expired)", async () => {
    const run = store("run");

    expect(await check(run)).toEqual({
      verdict: "unconfirmed",
      reason: "base_raw_not_found",
      newRawVersion: run,
      baseRawVersion: null,
      gets: 1,
      skipped: 0,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("walks only copies older than the new one: a newer copy holding the row's text is not its base", async () => {
    const run = store("run");
    // A later fetch holding the text before the run again (say, a rollback of the raw key): newer than the new copy.
    const newer = mockS3.putAt(RAW_KEY, PRE, "2026-11-17T02:30:00.000Z");

    expect(await check(run)).toEqual({
      verdict: "unconfirmed",
      reason: "base_raw_not_found",
      newRawVersion: run,
      baseRawVersion: null,
      gets: 1,
      skipped: 0,
    });
    expect(calls()).toEqual([`ListObjectVersions ${RAW_KEY}`, `GetObject ${run}`]);
    expect(calls()).not.toContain(`GetObject ${newer}`);
  });

  /**
   * Copies of the run copy, each with other XML, stored a minute apart after the copy before the run and before the
   * run's (01:51:23Z), for up to 51 copies.
   */
  const otherTexts = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      mockS3.putAt(
        RAW_KEY,
        withContent(RUN, (content) => (content.billXML = `${content.billXML} <!-- ${index} -->`)),
        new Date(Date.parse("2026-11-17T01:00:00.000Z") + index * 60_000).toISOString(),
      ),
    );

  it(`stops after ${TEXT_VERSION_BASE_MAX_GETS} older copies with other text: too_many_versions`, async () => {
    const pre = store("pre");
    const others = otherTexts(TEXT_VERSION_BASE_MAX_GETS + 1);
    const run = store("run");

    expect(await check(run)).toEqual({
      verdict: "unconfirmed",
      reason: "too_many_versions",
      newRawVersion: run,
      baseRawVersion: null,
      gets: 6,
      skipped: 5,
    });
    // Newest first, five of the six; neither the sixth nor the base copy behind it is read.
    expect(calls()).toEqual([
      `ListObjectVersions ${RAW_KEY}`,
      `GetObject ${run}`,
      ...others
        .slice(1)
        .reverse()
        .map((versionId) => `GetObject ${versionId}`),
    ]);
    expect(calls()).not.toContain(`GetObject ${pre}`);
  });

  it(`still finds the base as the ${TEXT_VERSION_BASE_MAX_GETS}th older copy`, async () => {
    const pre = store("pre");
    otherTexts(TEXT_VERSION_BASE_MAX_GETS - 1);
    const run = store("run");

    expect(await check(run)).toMatchObject({
      verdict: "same_text_versions",
      baseRawVersion: pre,
      gets: 6,
      skipped: 4,
    });
  });

  it(`is base_raw_not_found after exactly ${TEXT_VERSION_BASE_MAX_GETS} older copies with other text and no more`, async () => {
    otherTexts(TEXT_VERSION_BASE_MAX_GETS);
    const run = store("run");

    expect(await check(run)).toMatchObject({
      verdict: "unconfirmed",
      reason: "base_raw_not_found",
      gets: 6,
      skipped: 5,
    });
  });

  it.each([
    ["no source-raw-version", undefined],
    ["an empty one", ""],
  ])("is no_source_raw_version for %s, with no S3 call", async (_case, newRawVersion) => {
    store("pre");
    store("run");
    mockS3.calls.length = 0;

    expect(await check(newRawVersion)).toEqual({
      verdict: "unconfirmed",
      reason: "no_source_raw_version",
      newRawVersion: null,
      baseRawVersion: null,
      gets: 0,
      skipped: 0,
    });
    expect(calls()).toEqual([]);
  });

  it("is new_raw_unlisted when the version named is not listed (expired, or never stored), with no GET", async () => {
    store("pre");
    store("run");

    expect(await check("expired-version-id")).toEqual({
      verdict: "unconfirmed",
      reason: "new_raw_unlisted",
      newRawVersion: "expired-version-id",
      baseRawVersion: null,
      gets: 0,
      skipped: 0,
    });
    expect(calls()).toEqual([`ListObjectVersions ${RAW_KEY}`]);
  });

  it("is new_raw_unreadable when the version named expires between the listing and its GET, with no warning", async () => {
    store("pre");
    const run = store("run");
    // S3 answers the GET with 404 NoSuchVersion, which BillStorage reads as nothing.
    afterSend("ListObjectVersions", () => expire(run));

    expect(await check(run)).toEqual({
      verdict: "unconfirmed",
      reason: "new_raw_unreadable",
      newRawVersion: run,
      baseRawVersion: null,
      gets: 1,
      skipped: 0,
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("skips an older copy that expires between the listing and its GET", async () => {
    const pre = store("pre");
    const [other] = otherTexts(1);
    const run = store("run");
    afterSend("ListObjectVersions", () => expire(other));

    expect(await check(run)).toMatchObject({
      verdict: "same_text_versions",
      baseRawVersion: pre,
      gets: 3,
      skipped: 1,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("is listing_failed, with one warning, when ListObjectVersions throws; it never throws", async () => {
    const run = store("run");
    jest.spyOn(mockS3, "send").mockRejectedValue(internalError());

    expect(await check(run)).toEqual({
      verdict: "unconfirmed",
      reason: "listing_failed",
      newRawVersion: run,
      baseRawVersion: null,
      gets: 0,
      skipped: 0,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logLinesWithMessage(warn, MESSAGE)).toEqual([
      expect.objectContaining({
        level: "WARN",
        key: RAW_KEY,
        newRawVersion: run,
        reason: "listing_failed",
        error: expect.objectContaining({ name: "InternalError", statusCode: 500 }),
      }),
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it("is read_failed, with the warning and BillStorage's error, when a walk GET throws; it never throws", async () => {
    store("pre");
    const run = store("run");
    // The first GET (the new copy) answers; the second (the walk's first) fails.
    mockS3.afterGet(RAW_KEY, () =>
      mockS3.afterGet(RAW_KEY, () => {
        throw internalError();
      }),
    );

    expect(await check(run)).toEqual({
      verdict: "unconfirmed",
      reason: "read_failed",
      newRawVersion: run,
      baseRawVersion: null,
      gets: 2,
      skipped: 0,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logLinesWithMessage(warn, MESSAGE)).toEqual([
      expect.objectContaining({ key: RAW_KEY, newRawVersion: run, reason: "read_failed" }),
    ]);
    expect(logLines(error).map((line) => line.message)).toEqual(["Failed to load bill from S3"]);
  });

  it("is read_failed when the new copy's GET throws", async () => {
    store("pre");
    const run = store("run");
    mockS3.afterGet(RAW_KEY, () => {
      throw internalError();
    });

    expect(await check(run)).toMatchObject({ verdict: "unconfirmed", reason: "read_failed", gets: 1, skipped: 0 });
    expect(logLinesWithMessage(warn, MESSAGE)).toHaveLength(1);
    expect(logLines(error).map((line) => line.message)).toEqual(["Failed to load bill from S3"]);
  });

  it("is new_raw_has_base_text when the new copy holds the row's text (a later textless copy)", async () => {
    // A legacy bill summarized without XML; a later fetch lists a new head version, still without its XML, and the
    // summary is built from it (BillSummarizer's chooseSummaryBase). Same title and no XML: the same hash.
    store("pre");
    const later = withContent(PRE, (content) => {
      (content.text as { textVersions: unknown[] }).textVersions.unshift({
        type: "Reported in House",
        date: "2026-10-01T04:00:00Z",
        formats: [],
      });
    });
    expect(sourceTextHash(later)).toBe(sourceTextHash(PRE));
    const latest = mockS3.putAt(RAW_KEY, later, "2026-10-02T09:00:00.000Z");

    expect(await check(latest)).toEqual({
      verdict: "unconfirmed",
      reason: "new_raw_has_base_text",
      newRawVersion: latest,
      baseRawVersion: null,
      gets: 1,
      skipped: 0,
    });
  });

  it("skips a delete marker in the listing without reading it", async () => {
    const pre = store("pre");
    const marker = mockS3.deleteObject(RAW_KEY);
    mockS3.versions(RAW_KEY).find((version) => version.versionId === marker)!.lastModified = new Date(
      "2026-06-01T00:00:00.000Z",
    );
    const run = store("run");

    expect(await check(run)).toMatchObject({ verdict: "same_text_versions", baseRawVersion: pre, gets: 2, skipped: 0 });
    expect(calls()).not.toContain(`GetObject ${marker}`);
  });

  it("is no_text_version_list, with the base copy named, when the base has no content.text", async () => {
    const pre = mockS3.putAt(
      RAW_KEY,
      withContent(PRE, (content) => delete content.text),
      RAW_COPY_STORED[GUID].pre,
    );
    const run = store("run");

    expect(await check(run)).toEqual({
      verdict: "unconfirmed",
      reason: "no_text_version_list",
      newRawVersion: run,
      baseRawVersion: pre,
      gets: 2,
      skipped: 0,
    });
  });
});
