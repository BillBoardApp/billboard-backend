import type { RawBill } from "../../../models/bill";

// Raw copies of six bills from congress.gov (public records), as FetchRawBill stored them under raw-bills/<guid>.json
// around the REL-56 backfill run of 2026-11-16/17: the copy current before the run (`pre`) and the run's first copy
// (`run`). They test the text version check of CreateBillsManifest (shared/textVersionEvidence.ts; project decision
// 2026-11-17, docs/RUNBOOK.md 4.9 and 16.1 step 6).
//
// - BILLS-119hr7349, hr6890, s4903 and s3909: the stored JSON, byte for byte.
//     hr7349   the case the check was written for: no XML before, the XML of the one listed version (Introduced in
//              House, 2026-02-04) in the run, the same title. Its sourceTextHash goldens are the production metadata.
//     hr6890   the same, and the pre copy has no metadata.title, so the title is read from content.bill.bill.title.
//     s4903    no XML and an empty text-version list before, "Introduced in Senate" 2026-06-24 in the run.
//     s3909    a retitle alone: the same XML, "A bill to amend title 18, ..." becomes "Stop Illegal Alien Cops Act".
// - BILLS-119s4631 and hres1438: content.billXML cut to its first 2,000 characters in both copies, everything else as
//   stored (tests that need the hashes recompute them from these copies).
//     s4631    the same-day switch: Engrossed in Senate and Considered and Passed Senate of 2026-05-21 swap places at
//              the head of the list, so the stored XML changed from the one to the other.
//     hres1438 Engrossed in House (2026-07-21) added above Reported in House.
// - textVersionPairs.json: the 113 bills whose `Dated manifest upsert` line moved for `textVersion` alone in that run,
//   one bill per line. Each copy is reduced to what compareRawTextVersions reads, values as stored (untrimmed): its
//   metadata.title (`metadataTitle`) and content.bill.bill.title (`billTitle`), each absent when the copy has none, and
//   content.text.textVersions as [{ type, date }] (no copy has an entry that is not an object, or a list that is not
//   an array). `oldXml` is "present" when the pre copy's content.billXML is not empty once trimmed. `expected` is the
//   verdict an independent implementation of the rule gave on the full copies, which the reduced copies reproduce.
//   The file was built once from the copies; the script that built it is not kept.
//
// The copies' VersionIds are not kept: tests store them in FakeVersionedS3 at the LastModified times below, which are
// the ones S3 listed for them (whole seconds).

/** The bills whose two copies are here. */
export type FixtureGuid =
  | "BILLS-119hr7349"
  | "BILLS-119hr6890"
  | "BILLS-119s4903"
  | "BILLS-119s3909"
  | "BILLS-119s4631"
  | "BILLS-119hres1438";

export type CopyName = "pre" | "run";

const COPIES: Record<FixtureGuid, Record<CopyName, unknown>> = {
  "BILLS-119hr7349": { pre: require("./BILLS-119hr7349.pre.json"), run: require("./BILLS-119hr7349.run.json") },
  "BILLS-119hr6890": { pre: require("./BILLS-119hr6890.pre.json"), run: require("./BILLS-119hr6890.run.json") },
  "BILLS-119s4903": { pre: require("./BILLS-119s4903.pre.json"), run: require("./BILLS-119s4903.run.json") },
  "BILLS-119s3909": { pre: require("./BILLS-119s3909.pre.json"), run: require("./BILLS-119s3909.run.json") },
  "BILLS-119s4631": { pre: require("./BILLS-119s4631.pre.json"), run: require("./BILLS-119s4631.run.json") },
  "BILLS-119hres1438": { pre: require("./BILLS-119hres1438.pre.json"), run: require("./BILLS-119hres1438.run.json") },
};

/** When S3 stored each copy (its LastModified in the version listing). */
export const RAW_COPY_STORED: Record<FixtureGuid, Record<CopyName, string>> = {
  "BILLS-119hr7349": { pre: "2026-02-19T12:04:29.000Z", run: "2026-11-17T01:51:23.000Z" },
  "BILLS-119hr6890": { pre: "2026-02-01T19:53:34.000Z", run: "2026-11-17T01:50:59.000Z" },
  "BILLS-119s4903": { pre: "2026-06-26T17:22:57.000Z", run: "2026-11-17T01:36:43.000Z" },
  "BILLS-119s3909": { pre: "2026-03-12T03:23:20.000Z", run: "2026-11-16T21:12:01.000Z" },
  "BILLS-119s4631": { pre: "2026-10-11T21:22:55.000Z", run: "2026-11-17T01:06:10.000Z" },
  "BILLS-119hres1438": { pre: "2026-10-31T18:18:52.000Z", run: "2026-11-16T18:23:37.000Z" },
};

/** A fresh copy of a bill's raw copy, which a test may change. */
export const rawCopy = (guid: FixtureGuid, copy: CopyName): RawBill => structuredClone(COPIES[guid][copy]) as RawBill;

/** One copy of textVersionPairs.json, as reduced. */
export interface ReducedCopy {
  metadataTitle?: unknown;
  billTitle?: unknown;
  textVersions: Array<{ type?: unknown; date?: unknown }>;
}

/** One bill of textVersionPairs.json. */
export interface TextVersionPair {
  guid: string;
  oldXml: "empty" | "present";
  pre: ReducedCopy;
  run: ReducedCopy;
  expected: "same_text_versions" | "new_text_version" | "retitled";
}

export const textVersionPairs = (): TextVersionPair[] =>
  structuredClone(require("./textVersionPairs.json")) as TextVersionPair[];

/** A raw copy holding only what a reduced copy kept, where FetchRawBill stores it. */
export const fromReducedCopy = (reduced: ReducedCopy): RawBill =>
  ({
    metadata: reduced.metadataTitle === undefined ? {} : { title: reduced.metadataTitle },
    content: {
      bill: { bill: reduced.billTitle === undefined ? {} : { title: reduced.billTitle } },
      text: { textVersions: reduced.textVersions },
    },
  }) as unknown as RawBill;
