import type { BillStorage } from "../adapters/billStorage";
import type { RawBill } from "../models/bill";
import { extractRawBillTitle, sourceTextHash } from "./billSourceReconcile";
import { textVersionDigest } from "./billVersionChange";
import { logger } from "./logger";

// Confirming a manifest date move for the text alone (project decision 2026-11-17; docs/RUNBOOK.md 4.9 and 16.1
// step 6). billVersionChange.manifestDateJudgement moves a row for `textVersion` when the source-text-hash of the
// summary changed. That hash (billSourceReconcile.sourceTextHash) covers the title and the bill XML, so it is the right
// trigger for a re-summary, but on its own it is not news: a legacy bill summarized before its XML was stored, a
// same-day switch of the text stored at the head of the list (BILLS-119s4631: Engrossed and Considered and Passed of
// one day swapped), or a format added all change it with nothing new from Congress. A move for the text alone is
// therefore kept only when, between the raw copy the row's summary text came from (the base copy) and the raw copy the
// new summary came from (the new copy), congress.gov:
//
// - listed a text version the base copy did not list: an entry of content.text.textVersions known by its type (spaces
//   collapsed, trimmed, lower case; "" when not a string) and its day (the date's leading YYYY-MM-DD, else the trimmed
//   date, "" when null or missing: congress.gov's "Enrolled Bill" has a null date), as the sorted set of `type|day`;
// - or retitled the bill, as the hash reads the title (extractRawBillTitle: metadata.title, else
//   content.bill.bill.title). A GovInfo-form title replaced by the list's title is a retitle by this rule.
//
// The title is compared first. Formats and URLs, the XML body, the order of the list, a removed entry, the time of a
// date and the content.titles labels do not count. A list that is not an array, or holds an entry that is not an object,
// cannot be read, and the row moves as before. This is the test RUNBOOK 16.1 step 6 applies by hand.
//
// Finding the two copies. The new copy is the processed version's source-raw-version (the summary's base, which
// BillSummarizer records). The base copy is found by content, never by a processed version's source-raw-version: a
// BillDiffer pre-summary patch keeps the summarized text's hash but names the NEW raw version, so its raw version is not
// the copy the text came from. Walking the raw key's versions newest first from the new copy, the base copy is the first
// older copy whose sourceTextHash digests (textVersionDigest) to the text version the row was judged against.
//
// Why the newest such copy stands for the copy actually summarized: since REL-45 fetchRawBill stores as billXML only
// the "Formatted XML" of textVersions[0] (fetchRawBill/billText.ts locateBillXmlUrl), fetched, reused or carried only
// for the same version stem, and otherwise no XML at all. So every copy holding a text lists that text's version at its
// head, and no copy with its hash lists a newer head; two such copies differ only below the head (a Public Law appended
// last, which comes with a status move) or in same-day order. A textless base (title + "") is shared by every textless
// copy with that title, and the walk stops at the newest one before the new copy: the copy before the run, which is what
// step 6 compares. For copies older than REL-45 the comparison is the step-6 test by definition.
//
// Bounds and failures. Raw versions are kept 7 days after they go noncurrent (infra congress-store.ts, the raw-bills
// lifecycle rule), so a summary redriven later than that finds no base and moves. Each check makes one
// ListObjectVersions call (one page per 1,000 versions), the new copy's GET and at most TEXT_VERSION_BASE_MAX_GETS
// walk GETs. Every failure moves the row exactly as before 2026-11-17, with its reason; an S3 error is also logged as a
// warning ("Could not read the raw copies ..."), and a failed GET first as BillStorage's error "Failed to load bill from
// S3". The function never throws, so it never fails a record.
//
// Considered and rejected:
// - a d3 date basis carrying the text-version list: an older release cannot parse it and judges such a row as one with
//   no basis, so a rollback would lose every basis written since;
// - a write-time digest of the list in S3 metadata: three Lambdas change, and metadata written before that deploy
//   still needs this read;
// - an alias decided in BillSummarizer: judged after the paid Bedrock call, pairwise only, and racy when
//   CreateBillsManifest lags;
// - "the base summary had no XML" as the rule: it would hide 46 real moves of 2026-11-16/17 (a new text version or a
//   new title over an empty XML).

/** Walk GETs (older raw copies read) per check, the new copy's GET not included; at most 1 + this many GETs. */
export const TEXT_VERSION_BASE_MAX_GETS = 5;

/** Why a check could not confirm a move for the text alone; the row then moves as before. */
export type TextVersionUnconfirmed =
  | "no_source_raw_version"
  | "listing_failed"
  | "new_raw_unlisted"
  | "new_raw_unreadable"
  | "new_raw_has_base_text"
  | "base_raw_not_found"
  | "too_many_versions"
  | "no_text_version_list"
  | "read_failed";

/** compareRawTextVersions: how the new copy differs from the base copy. */
export type TextVersionComparison = "retitled" | "new_text_version" | "same_text_versions" | "no_text_version_list";

/** A check's verdict: `same_text_versions` keeps the row's date; any other moves it as before. */
export type TextVersionVerdict = Exclude<TextVersionComparison, "no_text_version_list"> | "unconfirmed";

/**
 * What a check found, for the `Dated manifest upsert` line (textVersionCheck). The keys are always written in this
 * order, so a Logs Insights parse of `verdict` and `reason` holds (RUNBOOK 4.9). That parse assumes the Lambda Text log
 * format, which prints the object over several lines; under the JSON format those line breaks are escaped (`\n`).
 */
export interface TextVersionEvidence {
  verdict: TextVersionVerdict;
  /** Non-null exactly when `verdict` is `unconfirmed`. */
  reason: TextVersionUnconfirmed | null;
  /** The new copy: the processed version's source-raw-version, or null when it names none. */
  newRawVersion: string | null;
  /** The matched base copy, when one was found. */
  baseRawVersion: string | null;
  /** GetObject calls, the new copy's included. */
  gets: number;
  /** Older copies read that did not hold the base text. */
  skipped: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}/;

/**
 * The raw copy's text versions as the sorted, distinct keys `type|day` (see the module comment), or null when
 * content.text.textVersions is not an array or holds an entry that is not an object.
 */
export const rawTextVersionKeys = (rawBill: RawBill): string[] | null => {
  const versions = asRecord(asRecord(asRecord(rawBill)?.content)?.text)?.textVersions;
  if (!Array.isArray(versions)) return null;
  const keys = new Set<string>();
  for (const entry of versions) {
    const version = asRecord(entry);
    if (!version) return null;
    const type = typeof version.type === "string" ? version.type.replace(/\s+/g, " ").trim().toLowerCase() : "";
    const date = typeof version.date === "string" ? version.date.trim() : "";
    keys.add(`${type}|${DAY_PATTERN.exec(date)?.[0] ?? date}`);
  }
  return Array.from(keys).sort();
};

/** How `next` differs from `base`: the title first, then a text version `base` did not list (see the module comment). */
export const compareRawTextVersions = (base: RawBill, next: RawBill): TextVersionComparison => {
  if (extractRawBillTitle(base) !== extractRawBillTitle(next)) return "retitled";
  const baseKeys = rawTextVersionKeys(base);
  const nextKeys = rawTextVersionKeys(next);
  if (baseKeys === null || nextKeys === null) return "no_text_version_list";
  const listed = new Set(baseKeys);
  return nextKeys.some((key) => !listed.has(key)) ? "new_text_version" : "same_text_versions";
};

const READ_FAILED_MESSAGE = "Could not read the raw copies to confirm a text version move; it moves as before";

/**
 * Reads the two raw copies of `rawKey` a move for the text alone is judged on and compares them: the new copy
 * (`newRawVersion`) and, walking older from it, the newest copy whose sourceTextHash digests to `baseTextVersion` (the
 * text version the row was judged against). At most one listing and 1 + TEXT_VERSION_BASE_MAX_GETS GETs; delete
 * markers are skipped. Never throws: a copy that cannot be found or read gives `unconfirmed` with its reason.
 */
export const readTextVersionEvidence = async (
  storage: Pick<BillStorage, "listObjectVersionsForKey" | "getJsonObjectWithVersionId">,
  rawKey: string,
  input: { newRawVersion?: string; baseTextVersion: string },
): Promise<TextVersionEvidence> => {
  const newRawVersion = input.newRawVersion || null;
  let baseRawVersion: string | null = null;
  let gets = 0;
  let skipped = 0;
  // Every result is built here, so the keys keep the order of TextVersionEvidence.
  const result = (verdict: TextVersionVerdict, reason: TextVersionUnconfirmed | null): TextVersionEvidence => ({
    verdict,
    reason,
    newRawVersion,
    baseRawVersion,
    gets,
    skipped,
  });
  const unconfirmed = (reason: TextVersionUnconfirmed): TextVersionEvidence => result("unconfirmed", reason);
  const warn = (reason: TextVersionUnconfirmed, error: unknown): void =>
    logger.warn(READ_FAILED_MESSAGE, { key: rawKey, newRawVersion, reason, error });

  if (!newRawVersion) return unconfirmed("no_source_raw_version");

  let versionIds: string[];
  try {
    // Newest first (BillStorage sorts by LastModified, stably, so versions of one second keep S3's order).
    versionIds = (await storage.listObjectVersionsForKey(rawKey))
      .filter((version) => !version.isDeleteMarker)
      .map((version) => version.versionId);
  } catch (error) {
    warn("listing_failed", error);
    return unconfirmed("listing_failed");
  }
  const index = versionIds.indexOf(newRawVersion);
  // Expired (a redrive more than 7 days after the fetch), or never stored.
  if (index < 0) return unconfirmed("new_raw_unlisted");

  try {
    gets += 1;
    const next = (await storage.getJsonObjectWithVersionId<RawBill>(rawKey, newRawVersion)).value;
    if (!next) return unconfirmed("new_raw_unreadable");
    // The summary's base is a later copy with the row's text (a textless copy after a textless base): it usually lists
    // a new head version without its XML, so the row moves.
    if (textVersionDigest(sourceTextHash(next)) === input.baseTextVersion) return unconfirmed("new_raw_has_base_text");
    for (const versionId of versionIds.slice(index + 1)) {
      if (gets - 1 >= TEXT_VERSION_BASE_MAX_GETS) return unconfirmed("too_many_versions");
      gets += 1;
      const base = (await storage.getJsonObjectWithVersionId<RawBill>(rawKey, versionId)).value;
      if (!base || textVersionDigest(sourceTextHash(base)) !== input.baseTextVersion) {
        skipped += 1;
        continue;
      }
      baseRawVersion = versionId;
      const comparison = compareRawTextVersions(base, next);
      return comparison === "no_text_version_list" ? unconfirmed(comparison) : result(comparison, null);
    }
    return unconfirmed("base_raw_not_found");
  } catch (error) {
    warn("read_failed", error);
    return unconfirmed("read_failed");
  }
};
