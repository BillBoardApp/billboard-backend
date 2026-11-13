import { createHash } from "node:crypto";
import { stableStringify, visibleVotes } from "./billSourceReconcile";
import { actionTextWithoutCitations } from "./congressionalRecordCitations";

// Manifest "updated" dates (docs/RUNBOOK.md 4.9). A BillsManifest row's updatedAt, and the sort key built from it,
// says when something last happened to the bill: the apps' "recently updated" windows and Bills list order, the weekly
// digest and the priority resolver all select bills by it. Since 2026-10-28 (project decision, feature review S3; it replaces
// the rule of 2026-10-14, under which any detail or visible change moved the row) a newer version moves the row only
// when it brings news (manifestDateMoves below):
//
//   status          billStatus changed, as the apps show it (a missing or unknown status shows as New);
//   newerAction     an action dated after the latest action the row's document had;
//   newActionEntry  another action on that same latest date (since 2026-11-12 an action whose text differs from one
//                   already there only by Congressional Record citations is the same action: congress.gov adds,
//                   changes and drops them on existing actions days or months later);
//   textVersion     the summary was written from other text (the source-text-hash S3 metadata changed: Congress
//                   published another text, or retitled the bill).
//
// Everything else keeps the row's date while the row takes the new content: a reprocess or re-summary of the same
// text, cosponsors, member votes, committees, older actions filled in or removed, tallies, titles, life areas, topics,
// and any field added later. A first publication (no row) is dated by its document, as always. CreateBillsManifest
// stores each row's ManifestDateBasis (MANIFEST_DATE_BASIS_ATTRIBUTE) to judge the next version without reading S3
// (for a row stored with a d1 basis it reads the version before when that basis cannot tell: sameDayActions), and
// scripts/redateManifestRows.ts plans re-dates by the same rule.
//
// The change classes below are older and stay for billContentHash (the row's contentHash, which the re-date script and
// a rolled-back CreateBillsManifest read) and for the logs:
//
//   user_visible      a field the apps show on a card or in a list: title, soWhat, billBreakdown, civicProfile,
//                     billStatus, sponsors, subCategories, lifeAreas, the latest action, an official vote tally; or
//                     a first publication;
//   detail_only       none of those, but the rest of the document: the full actions array, committees, officialTitle,
//                     member vote lists, the order of the three lists, or any other or future field;
//   bookkeeping_only  only storedAt, guid, cosponsors, officialVotes.lastSyncedAt and officialVotes.completeness (and
//                     the S3 metadata, which is not part of the document).

type Doc = Record<string, unknown>;

export type BillVersionChangeClass = "user_visible" | "detail_only" | "bookkeeping_only";

export interface BillVersionChange {
  changeClass: BillVersionChangeClass;
  /** What differs, for logs and the re-date plan: V:<visible part>, D:<detail field>, K:<bookkeeping field>. */
  labels: string[];
}

/** The BillsManifest row attribute holding billContentHash of the processed bill the row reflects. */
export const MANIFEST_CONTENT_HASH_ATTRIBUTE = "contentHash";

/**
 * The projections' version, the first part of every billContentHash. Bump it with any change to the rules below
 * (a field moved between the classes, a new bookkeeping field before an envelope-only migration). A row's hash no
 * longer dates it (its date basis does), but CreateBillsManifest still uses an equal hash to keep a row without a
 * basis and to tell which S3 version a row reflects, and a release from before 2026-10-28 dates rows by the class:
 * keep "v1" unless the classes themselves must change.
 */
export const CONTENT_HASH_VERSION = "v1";

/**
 * Fields whose change alone is bookkeeping. cosponsors is here by the project's decision of 2026-10-14: a refilled
 * cosponsor list is not news, although a followed member found on it surfaces only at the bill's next date move
 * (RUNBOOK 4.9). Changing this list changes billContentHash: bump CONTENT_HASH_VERSION with it.
 */
const BOOKKEEPING_FIELDS = ["storedAt", "guid", "cosponsors"] as const;
/** officialVotes fields that move on every fetch or follow from the rest (billSourceReconcile.visibleVotes). */
const OFFICIAL_VOTES_SYNC_FIELDS = ["lastSyncedAt", "completeness"] as const;
const VISIBLE_SCALARS = ["title", "soWhat", "billBreakdown", "civicProfile", "billStatus"] as const;
const VISIBLE_LISTS = ["sponsors", "subCategories", "lifeAreas"] as const;
const CHAMBERS = ["house", "senate"] as const;
const TALLY_FIELDS = [
  "yea",
  "nay",
  "present",
  "notVoting",
  "totalCounted",
  "resultText",
  "actionDate",
  "actionCode",
] as const;
/** Left out of the detail projection: the bookkeeping fields, and the visible scalars (compared as visible). */
const NOT_DETAIL: ReadonlySet<string> = new Set<string>([...BOOKKEEPING_FIELDS, ...VISIBLE_SCALARS]);

const asRecord = (value: unknown): Doc | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Doc) : undefined;

const stringOrEmpty = (value: unknown): string => (typeof value === "string" ? value : "");

/** A list as the sorted text of its entries: a change of its members is visible, a change of its order detail. */
const sortedEntries = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => (typeof entry === "string" ? entry : stableStringify(entry))).sort() : [];

export interface LatestAction {
  actionDate: string;
  actionTime: string;
  /** The trimmed text of every action at exactly that date and time, sorted and without repeats. */
  texts: string[];
}

/**
 * The bill's latest action as a card shows it: the greatest (actionDate, actionTime) over all actions, each "" when
 * missing or not a string and compared as plain strings (so a missing time sorts first on its date), with the texts
 * of every action at that pair. Null unless `actions` is a non-empty array of objects. A newer action, a changed or
 * added text at that pair, or its removal changes it; an older action, or another field of the latest, does not.
 */
export const latestAction = (actions: unknown): LatestAction | null => {
  const list = Array.isArray(actions) ? actions.map(asRecord).filter((action) => action !== undefined) : [];
  if (list.length === 0) return null;
  let actionDate = stringOrEmpty(list[0].actionDate);
  let actionTime = stringOrEmpty(list[0].actionTime);
  for (const action of list.slice(1)) {
    const date = stringOrEmpty(action.actionDate);
    const time = stringOrEmpty(action.actionTime);
    if (date > actionDate || (date === actionDate && time > actionTime)) {
      actionDate = date;
      actionTime = time;
    }
  }
  const texts = new Set(
    list
      .filter(
        (action) => stringOrEmpty(action.actionDate) === actionDate && stringOrEmpty(action.actionTime) === actionTime,
      )
      .map((action) => stringOrEmpty(action.text).trim()),
  );
  return { actionDate, actionTime, texts: Array.from(texts).sort() };
};

/** The chamber's tally as a card shows it, or null when the chamber has no official vote. */
const chamberTally = (vote: unknown): Doc | null => {
  const record = asRecord(vote);
  return record ? Object.fromEntries(TALLY_FIELDS.map((field) => [field, record[field] ?? null])) : null;
};

/** What the apps show on a bill's card and in its lists. A missing field counts as null. */
export const visibleProjection = (doc: Doc): Doc => {
  const officialVotes = asRecord(doc.officialVotes) ?? {};
  return {
    ...Object.fromEntries(VISIBLE_SCALARS.map((field) => [field, doc[field] ?? null])),
    ...Object.fromEntries(VISIBLE_LISTS.map((field) => [field, sortedEntries(doc[field])])),
    latestAction: latestAction(doc.actions),
    officialVoteTallies: Object.fromEntries(CHAMBERS.map((chamber) => [chamber, chamberTally(officialVotes[chamber])])),
  };
};

/**
 * The rest of the document: every field but the bookkeeping fields and the visible scalars, with officialVotes
 * without its sync fields and with members in bioguideId order (billSourceReconcile.visibleVotes). A field that is
 * null counts as missing, as in the visible projection.
 */
export const detailProjection = (doc: Doc): Doc => {
  const rest: Doc = {};
  for (const [field, value] of Object.entries(doc)) {
    if (value !== undefined && value !== null && !NOT_DETAIL.has(field)) rest[field] = value;
  }
  const officialVotes = visibleVotes(doc.officialVotes);
  if (officialVotes === null) delete rest.officialVotes;
  else rest.officialVotes = officialVotes;
  return rest;
};

/** The parts of two projections that differ, compared as stable JSON (a missing part counts as null). */
const changedParts = (previous: Doc, current: Doc): string[] =>
  Array.from(new Set([...Object.keys(previous), ...Object.keys(current)]))
    .filter((part) => stableStringify(previous[part]) !== stableStringify(current[part]))
    .sort();

/** How `current` differs from `previous`, the version before it; with no previous version, a first publication. */
export const classifyBillVersionChange = (previous: unknown, current: unknown): BillVersionChange => {
  const before = previous === null || previous === undefined ? null : (asRecord(previous) ?? {});
  if (!before) return { changeClass: "user_visible", labels: ["V:firstPublication"] };
  const after = asRecord(current) ?? {};
  const visible = changedParts(visibleProjection(before), visibleProjection(after)).map((part) => `V:${part}`);
  const detail = changedParts(detailProjection(before), detailProjection(after)).map((field) => `D:${field}`);
  const beforeVotes = asRecord(before.officialVotes) ?? {};
  const afterVotes = asRecord(after.officialVotes) ?? {};
  const bookkeeping = [
    ...BOOKKEEPING_FIELDS.filter((field) => stableStringify(before[field]) !== stableStringify(after[field])),
    ...OFFICIAL_VOTES_SYNC_FIELDS.filter(
      (field) => stableStringify(beforeVotes[field]) !== stableStringify(afterVotes[field]),
    ).map((field) => `officialVotes.${field}`),
  ].map((field) => `K:${field}`);
  const changeClass: BillVersionChangeClass =
    visible.length > 0 ? "user_visible" : detail.length > 0 ? "detail_only" : "bookkeeping_only";
  return { changeClass, labels: [...visible, ...detail, ...bookkeeping] };
};

/** 64 bits of the SHA-256 of the projection's stable JSON. */
const projectionDigest = (projection: Doc): string =>
  createHash("sha256").update(stableStringify(projection)).digest("hex").slice(0, 16);

/**
 * `v1:<visible digest>:<detail digest>`, 16 hex characters each (about 47 bytes on a row with the attribute name).
 * Two documents' hashes give the same class as classifyBillVersionChange, and a bookkeeping-only change leaves the
 * hash equal, so a row can carry the hash of the document it reflects and be classified against a new version
 * without that document. A golden test pins it.
 */
export const billContentHash = (doc: unknown): string => {
  const record = asRecord(doc) ?? {};
  return `${CONTENT_HASH_VERSION}:${projectionDigest(visibleProjection(record))}:${projectionDigest(detailProjection(record))}`;
};

const CONTENT_HASH_PATTERN = /^([^:]+):([0-9a-f]{16}):([0-9a-f]{16})$/;

const parseContentHash = (value: unknown): { visible: string; detail: string } | null => {
  const match = typeof value === "string" ? CONTENT_HASH_PATTERN.exec(value) : null;
  return match && match[1] === CONTENT_HASH_VERSION ? { visible: match[2], detail: match[3] } : null;
};

/** True for a billContentHash of the current CONTENT_HASH_VERSION. */
export const isContentHash = (value: unknown): value is string => parseContentHash(value) !== null;

/** The class of the change between two documents known by their billContentHash; null when either is missing, malformed or of another version. */
export const contentHashChangeClass = (previous: unknown, current: unknown): BillVersionChangeClass | null => {
  const before = parseContentHash(previous);
  const after = parseContentHash(current);
  if (!before || !after) return null;
  if (before.visible !== after.visible) return "user_visible";
  return before.detail === after.detail ? "bookkeeping_only" : "detail_only";
};

// ─── The date rule (2026-10-28) ──────────────────────────────────────────────

/**
 * The BillsManifest row attribute holding formatDateBasis of the processed bill the row reflects. Never served: the
 * manifest builders pick their attributes by name, as for contentHash.
 */
export const MANIFEST_DATE_BASIS_ATTRIBUTE = "dateBasis";

/**
 * The basis format this release writes. d2 (2026-11-12) knows an action by its text without Congressional Record
 * citations; d1 (2026-10-28) knew it by its text with them. A row keeps the d1 basis it was written with until its next
 * write, and is judged by sameDayActions below; an older release cannot parse d2 and judges such a row as one without a
 * basis (its contentHash, the previous S3 version, else its own status and date; docs/RUNBOOK.md 4.9).
 */
const DATE_BASIS_VERSION = "d2";

/** The format a basis was written in: d2 by this release, d1 by the releases of 2026-10-28 to 2026-11-12. */
export type DateBasisVersion = "d1" | "d2";

/** The statuses the manifest serves; any other value, or none, is left out and the apps show New. */
const MANIFEST_STATUSES: ReadonlySet<string> = new Set(["New", "Updated", "Passed", "Failed", "Finalized"]);

/** What of a processed bill dates its manifest row: the parts manifestDateMoves compares. */
export interface ManifestDateBasis {
  /** d2 for a basis computed from a document or read from a row this release wrote; d1 for a row written before. */
  version: DateBasisVersion;
  /** billStatus as the apps show it: "New" for a missing or unknown status. */
  status: string;
  /** The latest actionDate (YYYY-MM-DD) over all actions, or "" when no action has one. */
  latestActionDate: string;
  /**
   * The actions on that date, each as 8 hex of the SHA-256 of its date and text (trimmed, spaces collapsed, lower case;
   * in d2 also without its Congressional Record citations, actionTextWithoutCitations); sorted, without repeats.
   */
  latestActionKeys: string[];
  /** 16 hex of the SHA-256 of the source-text-hash the summary was written from, or "" when it is unknown (a legacy bill). */
  textVersion: string;
  /**
   * Only on a basis computed from a document, never stored: each action on the latest date as its d1 key (the text
   * with its citations) and its d2 key, sorted, without repeats. A row written with a d1 basis is judged by them.
   */
  latestActionKeyPairs?: Array<[d1Key: string, d2Key: string]>;
}

/** Why a newer version moves a row: the news it brings (see the module comment). */
export type ManifestDateMove = "status" | "newerAction" | "newActionEntry" | "textVersion";

const digest = (text: string, length: number): string =>
  createHash("sha256").update(text).digest("hex").slice(0, length);

/** A status as the apps show it. */
export const manifestDateStatus = (value: unknown): string => {
  const status = typeof value === "string" ? value.trim() : "";
  return MANIFEST_STATUSES.has(status) ? status : "New";
};

const ACTION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;

/** An action's date as YYYY-MM-DD, or "" when it has none (a full timestamp keeps its date part). */
const actionDay = (action: Doc): string => {
  const match = typeof action.actionDate === "string" ? ACTION_DATE_PATTERN.exec(action.actionDate.trim()) : null;
  return match ? match[0] : "";
};

/** An action's text as the d1 basis knows it: trimmed, spaces collapsed, lower case. */
const legacyActionText = (action: Doc): string =>
  typeof action.text === "string" ? action.text.replace(/\s+/g, " ").trim().toLowerCase() : "";

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The date basis of a processed bill and the source-text-hash S3 metadata it was stored with. An action is known by
 * its date and its text without citations only, so a refetch that adds an actionCode, a time, a source system or a
 * Congressional Record citation to it changes nothing.
 */
export const manifestDateBasis = (doc: unknown, sourceTextHash?: string | null): ManifestDateBasis => {
  const record = asRecord(doc) ?? {};
  const actions = Array.isArray(record.actions) ? record.actions.map(asRecord).filter((a) => a !== undefined) : [];
  const latestActionDate = actions.reduce((latest, action) => {
    const day = actionDay(action);
    return day > latest ? day : latest;
  }, "");
  const pairs = new Map<string, [string, string]>();
  if (latestActionDate) {
    for (const action of actions.filter((entry) => actionDay(entry) === latestActionDate)) {
      const legacyText = legacyActionText(action);
      const d1Key = digest(`${latestActionDate}|${legacyText}`, 8);
      const d2Key = digest(`${latestActionDate}|${actionTextWithoutCitations(legacyText)}`, 8);
      pairs.set(`${d1Key}.${d2Key}`, [d1Key, d2Key]);
    }
  }
  const latestActionKeyPairs = Array.from(pairs.values()).sort(([a1, a2], [b1, b2]) =>
    a1 === b1 ? compareStrings(a2, b2) : compareStrings(a1, b1),
  );
  const text = typeof sourceTextHash === "string" ? sourceTextHash.trim() : "";
  return {
    version: DATE_BASIS_VERSION,
    status: manifestDateStatus(record.billStatus),
    latestActionDate,
    latestActionKeys: Array.from(new Set(latestActionKeyPairs.map(([, d2Key]) => d2Key))).sort(),
    textVersion: text ? digest(text, 16) : "",
    latestActionKeyPairs,
  };
};

/**
 * `<version>|<status>|<latest action date>|<keys joined by .>|<text version>`, about 50 bytes for one latest action. This
 * release writes only d2 bases (manifestDateBasis); the pairs are never stored.
 */
export const formatDateBasis = (basis: ManifestDateBasis): string =>
  [basis.version, basis.status, basis.latestActionDate, basis.latestActionKeys.join("."), basis.textVersion].join("|");

const DATE_BASIS_PATTERN =
  /^(d1|d2)\|(New|Updated|Passed|Failed|Finalized)\|(\d{4}-\d{2}-\d{2}|)\|((?:[0-9a-f]{8}(?:\.[0-9a-f]{8})*)?)\|([0-9a-f]{16}|)$/;

/**
 * A row's date basis, d2 or d1, or null when it has none (a row written before 2026-10-28 or by a release before it)
 * or it is malformed.
 */
export const parseDateBasis = (value: unknown): ManifestDateBasis | null => {
  const match = typeof value === "string" ? DATE_BASIS_PATTERN.exec(value) : null;
  if (!match) return null;
  const [, version, status, latestActionDate, keys, textVersion] = match;
  if (!latestActionDate && keys) return null;
  return {
    version: version as DateBasisVersion,
    status,
    latestActionDate,
    latestActionKeys: keys ? keys.split(".") : [],
    textVersion,
  };
};

/**
 * What a newer version's actions on the row's latest date are against the row's: `new` (an action the row's document
 * did not have), `same`, or `unknown` (a d1 row that cannot tell; see sameDayActions).
 */
export type SameDayActions = "new" | "same" | "unknown";

/**
 * The actions of `next` on its latest date, which is the row's, against the row's.
 *
 * A basis of the same version as the row's: any key the row does not hold is another action. A row with a d1 basis and
 * a basis computed from a document (with its pairs): the row holds a digest of each latest-date text with its
 * citations, so it cannot see a text, and it can tell only this much of each next action, grouped by its text without
 * citations (its d2 key):
 *
 * - known: some action of the group has a d1 key the row holds (its text is unchanged), or the group's d2 key is one
 *   the row holds (the row's action had no citation, and its d1 key is that text's: a citation was added);
 * - unknown: neither. The text is new, or a citation of one of the row's actions was changed or removed.
 *
 * An unknown group can only be a citation edit of a row action whose key no next action matched, and each such action
 * accounts for one group at most. So `new` when the unknown groups outnumber those unmatched row keys (some group is
 * another action), `same` when there is no unknown group, and `unknown` otherwise: a changed or removed citation looks
 * like a reworded action or a new action that came with another one's edit. A citation-only change is never `new`.
 * CreateBillsManifest then judges by the previous S3 version when the row reflects it, and otherwise keeps the date.
 * Any other pair (a d2 row against a d1 basis, or a d1 row against a basis without its pairs) is `unknown`.
 */
export const sameDayActions = (row: ManifestDateBasis, next: ManifestDateBasis): SameDayActions => {
  const stored = new Set(row.latestActionKeys);
  if (row.version === next.version) {
    return next.latestActionKeys.some((key) => !stored.has(key)) ? "new" : "same";
  }
  const pairs = next.latestActionKeyPairs;
  if (row.version !== "d1" || !pairs) return "unknown";
  const groups = new Map<string, string[]>();
  for (const [d1Key, d2Key] of pairs) groups.set(d2Key, [...(groups.get(d2Key) ?? []), d1Key]);
  const matched = new Set<string>();
  let unknownGroups = 0;
  for (const [d2Key, d1Keys] of groups) {
    const found = [d2Key, ...d1Keys].filter((key) => stored.has(key));
    for (const key of found) matched.add(key);
    if (found.length === 0) unknownGroups += 1;
  }
  if (unknownGroups === 0) return "same";
  const unmatched = Array.from(stored).filter((key) => !matched.has(key)).length;
  return unknownGroups > unmatched ? "new" : "unknown";
};

/** How a newer version dates a row (manifestDateJudgement). */
export interface ManifestDateJudgement {
  /** The news that moves the row; empty when it keeps its date. */
  moves: ManifestDateMove[];
  /** sameDayActions when both have the same latest date, else null. `unknown` leaves newActionEntry out. */
  sameDay: SameDayActions | null;
}

/**
 * Why `next` moves a row that reflects `row`, and what its actions on the latest date are. An action dated before the
 * latest one, a removed action, a Congressional Record citation added, changed or removed, or a latest date that went
 * back is not news, and a text version is compared only when both are known (a legacy bill's first text hash is not a
 * new text).
 */
export const manifestDateJudgement = (row: ManifestDateBasis, next: ManifestDateBasis): ManifestDateJudgement => {
  const moves: ManifestDateMove[] = [];
  let sameDay: SameDayActions | null = null;
  if (row.status !== next.status) moves.push("status");
  if (next.latestActionDate > row.latestActionDate) moves.push("newerAction");
  else if (next.latestActionDate !== "" && next.latestActionDate === row.latestActionDate) {
    sameDay = sameDayActions(row, next);
    if (sameDay === "new") moves.push("newActionEntry");
  }
  if (row.textVersion && next.textVersion && row.textVersion !== next.textVersion) moves.push("textVersion");
  return { moves, sameDay };
};

/** Why `next` moves a row that reflects `row`; empty when it keeps the row's date (manifestDateJudgement). */
export const manifestDateMoves = (row: ManifestDateBasis, next: ManifestDateBasis): ManifestDateMove[] =>
  manifestDateJudgement(row, next).moves;

/**
 * The rule for a row with neither a date basis nor a known document (CreateBillsManifest's last resort), from what the
 * row itself holds: its status, and its date against the latest action's. An action dated after the day the row was
 * dated (UTC) moves it; a later action on that same day, or a new text, cannot be told and keeps it.
 */
export const rowDateMoves = (
  row: { billStatus?: string; updatedAt?: string },
  next: ManifestDateBasis,
): ManifestDateMove[] => {
  const moves: ManifestDateMove[] = [];
  if (manifestDateStatus(row.billStatus) !== next.status) moves.push("status");
  const rowDay = manifestTimestamp(row.updatedAt)?.slice(0, 10) ?? "";
  if (next.latestActionDate > rowDay) moves.push("newerAction");
  return moves;
};

/** A time as the manifest stores it (`new Date(x).toISOString()`), or null when it is not a readable time string. */
export const manifestTimestamp = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

/** A BILL row's sort key: `<updatedAt>#<guid>`, so the partition reads in date order. */
export const manifestSortKey = (updatedAt: string, guid: string): string => `${updatedAt}#${guid}`;
