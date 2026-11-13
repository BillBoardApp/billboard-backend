import { createHash } from "node:crypto";
import {
  CONTENT_HASH_VERSION,
  billContentHash,
  classifyBillVersionChange,
  contentHashChangeClass,
  formatDateBasis,
  isContentHash,
  latestAction,
  manifestDateBasis,
  manifestDateJudgement,
  manifestDateMoves,
  manifestDateStatus,
  manifestSortKey,
  manifestTimestamp,
  parseDateBasis,
  rowDateMoves,
  sameDayActions,
  type ManifestDateBasis,
} from "../shared/billVersionChange";
import { actionTextWithoutCitations } from "../shared/congressionalRecordCitations";

interface Member {
  bioguideId: string;
  displayName: string;
  party: string;
  state: string;
  votePosition: string;
}

/** A chamber's tally; tests rewrite any field, so every field is open. */
interface Tally {
  [field: string]: string | number | boolean | Member[] | undefined;
  members: Member[];
}

interface ActionEntry {
  actionCode?: string;
  actionDate?: string;
  text?: string;
  type?: string;
  sourceSystem?: { code: number; name: string };
  [field: string]: unknown;
}

/** A processed bill as the tests edit it: the fields they touch are typed, any other field is open. */
interface Doc {
  [field: string]: unknown;
  storedAt: string;
  identifier: Record<string, string>;
  guid: string;
  title: string;
  sponsors: string[];
  cosponsors: string[];
  subCategories: string[];
  lifeAreas: string[];
  actions: ActionEntry[];
  committees: unknown[] | null;
  officialVotes: { house: Tally; senate?: Partial<Tally>; lastSyncedAt: string; [field: string]: unknown };
}

const member = (bioguideId: string, party: string, votePosition: string): Member => ({
  bioguideId,
  displayName: `Member ${bioguideId}`,
  party,
  state: "NJ",
  votePosition,
});

/** A processed bill as BillSummarizer and BillDiffer store it (shapes from processed-bills/, 2026-10-11). */
const BILL: Doc = {
  schemaVersion: 1,
  kind: "processed",
  storedAt: "2026-03-19T16:57:53.915Z",
  identifier: { congress: "119", billType: "hr", billNumber: "2743" },
  guid: "BILLS-119hr2743",
  title: "Lowers Drug Costs for Seniors",
  link: "https://www.congress.gov/bill/119th-congress/house-bill/2743/text",
  soWhat: "Seniors would pay less for insulin.",
  billBreakdown: ["Caps insulin at $35 a month."],
  internalSchema: 2,
  subCategories: ["Healthcare", "Seniors"],
  lifeAreas: ["Medical Costs", "Retirement"],
  sponsors: ["R000606", "S001205"],
  cosponsors: ["B001318", "C001091"],
  actions: [
    {
      actionCode: "H11100",
      actionDate: "2026-02-10",
      sourceSystem: { code: 2, name: "House floor actions" },
      text: "Referred to the House Committee on Energy and Commerce.",
      type: "IntroReferral",
    },
    {
      actionCode: "1025",
      actionDate: "2026-02-10",
      sourceSystem: { code: 9, name: "Library of Congress" },
      text: "Introduced in House",
      type: "IntroReferral",
    },
  ],
  committees: [{ chamber: "House", name: "Energy and Commerce Committee", systemCode: "hsif00" }],
  billStatus: "New",
  civicProfile: { individualVsCommunity: 0.7, freeMarketVsRegulated: 0.6 },
  officialVotes: {
    house: {
      yea: 216,
      nay: 211,
      present: 0,
      notVoting: 0,
      totalCounted: 427,
      actionCode: "H37100",
      actionDate: "2026-02-12",
      resultText: "On passage Passed by the Yeas and Nays: 216 - 211 (Roll no. 351).",
      memberDataAvailable: true,
      members: [member("A000055", "R", "Yea"), member("V000133", "D", "Nay")],
    },
    lastSyncedAt: "2026-03-19T16:57:00.000Z",
    source: "congress_api",
    completeness: "complete",
  },
};

const clone = <T>(doc: T): T => JSON.parse(JSON.stringify(doc));

/** BILL with `change` applied to a copy (storedAt moved, as every new version does). */
const changed = (change: (doc: Doc) => void, base: Doc = BILL): Doc => {
  const doc = clone(base);
  doc.storedAt = "2026-10-11T22:41:29.355Z";
  change(doc);
  return doc;
};

const classOf = (previous: Doc | null, current: Doc) => classifyBillVersionChange(previous, current).changeClass;

const labelsOf = (previous: Doc, current: Doc) => classifyBillVersionChange(previous, current).labels;

const action = (actionDate: string, text: string, extra: Record<string, unknown> = {}) => ({
  actionCode: "H11100",
  actionDate,
  text,
  type: "Floor",
  ...extra,
});

describe("classifyBillVersionChange", () => {
  it("treats a first publication, or a version after only a delete marker, as visible", () => {
    expect(classifyBillVersionChange(null, BILL)).toEqual({
      changeClass: "user_visible",
      labels: ["V:firstPublication"],
    });
    expect(classOf(undefined as unknown as null, BILL)).toBe("user_visible");
  });

  it("finds a new version with only storedAt moved bookkeeping", () => {
    expect(
      classifyBillVersionChange(
        BILL,
        changed(() => undefined),
      ),
    ).toEqual({
      changeClass: "bookkeeping_only",
      labels: ["K:storedAt"],
    });
    expect(classOf(BILL, clone(BILL))).toBe("bookkeeping_only");
  });

  it.each(["title", "soWhat", "billBreakdown", "civicProfile", "billStatus"])(
    "finds a change of %s visible",
    (field) => {
      const current = changed((doc) => {
        doc[field] = field === "billBreakdown" ? ["Caps insulin at $25 a month."] : field === "civicProfile" ? {} : "x";
      });
      expect(classifyBillVersionChange(BILL, current)).toEqual({
        changeClass: "user_visible",
        labels: [`V:${field}`, "K:storedAt"],
      });
    },
  );

  it("counts a missing visible field as null", () => {
    const withNull = changed((doc) => {
      doc.billStatus = null;
    });
    const without = changed((doc) => {
      delete doc.billStatus;
    });
    expect(classOf(withNull, without)).toBe("bookkeeping_only");
    expect(contentHashChangeClass(billContentHash(withNull), billContentHash(without))).toBe("bookkeeping_only");
    expect(classOf(BILL, without)).toBe("user_visible");
  });

  it.each(["sponsors", "subCategories", "lifeAreas"] as const)(
    "finds a member of %s visible and a pure reorder detail",
    (field) => {
      const added = changed((doc) => {
        doc[field] = [...doc[field], "Z000001"];
      });
      const reordered = changed((doc) => {
        doc[field] = [...doc[field]].reverse();
      });
      expect(labelsOf(BILL, added)).toEqual([`V:${field}`, `D:${field}`, "K:storedAt"]);
      expect(labelsOf(BILL, reordered)).toEqual(BILL[field].length > 1 ? [`D:${field}`, "K:storedAt"] : ["K:storedAt"]);
    },
  );

  describe("latest action", () => {
    it("finds a newer action visible", () => {
      const current = changed((doc) => {
        doc.actions.push(action("2026-03-01", "Passed House"));
      });
      expect(labelsOf(BILL, current)).toEqual(["V:latestAction", "D:actions", "K:storedAt"]);
    });

    it("finds a changed text of the latest action visible", () => {
      const current = changed((doc) => {
        doc.actions[1].text = "Introduced in House (corrected)";
      });
      expect(classOf(BILL, current)).toBe("user_visible");
    });

    it("finds another text on the same date and time visible", () => {
      const current = changed((doc) => {
        doc.actions.push(action("2026-02-10", "Sponsor introductory remarks on measure."));
      });
      expect(classOf(BILL, current)).toBe("user_visible");
    });

    it("finds the latest action removed visible", () => {
      const previous = changed((doc) => {
        doc.actions.push(action("2026-03-01", "Passed House"));
      });
      expect(
        labelsOf(
          previous,
          changed(() => undefined),
        ),
      ).toEqual(["V:latestAction", "D:actions"]);
    });

    it("compares the latest texts as a set of trimmed strings", () => {
      expect(latestAction(BILL.actions)?.texts).toEqual([
        "Introduced in House",
        "Referred to the House Committee on Energy and Commerce.",
      ]);
      const swapped = changed((doc) => {
        doc.actions[1].text = BILL.actions[0].text;
        doc.actions[0].text = `  ${BILL.actions[1].text}  `;
      });
      expect(labelsOf(BILL, swapped)).toEqual(["D:actions", "K:storedAt"]);
    });

    it("finds an older action's text detail", () => {
      const previous = changed((doc) => {
        doc.actions.push(action("2026-03-01", "Passed House"));
      });
      const current = changed((doc) => {
        doc.actions[0].text = "Referred to the Committee on Energy and Commerce.";
      }, previous);
      expect(labelsOf(previous, current)).toEqual(["D:actions"]);
    });

    it("finds a removed duplicate of the latest action detail (hres1186)", () => {
      const previous = changed((doc) => {
        doc.actions.push(clone(doc.actions[1]));
      });
      expect(
        labelsOf(
          previous,
          changed(() => undefined),
        ),
      ).toEqual(["D:actions"]);
    });

    it("finds a pure reorder of the actions detail", () => {
      const current = changed((doc) => {
        doc.actions.reverse();
      });
      expect(labelsOf(BILL, current)).toEqual(["D:actions", "K:storedAt"]);
    });

    it("finds only the latest action's actionCode changed detail", () => {
      const current = changed((doc) => {
        doc.actions[1].actionCode = "1000";
      });
      expect(labelsOf(BILL, current)).toEqual(["D:actions", "K:storedAt"]);
    });

    it("breaks a same-date tie by the time, and sorts a missing time first", () => {
      const actions = [
        action("2026-03-01", "Motion to reconsider laid on the table", { actionTime: "14:05:00" }),
        action("2026-03-01", "On passage Passed", { actionTime: "14:04:59" }),
        action("2026-03-01", "Passed House"),
        action("2026-02-28", "Rule adopted", { actionTime: "23:59:59" }),
      ];
      expect(latestAction(actions)).toEqual({
        actionDate: "2026-03-01",
        actionTime: "14:05:00",
        texts: ["Motion to reconsider laid on the table"],
      });
      expect(latestAction(actions.slice(2))).toEqual({
        actionDate: "2026-03-01",
        actionTime: "",
        texts: ["Passed House"],
      });
      expect(latestAction([])).toBeNull();
      expect(latestAction("not a list")).toBeNull();
      expect(latestAction([null, "x"])).toBeNull();
    });
  });

  describe("official votes", () => {
    it("finds a chamber added or removed visible", () => {
      const added = changed((doc) => {
        doc.officialVotes.senate = { yea: 51, nay: 49, resultText: "Passed Senate" };
      });
      const removed = changed((doc) => {
        Reflect.deleteProperty(doc.officialVotes, "house");
      });
      expect(labelsOf(BILL, added)).toEqual(["V:officialVoteTallies", "D:officialVotes", "K:storedAt"]);
      expect(classOf(BILL, removed)).toBe("user_visible");
    });

    it.each(["yea", "nay", "present", "notVoting", "totalCounted", "resultText", "actionDate", "actionCode"])(
      "finds a change of the tally's %s visible",
      (field) => {
        const current = changed((doc) => {
          doc.officialVotes.house[field] = field === "yea" ? 2116 : "changed";
        });
        expect(classOf(BILL, current)).toBe("user_visible");
      },
    );

    it("finds a bogus tally removed visible (U9h)", () => {
      const previous = changed((doc) => {
        doc.officialVotes.house.yea = 2116;
        doc.officialVotes.house.nay = 2117;
      });
      expect(
        classOf(
          previous,
          changed(() => undefined),
        ),
      ).toBe("user_visible");
    });

    it("finds a member list filled detail (hres426)", () => {
      const previous = changed((doc) => {
        doc.officialVotes.house.members = [];
        doc.officialVotes.house.memberDataAvailable = false;
        doc.officialVotes.completeness = "partial";
      });
      expect(
        labelsOf(
          previous,
          changed(() => undefined),
        ),
      ).toEqual(["D:officialVotes", "K:officialVotes.completeness"]);
    });

    it("finds a member's party corrected detail (hr3492)", () => {
      const current = changed((doc) => {
        doc.officialVotes.house.members[1].party = "R";
      });
      expect(labelsOf(BILL, current)).toEqual(["D:officialVotes", "K:storedAt"]);
    });

    it("finds members reordered, lastSyncedAt or completeness alone bookkeeping", () => {
      const reordered = changed((doc) => {
        doc.officialVotes.house.members.reverse();
      });
      const synced = changed((doc) => {
        doc.officialVotes.lastSyncedAt = "2026-10-11T22:46:38.798Z";
      });
      const completeness = changed((doc) => {
        doc.officialVotes.completeness = "partial";
      });
      expect(labelsOf(BILL, reordered)).toEqual(["K:storedAt"]);
      expect(labelsOf(BILL, synced)).toEqual(["K:storedAt", "K:officialVotes.lastSyncedAt"]);
      expect(labelsOf(BILL, completeness)).toEqual(["K:storedAt", "K:officialVotes.completeness"]);
    });
  });

  describe("bookkeeping and detail fields", () => {
    it("finds cosponsors 20 to 177 plus storedAt bookkeeping (hr2743)", () => {
      const previous = changed((doc) => {
        doc.cosponsors = Array.from({ length: 20 }, (_, index) => `C${String(index).padStart(6, "0")}`);
      });
      const current = changed((doc) => {
        doc.cosponsors = Array.from({ length: 177 }, (_, index) => `C${String(index).padStart(6, "0")}`);
        doc.storedAt = "2026-10-11T22:41:29.356Z";
      }, previous);
      expect(classifyBillVersionChange(previous, current)).toEqual({
        changeClass: "bookkeeping_only",
        labels: ["K:storedAt", "K:cosponsors"],
      });
    });

    it("finds a guid made plain with storedAt plus 1 ms bookkeeping (REL-41)", () => {
      const previous = changed((doc) => {
        doc.guid = "BILLS-119hr2743ih";
      });
      const current = changed((doc) => {
        doc.storedAt = "2026-10-11T22:41:29.356Z";
      });
      expect(labelsOf(previous, current)).toEqual(["K:storedAt", "K:guid"]);
    });

    const detailChanges: Array<[string, (doc: Doc) => unknown]> = [
      ["committees", (doc) => doc.committees!.push({ name: "Rules Committee", systemCode: "hsru00" })],
      ["officialTitle", (doc) => (doc.officialTitle = "To lower drug costs, and for other purposes.")],
      ["link", (doc) => (doc.link = "https://www.congress.gov/bill/119th-congress/house-bill/2743")],
      ["identifier", (doc) => (doc.identifier.billNumber = "2744")],
      ["summary", (doc) => (doc.summary = "A field no rule names yet")],
    ];

    it.each(detailChanges)("finds %s detail", (field, change) => {
      expect(labelsOf(BILL, changed(change))).toEqual([`D:${field}`, "K:storedAt"]);
    });
  });
});

describe("billContentHash", () => {
  // Pairs whose direct class the hash must reproduce: one per rule above.
  const pairs: Array<[string, Doc, Doc]> = [
    ["storedAt only", BILL, changed(() => undefined)],
    ["cosponsors", BILL, changed((doc) => doc.cosponsors.push("Z000001"))],
    ["guid", BILL, changed((doc) => (doc.guid = "BILLS-119hr2743ih"))],
    ["lastSyncedAt", BILL, changed((doc) => (doc.officialVotes.lastSyncedAt = "2026-10-11T00:00:00.000Z"))],
    ["members reordered", BILL, changed((doc) => doc.officialVotes.house.members.reverse())],
    ["title", BILL, changed((doc) => (doc.title = "x"))],
    ["latest action", BILL, changed((doc) => doc.actions.push(action("2026-03-01", "Passed House")))],
    ["tally", BILL, changed((doc) => (doc.officialVotes.house.yea = 2116))],
    ["sponsor", BILL, changed((doc) => doc.sponsors.push("Z000001"))],
    ["actions reordered", BILL, changed((doc) => doc.actions.reverse())],
    ["party", BILL, changed((doc) => (doc.officialVotes.house.members[1].party = "R"))],
    ["committees", BILL, changed((doc) => (doc.committees = []))],
    ["unknown field", BILL, changed((doc) => (doc.summary = "new"))],
    ["field set to null", BILL, changed((doc) => (doc.committees = null))],
  ];

  it.each(pairs)("gives the direct class from the hashes (%s)", (_name, previous, current) => {
    const direct = classOf(previous, current);
    expect(contentHashChangeClass(billContentHash(previous), billContentHash(current))).toBe(direct);
    expect(billContentHash(previous) === billContentHash(current)).toBe(direct === "bookkeeping_only");
  });

  it("is pinned: a change to a projection rule must bump CONTENT_HASH_VERSION", () => {
    expect(CONTENT_HASH_VERSION).toBe("v1");
    expect(billContentHash(BILL)).toBe("v1:cd76cdf08d935ab3:8f86b040e2721734");
    expect(billContentHash({ kind: "processed", guid: "BILLS-119hr1", title: "Bill 1" })).toBe(
      "v1:99458d51651a84c8:588f0d078f19d905",
    );
    expect(billContentHash(BILL)).toMatch(/^v1:[0-9a-f]{16}:[0-9a-f]{16}$/);
  });

  it("does not depend on key order", () => {
    const reversed = Object.fromEntries(Object.entries(BILL).reverse());
    expect(billContentHash(reversed)).toBe(billContentHash(BILL));
  });

  it("gives no class for a missing, malformed or other-version hash", () => {
    const hash = billContentHash(BILL);
    expect(contentHashChangeClass(undefined, hash)).toBeNull();
    expect(contentHashChangeClass(hash, undefined)).toBeNull();
    expect(contentHashChangeClass("", hash)).toBeNull();
    expect(contentHashChangeClass(hash.replace(/^v1:/, "v0:"), hash)).toBeNull();
    expect(contentHashChangeClass("v1:abc:def", hash)).toBeNull();
    expect(contentHashChangeClass(hash.toUpperCase(), hash)).toBeNull();
    expect(contentHashChangeClass(hash, hash)).toBe("bookkeeping_only");
  });
});

describe("isContentHash", () => {
  it("accepts only a hash of the current version", () => {
    expect(isContentHash(billContentHash(BILL))).toBe(true);
    expect(isContentHash(billContentHash(BILL).replace(/^v1:/, "v0:"))).toBe(false);
    expect(isContentHash("v1:abc:def")).toBe(false);
    expect(isContentHash(undefined)).toBe(false);
  });
});

describe("manifest dates: only news moves a row (2026-10-28)", () => {
  const TEXT = "v1:1f0e3dad99908345f7439f8ffabdffc4f3ff2c6b9c5e8d06e6c2b0fa8f6b1d3e";
  const NEW_TEXT = "v1:9a8b7c6d5e4f30211f0e3dad99908345f7439f8ffabdffc4f3ff2c6b9c5e8d06";
  /** The basis of `doc` stored with the source-text-hash `text` (null: a legacy bill, without one). */
  const basis = (doc: unknown, text: string | null = TEXT) => manifestDateBasis(doc, text);
  /** The moves from BILL (stored with TEXT) to `doc` (stored with `text`). */
  const movesTo = (doc: unknown, text: string | null = TEXT) => manifestDateMoves(basis(BILL), basis(doc, text));
  /**
   * The d1 basis a release of 2026-10-28 to 2026-11-12 wrote for `doc` stored with `text`, by that release's rule: each
   * action on the latest date as 8 hex of the SHA-256 of its date and its whole text (trimmed, spaces collapsed, lower
   * case), citations and all.
   */
  const legacyBasis = (doc: unknown, text: string | null = TEXT): string => {
    const { status, latestActionDate, textVersion } = basis(doc, text);
    const actions = (doc as { actions?: unknown } | null)?.actions;
    const keys = new Set(
      (Array.isArray(actions) ? actions : [])
        .filter(
          (entry: ActionEntry) =>
            latestActionDate !== "" &&
            typeof entry?.actionDate === "string" &&
            entry.actionDate.trim().slice(0, 10) === latestActionDate,
        )
        .map((entry: ActionEntry) => {
          const actionText = typeof entry.text === "string" ? entry.text.replace(/\s+/g, " ").trim().toLowerCase() : "";
          return createHash("sha256").update(`${latestActionDate}|${actionText}`).digest("hex").slice(0, 8);
        }),
    );
    return ["d1", status, latestActionDate, Array.from(keys).sort().join("."), textVersion].join("|");
  };
  /** The row an older release wrote for `doc`: its d1 basis, as CreateBillsManifest reads it. */
  const legacyRow = (doc: unknown, text: string | null = TEXT): ManifestDateBasis =>
    parseDateBasis(legacyBasis(doc, text))!;

  describe("the basis", () => {
    it("holds the status, the latest action date, one key per action on it, and the text version", () => {
      const result = basis(BILL);
      expect(result.status).toBe("New");
      expect(result.latestActionDate).toBe("2026-02-10");
      expect(result.latestActionKeys).toHaveLength(2);
      expect(result.latestActionKeys).toEqual([...result.latestActionKeys].sort());
      expect(result.latestActionKeys.every((key) => /^[0-9a-f]{8}$/.test(key))).toBe(true);
      expect(result.textVersion).toMatch(/^[0-9a-f]{16}$/);
      expect(basis(BILL, null).textVersion).toBe("");
      expect(basis(BILL, "  ").textVersion).toBe("");
    });

    it("reads a status as the apps show it: a missing or unknown one is New", () => {
      expect(manifestDateStatus(undefined)).toBe("New");
      expect(manifestDateStatus("")).toBe("New");
      expect(manifestDateStatus("Pending")).toBe("New");
      expect(manifestDateStatus(" Passed ")).toBe("Passed");
      for (const status of ["New", "Updated", "Passed", "Failed", "Finalized"]) {
        expect(manifestDateStatus(status)).toBe(status);
      }
    });

    it("knows an action by its date and text only", () => {
      const reformatted = changed((doc) => {
        doc.actions = doc.actions.map((entry) => ({
          ...entry,
          actionDate: `${entry.actionDate}T14:00:00Z`,
          actionTime: "14:00:00",
          actionCode: "Intro-H",
          sourceSystem: { code: 0, name: "Senate" },
          text: `  ${String(entry.text).toUpperCase().replace(/ /g, "   ")}  `,
        }));
      });
      expect(basis(reformatted)).toEqual(basis(BILL));
    });

    it("keeps one key for repeated actions and none for a bill without dated actions", () => {
      const duplicated = changed((doc) => doc.actions.push({ ...doc.actions[1] }));
      expect(basis(duplicated).latestActionKeys).toEqual(basis(BILL).latestActionKeys);
      expect(basis(changed((doc) => (doc.actions = [])))).toMatchObject({ latestActionDate: "", latestActionKeys: [] });
      expect(basis(changed((doc) => Reflect.deleteProperty(doc, "actions")))).toMatchObject({
        latestActionDate: "",
        latestActionKeys: [],
      });
      const undated = changed((doc) => (doc.actions = [{ text: "Introduced" }, "not an action"] as ActionEntry[]));
      expect(basis(undated)).toMatchObject({ latestActionDate: "", latestActionKeys: [] });
      expect(manifestDateBasis(null)).toEqual({
        version: "d2",
        status: "New",
        latestActionDate: "",
        latestActionKeys: [],
        textVersion: "",
        latestActionKeyPairs: [],
      });
    });

    it("is pinned: a change to the basis needs a new format version and a fallback for old rows", () => {
      // Without a citation an action's d2 key is its d1 key: BILL's keys are the ones the d1 golden pinned.
      expect(formatDateBasis(basis(BILL))).toBe("d2|New|2026-02-10|27bf6936.81f46a4a|cd038fbd2e83ff3f");
      expect(formatDateBasis(manifestDateBasis({}))).toBe("d2|New|||");
      const cited = changed((doc) => (doc.actions[0].text = `${doc.actions[0].text} (text: CR H6104)`));
      expect(formatDateBasis(basis(cited))).toBe("d2|New|2026-02-10|27bf6936.81f46a4a|cd038fbd2e83ff3f");
      expect(basis(cited).latestActionKeyPairs).toEqual([
        ["27bf6936", "27bf6936"],
        ["49cf36ae", "81f46a4a"],
      ]);
      expect(legacyBasis(cited)).toBe("d1|New|2026-02-10|27bf6936.49cf36ae|cd038fbd2e83ff3f");
    });

    it("parses what it formats, d1 rows too, and nothing else", () => {
      for (const doc of [BILL, changed((doc) => (doc.billStatus = "Passed")), {}]) {
        const { latestActionKeyPairs, ...stored } = basis(doc);
        expect(latestActionKeyPairs).toBeDefined();
        expect(parseDateBasis(formatDateBasis(basis(doc)))).toEqual(stored);
        expect(parseDateBasis(formatDateBasis(basis(doc, null)))).toEqual({ ...stored, textVersion: "" });
      }
      // A row an older release wrote (2026-10-28 to 2026-11-12) keeps its d1 basis until its next write.
      expect(parseDateBasis("d1|New|2026-02-10|27bf6936.81f46a4a|cd038fbd2e83ff3f")).toEqual({
        version: "d1",
        status: "New",
        latestActionDate: "2026-02-10",
        latestActionKeys: ["27bf6936", "81f46a4a"],
        textVersion: "cd038fbd2e83ff3f",
      });
      expect(formatDateBasis(parseDateBasis("d1|Passed|2026-05-14|00c11e1f.7b05eb46|")!)).toBe(
        "d1|Passed|2026-05-14|00c11e1f.7b05eb46|",
      );
    });

    it.each([
      ["another version", (good: string) => good.replace(/^d2/, "d3")],
      ["no version", (good: string) => good.replace(/^d2\|/, "")],
      ["an unknown status", (good: string) => good.replace("|New|", "|Pending|")],
      ["a short date", (good: string) => good.replace("2026-02-10", "2026-2-10")],
      ["a short text version", (good: string) => good.replace(/\|[0-9a-f]{16}$/, "|abc")],
      ["a short key", (good: string) => good.replace("27bf6936", "27bf693")],
      ["an upper-case key", (good: string) => good.replace("27bf6936", "27BF6936")],
      ["an empty key", (good: string) => good.replace(".", "..")],
      ["keys without a date", () => "d2|New||1d8b9c37|"],
      ["a d1 basis with keys without a date", () => "d1|New||1d8b9c37|"],
      ["a part more", (good: string) => `${good}|`],
      ["a part less", (good: string) => good.replace(/\|[0-9a-f]{16}$/, "")],
    ])("reads a malformed basis (%s) as none", (_name, malformed) => {
      expect(parseDateBasis(malformed(formatDateBasis(basis(BILL))))).toBeNull();
    });

    it("reads no basis from a missing or non-string value", () => {
      expect(parseDateBasis(undefined)).toBeNull();
      expect(parseDateBasis(null)).toBeNull();
      expect(parseDateBasis("")).toBeNull();
      expect(parseDateBasis(42)).toBeNull();
    });

    it("cannot be read by an older release, which then judges the row as one without a basis (the rollback)", () => {
      // The pattern of the releases of 2026-10-28 to 2026-11-12 (8879b33 and before): it reads no d2 basis at all,
      // so their CreateBillsManifest judges a d2 row by its contentHash, the previous S3 version or its own status and
      // date, never by d2 keys taken for d1 keys. The d1 bases they write are read here as d1.
      const OLDER_RELEASE_PATTERN =
        /^d1\|(New|Updated|Passed|Failed|Finalized)\|(\d{4}-\d{2}-\d{2}|)\|((?:[0-9a-f]{8}(?:\.[0-9a-f]{8})*)?)\|([0-9a-f]{16}|)$/;
      for (const doc of [BILL, changed((doc) => (doc.billStatus = "Passed")), {}]) {
        expect(formatDateBasis(basis(doc))).not.toMatch(OLDER_RELEASE_PATTERN);
        expect(legacyBasis(doc)).toMatch(OLDER_RELEASE_PATTERN);
        expect(parseDateBasis(legacyBasis(doc))?.version).toBe("d1");
      }
    });
  });

  describe("news moves the row", () => {
    const passed = changed((doc) => (doc.billStatus = "Passed"));

    it.each<[string, Doc, Doc, string | null, string[]]>([
      ["a status change", BILL, passed, TEXT, ["status"]],
      ["Updated", BILL, changed((doc) => (doc.billStatus = "Updated")), TEXT, ["status"]],
      ["a status corrected back to New (a repair)", passed, BILL, TEXT, ["status"]],
      [
        "an action dated after the latest",
        BILL,
        changed((doc) => doc.actions.push(action("2026-02-12", "Reported by the Committee"))),
        TEXT,
        ["newerAction"],
      ],
      [
        "another action on the latest date",
        BILL,
        changed((doc) => doc.actions.push(action("2026-02-10", "Referred to the Subcommittee on Health."))),
        TEXT,
        ["newActionEntry"],
      ],
      [
        "another text of the latest action",
        BILL,
        changed((doc) => (doc.actions[1].text = "Introduced")),
        TEXT,
        ["newActionEntry"],
      ],
      [
        "another text the summary was written from",
        BILL,
        changed((doc) => (doc.soWhat = "Now caps it at $25.")),
        NEW_TEXT,
        ["textVersion"],
      ],
      [
        "a vote that passed it, with its new text",
        BILL,
        changed((doc) => {
          doc.billStatus = "Passed";
          doc.actions.push(action("2026-03-01", "On passage Passed by the Yeas and Nays: 216 - 211"));
        }),
        NEW_TEXT,
        ["status", "newerAction", "textVersion"],
      ],
    ])("%s", (_name, from, to, text, expected) => {
      expect(manifestDateMoves(basis(from), basis(to, text))).toEqual(expected);
    });

    it("moves a row whose bill had no dated action when the first one arrives", () => {
      const none = changed((doc) => (doc.actions = []));
      expect(manifestDateMoves(basis(none), basis(BILL))).toEqual(["newerAction"]);
    });
  });

  describe("anything else keeps the row's date", () => {
    // [case, the new version, its source-text-hash, the row's document's source-text-hash]
    it.each<[string, Doc, string | null, string | null]>([
      ["storedAt only (a replay or a reprocess that changed nothing)", changed(() => undefined), TEXT, TEXT],
      ["cosponsors (U9b)", changed((doc) => doc.cosponsors.push("Z000001")), TEXT, TEXT],
      [
        "a re-summary of the same text: title, soWhat, breakdown, civic profile",
        changed((doc) => {
          doc.title = "Caps Insulin Costs";
          doc.soWhat = "Insulin would cost at most $35.";
          doc.billBreakdown = ["Caps insulin."];
          doc.civicProfile = { individualVsCommunity: 0.2 };
          doc.internalSchema = 3;
        }),
        TEXT,
        TEXT,
      ],
      [
        "topics and life areas relabelled",
        changed((doc) => {
          doc.subCategories = ["Health Care"];
          doc.lifeAreas = [];
        }),
        TEXT,
        TEXT,
      ],
      ["sponsors", changed((doc) => doc.sponsors.push("Z000001")), TEXT, TEXT],
      [
        "member votes filled in (vote enrichment)",
        changed((doc) => doc.officialVotes.house.members.push(member("Z000001", "D", "Yea"))),
        TEXT,
        TEXT,
      ],
      ["a bogus tally removed (U9h)", changed((doc) => Reflect.deleteProperty(doc.officialVotes, "house")), TEXT, TEXT],
      ["committees", changed((doc) => (doc.committees = [])), TEXT, TEXT],
      ["the official title", changed((doc) => (doc.officialTitle = "To amend title XVIII.")), TEXT, TEXT],
      [
        "an older action filled in",
        changed((doc) => doc.actions.unshift(action("2026-01-30", "Sponsor introductory remarks"))),
        TEXT,
        TEXT,
      ],
      ["one of the latest date's actions removed", changed((doc) => doc.actions.pop()), TEXT, TEXT],
      ["the actions reordered", changed((doc) => doc.actions.reverse()), TEXT, TEXT],
      [
        "the latest action removed, so the latest date goes back",
        changed((doc) => (doc.actions = [action("2026-01-30", "Introduced in House")])),
        TEXT,
        TEXT,
      ],
      ["a legacy bill's first text hash", changed(() => undefined), TEXT, null],
      ["a text hash lost (a write by an older release)", changed(() => undefined), null, TEXT],
      ["a missing status read as New", changed((doc) => delete doc.billStatus), TEXT, TEXT],
      ["an unknown status read as New", changed((doc) => (doc.billStatus = "Pending")), TEXT, TEXT],
      ["a field added later", changed((doc) => (doc.isCommemorative = true)), TEXT, TEXT],
    ])("%s", (_name, doc, text, rowText) => {
      expect(manifestDateMoves(basis(BILL, rowText), basis(doc, text))).toEqual([]);
    });

    it("keeps the date for an older action's text changed", () => {
      const older = changed((doc) => doc.actions.unshift(action("2026-01-30", "Sponsor introductory remarks")));
      const edited = changed((doc) => (doc.actions[0].text = "Sponsor introductory remarks on measure"), older);
      expect(manifestDateMoves(basis(older), basis(edited))).toEqual([]);
    });

    it("keeps the date for a duplicate removed although the action set changed (hres1186)", () => {
      const duplicated = changed((doc) => doc.actions.push({ ...doc.actions[1] }));
      expect(movesTo(duplicated)).toEqual([]);
      expect(manifestDateMoves(basis(duplicated), basis(BILL))).toEqual([]);
    });
  });

  describe("Congressional Record citations are not news (2026-11-12)", () => {
    // Every text below is congress.gov's, as stored in processed-bills/ on 2026-11-12.
    it.each<[string, string, string]>([
      [
        "a consideration (BILLS-119hr9614)",
        "Considered under suspension of the rules. (consideration: CR H6104-6105)",
        "considered under suspension of the rules.",
      ],
      [
        "a text (BILLS-119hr9614)",
        "On motion to suspend the rules and pass the bill Agreed to by voice vote. (text: CR H6104)",
        "on motion to suspend the rules and pass the bill agreed to by voice vote.",
      ],
      [
        "a consideration and a text (BILLS-119sres734)",
        "Submitted in the Senate, considered, and agreed to without amendment and with a preamble by Unanimous " +
          "Consent. (consideration: CR S2313; text: CR S2310)",
        "submitted in the senate, considered, and agreed to without amendment and with a preamble by unanimous consent.",
      ],
      [
        "no label (BILLS-119hconres14)",
        "Motion to proceed to consideration of measure made in Senate. (CR S2159)",
        "motion to proceed to consideration of measure made in senate.",
      ],
      [
        "Extensions of Remarks (BILLS-119hr7281)",
        "Sponsor introductory remarks on measure. (CR E85)",
        "sponsor introductory remarks on measure.",
      ],
      [
        "sponsor remarks (BILLS-119s1015)",
        "Read twice and referred to the Committee on Banking, Housing, and Urban Affairs. (Sponsor introductory " +
          "remarks on measure: CR S1745)",
        "read twice and referred to the committee on banking, housing, and urban affairs.",
      ],
      [
        "a substitute's text, after a roll call that stays (BILLS-119hconres113)",
        "On agreeing to the resolution Agreed to by the Yeas and Nays: 216 - 214 (Roll no. 281). (text of amendment " +
          "in the nature of a substitute: CR H5138-5143)",
        "on agreeing to the resolution agreed to by the yeas and nays: 216 - 214 (roll no. 281).",
      ],
      [
        "several pages (BILLS-119hjres20)",
        "Considered by Senate. (consideration: CR S2533, S2537-2538)",
        "considered by senate.",
      ],
      [
        "a part after the page (BILLS-119hjres87)",
        "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 231 - 191 (Roll no. 111). (text: CR " +
          "H1741: 6)",
        "passed/agreed to in house: on passage passed by the yeas and nays: 231 - 191 (roll no. 111).",
      ],
      [
        "parts after two references (BILLS-119sres187)",
        "Passed/agreed to in Senate: Submitted in the Senate, considered, and agreed to without amendment and with a " +
          "preamble by Unanimous Consent. (consideration: CR S2643: 3; text: CR S2669-2670: 3)",
        "passed/agreed to in senate: submitted in the senate, considered, and agreed to without amendment and with a " +
          "preamble by unanimous consent.",
      ],
      [
        "a double hyphen (BILLS-119s2950)",
        "Passed Senate with an amendment by Unanimous Consent. (consideration: CR S8533-8535; text: CR S8533--8535)",
        "passed senate with an amendment by unanimous consent.",
      ],
      [
        "a space before the parenthesis (BILLS-119hres426)",
        "Considered as unfinished business. (consideration: CR H2166-2168 )",
        "considered as unfinished business.",
      ],
      [
        "a date before CR (BILLS-119hconres14)",
        "On motion that the House agree to the Senate amendment Agreed to by the Yeas and Nays: 216 - 214 (Roll no. " +
          "100). (text: 4/9/2025 CR H1533-1540)",
        "on motion that the house agree to the senate amendment agreed to by the yeas and nays: 216 - 214 (roll no. 100).",
      ],
      [
        "a date with two-digit parts (BILLS-119hjres88)",
        "On passage Passed by the Yeas and Nays: 246 - 164 (Roll no. 114). (text: 04/30/2025 CR H1749)",
        "on passage passed by the yeas and nays: 246 - 164 (roll no. 114).",
      ],
      [
        "a date after CR (BILLS-119hr4593)",
        "On passage Passed by the Yeas and Nays: 226 - 197 (Roll no. 23). (text: CR 1/7/2026 H127)",
        "on passage passed by the yeas and nays: 226 - 197 (roll no. 23).",
      ],
      [
        "a date without a year (BILLS-119sres503)",
        "Resolution agreed to in Senate without amendment and with a preamble by Unanimous Consent. (consideration: " +
          "CR S90; text: CR 11/19 S8242)",
        "resolution agreed to in senate without amendment and with a preamble by unanimous consent.",
      ],
      [
        "after a Senate record vote number (BILLS-119hjres140)",
        "Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 51 - 49. Record Vote " +
          "Number: 83. (CR S1790)",
        "motion to proceed to consideration of measure agreed to in senate by yea-nay vote. 51 - 49. record vote number: 83.",
      ],
      [
        "after (2/3 required) and a roll call (BILLS-119hr4275)",
        "Passed/agreed to in House: On motion to suspend the rules and pass the bill, as amended Agreed to by the " +
          "Yeas and Nays: (2/3 required): 399 - 12 (Roll no. 218). (text: CR H3572-3617: 4)",
        "passed/agreed to in house: on motion to suspend the rules and pass the bill, as amended agreed to by the yeas " +
          "and nays: (2/3 required): 399 - 12 (roll no. 218).",
      ],
    ])("drops %s", (_name, text, expected) => {
      expect(actionTextWithoutCitations(text)).toBe(expected);
      expect(actionTextWithoutCitations(expected)).toBe(expected);
      expect(actionTextWithoutCitations(`  ${text.replace(/ /g, "   ")}  `)).toBe(expected);
    });

    it.each([
      // Parentheses that tell actions apart stay.
      "Motion by Senator Thune to reconsider the vote by which cloture on the motion to proceed to H.R. 4016 was not " +
        "invoked (Record Vote No. 575) entered in Senate.",
      "On motion to suspend the rules and pass the bill, as amended Agreed to by the Yeas and Nays: (2/3 required): " +
        "394 - 3 (Roll no. 316).",
      "Introduced in House",
      // A citation is dropped only at the end of the text (none was found elsewhere).
      "Considered under suspension of the rules. (consideration: CR H6104-6105) Postponed.",
      // Only the House, Senate and Extensions of Remarks pages were found.
      "Considered under suspension of the rules. (consideration: CR D1104)",
    ])("keeps %s", (text) => {
      expect(actionTextWithoutCitations(text)).toBe(text.replace(/\s+/g, " ").trim().toLowerCase());
    });

    it("drops every citation at the end, so it changes nothing applied twice", () => {
      expect(actionTextWithoutCitations("Considered by Senate. (CR S2533) (consideration: CR S2537-2538)")).toBe(
        "considered by senate.",
      );
    });

    /** H.R. 9614 on 2026-11-10 (version of 18:29Z): passed by voice vote on 2026-11-09, no citation yet. */
    const HR9614_PASSED = changed((doc) => {
      doc.billStatus = "Passed";
      doc.actions = [
        action("2026-11-09", "Mr. Latta moved to suspend the rules and pass the bill.", { actionCode: "H30300" }),
        action("2026-11-09", "Considered under suspension of the rules.", { actionCode: "H30000" }),
        action("2026-11-09", "DEBATE - The House proceeded with forty minutes of debate on H.R. 9614.", {
          actionCode: "H8D000",
        }),
        action(
          "2026-11-09",
          "Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote.",
          { actionCode: "8000" },
        ),
        action("2026-11-09", "On motion to suspend the rules and pass the bill Agreed to by voice vote.", {
          actionCode: "H37300",
        }),
        action("2026-11-09", "Motion to reconsider laid on the table Agreed to without objection.", {
          actionCode: "H38310",
        }),
      ];
    });
    /** The version with `texts` (by actionCode) replacing the texts of HR9614_PASSED. */
    const hr9614With = (texts: Record<string, string>, base: Doc = HR9614_PASSED) =>
      changed((doc) => {
        for (const entry of doc.actions) entry.text = texts[entry.actionCode!] ?? entry.text;
      }, base);
    /** 2026-11-11T04:53Z: the consideration and the House's passage got their citations (moved the row for nothing). */
    const HR9614_CITED = hr9614With({
      H30000: "Considered under suspension of the rules. (consideration: CR H6104-6105)",
      H37300: "On motion to suspend the rules and pass the bill Agreed to by voice vote. (text: CR H6104)",
    });
    /** 2026-11-11T09:12Z: the Library of Congress copy of the passage got its citation too (moved it again). */
    const HR9614_CITED_TWICE = hr9614With(
      {
        8000:
          "Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote. " +
          "(text: CR H6104)",
      },
      HR9614_CITED,
    );
    /** A citation's pages changed, as from 'CR H6104-6105' to 'CR H6104'. */
    const HR9614_RECITED = hr9614With(
      { H30000: "Considered under suspension of the rules. (consideration: CR H6104)" },
      HR9614_CITED,
    );
    /** HR9614_PASSED before the motion to reconsider was laid on the table: that entry is another action. */
    const HR9614_BEFORE_RECONSIDER = changed((doc) => doc.actions.pop(), HR9614_PASSED);
    /** S.Res. 734 on 2026-05-19: the Senate's entry has its citations, the Library of Congress copy has none. */
    const SRES734_MAY = changed((doc) => {
      doc.billStatus = "Passed";
      doc.actions = [
        action(
          "2026-05-14",
          "Submitted in the Senate, considered, and agreed to without amendment and with a preamble by Unanimous " +
            "Consent. (consideration: CR S2313; text: CR S2310)",
        ),
        action(
          "2026-05-14",
          "Passed/agreed to in Senate: Submitted in the Senate, considered, and agreed to without amendment and with " +
            "a preamble by Unanimous Consent.",
          { actionCode: "17000" },
        ),
      ];
    });
    /** 2026-11-09: the copy got both citations, which moved a May resolution to November 9. */
    const SRES734_NOVEMBER = changed((doc) => {
      doc.actions[1].text = `${doc.actions[1].text} (consideration: CR S2313; text: CR S2310)`;
    }, SRES734_MAY);
    /** S.Res. 950 on 2026-10-20 and 2026-11-10: its referral reworded, and a 'Submitted in Senate' entry added. */
    const SRES950_OCTOBER = changed((doc) => {
      doc.actions = [
        action(
          "2026-10-15",
          "Under authority of the order of the Senate of September 30, 2026, ordered referred to the Committee on " +
            "the Judiciary.",
        ),
      ];
    });
    const SRES950_NOVEMBER = changed((doc) => {
      doc.actions = [
        action(
          "2026-10-15",
          "Referred to the Committee on the Judiciary under authority of the order of the Senate of 09/30/2026. " +
            "(text: CR S5358)",
        ),
        action("2026-10-15", "Submitted in Senate", { actionCode: "10025" }),
      ];
    }, SRES950_OCTOBER);
    /** H.R. 3857 on 2026-11-10 and 11-11: its latest action reworded alone. */
    const reported = (text: string) =>
      changed((doc) => {
        doc.actions = [
          action("2026-09-17", `Committee on Energy and Natural Resources. Reported by Senator Lee ${text}`),
        ];
      });
    const HR3857_BEFORE = reported("with an amendment in the nature of a substitute. Without written report.");
    const HR3857_AFTER = reported("without amendment. Without written report.");
    /** H.R. 8800 on 2026-07-22: considered twice that day, the two entries told apart only by their citations. */
    const unfinished = (pages: string[]) =>
      changed((doc) => {
        doc.actions = pages.map((page) =>
          action("2026-07-22", `Considered as unfinished business. (consideration: CR ${page})`),
        );
      });

    describe("a row this release wrote (d2)", () => {
      it.each<[string, Doc, Doc]>([
        ["two citations added (BILLS-119hr9614, 2026-11-11T04:53Z)", HR9614_PASSED, HR9614_CITED],
        ["a citation added to a copy (BILLS-119hr9614, 2026-11-11T09:12Z)", HR9614_CITED, HR9614_CITED_TWICE],
        ["two citations added at once (BILLS-119sres734, 2026-11-09)", SRES734_MAY, SRES734_NOVEMBER],
        ["a citation's pages changed (CR H6104-6105 to CR H6104)", HR9614_CITED, HR9614_RECITED],
        ["the citations removed", HR9614_CITED_TWICE, HR9614_PASSED],
      ])("keeps the date for %s", (_name, from, to) => {
        expect(basis(to).latestActionKeys).toEqual(basis(from).latestActionKeys);
        expect(manifestDateJudgement(basis(from), basis(to))).toEqual({ moves: [], sameDay: "same" });
      });

      it("moves the row for another action on the latest date, with a citation or without", () => {
        expect(manifestDateMoves(basis(HR9614_BEFORE_RECONSIDER), basis(HR9614_PASSED))).toEqual(["newActionEntry"]);
        const reconsideredAndCited = hr9614With(
          { H30000: "Considered under suspension of the rules. (consideration: CR H6104-6105)" },
          HR9614_PASSED,
        );
        expect(manifestDateMoves(basis(HR9614_BEFORE_RECONSIDER), basis(reconsideredAndCited))).toEqual([
          "newActionEntry",
        ]);
      });

      it("moves the row for a reworded action, which stays news (BILLS-119sres950, BILLS-119hr3857)", () => {
        expect(manifestDateMoves(basis(SRES950_OCTOBER), basis(SRES950_NOVEMBER))).toEqual(["newActionEntry"]);
        expect(manifestDateMoves(basis(HR3857_BEFORE), basis(HR3857_AFTER))).toEqual(["newActionEntry"]);
      });

      it("takes two entries told apart only by their citations for one action (BILLS-119hr8800)", () => {
        // The cost of the rule: a second consideration on the latest date keeps the date the first one gave the row.
        expect(
          manifestDateMoves(basis(unfinished(["H5029-5127"])), basis(unfinished(["H5029-5127", "H5153-5157"]))),
        ).toEqual([]);
      });
    });

    describe("a row an older release wrote (d1): its keys hold the citations", () => {
      it("keeps the date for a citation added, which the key of the text without it shows", () => {
        for (const [from, to] of [
          [HR9614_PASSED, HR9614_CITED],
          [HR9614_CITED, HR9614_CITED_TWICE],
          [SRES734_MAY, SRES734_NOVEMBER],
          [HR9614_PASSED, HR9614_CITED_TWICE],
        ]) {
          expect(legacyRow(from).version).toBe("d1");
          expect(manifestDateJudgement(legacyRow(from), basis(to))).toEqual({ moves: [], sameDay: "same" });
        }
      });

      it("keeps the date for a citation changed or removed, which it cannot tell from another text (unknown)", () => {
        expect(manifestDateJudgement(legacyRow(HR9614_CITED), basis(HR9614_RECITED))).toEqual({
          moves: [],
          sameDay: "unknown",
        });
        expect(manifestDateJudgement(legacyRow(HR9614_CITED_TWICE), basis(HR9614_PASSED))).toEqual({
          moves: [],
          sameDay: "unknown",
        });
      });

      /** H.Res. 719 as stored on 2026-11-12: on 2025-09-19 the House's passage has its dated citation, the copy none. */
      const HRES719 = changed((doc) => {
        doc.billStatus = "Passed";
        doc.actions = [
          action("2025-09-19", "Motion to reconsider laid on the table Agreed to without objection.", {
            actionCode: "H38310",
          }),
          action(
            "2025-09-19",
            "On agreeing to the resolution Agreed to by the Yeas and Nays: 310 - 58, 38 Present (Roll no. 282). " +
              "(text: CR 9/18/2025 H4437)",
            { actionCode: "H37100" },
          ),
          action(
            "2025-09-19",
            "Passed/agreed to in House: On agreeing to the resolution Agreed to by the Yeas and Nays: 310 - 58, 38 " +
              "Present (Roll no. 282).",
            { actionCode: "8000" },
          ),
          action("2025-09-19", "Considered as unfinished business. (consideration: CR H4477-4478)", {
            actionCode: "H30000",
          }),
        ];
      });
      /** HRES719 with `citation` added to the text of the action with `actionCode`. */
      const hres719Cited = (actionCode: string, citation: string) =>
        changed((doc) => {
          for (const entry of doc.actions)
            if (entry.actionCode === actionCode) entry.text = `${entry.text} ${citation}`;
        }, HRES719);

      it("keeps the date for a dated citation added, and for a second citation (BILLS-119hres719)", () => {
        // The copy gets the passage's dated citation, as H.Res. 878's copy has its own: a citation added.
        const copyCited = hres719Cited("8000", "(text: CR 9/18/2025 H4437)");
        expect(manifestDateJudgement(legacyRow(HRES719), basis(copyCited))).toEqual({ moves: [], sameDay: "same" });
        // A second citation on the passage, which has one: to the d1 row, a text with citations changed (unknown); a
        // d2 row sees the same action.
        const twice = hres719Cited("H37100", "(consideration: CR H4477-4478)");
        expect(manifestDateJudgement(legacyRow(HRES719), basis(twice))).toEqual({ moves: [], sameDay: "unknown" });
        expect(manifestDateJudgement(basis(HRES719), basis(twice))).toEqual({ moves: [], sameDay: "same" });
      });

      it("keeps the date for a reworded action alone, which it cannot tell from a changed citation (unknown)", () => {
        expect(manifestDateJudgement(legacyRow(HR3857_BEFORE), basis(HR3857_AFTER))).toEqual({
          moves: [],
          sameDay: "unknown",
        });
      });

      it("moves the row for another action: more new texts than texts gone (BILLS-119sres950)", () => {
        expect(manifestDateJudgement(legacyRow(SRES950_OCTOBER), basis(SRES950_NOVEMBER))).toEqual({
          moves: ["newActionEntry"],
          sameDay: "new",
        });
        expect(manifestDateMoves(legacyRow(HR9614_BEFORE_RECONSIDER), basis(HR9614_PASSED))).toEqual([
          "newActionEntry",
        ]);
        // Citations added to two actions and the motion to reconsider laid on the table: the citations are known.
        const reconsidered = hr9614With(
          {
            H30000: "Considered under suspension of the rules. (consideration: CR H6104-6105)",
            H37300: "On motion to suspend the rules and pass the bill Agreed to by voice vote. (text: CR H6104)",
          },
          HR9614_PASSED,
        );
        expect(manifestDateMoves(legacyRow(HR9614_BEFORE_RECONSIDER), basis(reconsidered))).toEqual(["newActionEntry"]);
        // A citation changed and another action: two new texts, one text gone.
        const recitedAndReconsidered = changed(
          (doc) =>
            doc.actions.push(
              action("2026-11-09", "Motion to reconsider laid on the table Agreed to without objection."),
            ),
          hr9614With(
            { H30000: "Considered under suspension of the rules. (consideration: CR H6104)" },
            changed((doc) => doc.actions.pop(), HR9614_CITED),
          ),
        );
        expect(
          manifestDateMoves(
            legacyRow(changed((doc) => doc.actions.pop(), HR9614_CITED)),
            basis(recitedAndReconsidered),
          ),
        ).toEqual(["newActionEntry"]);
      });

      it("keeps the date for a version without changes, or with an action removed", () => {
        for (const doc of [
          BILL,
          HR9614_PASSED,
          HR9614_CITED_TWICE,
          SRES734_MAY,
          unfinished(["H5029-5127", "H5153-5157"]),
        ]) {
          expect(manifestDateJudgement(legacyRow(doc), basis(doc))).toEqual({ moves: [], sameDay: "same" });
        }
        expect(manifestDateMoves(legacyRow(HR9614_PASSED), basis(HR9614_BEFORE_RECONSIDER))).toEqual([]);
      });

      it("still moves the row for a status, a newer action or a new text", () => {
        const newer = changed(
          (doc) => doc.actions.push(action("2026-11-10", "Received in the Senate.")),
          HR9614_PASSED,
        );
        expect(manifestDateMoves(legacyRow(HR9614_PASSED), basis(newer))).toEqual(["newerAction"]);
        expect(manifestDateMoves(legacyRow(BILL), basis(changed((doc) => (doc.billStatus = "Passed"))))).toEqual([
          "status",
        ]);
        expect(manifestDateMoves(legacyRow(BILL), basis(BILL, NEW_TEXT))).toEqual(["textVersion"]);
      });

      it("cannot tell without the next version's pairs, nor a d2 row against a d1 basis", () => {
        const { latestActionKeyPairs: _pairs, ...withoutPairs } = basis(HR9614_CITED);
        expect(sameDayActions(legacyRow(HR9614_PASSED), withoutPairs)).toBe("unknown");
        expect(sameDayActions(basis(HR9614_PASSED), legacyRow(HR9614_PASSED))).toBe("unknown");
        expect(manifestDateMoves(basis(HR9614_PASSED), legacyRow(HR9614_PASSED))).toEqual([]);
      });

      it("judges only the latest date's actions", () => {
        const newer = changed(
          (doc) => doc.actions.push(action("2026-11-10", "Received in the Senate.")),
          HR9614_PASSED,
        );
        expect(manifestDateJudgement(legacyRow(HR9614_PASSED), basis(newer)).sameDay).toBeNull();
        expect(manifestDateJudgement(legacyRow(newer), basis(HR9614_PASSED)).sameDay).toBeNull();
      });
    });
  });

  describe("a row with nothing but its status and date (rowDateMoves)", () => {
    const next = basis(BILL);

    it("moves for another status, a missing one counting as New", () => {
      expect(rowDateMoves({ billStatus: "Passed", updatedAt: "2026-03-19T16:57:53.915Z" }, next)).toEqual(["status"]);
      expect(rowDateMoves({ updatedAt: "2026-03-19T16:57:53.915Z" }, next)).toEqual([]);
    });

    it("moves for an action dated after the day the row was dated, and only then", () => {
      expect(rowDateMoves({ billStatus: "New", updatedAt: "2026-02-09T23:59:59.000Z" }, next)).toEqual(["newerAction"]);
      expect(rowDateMoves({ billStatus: "New", updatedAt: "2026-02-10T08:00:00.000Z" }, next)).toEqual([]);
      expect(rowDateMoves({ billStatus: "New", updatedAt: "2026-03-19T16:57:53.915Z" }, next)).toEqual([]);
    });

    it("moves when the row's date cannot be read and the bill has a dated action", () => {
      expect(rowDateMoves({ billStatus: "New", updatedAt: "not a date" }, next)).toEqual(["newerAction"]);
      expect(rowDateMoves({ billStatus: "New" }, manifestDateBasis({}))).toEqual([]);
    });
  });
});

describe("manifest keys", () => {
  it("normalizes times as CreateBillsManifest always has", () => {
    expect(manifestTimestamp("2026-03-19T16:57:53.915Z")).toBe("2026-03-19T16:57:53.915Z");
    expect(manifestTimestamp(" 2026-03-19T16:57:53Z ")).toBe("2026-03-19T16:57:53.000Z");
    expect(manifestTimestamp("2026-03-19")).toBe("2026-03-19T00:00:00.000Z");
    expect(manifestTimestamp("")).toBeNull();
    expect(manifestTimestamp("  ")).toBeNull();
    expect(manifestTimestamp("not a date")).toBeNull();
    expect(manifestTimestamp(1773939473915)).toBeNull();
    expect(manifestTimestamp(undefined)).toBeNull();
  });

  it("builds the sort key from the time and the guid", () => {
    expect(manifestSortKey("2026-03-19T16:57:53.915Z", "BILLS-119hr2743")).toBe(
      "2026-03-19T16:57:53.915Z#BILLS-119hr2743",
    );
  });
});
