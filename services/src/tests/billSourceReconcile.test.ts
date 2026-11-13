import { FakeVersionedS3 } from "./fakeVersionedS3";

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

import { S3Client } from "@aws-sdk/client-s3";
import { BillStorage } from "../adapters/billStorage";
import { ProcessedBillDao, type ProcessedBillRevision } from "../adapters/processedBillDao";
import type { OfficialChamberVote, OfficialVotesBreakdown, ProcessedBillDocument, RawBill } from "../models/bill";
import {
  LEGACY_ANCHOR_MAX_GETS,
  MANAGED_BILL_STATUSES,
  SOURCE_METADATA_KEYS,
  applyDerivedFields,
  carryForwardOfficialVotes,
  decideMemberVoteCarry,
  derivedPatch,
  extractRawBillTitle,
  hasMeaningfulRawContent,
  isActionablePlan,
  legacyAnchorHash,
  mergeOfficialVotes,
  needsLegacyAnchor,
  planReconcile,
  processedSourceMetadata,
  rawCongressUpdatedAt,
  rawFetchedAt,
  readProcessedSource,
  reconcileProcessedBill,
  sourceTextHash,
  visibleKey,
} from "../shared/billSourceReconcile";
import { logLines } from "./logLines";

const GUID = "BILLS-119hr7";
const RAW_KEY = `raw-bills/${GUID}.json`;
const PROCESSED_KEY = `processed-bills/${GUID}.json`;

const member = (bioguideId: string, votePosition: "Yea" | "Nay" = "Yea") => ({
  bioguideId,
  displayName: bioguideId,
  votePosition,
});

const chamber = (overrides: Partial<OfficialChamberVote> = {}): OfficialChamberVote => ({
  yea: 220,
  nay: 210,
  present: 0,
  notVoting: 0,
  totalCounted: 430,
  actionCode: "8000",
  actionDate: "2026-01-30",
  resultText: "On passage Passed by the Yeas and Nays: 220 - 210 (Roll no. 31).",
  memberDataAvailable: false,
  members: [],
  ...overrides,
});

const votes = (overrides: Partial<OfficialVotesBreakdown> = {}): OfficialVotesBreakdown => ({
  house: chamber(),
  lastSyncedAt: "2026-02-01T00:00:00.000Z",
  source: "congress_api",
  completeness: "partial",
  ...overrides,
});

const ACTION = { actionDate: "2026-01-10", actionCode: "Intro-H", text: "Introduced in House" };
const PASSAGE = {
  actionDate: "2026-01-30",
  actionCode: "8000",
  text: "On passage Passed by the Yeas and Nays: 220 - 210.",
};
const LAW = { actionDate: "2026-03-02", actionCode: "36000", text: "Became Public Law No: 119-80.", type: "BecameLaw" };

const raw = (content: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}): RawBill =>
  ({
    schemaVersion: 1,
    kind: "raw",
    storedAt: "2026-02-01T00:00:00.000Z",
    identifier: { congress: "119", billType: "hr", billNumber: "7" },
    metadata: { guid: `${GUID}ih`, title: "Title", pubDate: "", fetchedAt: "2026-02-01T00:00:00.000Z", ...metadata },
    content: {
      billXML: "<bill>text</bill>",
      actions: { actions: [ACTION] },
      committees: { committees: [] },
      bill: { bill: { sponsors: [{ bioguideId: "S000001" }] } },
      cosponsors: { cosponsors: [{ bioguideId: "C000001" }] },
      ...content,
    },
  }) as RawBill;

const processedDoc = (overrides: Partial<ProcessedBillDocument> = {}): ProcessedBillDocument => ({
  schemaVersion: 1,
  kind: "processed",
  storedAt: "2026-01-15T00:00:00.000Z",
  identifier: { congress: "119", billType: "hr", billNumber: "7" },
  guid: `${GUID}ih`,
  title: "Headline",
  link: "",
  soWhat: "Summary.",
  billBreakdown: { who: "", what: "", how: "", when: "", where: "", why: "" },
  subCategories: [],
  lifeAreas: [],
  sponsors: ["S000001"],
  cosponsors: ["C000001"],
  actions: [ACTION],
  committees: [],
  billStatus: "New",
  ...overrides,
});

const revision = (
  bill: ProcessedBillDocument,
  metadata?: Record<string, string>,
  extra: Partial<ProcessedBillRevision> = {},
): ProcessedBillRevision => ({
  bill,
  key: PROCESSED_KEY,
  location: "flat",
  etag: '"etag-p"',
  versionId: "pv1",
  lastModified: "2026-01-15T00:00:00.000Z",
  ...(metadata ? { metadata } : {}),
  ...extra,
});

const sourceFor = (rawBill: RawBill, rawVersion = "rv1") =>
  processedSourceMetadata({ textHash: sourceTextHash(rawBill), rawVersion, fetchedAt: rawFetchedAt(rawBill) });

describe("raw bill fields", () => {
  it("hashes the title and text only, stably, with a v1: prefix", () => {
    const base = raw();
    expect(sourceTextHash(base)).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(sourceTextHash(base)).toBe(sourceTextHash(raw()));
    expect(sourceTextHash(raw({ actions: { actions: [] } }, { fetchedAt: "2026-03-01T00:00:00Z" }))).toBe(
      sourceTextHash(base),
    );
    expect(sourceTextHash(raw({ billXML: "<bill>other</bill>" }))).not.toBe(sourceTextHash(base));
    expect(sourceTextHash(raw({}, { title: "Other" }))).not.toBe(sourceTextHash(base));
    // Surrounding whitespace is not a text change.
    expect(sourceTextHash(raw({ billXML: "  <bill>text</bill>\n" }))).toBe(sourceTextHash(base));
  });

  it("takes the title from metadata, else Congress's title in either content shape", () => {
    expect(extractRawBillTitle(raw())).toBe("Title");
    expect(extractRawBillTitle(raw({ bill: { bill: { title: "Nested" } } }, { title: "" }))).toBe("Nested");
    expect(extractRawBillTitle(raw({ bill: { title: "Flat" } }, { title: "" }))).toBe("Flat");
  });

  it("calls an empty fetch not meaningful", () => {
    expect(hasMeaningfulRawContent(raw())).toBe(true);
    const empty = { metadata: { guid: GUID }, content: {} } as unknown as RawBill;
    expect(hasMeaningfulRawContent(empty)).toBe(false);
    expect(hasMeaningfulRawContent({ ...empty, content: { officialVotes: {} } } as unknown as RawBill)).toBe(true);
    expect(rawFetchedAt(empty)).toBeUndefined();
  });

  it("takes congress.gov's update time as the later of updateDate and updateDateIncludingText, in either shape", () => {
    const at = (bill: Record<string, unknown>) => rawCongressUpdatedAt(raw({ bill }));
    expect(at({ bill: { updateDate: "2026-05-21T08:08:29Z", updateDateIncludingText: "2026-05-22T14:03:11Z" } })).toBe(
      "2026-05-22T14:03:11.000Z",
    );
    expect(at({ bill: { updateDate: "2026-05-23T09:00:00Z", updateDateIncludingText: "2026-05-22T14:03:11Z" } })).toBe(
      "2026-05-23T09:00:00.000Z",
    );
    expect(at({ updateDate: "2026-05-21" })).toBe("2026-05-21T00:00:00.000Z");
    expect(at({ bill: { updateDate: "not a date", updateDateIncludingText: "2026-05-22T14:03:11Z" } })).toBe(
      "2026-05-22T14:03:11.000Z",
    );
    expect(at({ bill: { updateDate: "", updateDateIncludingText: 20260522 } })).toBeUndefined();
    expect(at({ bill: {} })).toBeUndefined();
    expect(rawCongressUpdatedAt({ metadata: { guid: GUID }, content: {} } as unknown as RawBill)).toBeUndefined();
    expect(rawCongressUpdatedAt(null)).toBeUndefined();
  });

  it("reads and writes the source metadata, leaving out values S3 cannot carry", () => {
    expect(readProcessedSource(undefined)).toBeUndefined();
    expect(readProcessedSource({ "correlation-id": "x" })).toBeUndefined();
    expect(
      readProcessedSource({ [SOURCE_METADATA_KEYS.textHash]: "v1:abc", [SOURCE_METADATA_KEYS.rawVersion]: "rv" }),
    ).toEqual({ textHash: "v1:abc", rawVersion: "rv" });
    expect(
      processedSourceMetadata({ textHash: "v1:abc", rawVersion: "rv", fetchedAt: "2026-02-01T00:00:00Z" }),
    ).toEqual({
      "source-text-hash": "v1:abc",
      "source-raw-version": "rv",
      "source-fetched-at": "2026-02-01T00:00:00Z",
    });
    expect(processedSourceMetadata({ textHash: "v1:abc", fetchedAt: "février" })).toEqual({
      "source-text-hash": "v1:abc",
    });
  });
});

describe("visibleKey", () => {
  it("ignores lastSyncedAt, completeness and member order", () => {
    const a = processedDoc({ officialVotes: votes({ house: chamber({ members: [member("B2"), member("A1")] }) }) });
    const b = processedDoc({
      officialVotes: votes({
        house: chamber({ members: [member("A1"), member("B2")] }),
        lastSyncedAt: "2026-09-01T00:00:00.000Z",
        completeness: "complete",
      }),
    });
    expect(visibleKey(a)).toBe(visibleKey(b));
  });

  it("sees a changed tally, a reordered action list and a status change, but not key order", () => {
    const base = processedDoc({ actions: [ACTION, PASSAGE] });
    expect(visibleKey(processedDoc({ actions: [PASSAGE, ACTION] }))).not.toBe(visibleKey(base));
    expect(visibleKey(processedDoc({ actions: [ACTION, PASSAGE], billStatus: "Passed" }))).not.toBe(visibleKey(base));
    expect(
      visibleKey(
        processedDoc({ actions: [{ text: ACTION.text, actionCode: "Intro-H", actionDate: "2026-01-10" }, PASSAGE] }),
      ),
    ).toBe(visibleKey(base));
    expect(visibleKey(processedDoc({ officialVotes: votes() }))).not.toBe(
      visibleKey(processedDoc({ officialVotes: votes({ house: chamber({ yea: 221 }) }) })),
    );
    // Missing lists read as empty lists, a missing status as "".
    expect(visibleKey(processedDoc({ cosponsors: undefined as unknown as string[] }))).toBe(
      visibleKey(processedDoc({ cosponsors: [] })),
    );
  });
});

describe("mergeOfficialVotes (the carry rule)", () => {
  const withMembers = chamber({ memberDataAvailable: true, members: [member("A1"), member("B2", "Nay")] });

  it("keeps the processed chamber whole for the same roll call when the raw one has no members", () => {
    const merged = mergeOfficialVotes(
      votes({ house: withMembers }),
      votes({ lastSyncedAt: "2026-03-01T00:00:00.000Z" }),
    )!;
    expect(merged.house).toBe(withMembers);
    expect(merged.lastSyncedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(merged.completeness).toBe("complete");
  });

  it("compares only the date part of actionDate", () => {
    const xmlDated = { ...withMembers, actionDate: "2026-01-30T18:15:00.000Z" };
    expect(mergeOfficialVotes(votes({ house: xmlDated }), votes())!.house).toBe(xmlDated);
  });

  it("uses the raw chamber when yea/nay changed (a REL-31 fix) or the date differs", () => {
    const fixed = votes({ house: chamber({ yea: 221, nay: 209 }) });
    expect(mergeOfficialVotes(votes({ house: withMembers }), fixed)!.house).toEqual(fixed.house);
    const later = votes({ house: chamber({ actionDate: "2026-02-04" }) });
    expect(mergeOfficialVotes(votes({ house: withMembers }), later)!.house).toEqual(later.house);
    expect(mergeOfficialVotes(votes({ house: withMembers }), later)!.completeness).toBe("partial");
  });

  it("uses the raw chamber when it has members, and drops a chamber the raw votes no longer have", () => {
    const rawMembers = votes({ house: chamber({ memberDataAvailable: true, members: [member("C3")] }) });
    expect(mergeOfficialVotes(votes({ house: withMembers }), rawMembers)!.house!.members).toEqual([member("C3")]);
    const senateOnly = votes({ house: undefined, senate: chamber({ actionCode: "17000" }) });
    expect(mergeOfficialVotes(votes({ house: withMembers }), senateOnly)!.house).toBeUndefined();
    expect(mergeOfficialVotes(votes(), undefined)).toBeUndefined();
  });
});

describe("decideMemberVoteCarry and carryForwardOfficialVotes (REL-35)", () => {
  const PREVIOUS_SYNC = "2026-02-01T00:00:00.000Z";
  const FETCHED_SYNC = "2026-03-01T00:00:00.000Z";
  const withMembers = chamber({ memberDataAvailable: true, members: [member("A1"), member("B2", "Nay")] });
  const fetched = (overrides: Partial<OfficialVotesBreakdown> = {}) =>
    votes({ lastSyncedAt: FETCHED_SYNC, ...overrides });
  const houseSummary = (members: number) => ({
    actionCode: "8000",
    actionDate: "2026-01-30",
    yea: 220,
    nay: 210,
    members,
  });

  it("keeps the previous chamber whole for the same roll call, recomputes completeness and keeps lastSyncedAt", () => {
    const decision = decideMemberVoteCarry(votes({ house: withMembers, completeness: "complete" }), fetched());

    expect(decision.votes).toEqual({
      house: withMembers,
      lastSyncedAt: PREVIOUS_SYNC,
      source: "congress_api",
      completeness: "complete",
    });
    expect(decision.votes!.house).toBe(withMembers);
    expect(decision.carried).toEqual(["house"]);
    expect(decision.lastSyncedAtKept).toBe(true);
    expect(decision.previousHadMembers).toBe(true);
    expect(decision.chambers).toEqual({
      house: { outcome: "carried", previous: houseSummary(2), fetched: houseSummary(0) },
    });
    expect(carryForwardOfficialVotes(votes({ house: withMembers }), fetched())).toEqual(decision.votes);
  });

  it("keeps enrichment's own tallies (a Senate vote read from the roll-call XML) and compares only the date part", () => {
    const fromXml = chamber({
      actionCode: "17000",
      actionDate: "2026-02-03T18:15:00.000Z",
      yea: 58,
      nay: 40,
      notVoting: 2,
      totalCounted: 100,
      memberDataAvailable: true,
      members: [member("S1")],
    });
    const fromActions = chamber({ actionCode: "17000", actionDate: "2026-02-03", yea: 58, nay: 40, totalCounted: 98 });

    const decision = decideMemberVoteCarry(
      votes({ house: undefined, senate: fromXml }),
      fetched({ house: undefined, senate: fromActions }),
    );

    expect(decision.votes!.senate).toBe(fromXml);
    expect(decision.carried).toEqual(["senate"]);
    expect(decision.votes!.lastSyncedAt).toBe(PREVIOUS_SYNC);
  });

  it("keeps the House Present and Not voting figures enrichment counted from the member rows", () => {
    // The action text gives only 220 - 210; enrichment counted 1 Present and 3 Not Voting from the rows.
    const enriched = chamber({
      present: 1,
      notVoting: 3,
      totalCounted: 434,
      memberDataAvailable: true,
      members: [member("A1"), member("B2", "Nay")],
    });

    const decision = decideMemberVoteCarry(votes({ house: enriched }), fetched());

    expect(fetched().house).toMatchObject({ present: 0, notVoting: 0, totalCounted: 430 });
    expect(decision.carried).toEqual(["house"]);
    expect(decision.votes!.house).toMatchObject({ yea: 220, nay: 210, present: 1, notVoting: 3, totalCounted: 434 });
    expect(decision.lastSyncedAtKept).toBe(true);
    expect(mergeOfficialVotes(votes({ house: enriched }), fetched())!.house).toBe(enriched);
  });

  it.each([
    ["a changed tally (a REL-31 fix)", { yea: 221, nay: 209 }],
    ["another day", { actionDate: "2026-02-04" }],
    ["another action code", { actionCode: "8100" }],
  ])("keeps neither members nor lastSyncedAt for another roll call: %s", (_label, change) => {
    const next = fetched({ house: chamber(change) });

    const decision = decideMemberVoteCarry(votes({ house: withMembers }), next);

    expect(decision.votes!.house).toEqual(next.house);
    expect(decision.votes!.lastSyncedAt).toBe(FETCHED_SYNC);
    expect(decision.votes!.completeness).toBe("partial");
    expect(decision.carried).toEqual([]);
    expect(decision.lastSyncedAtKept).toBe(false);
    expect(decision.chambers.house!.outcome).toBe("new_roll_call");
  });

  it("leaves a fetched chamber that already has members", () => {
    const next = fetched({ house: chamber({ memberDataAvailable: true, members: [member("C3")] }) });

    const decision = decideMemberVoteCarry(votes({ house: withMembers }), next);

    expect(decision.votes!.house!.members).toEqual([member("C3")]);
    expect(decision.chambers.house!.outcome).toBe("fetched_members");
    expect(decision.votes!.lastSyncedAt).toBe(FETCHED_SYNC);
  });

  it("carries nothing from a chamber without members, and keeps lastSyncedAt when nothing visible changed", () => {
    const decision = decideMemberVoteCarry(votes(), fetched());

    expect(decision.votes).toEqual({ ...votes(), lastSyncedAt: PREVIOUS_SYNC, completeness: "partial" });
    expect(decision.carried).toEqual([]);
    expect(decision.previousHadMembers).toBe(false);
    expect(decision.lastSyncedAtKept).toBe(true);
    expect(decision.chambers.house!.outcome).toBe("no_previous_members");
  });

  it("decides each chamber on its own, and takes the fetched lastSyncedAt when a chamber appears or goes", () => {
    const senate = chamber({ actionCode: "17000", actionDate: "2026-02-03", yea: 60, nay: 40, totalCounted: 100 });

    const added = decideMemberVoteCarry(votes({ house: withMembers }), fetched({ senate }));
    expect(added.votes).toMatchObject({
      house: withMembers,
      senate,
      lastSyncedAt: FETCHED_SYNC,
      completeness: "partial",
    });
    expect(added.carried).toEqual(["house"]);
    expect(added.chambers).toEqual({
      house: expect.objectContaining({ outcome: "carried" }),
      senate: { outcome: "no_previous_members", fetched: expect.objectContaining({ actionCode: "17000" }) },
    });

    const senateWithMembers = { ...senate, memberDataAvailable: true, members: [member("S1")] };
    const gone = decideMemberVoteCarry(votes({ house: withMembers, senate: senateWithMembers }), fetched());
    expect(gone.votes).toMatchObject({ house: withMembers, lastSyncedAt: FETCHED_SYNC, completeness: "complete" });
    expect(gone.votes).not.toHaveProperty("senate");
    expect(gone.carried).toEqual(["house"]);
    expect(gone.chambers.senate).toEqual({
      outcome: "no_fetched_vote",
      previous: expect.objectContaining({ members: 1 }),
    });
  });

  it("returns no votes when the fetch has none, and reports the chamber it could not carry", () => {
    const decision = decideMemberVoteCarry(votes({ house: withMembers }), undefined);

    expect(decision.votes).toBeUndefined();
    expect(decision.carried).toEqual([]);
    expect(decision.lastSyncedAtKept).toBe(false);
    expect(decision.chambers).toEqual({ house: { outcome: "no_fetched_vote", previous: houseSummary(2) } });
    expect(decideMemberVoteCarry(undefined, undefined)).toEqual({
      votes: undefined,
      carried: [],
      chambers: {},
      lastSyncedAtKept: false,
      previousHadMembers: false,
    });
  });

  it.each([
    ["missing", undefined],
    ["without a source", { house: withMembers, lastSyncedAt: PREVIOUS_SYNC }],
    ["without lastSyncedAt", { house: withMembers, source: "congress_api" }],
    ["not an object", "votes"],
  ])("treats previous votes that are %s as none", (_label, previous) => {
    const decision = decideMemberVoteCarry(previous as unknown as OfficialVotesBreakdown, fetched());

    expect(decision.votes).toEqual(fetched());
    expect(decision.carried).toEqual([]);
    expect(decision.previousHadMembers).toBe(false);
    expect(decision.lastSyncedAtKept).toBe(false);
  });

  it("modifies neither argument", () => {
    const previous = votes({ house: withMembers, completeness: "complete" });
    const next = fetched();
    const before = JSON.stringify([previous, next]);

    decideMemberVoteCarry(previous, next);
    decideMemberVoteCarry(votes({ house: withMembers }), next);

    expect(JSON.stringify([previous, next])).toBe(before);
  });

  it("gives billDiffer nothing to patch: the processed bill built from the enriched raw bill stays as it is", () => {
    const enriched = votes({ house: withMembers, completeness: "complete" });
    const processed = applyDerivedFields(processedDoc(), raw({ officialVotes: enriched }));
    const refetch = raw(
      { officialVotes: carryForwardOfficialVotes(enriched, fetched()) },
      { fetchedAt: "2026-03-01T00:00:00.000Z" },
    );

    expect(derivedPatch(processed, refetch)).toBeNull();
    expect(processed.officialVotes!.house).toBe(withMembers);
  });
});

describe("applyDerivedFields and derivedPatch", () => {
  it("replaces each field from its raw container", () => {
    const next = applyDerivedFields(
      processedDoc({ sponsors: [], cosponsors: [] }),
      raw({
        actions: { actions: [PASSAGE, ACTION] },
        committees: { committees: [{ name: "Judiciary" }] },
        bill: { bill: { sponsors: [{ bioguideId: "S000002" }] } },
        cosponsors: { cosponsors: [{ bioguideId: "C000002" }, { bioguideId: "C000003" }] },
        officialVotes: votes(),
      }),
    );
    expect(next).toMatchObject({
      actions: [PASSAGE, ACTION],
      committees: [{ name: "Judiciary" }],
      sponsors: ["S000002"],
      cosponsors: ["C000002", "C000003"],
      billStatus: "Passed",
      officialVotes: { house: { yea: 220, nay: 210 } },
    });
  });

  it("keeps the processed value when a raw container is missing", () => {
    const processed = processedDoc({ committees: [{ name: "Rules" }], officialVotes: votes() });
    const sparse = raw({
      actions: undefined,
      committees: undefined,
      bill: { title: "flat shape" },
      cosponsors: undefined,
    });
    const next = applyDerivedFields(processed, sparse);
    expect(next.actions).toEqual([ACTION]);
    expect(next.committees).toEqual([{ name: "Rules" }]);
    expect(next.sponsors).toEqual(["S000001"]);
    expect(next.cosponsors).toEqual(["C000001"]);
    // No actions container: the votes are kept even though the raw bill has none.
    expect(next.officialVotes).toEqual(votes());
  });

  it("removes the votes only when the raw bill has none and its actions container is present", () => {
    expect(applyDerivedFields(processedDoc({ officialVotes: votes() }), raw()).officialVotes).toBeUndefined();
    // Votes without a source (an old shape) count as none.
    const unsourced = raw({ officialVotes: { house: chamber(), lastSyncedAt: "2026-02-01T00:00:00Z" } });
    expect(applyDerivedFields(processedDoc({ officialVotes: votes() }), unsourced).officialVotes).toBeUndefined();
  });

  it("derives a managed billStatus, Finalized included (REL-44), and keeps Updated", () => {
    const passed = raw({ actions: { actions: [PASSAGE, ACTION] } });
    const law = raw({ actions: { actions: [LAW, PASSAGE, ACTION] } });
    expect(MANAGED_BILL_STATUSES.has("New")).toBe(true);
    expect(MANAGED_BILL_STATUSES.has("Finalized")).toBe(true);
    expect(MANAGED_BILL_STATUSES.has("Updated")).toBe(false);
    expect(applyDerivedFields(processedDoc({ billStatus: "New" }), passed).billStatus).toBe("Passed");
    expect(applyDerivedFields(processedDoc({ billStatus: undefined }), passed).billStatus).toBe("Passed");
    expect(applyDerivedFields(processedDoc({ billStatus: "" as never }), raw()).billStatus).toBe("New");
    expect(applyDerivedFields(processedDoc({ billStatus: "Passed" }), law).billStatus).toBe("Finalized");
    expect(applyDerivedFields(processedDoc({ billStatus: "Finalized" }), law).billStatus).toBe("Finalized");
    // Managed both ways: actions that no longer record the law give the status they do record.
    expect(applyDerivedFields(processedDoc({ billStatus: "Finalized" }), passed).billStatus).toBe("Passed");
    expect(applyDerivedFields(processedDoc({ billStatus: "Updated" }), passed).billStatus).toBe("Updated");
    expect(applyDerivedFields(processedDoc({ billStatus: "Updated" }), law).billStatus).toBe("Updated");
  });

  it("patches a Passed bill whose raw actions record the law, as a visible billStatus change (REL-44)", () => {
    const processed = processedDoc({ billStatus: "Passed", actions: [LAW, PASSAGE, ACTION] });
    const patch = derivedPatch(processed, raw({ actions: { actions: [LAW, PASSAGE, ACTION] } }));
    expect(patch?.changedFields).toEqual(["billStatus"]);
    expect(patch?.next.billStatus).toBe("Finalized");
  });

  it("returns null when nothing visible changes, else the changed fields", () => {
    expect(derivedPatch(processedDoc(), raw())).toBeNull();
    expect(derivedPatch(processedDoc(), raw({ actions: { actions: [PASSAGE, ACTION] } }))?.changedFields).toEqual([
      "actions",
      "billStatus",
    ]);
  });
});

describe("legacyAnchorHash", () => {
  let storage: BillStorage;
  beforeEach(() => {
    mockS3 = new FakeVersionedS3();
    storage = new BillStorage(new S3Client({}), "bucket");
  });
  const textRaw = (label: string) => raw({ billXML: `<bill>${label}</bill>` });
  const latest = () => {
    const current = mockS3.current(RAW_KEY)!;
    return { versionId: current.versionId, lastModified: current.lastModified.toISOString() };
  };
  const versionGets = () => mockS3.commands("GetObject", RAW_KEY).filter((call) => call.input.VersionId);

  it("prefers the newest version at or before the processed bill, skipping delete markers and a newer current version", async () => {
    mockS3.put(RAW_KEY, textRaw("old"));
    mockS3.put(RAW_KEY, textRaw("summarized"));
    const processedAt = new Date(Date.parse("2026-02-01T21:20:02.500Z")).toISOString();
    mockS3.deleteObject(RAW_KEY);
    mockS3.put(RAW_KEY, textRaw("later"));
    mockS3.put(RAW_KEY, textRaw("current"));

    expect(await legacyAnchorHash(storage, RAW_KEY, latest(), processedAt)).toBe(sourceTextHash(textRaw("summarized")));
    expect(versionGets()).toHaveLength(1);
  });

  it("takes the current version when the processed bill was written at or after it, without reading it again", async () => {
    // The old pipeline's text change: billDiffer queued the new text and billSummarizer built the
    // processed bill from it, so the processed bill is newer than the current raw version.
    mockS3.put(RAW_KEY, textRaw("introduced"));
    mockS3.put(RAW_KEY, textRaw("reported"));
    const read = { ...latest(), value: textRaw("reported") };
    const twoMinutesLater = new Date(Date.parse(read.lastModified) + 120_000).toISOString();

    expect(await legacyAnchorHash(storage, RAW_KEY, read, twoMinutesLater)).toBe(sourceTextHash(textRaw("reported")));
    expect(await legacyAnchorHash(storage, RAW_KEY, read, read.lastModified)).toBe(sourceTextHash(textRaw("reported")));
    expect(versionGets()).toHaveLength(0);
    // Without the body in hand it reads that version.
    expect(await legacyAnchorHash(storage, RAW_KEY, latest(), twoMinutesLater)).toBe(
      sourceTextHash(textRaw("reported")),
    );
    expect(versionGets()).toHaveLength(1);
  });

  it("falls back to the oldest later version when none is older than the processed bill", async () => {
    mockS3.put(RAW_KEY, textRaw("later-1"));
    mockS3.put(RAW_KEY, textRaw("later-2"));
    mockS3.put(RAW_KEY, textRaw("current"));
    expect(await legacyAnchorHash(storage, RAW_KEY, latest(), "2026-01-01T00:00:00.000Z")).toBe(
      sourceTextHash(textRaw("later-1")),
    );
  });

  it("skips versions without meaningful content, GETs at most 3, and gives null when none is usable", async () => {
    // The only meaningful older version is the 5th candidate (newest first): never read.
    mockS3.put(RAW_KEY, textRaw("fifth"));
    for (let index = 0; index < 4; index += 1) mockS3.put(RAW_KEY, { metadata: {}, content: {} });
    mockS3.put(RAW_KEY, textRaw("current"));

    expect(await legacyAnchorHash(storage, RAW_KEY, latest(), undefined)).toBeNull();
    expect(versionGets()).toHaveLength(LEGACY_ANCHOR_MAX_GETS);
  });

  it("ignores versions newer than the raw bill that was read, and gives null with no history", async () => {
    mockS3.put(RAW_KEY, textRaw("read"));
    const read = latest();
    mockS3.put(RAW_KEY, textRaw("written after the read"));
    expect(await legacyAnchorHash(storage, RAW_KEY, read, undefined)).toBeNull();
    expect(versionGets()).toHaveLength(0);
  });
});

describe("a page-only status repair of a legacy bill (repair:failed-status, RUNBOOK 4.11, 2026-10-29)", () => {
  // H.J.Res. 139: its raw bill was written once, in March; backfill:bill-status rewrote its processed bill on 2026-04-07
  // (Failed, no source metadata), and the repair writes it again (New, storedAt to its row's date), so its LastModified
  // moves from April to the day of the repair.
  const APRIL_7 = "2026-04-07T00:27:09.000Z";
  const REPAIRED = "2026-10-30T03:00:00.000Z";
  const SUSPENSION = {
    actionDate: "2026-03-18",
    actionCode: "9000",
    text: "Failed of passage/not agreed to in House: On motion to suspend the rules and pass the resolution Failed by the Yeas and Nays: (2/3 required): 211 - 207 (Roll no. 95).",
  };
  const rawBill = raw({ actions: { actions: [SUSPENSION, ACTION] } });
  let storage: BillStorage;
  beforeEach(() => {
    mockS3 = new FakeVersionedS3();
    storage = new BillStorage(new S3Client({}), "bucket");
  });
  const latest = () => {
    const current = mockS3.current(RAW_KEY)!;
    return { versionId: current.versionId, lastModified: current.lastModified.toISOString() };
  };

  it("leaves billDiffer's legacy anchor where it was, now and at the bill's next raw version", async () => {
    mockS3.putAt(RAW_KEY, rawBill, "2026-03-23T18:22:59.000Z");
    const march = latest();
    const anchor = sourceTextHash(rawBill);
    expect(await legacyAnchorHash(storage, RAW_KEY, march, APRIL_7)).toBe(anchor);
    expect(await legacyAnchorHash(storage, RAW_KEY, march, REPAIRED)).toBe(anchor);

    mockS3.putAt(RAW_KEY, raw({ billXML: "<bill>new text</bill>" }), "2026-11-02T10:00:00.000Z");
    expect(await legacyAnchorHash(storage, RAW_KEY, latest(), APRIL_7)).toBe(anchor);
    expect(await legacyAnchorHash(storage, RAW_KEY, latest(), REPAIRED)).toBe(anchor);
  });

  it("leaves billDiffer no status to write: it derives New from the actions, whatever the anchor", () => {
    const actions = applyDerivedFields(processedDoc(), rawBill).actions;
    const page = (billStatus: string, lastModified: string) =>
      revision(processedDoc({ actions, billStatus: billStatus as ProcessedBillDocument["billStatus"] }), undefined, {
        lastModified,
      });
    const plan = (processed: ProcessedBillRevision) =>
      planReconcile({
        processed,
        raw: { value: rawBill, versionId: "rv-march", lastModified: "2026-03-23T18:22:59.000Z" },
        messageGuid: GUID,
        anchorHash: sourceTextHash(rawBill),
        now: new Date("2026-11-02T10:00:00.000Z"),
      });
    // Unrepaired, the page's Failed is a visible change billDiffer writes with storedAt now: status news, which moves
    // the row (RUNBOOK 4.9). Repaired, nothing is left to write, and the text counts as unchanged either way.
    expect(plan(page("Failed", APRIL_7))).toMatchObject({
      kind: "patch",
      changedFields: ["billStatus"],
      next: { billStatus: "New", storedAt: "2026-11-02T10:00:00.000Z" },
    });
    expect(plan(page("New", REPAIRED))).toMatchObject({ kind: "unchanged", decidedBy: "legacy-anchor" });
  });
});

describe("planReconcile", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const plan = (
    processed: ProcessedBillRevision | null,
    rawBill: RawBill | null,
    extra: Record<string, unknown> = {},
  ) =>
    planReconcile({ processed, raw: { value: rawBill, versionId: "rv2", ...extra }, messageGuid: GUID, now, ...extra });

  it("skips a missing or empty raw bill, and falls back to the message guid", () => {
    expect(plan(null, null)).toMatchObject({ kind: "skipped", reason: "no_raw", guid: GUID });
    const empty = { metadata: {}, content: {} } as unknown as RawBill;
    expect(plan(revision(processedDoc()), empty)).toMatchObject({ kind: "skipped", reason: "no_meaningful_content" });
  });

  it("summarizes a bill with text and no processed copy under its plain guid, and waits for text otherwise", () => {
    // raw() keeps a legacy metadata.guid (BILLS-119hr7ih): a raw metadata.guid with a suffix is sent plain.
    expect(plan(null, raw())).toMatchObject({ kind: "summarize_missing", guid: GUID });
    expect(plan(null, raw({ billXML: undefined }))).toMatchObject({ kind: "awaiting_text", reason: "no_text" });
    expect(isActionablePlan("summarize_missing")).toBe(true);
    expect(isActionablePlan("awaiting_text")).toBe(false);
  });

  it("is unchanged for the raw version it was built from, and for a raw bill with nothing visible new", () => {
    const rawBill = raw();
    expect(plan(revision(processedDoc(), sourceFor(rawBill, "rv2")), rawBill)).toMatchObject({
      kind: "unchanged",
      reason: "same_raw_version",
    });
    expect(plan(revision(processedDoc(), sourceFor(rawBill, "rv1")), rawBill)).toMatchObject({
      kind: "unchanged",
      reason: "no_visible_change",
      decidedBy: "source-hash",
    });
  });

  it("calls a raw bill from an older fetch stale", () => {
    const newer = raw({}, { fetchedAt: "2026-03-01T00:00:00.000Z" });
    const older = raw({ actions: { actions: [PASSAGE] } }, { fetchedAt: "2026-02-01T00:00:00.000Z" });
    expect(plan(revision(processedDoc(), sourceFor(newer)), older)).toMatchObject({ kind: "stale_raw" });
  });

  it("summarizes changed text by the recorded hash, the legacy anchor, and never when assumed", () => {
    const old = raw({ billXML: "<bill>old</bill>" });
    const changed = raw({ billXML: "<bill>new</bill>" });
    expect(plan(revision(processedDoc(), sourceFor(old)), changed)).toMatchObject({
      kind: "summarize_text_changed",
      decidedBy: "source-hash",
    });
    expect(plan(revision(processedDoc()), changed, { anchorHash: sourceTextHash(old) })).toMatchObject({
      kind: "summarize_text_changed",
      decidedBy: "legacy-anchor",
    });
    expect(plan(revision(processedDoc()), changed, { anchorHash: null })).toMatchObject({
      kind: "unchanged",
      decidedBy: "assumed",
    });
    // Text removed from the raw bill is never summarized; the summary's hash is kept.
    const noText = raw({ billXML: undefined, actions: { actions: [PASSAGE, ACTION] } });
    expect(plan(revision(processedDoc(), sourceFor(old)), noText)).toMatchObject({
      kind: "patch",
      source: { textHash: sourceTextHash(old) },
    });
  });

  it("patches the derived fields of a text change before its summary, keeping the old text hash", () => {
    const old = raw({ billXML: "<bill>old</bill>" });
    const changed = raw(
      { billXML: "<bill>new</bill>", actions: { actions: [PASSAGE, ACTION] } },
      { fetchedAt: "2026-02-02T00:00:00.000Z" },
    );
    const result = plan(revision(processedDoc(), sourceFor(old)), changed);
    expect(result).toMatchObject({
      kind: "summarize_text_changed",
      changedFields: ["actions", "billStatus"],
      source: { textHash: sourceTextHash(old), rawVersion: "rv2", fetchedAt: "2026-02-02T00:00:00.000Z" },
    });
    expect(result.next).toMatchObject({ billStatus: "Passed", soWhat: "Summary.", storedAt: now.toISOString() });
    // Nothing visible new: only the summary.
    const textOnly = plan(revision(processedDoc(), sourceFor(old)), raw({ billXML: "<bill>new</bill>" }));
    expect(textOnly).toMatchObject({ kind: "summarize_text_changed", changedFields: [] });
    expect(textOnly.next).toBeUndefined();
    // After that patch the same raw version still plans the summary (a redelivery after a failed send).
    const patched = processedDoc({ actions: [PASSAGE, ACTION], billStatus: "Passed" });
    const redelivered = plan(
      revision(patched, { ...sourceFor(changed, "rv2"), [SOURCE_METADATA_KEYS.textHash]: sourceTextHash(old) }),
      changed,
    );
    expect(redelivered).toMatchObject({ kind: "summarize_text_changed", reason: "text_changed", changedFields: [] });
    expect(redelivered.next).toBeUndefined();
  });

  it("patches with storedAt now and the raw bill as the source", () => {
    const rawBill = raw({ actions: { actions: [PASSAGE, ACTION] } }, { fetchedAt: "2026-02-02T00:00:00.000Z" });
    const result = plan(revision(processedDoc(), sourceFor(raw())), rawBill);
    expect(result).toMatchObject({
      kind: "patch",
      reason: "derived_fields_changed",
      changedFields: ["actions", "billStatus"],
      source: { textHash: sourceTextHash(rawBill), rawVersion: "rv2", fetchedAt: "2026-02-02T00:00:00.000Z" },
    });
    expect(result.next).toMatchObject({ storedAt: now.toISOString(), billStatus: "Passed", soWhat: "Summary." });
  });

  it("asks for the anchor only for a processed bill without source metadata", () => {
    const rawBill = raw();
    expect(needsLegacyAnchor(revision(processedDoc()), { value: rawBill })).toBe(true);
    expect(needsLegacyAnchor(revision(processedDoc(), sourceFor(rawBill)), { value: rawBill })).toBe(false);
    expect(needsLegacyAnchor(null, { value: rawBill })).toBe(false);
  });
});

describe("reconcileProcessedBill", () => {
  let storage: BillStorage;
  let processedDao: ProcessedBillDao;
  beforeEach(() => {
    mockS3 = new FakeVersionedS3();
    storage = new BillStorage(new S3Client({}), "bucket");
    processedDao = new ProcessedBillDao(new S3Client({}), "bucket");
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  const request = (mode: "differ" | "summarizer" = "differ") => ({ key: RAW_KEY, messageGuid: GUID, mode });
  const metrics = (name: string) => logLines(console.log).filter((line) => line._aws && name in line).length;

  it("skips when the raw bill is gone", async () => {
    expect(await reconcileProcessedBill(request(), { storage, processedDao })).toMatchObject({ outcome: "skipped" });
  });

  it("retries a refused patch from fresh reads and throws after 3 conflicts", async () => {
    const rawBill = raw({ actions: { actions: [PASSAGE, ACTION] } });
    const rawVersion = mockS3.put(RAW_KEY, rawBill);
    mockS3.put(PROCESSED_KEY, processedDoc(), sourceFor(raw(), "older"));
    for (let index = 0; index < 3; index += 1) mockS3.injectPutError(PROCESSED_KEY, index === 1 ? 412 : 409);

    await expect(reconcileProcessedBill(request(), { storage, processedDao })).rejects.toThrow(
      "3 conditional writes refused",
    );
    expect(metrics("BillDifferWriteConflict")).toBe(3);

    mockS3.injectPutError(PROCESSED_KEY, 409);
    const result = await reconcileProcessedBill(request(), { storage, processedDao });
    expect(result).toMatchObject({ outcome: "patched", attempts: 2 });
    expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({ "source-raw-version": rawVersion });
  });

  it("never sends from the summarizer's catch-up, and throws through a failed send", async () => {
    mockS3.put(RAW_KEY, raw());
    expect(await reconcileProcessedBill(request("summarizer"), { storage, processedDao })).toMatchObject({
      outcome: "superseded",
    });
    const sendToSummarizer = jest.fn().mockRejectedValue(new Error("SQS down"));
    await expect(reconcileProcessedBill(request(), { storage, processedDao, sendToSummarizer })).rejects.toThrow(
      "SQS down",
    );
  });

  // The U9b cosponsor backfill sent such a raw bill's metadata.guid; the summarizer then stored the suffixed guid.
  it("sends a text change under the plain guid when the raw metadata.guid keeps a suffix", async () => {
    const before = raw({ billXML: "<bill>old</bill>" }, { guid: `${GUID}rh` });
    mockS3.put(PROCESSED_KEY, processedDoc({ guid: GUID }), sourceFor(before, "older"));
    const rawVersion = mockS3.put(RAW_KEY, raw({}, { guid: `${GUID}rh` }));
    const sendToSummarizer = jest.fn(async () => undefined);

    const result = await reconcileProcessedBill(request(), { storage, processedDao, sendToSummarizer });

    expect(result).toMatchObject({ outcome: "enqueued", plan: { kind: "summarize_text_changed", guid: GUID } });
    expect(sendToSummarizer).toHaveBeenCalledWith({ guid: GUID, rawVersionId: rawVersion }, undefined);
  });

  it("writes the pre-summary patch before sending, and retries it from fresh reads after a conflict", async () => {
    mockS3.put(PROCESSED_KEY, processedDoc(), sourceFor(raw({ billXML: "<bill>old</bill>" }), "older"));
    const rawVersion = mockS3.put(RAW_KEY, raw({ actions: { actions: [PASSAGE, ACTION] } }));
    mockS3.injectPutError(PROCESSED_KEY, 412);
    const order: string[] = [];
    mockS3.beforePut(PROCESSED_KEY, () => {
      order.push("write");
    });
    const sendToSummarizer = jest.fn(async () => {
      order.push("send");
    });

    const result = await reconcileProcessedBill(request(), { storage, processedDao, sendToSummarizer });

    expect(result).toMatchObject({
      outcome: "enqueued",
      attempts: 2,
      plan: { changedFields: ["actions", "billStatus"] },
    });
    expect(sendToSummarizer).toHaveBeenCalledTimes(1);
    expect(sendToSummarizer).toHaveBeenCalledWith({ guid: GUID, rawVersionId: rawVersion }, undefined);
    expect(order).toEqual(["write", "send"]);
    expect(mockS3.json(PROCESSED_KEY)).toMatchObject({ billStatus: "Passed", soWhat: "Summary." });
    expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
      [SOURCE_METADATA_KEYS.textHash]: sourceTextHash(raw({ billXML: "<bill>old</bill>" })),
      [SOURCE_METADATA_KEYS.rawVersion]: rawVersion,
    });
    expect(metrics("BillDifferPatched")).toBe(1);
    expect(metrics("BillDifferEnqueued")).toBe(1);
  });

  it("writes a legacy-location bill to the flat key with IfNoneMatch and counts the anchor lookup", async () => {
    mockS3.put(RAW_KEY, raw({ actions: { actions: [PASSAGE, ACTION] } }));
    mockS3.put("bills-manifest.json", { bills: [{ guid: GUID, congress: "119", billType: "hr", billNumber: "7" }] });
    mockS3.put(`processed-bills/congress-119/hr/${GUID}.json`, processedDoc());

    const result = await reconcileProcessedBill(request(), { storage, processedDao });

    expect(result).toMatchObject({ outcome: "patched", plan: { decidedBy: "assumed" } });
    expect(mockS3.commands("PutObject", PROCESSED_KEY)[0].input).toMatchObject({ IfNoneMatch: "*" });
    expect(metrics("BillDifferLegacyAnchor")).toBe(1);
    expect(metrics("ProcessedBillLegacyLocation")).toBe(1);
  });
});
