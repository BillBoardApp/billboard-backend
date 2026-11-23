# contracts

Source-of-truth wire contracts for Billboard, read in place by `services/` and `infra/` in this repository and copied
into the iOS app's repository (`billboard-ios`) by its sync script.

This directory owns **wire contracts** only:
- API request/response payloads
- Data documents shared across services and clients
- Event payloads (when added)
- Release manifest schema used by deploy tooling

It does **not** own app-only or service-internal domain models.

## Layout

```text
schemas/
  entities/     JSON Schema 2020-12 documents for stored and served payloads
  release/      Lambda release manifest
openapi/        user-api.v1.json: every route of the user API
fixtures/
  entities/     one <name>.valid.json per entity schema, validated against it
  release/      the release manifest fixture
  openapi/      <Component>.valid.json: sample bodies of OpenAPI component schemas (BillStats, the App Attest bodies, ...)
generated/
  ts/           TypeScript types (services and infra import these in place)
  swift/        UserAPIContractsV1.swift (copied into the app)
scripts/        generate.mjs, check-contracts.mjs, check-swift.mjs, validate-live-processed-bills.mjs
```

## Commands

Run `npm ci` here once (the root `npm run setup` does it), then:

```bash
npm run generate      # rewrite generated/ from the schemas
npm run check         # the contract checks below, then fail if generated/ is out of date
npm run check:swift   # optional, needs swiftc: compile the Swift contract and decode every entity fixture
AWS_PROFILE=billboard AWS_REGION=us-east-1 npm run validate:live   # read-only: validate every stored processed bill
```

From the repository root, `npm run generate` and `npm run check` do the same (the root check also runs the layout
guard). `npm run verify` includes the check.

## Generated code

`scripts/generate.mjs` (no dependencies) writes `generated/ts/user-api-contracts-v1.ts`,
`generated/ts/release-contracts-v1.ts` and `generated/swift/UserAPIContractsV1.swift`. Never edit them by hand: change
the schema and regenerate. The check fails when a committed file differs from what the schemas produce, or when
`generated/` holds a file the generator does not write.

How the schemas map to code:
- A sub-schema's `title` is its type name: `ProcessedBillActionV1` in TypeScript, `ProcessedBillAction` inside
  `UserAPIContractsV1` in Swift. Every object with properties needs one. Two schemas may share a title only when they
  generate the same type (the two civic-profile score maps are both `CivicProfileScoresV1`).
- Required fields are non-optional; optional or nullable fields are optional (`?`) in both languages.
- A `description` becomes a doc comment.
- Swift types are `nonisolated`, so the app (MainActor default isolation) can decode them off the main actor;
  `check:swift` compiles with that isolation and fails if a conformance is main-actor isolated.
- String enums are string unions in TypeScript and `String` in Swift. A field typed `["integer", "string"]` is a
  `String` in Swift, decoded by a helper that accepts either.
- The few emission choices a schema cannot express are the tables at the top of `generate.mjs`: which enums also get a
  TypeScript value list (`BILL_STATUS_VALUES_V1`), which object is a record keyed by the civic-profile axes, which
  enums stay plain `string` in the types (sub-categories and life areas), and which Swift types are `Equatable`.

## Checks

`scripts/check-contracts.mjs` (ajv with ajv-formats, and swagger-parser):
- Every schema compiles, has `$id` = `https://contracts.billboard/<path>` and a versioned root `title`.
- Every schema has a fixture, and every fixture validates against its schema. A few deliberately wrong payloads must
  be rejected (unknown sub-category or life area, a sponsor name instead of a bioguide ID, an extra field, a committee
  without a chamber, an action without a date, a breakdown without `who`, a relative snapshot URL, a companion group
  with one member or without a `relationship`, a `vetoed` other than `true`), and the shapes seen on live bills must be
  accepted (a committee activity without a date, a committee with only subcommittee activities, an action without
  `text`, a breakdown without `why` or with an extra key, a cosponsor listed twice), as must the companion-group shapes
  clients have to keep decoding (no `companionGroup` or `companionGroups`, an empty list, an unknown `relationship`,
  three members) and each shape without `vetoed`. The recent-actions list must reject any count or other user's vote
  on it (`RECENT_ACTIONS_*`, see "Recent actions (UX-35)").
- The OpenAPI component schemas are checked the same way: each `fixtures/openapi/<Component>.valid.json` validates
  against `#/components/schemas/<Component>`, and the label, stats, limit and App Attest cases (`LABEL_*`, `STATS_*`,
  `VERIFICATION_*` and `APP_ATTEST_*` in the script) and UX-32's `CIVIC_PROFILE_*` must be accepted or rejected as
  listed there: both spellings of each renamed sub-category and the near-miss spellings; `BillStats` with and without
  `comparison`, a withheld verified split, and the `weighted*` fields old builds need; `limitReason`;
  `UserCivicProfile` with and without the theme lock's fields and `themeVotes`; `CivicScore`'s weeks (`CIVIC_SCORE_*`);
  `VoteExport` (`VOTE_EXPORT_*`); the App Attest bodies, header grammar, `clientData`, version, ClientMetadata and
  `Retry-After`. A case may also be a literal value (for a schema with no fixture, such as a header). The script
  prints how many cases ran.
- Rules a schema cannot express: manifest `count` equals the array length; release artifact names are unique;
  the life-area enum matches `services/src/models/lifeAreas.ts`; the sub-category enum equals the current names in
  `services/src/models/categories.ts` plus the keys of `LEGACY_SUB_CATEGORY_ALIASES` there (read as quoted
  `"old": "new"` pairs; anything else in that literal fails the check), and every alias maps to a current name; in the
  fixtures, a companion group's `primaryGuid` is `memberGuids[0]` and its members are distinct plain guids (manifest
  groups also list only the manifest's bills, sorted by `primaryGuid`; a processed bill is a member of its own group);
  the `BillStats` sample has `weighted*` equal to the plain counts in every bucket and a `comparison` derived from
  `totals` and `segments.verified`; the ClientMetadata sample's assertion carries a 32-byte key ID and sign-up
  `clientData`; the `UserCivicProfile` sample's `themeVotes` has no count above `votesUsed`, and its themes at
  `minThemeVotes` or more are exactly the themes in `axes`, `themesReady` of them; the `CivicScore` sample's weeks are
  consecutive Sundays ending with the week of its last day, with `weeksVotedRecent` the weeks voted in, its
  `civicScore` is `voteScore + streakBonus + honorBonus`, and its `streakBonus` (frozen, D85 (a)) is a multiple of 5
  no greater than 5 x `longestStreak`; the `VoteExport` sample's reasons are sorted and distinct.
- `openapi/user-api.v1.json` validates as OpenAPI 3.1 with its `$ref`s into `schemas/`, and documents exactly the
  routes (method, path and auth) declared in `infra/lib/stacks/user-api-service.ts`. `stackRoutes()` parses that file:
  one `const` per resource from `parent.addResource('segment')`, then `addCognitoMethod`, `addPublicMethod` or
  `x.addMethod`. If the route code is restructured, update `stackRoutes()` in the same change.

## Companion groups (APPF-23)

Identical bills introduced in both chambers of one Congress (H.R. 1285 and S. 570) are served as a companion group,
so clients can show them as one bill. All of it is optional and additive; nothing new is stored in processed bills.

- `processed-bill.v1.schema.json#/$defs/companionGroup` (title `CompanionGroupV1`): `primaryGuid`, the House bill's
  plain guid and always `memberGuids[0]` (card identity, share guid, default vote target); `memberGuids`, at least 2
  plain guids `BILLS-<congress><type><number>` (no text-version suffix), primary first, from which clients parse the
  congress, type and number; `relationship`, a string, today always `identical`, deliberately not an enum so a new
  value never breaks decoding.
- `ProcessedBill.companionGroup`: added by `GET /processed-bill` and `/public/processed-bill` when the bill (plain or
  suffixed guid) is in a group. Never stored, so `validate:live` never sees it.
- `BillsManifest.companionGroups`: every group among the manifest's bills, complete on every response (full,
  windowed and snapshot) and sorted by `primaryGuid`. `[]` means no groups (or switched off): clear any kept list.
  An absent field means the server predates companion groups or could not read them this time: keep what you have.
- `openapi/user-api.v1.json`: `GET /bill-stats` takes `scope` (`bill`, the default, or `companions`), and `BillStats`
  has `companionBillIds` (at least 2), present only for `scope=companions` on a grouped bill, whose members' votes
  were combined one per person. `BillStats` has no generated type (of the OpenAPI component schemas, `generate.mjs`
  emits only `ApiError`), so services and the app type `companionBillIds` and `scope` by hand.
- Generated: `CompanionGroupV1`, `ProcessedBillV1.companionGroup?` and `BillsManifestV1.companionGroups?` in
  TypeScript; `UserAPIContractsV1.CompanionGroup` (`Decodable`, not `Equatable`), `ProcessedBill.companionGroup` and
  `BillsManifest.companionGroups` in Swift. The app picks them up with `./scripts/syncContracts.sh`.
- The entity fixtures use the pair `BILLS-119hr1285` and `BILLS-119s570` (the processed-bill fixture is
  `BILLS-119hr1285ih`).

## Vetoed bills (project decision 2026-11-19)

A vetoed bill says VETOED wherever an outcome is labelled. `billStatus` keeps its five values: builds 1.1 and 1.2 read
an unknown status as New and never lower one, so a new value would put vetoed bills back in their Bills queue. The veto
is a flag beside the status instead, optional and additive; clients that predate it ignore it.

- `vetoed`: `{"type": "boolean", "const": true}`, sent only as `true`, absent otherwise, on `ProcessedBill` (added by
  `GET /processed-bill` and `/public/processed-bill`, never stored, so `validate:live` never sees it), on
  `BillsManifest.bills[]` (a row attribute, in inline, windowed and snapshot manifests alike) and on the Weekly Brief's
  item (`billState` keeps the status's value).
- The rule is `services/src/shared/billOutcomes.ts` `deriveBillVetoedFromActions`: an action coded 31000 (or 30000, a
  pocket veto), no action that records the bill becoming law (36000, E40000), and not both chambers' votes over the
  veto (32000 and 34000). It never reads the status: a vetoed bill derives `Passed`, or `Failed` once an override
  fails, but `billDiffer` keeps a stored `Updated` as it is, so a vetoed bill can be `Updated` too (and `New` when its
  passage lines carry no code); a `Finalized` bill is never vetoed.
- Clients stamp it VETOED in the Failed colour, in place of the status word, unless the status is `Finalized`.
- `check-contracts.mjs` accepts each shape without the field and rejects `false`, `"true"`, `1` and `null`
  (`VETOED_*`). One bill in each of the three fixtures carries it, so `check:swift` decodes it.
- Generated: `vetoed?: true` in TypeScript and `vetoed: Bool?` in Swift (a boolean `const` is a `Bool`; only a string
  `const` becomes a `String` enum).

## Member counts per Congress (REL-46)

Each Congress's bills are counted apart in BillBoard's member stats, so every count can be labelled with the Congress it
covers. All of it is optional and additive; builds 1.1 and 1.2 keep decoding both member responses.

- `trackedSponsoredCount`, `trackedSupportedCount` and `currentCongressBillsSupportedCount` stay the 119th Congress's,
  which 1.1 and 1.2 label "119th Congress". They are absent when the member has no 119th counts: a member new in the
  120th Congress has a stats row once a 120th bill counts, but still none of the three (project decision D8).
- `currentCongressCounts` (`$defs/congressCounts` of `congress-member-manifest.v1`, title `CongressMemberCongressCountsV1`,
  also on `processed-congress-member.v1` by `$ref`): `congress` (an integer, at least 119), `sponsored` and `supported`
  (at least 0), all required, nothing else. It is the newest Congress the member has counts in, else the 119th, and is
  absent when the member has none or the stats could not be read. Label the counts with `congress`, never with a
  Congress computed from a date (decision D78). A returning member shows the 119th until a 120th bill counts (D79).
- `check-contracts.mjs` accepts each member shape without the field and a member new in the 120th Congress (the field
  without the 119th counts), and rejects a Congress before the 119th or as a string, a missing count, a negative count
  and an extra key.
- Generated: `CongressMemberCongressCountsV1` and `currentCongressCounts?` on both member types in TypeScript;
  `UserAPIContractsV1.CongressMemberCongressCounts` and `currentCongressCounts` in Swift.

## Sponsor names on processed bills (REL-46 5.3)

A bill keeps naming its sponsor after the sponsor leaves the members manifest (the 119th's departing members, from
2027-01-03). Optional and additive: builds 1.1 and 1.2 ignore it, and the bills manifest does not change.

- `ProcessedBill.sponsorDetails` (`$defs/sponsorDetail`, title `BillSponsorDetailV1`): one entry per sponsor, in the
  order of `sponsors`, with `bioguideId` and `name` (first and last name) always, `title` (`Rep`, `Sen`, `Del` or
  `ResComm`, the title congress.gov puts before the sponsor's name, so a client can say Representative, Senator, Delegate
  or Resident Commissioner; absent when congress.gov gives none, and the chamber is then the bill type's), `party` (`D`,
  `R` or `I`; congress.gov's `ID` is `I`, any other code is left out), `state` (two letters) and `district` (two digits
  as the members manifest writes it, `00` at-large or for a delegate; `null` for a senator, and for a House sponsor
  whose seat congress.gov gives in no form read here, which clients treat as unknown). Stored, so `validate:live` checks it: billSummarizer
  and billDiffer write it from the raw bill (`services/src/shared/billSponsors.ts`), and a bill built before it gets it
  from billDiffer's next message (`ADDED_FIELDS`) or `npm run backfill:sponsor-details`. Absent when congress.gov gives
  no name.
- Clients show it only for a sponsor missing from the members manifest; a sponsor who moved chambers keeps the seat the
  bill lists.
- `check-contracts.mjs` accepts a bill without it, a senator (`district: null`), a delegate and a resident
  commissioner, an entry with only `bioguideId` and `name`, and an at-large seat, and rejects another party letter, a
  title spelled out or with its dot, a one-digit district, a state name, a missing or empty name, a name for an id and
  an extra key.
- Generated: `BillSponsorDetailV1` and `ProcessedBillV1.sponsorDetails?` in TypeScript;
  `UserAPIContractsV1.BillSponsorDetail` and `ProcessedBill.sponsorDetails` in Swift.

## A member's votes and bills (UX-39d)

`GET /congress-member-record?bioguideId=&limit=&cursor=` (Cognito) serves `congress-member-record.v1` (title
`CongressMemberRecordV1`), the member page's "How they voted" and "Their bills"; with `&billGuids=` (instead of `limit`
and `cursor`) it serves only the member's votes on those bills. New and additive: no older build reads it.

- `votes` (`CongressMemberRecordVoteV1`): the member's latest roll-call vote on each bill in BillBoard, newest first, at
  most `limit` (1 to 100, default 25): `billGuid` (plain), `congress`, `billType` and `billNumber` (from the guid, as the
  bills manifest writes them), `title` (absent without a manifest row), `chamber` (`House` or `Senate`), `position`
  (`CongressMemberRecordPositionV1`: `Yea`, `Nay`, `Present` or `Not Voting`, as Congress records it; never a judging
  word, and never `Abstain`, which only BillBoard users cast), `votedOn` (the roll call's day as Congress records it,
  `YYYY-MM-DD` with no time or zone: shown as it is, never converted to the device's zone) and `actionText` (what the
  roll call was on, a passage or a procedural vote). `nextCursor` is present while more follow; send it back as
  `cursor`.
- `billGuids` (1 to 100 plain guids, comma-separated): `votes` holds only the member's votes on those bills, both
  chambers, newest first, with no `nextCursor` and no sponsored bills, so a client can set them beside its own user's
  votes on the device (the UX-18 "You and <member> voted alike on <n> of <m> bills" line) without paging the whole
  record. `INVALID_BILL_GUIDS` (400) for a malformed list or one sent with `limit` or `cursor`.
- `sponsoredBills` (`CongressMemberRecordBillV1`), `sponsoredBillCount` and `sponsoredBillCounts`
  (`CongressMemberRecordCongressCountV1`: `congress` as each bill writes it, and `count`), on the first page only: the
  bills the member sponsored (not cosponsored) that the bills manifest lists, each Congress counted apart (REL-46),
  newest Congress first, then by `updatedAt`; at most 250. Each has the guid parts, and `title`, `billStatus`, `vetoed`
  (only as `true`) and `updatedAt` from the manifest. A bill still waiting for its text is left out of all three, except
  when the manifest could not be read, when every counted bill is sent and some lack a title. From 2027-01-03 they span
  more than one Congress: label them by each bill's `congress` or by `sponsoredBillCounts` (D78), not as the 119th.
- Public facts only: no score, no ranking and no BillBoard user's vote. Clients add "You voted ..." from the caller's own
  votes. An unknown member gets empty lists; 400s are `ApiError` with `INVALID_BIOGUIDE_ID`, `INVALID_LIMIT`,
  `INVALID_CURSOR` and `INVALID_BILL_GUIDS`.
- `check-contracts.mjs` accepts a last page, a later page or `billGuids` answer, a member with no record and a Senate
  vote, and rejects a judging word or `Abstain` as a position, a lower-case chamber, a suffixed guid, an extra key on a
  vote, a vote without `votedOn` or dated with a time, `vetoed: false`, a negative `sponsoredBillCount`, a Congress count
  of zero or with a numeric `congress`, and a record without `votes`.
- Generated: the five types above in TypeScript; `UserAPIContractsV1.CongressMemberRecord`,
  `CongressMemberRecordVote`, `CongressMemberRecordBill` and `CongressMemberRecordCongressCount` in Swift (`position` and
  `chamber` are `String`).

## Bill facts on manifest rows (UX-29, UX-38)

Facts the apps rank and label a bill by before they open it, on `BillsManifest.bills[]` (inline, windowed and
snapshot alike), optional and additive; clients that predate them ignore them. CreateBillsManifest derives each from
the processed bill on every row write and writes it only when the document gives it. None of them is part of what
dates a row, so a rows-only replay adds them to a row that reflects its document without moving it. A row whose
document has news it never got moves, as at any write, and a row at a key newer than its document (unless written from
it) is skipped and gets none.

- `isCommemorative`: `{"type": "boolean", "const": true}`, like `vetoed`, for a ceremonial resolution
  (`services/src/shared/commemorativeResolutions.ts`, the rule that also empties its topics and life areas).
- `introducedDate` (`format: date`): the document's introducedDate when it has one, else its earliest dated action
  (`services/src/shared/billManifestFacts.ts`). A fetch stores the newest 250 actions, so a longer history gives a later
  day.
- `passedHouseOn`, `passedSenateOn` (`format: date`): the earliest action coded 8000 or 17000
  (`services/src/shared/billOutcomes.ts` `chamberPassageDates`), whatever the status says. A bill reaches the second
  chamber only once the chamber it began in passed it, so the second chamber's day alone (the first passage older than
  the stored actions) still means both passed.
- `latestAction` (title `BillsManifestLatestActionV1`): `actionDate` (`format: date`, required) and `text` (congress.gov's,
  trimmed, at least one character, absent when that action has none) of the action the app's bill page and the website
  show as Latest action (UX-43; `billManifestFacts.ts` `latestManifestAction`, the rule of `timelineActions` in both):
  of the greatest day, the first listed (congress.gov lists the newest first). `actionTime` is not read: the Library of
  Congress's lines have none, and by time the day a bill became law named a House procedural step.
- `check-contracts.mjs` accepts an item without any of them and a `latestAction` without `text`, and rejects an
  `isCommemorative` other than `true`, a day that is not a calendar day (`2026-02-30`, `2026-3-5`, a timestamp, `""`),
  a `latestAction` without `actionDate`, with empty `text` or an undeclared field (`ROW_FACTS_*`). The fixture's
  H.R. 2207 and H.Res. 826 carry them, so `check:swift` decodes them.
- Generated: optional fields in both languages (`isCommemorative?: true` and `Bool?`, the days as `string` and
  `String?`, `BillsManifestLatestActionV1` and `UserAPIContractsV1.BillsManifestLatestAction`).

## Stats, verification limits and labels (C2)

All additive; builds 1.0 and R1 keep decoding every response.

- **Stats (2C, INT-08).** `BillStats.comparison` (`BillStatsComparison`, title `BillStatsComparisonV1`), optional, on
  every 200 body of `GET /bill-stats`: `allUsers` (`VoteSplit`), `verified` (`VoteSplit`, absent when
  withheld), `verifiedWithheld` (boolean) and `minDecisionVotes` (integer, at least 1; 5 today). `VoteSplit` (title
  `VoteSplitV1`): `votes`, `yea`, `nay`, `abstain`, `decisionVotes` (integers, at least 0) and `yeaPct` (0 to 100, or
  null), all required, nothing else. National only. Every vote counts 1, so every `weighted*` field of `VoteBucket`
  equals its plain counterpart; the `weighted*` fields stay required because 1.0 and R1 decode them. A body without
  `comparison` (an older server) means: use `totals` and `segments.verified`.
- **Vote cap (INT-06).** `POST /feedback` 429 `VOTE_DAILY_LIMIT` with `Retry-After` (to the next UTC midnight), only in
  enforce mode.
- **Verification limits (INT-03).** `POST /district-verification` 429 `VERIFICATION_RATE_LIMITED` with `Retry-After`,
  only in enforce mode. `DistrictVerification.limitReason` (optional, enum `address_limit`; GET and POST) and the
  `method` value `address_capped` (200, `verified: false`, `status: self_attested`). `limitReason` implies
  `verified: false`.
- **Labels (LLM-10, decision 1B, question Q1).** "Social Justice" became "Civil Rights and Liberties" (Social Policy)
  and "Identity Politics" became "Heritage and Identity" (Cultural and Ethical Issues). The processed-bill
  `$defs/subCategory` enum (title `BillSubCategoryV1`, so the bills manifest follows) lists the current names and keeps
  the two legacy names at the end until the legacy-name cleanup; `PUT /preferences` accepts either spelling for Category
  and stores the new one. The generated types keep sub-categories as plain strings, so the rename changes only doc
  comments in `generated/`; clients map legacy names to new ones themselves (the app's `legacyTopicAliases` mirrors
  `LEGACY_SUB_CATEGORY_ALIASES`).
- Of the OpenAPI components only `ApiError` is generated (`ApiErrorV1`, whose `error` stays a plain string), so
  services and the app type `BillStats.comparison`, `VoteSplit` and `DistrictVerification.limitReason` by hand from the
  component schemas, with `fixtures/openapi/` as samples.

## Results after the vote (INT-11)

Builds 1.0, 1.1 and 1.2 keep decoding every response.

- `GET /bill-stats` answers only a caller who has voted Yea, Nay or Abstain on the bill or a member of its companion
  group. Otherwise `403` with `ApiError` `{"error":"RESULTS_LOCKED","message":...}` (component response
  `ResultsLocked`). `billId` must be a bill guid, else `400` `INVALID_BILL_ID`. The `200` body is unchanged. Clients
  key on the `error` code, not the status, show the locked Results and ask again once their vote is saved. An
  `Abstain` that 1.0 or 1.1 sent for an Updates dismissal (no `X-Billboard-App-Version`, a Passed or Failed bill or
  companion) is stored as a dismissal and does not count, for the lock or in any `BillStats` count (`abstain`, `votes`,
  segments, rollups, `comparison`); `GET /feedback` and `POST /feedback-batch` leave it out for a request with
  `X-Billboard-App-Version`. No schema changes for this.
- `GET /bill-stats` documents `forceRefresh` (S1, 2026-10-28), which 1.1 and 1.2 already send right after a saved
  vote: with `true`, a caller whose own counted vote is newer than the cached aggregate and less than 2 minutes old
  gets the bill's votes counted on request (bills up to about 5,000 votes; `scope=bill`, or `scope=companions` on a
  bill not in a group), so Results right after a vote include it. Same floors, same `200` body; nothing generated
  changes. Since REL-48 (2026-10-29) the same holds for `scope=companions` on a bill in a companion group, which is
  what both builds ask for every grouped bill (under the primary's guid): the caller's vote the group counts, on
  either member, and the group's votes counted on request, one per person (groups up to about 5,000 votes between
  their members). Same `billId`, `companionBillIds` and floors; nothing generated changes.
- `BillsManifestItemV1.voteCount` is no longer sent and the manifest is no longer ordered by it. It stays optional in
  the schema (with a deprecation note, the only change in `generated/`), so older builds keep decoding; clients must
  not show or sort by it.

## Civic Profile lock (UX-32)

Builds 1.1 and 1.2 keep decoding `GET /civic-profile`: their `CivicProfileResponse` reads only `axes`, `votesUsed`,
`totalVotesWithProfile`, `minVotesRequired` and `isReady` (and ignores other keys).

- `UserCivicProfile.isReady` now needs 25 votes in the window and 3 themes with 8 votes each (a theme under 8 is left
  out of `axes`, as before), so a ready profile always has the 3 themes a chart shape needs. While it is false, both
  apps ask for `minVotesRequired - votesUsed` more votes, so `minVotesRequired` is `votesUsed` plus the larger of the
  votes' shortfall (25 less `votesUsed`) and the 3rd theme's (8 less its votes), at least 1: 25 for a new user and
  while the votes' is not the smaller, as before, and above 100 at the 100-vote cap. Under the cap the difference never
  rises as votes on bills not yet in the window are added, so it does not jump up at 25 votes; a vote on the other bill
  of a companion pair already voted on replaces that vote (the primary's row counts, an Abstain too) and can raise it
  by 1.
- Optional, additive: `lockedBy` (`votes` or `themes`, the shortfall that sets `minVotesRequired`; `null` when ready;
  read an unknown value as `votes`), `themesReady`, `minThemesRequired` (3) and `minThemeVotes` (8), for a client to
  explain a theme lock. Absent from a server before UX-32: decode them as optional.
- `fixtures/openapi/UserCivicProfile.valid.json` is a theme-locked sample; the `CIVIC_PROFILE_*` cases accept a body
  without the new fields, a ready one, one locked on its votes and one under 25 votes locked on its themes, and reject
  an unknown `lockedBy`. Not generated (only `ApiError` is), so services and the app type it by hand.

### Theme vote counts (UX-40 L4)

App 1.3 draws the profile as six theme bars, each with the count of votes its score rests on ("12 votes", or "Not
enough data · 5 of 8 votes"). Builds 1.1 and 1.2 ignore the new field.

- Optional, additive: `themeVotes` (component `UserCivicProfileThemeVotes`), an object with all six themes, zeros
  included, each a whole number of 0 or more: the caller's Yea/Nay votes in the window (the same votes as
  `votesUsed`) on bills scored on that theme. A theme is in `axes` exactly when its count is at least `minThemeVotes`.
  A bill scored on several themes counts for each, so the counts can add up to more than `votesUsed`; none exceeds it.
- Absent from a server before it: decode it as optional and hide the count line. Members need no change (their
  counts are `diagnostics.axisCoverage[theme].evidenceCount` on `GET /congress-member-civic-profile`).
- The sample carries it; the `CIVIC_PROFILE_*` cases accept a body without it and one with every count 0, and reject
  a missing or unknown theme, a negative, fractional or string count, and `null`. Not generated, so services and the
  app type it by hand.

## Weeks you voted (UX-41 concept 3)

App 1.3 shows "Weeks you voted: 6 of the last 8" and a strip of 8 week marks on Profile, in place of the day-streak
chips. Builds 1.1 and 1.2 require every `CivicScore` key they know and ignore the rest, so both fields are optional
and every day field stays.

- `CivicScore.recentVoteWeeks`: exactly 8 `{weekStart, count}`, oldest first, the current week last. A week runs
  Sunday to Saturday in America/New_York (the Weekly Brief's week), also before a user's switch to Eastern days (their
  days stay UTC days until then; weeks have no streak to protect). `weekStart` is its Sunday; `count` is the bills
  first voted on in it (`firstVotedAt`, so a changed vote never moves its week), Yea, Nay and Abstain alike. A
  companion pair counts once, in the week of the vote the score keeps for it (on the House bill, the group's primary,
  when there is one, else the first), the vote its day also comes from; a vote on the other bill in another week does
  not mark that week.
- `CivicScore.weeksVotedRecent`: the weeks of `recentVoteWeeks` with a count above 0, 0 to 8. One vote fills a week.
- Weeks earn no points, and the day-streak bonus is frozen (project decision 2026-11-23, D85 (a)) at the freeze,
  Monday 2026-11-23 00:00 America/New_York. `streakBonus` is 5 x the larger of the best streak on the caller's record
  (the one the score last showed) and the longest run of days with a bill first voted on before the freeze, so it is
  the same whenever the app reads, and 0 for a caller who first voted after the freeze unless the score code before
  D85 (live until its deploy, or after a rollback) had already stored a best streak for them, which then counts. It
  is stored once and never changes, so it can be below 5 x `longestStreak`. `longestStreak` and `currentStreak` still
  follow the days, because 1.1 and 1.2 show them; 1.3 shows the bonus as "Best streak +N". The record on `UserPII`
  gains `civicStreakBonus`, the frozen value, and holds no week.
- The `CivicScore` sample carries both; the `CIVIC_SCORE_*` cases accept a body without them and one with no vote in
  8 weeks, and reject 7 or 9 weeks, a week without or with a non-date `weekStart`, a negative count, an undeclared
  field, `weeksVotedRecent` above 8 or fractional, and `null`. The sample's weeks must be consecutive Sundays ending
  with the week of its last day, with `weeksVotedRecent` the weeks voted in; its `civicScore` must be the sum of its
  three parts, and its `streakBonus` a multiple of 5 no greater than 5 x `longestStreak`. Not generated, so the app
  types it by hand (`CivicScore.swift`).

## Download my votes (UX-40 L7)

`GET /account-data/votes` (Cognito, handler `services/src/handlers/fetchFeedback`, `exportVotes.ts`) gives the caller
their own votes, a page at a time; app 1.3 writes them as CSV or JSON on the phone. Votes only (project decision
2026-11-23): other account data stays a request by email.

- `VoteExport`: `votes` (array of `ExportedVote`) and, while more rows follow, `nextToken`. Ask again with
  `?cursor=<nextToken>` until it is absent. A page reads at most 500 rows, so it can hold fewer votes, even none, with
  a `nextToken`. The cursor is opaque (base64url without padding): it holds the last bill id read and a tag of the
  caller, and the handler rebuilds the start key in the caller's own partition. A cursor it did not give this caller
  is `400` with `ApiError` `{"error":"INVALID_CURSOR"}`: start again without one. API Gateway's route throttle
  answers `429` with only a message (`ACCOUNT_DATA_VOTES_THROTTLE` in `infra/lib/config/abuse-limits.ts`).
- `ExportedVote`: every field always present, `null` where nothing is known: `billId` (as stored), `title` (from the
  bills manifest; `null` without a manifest row), `congress`, `billType` and `billNumber` (from the bill id; `null`
  when it is not a bill guid), `vote` (`Yea`, `Nay` or `Abstain`), `reasons` (keys, sorted), `firstVotedAt` (UX-31's
  first-vote time, else `votedAt`), `votedAt` (last change), `state`, `district` and `verified` (as stored with the
  vote, which a later district verification updates on every vote: `RestampUserVotes`). Never the weight, the App
  Attest outcome, the adult flag or the bill's theme scores; the schema is closed.
- Left out: an `Abstain` stored for a 1.0 or 1.1 dismissal (INT-11), and rows with no Yea, Nay or Abstain.
- A legacy row beside a voted plain row: a row stored under a legacy id (`BILLS-119hr1181rh`) is left out when the
  row under its plain guid holds a vote, as `GET /feedback` reads only the plain guid's row; the plain row can be on
  another page, so the handler reads it by key. A legacy row with no voted plain row stays, so a bill with several
  legacy rows (`…ih` and `…rh`) and no voted plain row is listed once for each; app 1.3 keeps the first by bill id.
- `fixtures/openapi/VoteExport.valid.json` is a sample with a `nextToken`; the `VOTE_EXPORT_*` cases accept the last
  page, an empty page and a non-guid bill id, and reject the internal fields, another vote value, a missing field,
  a `null` or padded `nextToken` and an undeclared field. The sample's reasons must be sorted and distinct. Not
  generated, so services and the app type it by hand.

## App Attest (INT-04)

Wire format frozen by C3 4.3-4.4. Requests are refused only while `APP_ATTEST_MODE` is `enforce`; under `watch`
nothing is blocked, and builds that send nothing (1.0, R1, scripts) are recorded as `missing`.

- **Routes** `POST /app-attest/challenge` (`AppAttestChallengeRequest` → `AppAttestChallenge`) and
  `POST /app-attest/attest` (`AppAttestAttestRequest` → `AppAttestAttestResult`), both `security: []`, handler
  `services/src/handlers/appAttest`. Their component schemas and the `AppAttestUnavailable` (503) and
  `PayloadTooLarge` (413) responses are here already; the two `paths` entries land with the infra routes (the route
  check fails on a documented route the stack does not declare).
- **Header `X-Billboard-App-Attest`** (`AppAttestMarker`, at most 2,048 characters, base64url segments without
  padding): `v1.a.<keyId>.<clientData>.<assertion>` (32-byte key ID; `clientData` is the signed UTF-8 JSON,
  `AppAttestRequestClientData` with `purpose: request`, `method`, `path` and `bodySha256`), `v1.u` (unsupported),
  `v1.b` (Debug bypass) or `v1.e.<code>` (`challenge`, `attest`, `assert`, `timeout`, `disabled`, `keychain`). Sent by
  R2 on `POST /feedback` only.
- **Header `X-Billboard-App-Version`** (`AppVersion`, such as `1.2`): sent by R2 on the user API requests it builds;
  documented and read on `POST /feedback`, and on `GET /preferences`, which reads only whether it is there: without
  it (builds 1.0 and R1) the two renamed sub-categories are returned under their former names (LLM-10).
- **Sign-up ClientMetadata** (`PreSignUpClientMetadata`; Cognito, not this API): `billboardAppAttest` (the header
  grammar; an assertion signs `AppAttestSignUpClientData`, `purpose: signup` with `emailSha256`),
  `billboardDeviceCheck` (standard base64 DeviceCheck token) and `billboardAppVersion`. Values are strings.
- **Codes** (in `ApiError.error`; no enum, so `generated/` does not change): `APP_ATTEST_CHALLENGE_INVALID` and
  `APP_ATTEST_REJECTED` (400, attest), `APP_ATTEST_UNAVAILABLE` (503; on `POST /feedback` only when
  `APP_ATTEST_MODE` is enforce and `APP_ATTEST_FAIL_CLOSED` is true (false by default) and the check failed on the
  server's side; never in watch), and, under enforce only, `APP_ATTEST_REQUIRED`, `APP_ATTEST_FAILED`,
  `APP_ATTEST_UNKNOWN_KEY`, `DEVICE_ACCOUNT_LIMIT` (403 on `POST /feedback`, or the pre-sign-up error) and
  `APP_UPDATE_REQUIRED` (426, or the pre-sign-up error). Cognito reports a pre-sign-up rejection as "PreSignUp
  failed with error <CODE>.".
- None of these schemas is generated (only `ApiError` is): the app types them by hand in `AppAttestWire.swift` and
  `AppAttestService.swift`, using `fixtures/openapi/` as samples.

## Recent actions (UX-35)

`GET /recent-actions` (Cognito) builds the Updates tab's list from the caller's own data at request time; nothing new
is stored. `schemas/entities/recent-actions.v1.schema.json` (`RecentActionsV1`, generated in both languages, so the app
gets `UserAPIContractsV1.RecentActions` with `./scripts/syncContracts.sh`):

- The caller's bills: a Yea, Nay or Abstain vote (an Updates dismissal from 1.0 or 1.1 is not a vote) or a Watch row,
  on either member of a companion group. One row per bill, a group being one bill. The row shows the member whose
  status the Bills card shows for the group (`CompanionGroupIndex.statusLead` in the app, the Weekly Brief's rule, in
  `services/src/shared/companionStatusLead.ts`): a law first, then a veto, a passage, a failure, an update, then the
  member whose manifest row changed later, then the primary. So a law or a veto is never hidden by a twin's later
  action. The vote is the primary's when both members have one, and `watched` is set when either member is watched.
- An action dated in the last `windowDays` (30) Eastern days, the bill's latest there (for a group, from either
  member) in a push's words (`services/src/shared/pushText.ts` `pushActionPhrase`): a routine follow-up such as
  "Motion to reconsider laid on the table" only when the window has nothing else, and on the latest day the bill's own
  outcome ("Passed the House") before the other lines. Newest first, then by title, at most 50. Nothing to show is
  `200` with `items: []`.
- `action.billGuid` and `action.officialNumber` name the bill the action is on. For a group that can be the member the
  row does not show: a row for H.R. 77 (Passed) can carry S. 50's "Failed in the Senate". The app names that member
  beside the action when it differs from the row's `billGuid`, as a push names the bill whose action it is.
- `id` is the bill's key (a group's primary guid, as the app keys the group's card), the day and the wording, so only a
  newer action gives a new id, never a change in which member the row shows. `billStatus` and `vetoed` are the bill's
  as everywhere else (for a group, the member the row shows).
- `watched` comes from the caller's Watch rows. The Bill row a vote saves has the same key as the bill's Watch row.
  Since UX-47 `PUT /preferences` no longer lets it replace a Watch row, but a watch a vote replaced before then reads
  as `false` until the watch is saved again, so the app still shows its own watch state when it has one (the schema's
  description of `watched` is unchanged so the generated Swift stays as it is).
- `yourVote` and `votedOn` are the caller's own vote and the Eastern day it was last saved. `voteTiming` (UX-41
  concept 2) is the latest House or Senate roll call in the window (How Congress voted's), with `daysBefore`, the days
  from `votedOn` to it, only when that is at least 1: a vote changed or saved again on or after the roll call's day has
  none.
- Privacy: only the caller's own vote, never a count. The `RECENT_ACTIONS_*` cases reject `voteCount`, a tally,
  another user's vote and a top-level count, as well as a vote other than the three, a suffixed guid, an action that
  does not name its bill, a timing of 0 days and more than 50 items; they accept an empty list, items with only a
  watch and an action on the member the row does not show.

## Versioning

- Non-breaking changes in place: add optional fields, clarify docs.
- Breaking changes: add a new versioned file (for example `processed-bill.v2.schema.json`).
- Keep old versions until all consumers migrate.

## Release contract

`schemas/release/lambda-release-manifest.v1.schema.json` describes the Lambda release that `scripts/ci/build-release.sh`
writes and `infra/lib/release/lambda-artifacts.ts` deploys (the types are `generated/ts/release-contracts-v1.ts`).

## Consumers

- `services/`: `services/src/contracts/index.ts` re-exports `generated/ts/user-api-contracts-v1.ts`.
- `infra/`: imports `contracts/generated/ts/release-contracts-v1.ts` directly.
- `billboard-ios` (a separate repository next to this one): `./scripts/syncContracts.sh` copies
  `generated/swift/UserAPIContractsV1.swift` from `../billboard-backend/contracts` into
  `Billboard/Billboard/Domain/Contracts/` (`--check` compares without copying). Run it after regenerating and commit
  the copy in the app.
- `website/`: `app.js` reads the public processed-bill response described by `processed-bill.v1.schema.json`,
  including `companionGroup`.
