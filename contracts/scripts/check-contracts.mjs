// Contract checks: schemas compile (ajv, JSON Schema 2020-12), every fixture validates against its schema
// (an entity schema, or an OpenAPI component schema for fixtures/openapi/), the OpenAPI document validates
// (swagger-parser) and covers every route of the user API stack, plus the few rules a schema cannot express.
// `node scripts/generate.mjs --check` covers generated/.
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const contractsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platformRoot = path.resolve(contractsRoot, "..");
const SCHEMA_ID_BASE = "https://contracts.billboard/";
const OPENAPI_FILE = "openapi/user-api.v1.json";
const USER_API_STACK = "infra/lib/stacks/user-api-service.ts";
// An OpenAPI component, keyed like the entity schemas: the path after SCHEMA_ID_BASE (here with a JSON pointer).
const openApiPart = (pointer) => `${OPENAPI_FILE}#/components/${pointer}`;
const component = (name) => openApiPart(`schemas/${name}`);

const errors = [];
const addError = (message) => errors.push(message);
const rel = (filePath) => path.relative(contractsRoot, filePath);

function walkJsonFiles(dirPath) {
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) return walkJsonFiles(fullPath);
      return entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
    })
    .sort();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    addError(`JSON parse failed: ${rel(filePath)} -> ${error.message}`);
    return null;
  }
}

const formatAjvErrors = (validationErrors) =>
  (validationErrors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");

// ── Schemas ────────────────────────────────────────────────────────────────────────────────────

function loadSchemas(ajv) {
  const schemas = new Map();
  for (const filePath of walkJsonFiles(path.join(contractsRoot, "schemas"))) {
    const schema = readJson(filePath);
    if (!schema) continue;
    const expectedId = `${SCHEMA_ID_BASE}${rel(filePath)}`;
    if (schema.$id !== expectedId) addError(`${rel(filePath)}: $id must be ${expectedId}`);
    if (typeof schema.title !== "string" || !/V\d+$/.test(schema.title)) {
      addError(`${rel(filePath)}: root title must be the versioned type name, such as ProcessedBillV1`);
    }
    try {
      ajv.addSchema(schema);
      schemas.set(rel(filePath), schema);
    } catch (error) {
      addError(`${rel(filePath)}: ${error.message}`);
    }
  }
  for (const [file, schema] of schemas) {
    try {
      ajv.getSchema(schema.$id);
    } catch (error) {
      addError(`${file}: does not compile: ${error.message}`);
      schemas.delete(file);
    }
  }
  return schemas;
}

/**
 * Makes the OpenAPI components addressable by ajv as `${SCHEMA_ID_BASE}${OPENAPI_FILE}#/components/...`. Their
 * `#/components/...` refs resolve inside the document and their `../schemas/...` refs resolve to the entity schemas'
 * $ids. Only the components are added; "components" is registered as an annotation keyword so the strict mode does
 * not reject it, and each component compiles (strictly) when a fixture or a case first uses it.
 */
function addOpenApiComponents(ajv, openApi) {
  if (!openApi?.components) return;
  try {
    ajv.addKeyword({ keyword: "components" });
    ajv.addSchema({ $id: `${SCHEMA_ID_BASE}${OPENAPI_FILE}`, components: openApi.components });
  } catch (error) {
    addError(`${OPENAPI_FILE}: components do not load: ${error.message}`);
  }
}

/** The validator for an entity schema file or an OpenAPI component key, or undefined (with an error) if none. */
function validatorFor(ajv, schemas, key) {
  try {
    const validate = schemas.has(key)
      ? ajv.getSchema(schemas.get(key).$id)
      : key.startsWith(`${OPENAPI_FILE}#`)
        ? ajv.getSchema(`${SCHEMA_ID_BASE}${key}`)
        : undefined;
    if (!validate) addError(`${key}: no such schema`);
    return validate;
  } catch (error) {
    addError(`${key}: does not compile: ${error.message}`);
    return undefined;
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────
// fixtures/<group>/<name>.valid.json is validated against schemas/<group>/<name>.schema.json, and
// fixtures/openapi/<Name>.valid.json against the component schema <Name> of the OpenAPI document (sample bodies of
// the API's own request and response shapes; components need one only when a case below uses it).

function validateFixtures(ajv, schemas) {
  const fixtures = new Map();
  for (const filePath of walkJsonFiles(path.join(contractsRoot, "fixtures"))) {
    const fixtureFile = rel(filePath);
    const match = fixtureFile.match(/^fixtures\/(.+)\.valid\.json$/);
    if (!match) {
      addError(`${fixtureFile}: fixture names must end in .valid.json`);
      continue;
    }
    const componentName = match[1].match(/^openapi\/(\w+)$/)?.[1];
    const schemaKey = componentName ? component(componentName) : `schemas/${match[1]}.schema.json`;
    const fixture = readJson(filePath);
    if (!componentName && !schemas.has(schemaKey)) {
      addError(`${fixtureFile}: no schema at ${schemaKey}`);
      continue;
    }
    if (fixture === null) continue;
    const validate = validatorFor(ajv, schemas, schemaKey);
    if (!validate) continue;
    if (!validate(fixture)) addError(`${fixtureFile} does not match ${schemaKey}: ${formatAjvErrors(validate.errors)}`);
    fixtures.set(schemaKey, fixture);
  }
  for (const schemaFile of schemas.keys()) {
    if (!fixtures.has(schemaFile))
      addError(`${schemaFile}: add a fixture at fixtures/${schemaFile.slice(8, -12)}.valid.json`);
  }
  return fixtures;
}

// Cases: [schema key, label, payload]. The payload is a function of a copy of the key's fixture, or a literal value
// (for a schema without a fixture, such as a header value).
// MUST_REJECT: values the schemas must reject; proves the enum, pattern, format and closed-object rules are really
// enforced. MUST_ACCEPT: shapes producers send and clients must keep decoding.
const PROCESSED_BILL = "schemas/entities/processed-bill.v1.schema.json";
const BILLS_MANIFEST = "schemas/entities/bills-manifest.v1.schema.json";
const SNAPSHOT_POINTER = "schemas/entities/bills-manifest-snapshot-pointer.v1.schema.json";
const PROCESSED_MEMBER = "schemas/entities/processed-congress-member.v1.schema.json";
const MEMBERS_MANIFEST = "schemas/entities/congress-member-manifest.v1.schema.json";
// The fixtures' companion group (APPF-23), changed by `edit` (the processed bill's companionGroup, or the
// manifest's first companionGroups entry).
const withCompanionGroup = (edit) => (bill) => ({ ...bill, companionGroup: edit(bill.companionGroup) });
const withManifestCompanionGroup = (edit) => (manifest) => ({
  ...manifest,
  companionGroups: [edit(manifest.companionGroups[0]), ...manifest.companionGroups.slice(1)],
});
const oneMember = (group) => ({ ...group, memberGuids: [group.primaryGuid] });
const withoutRelationship = ({ relationship, ...group }) => group;

// ── Member facts (REL-52) ──
// A member with no stats row (REL-46) or whose stats could not be read has none of the three counts (no 0 for a member
// with no stats row or for an unknown count; a row with zeros keeps them), and a senator's per-Congress entries are
// merged into terms that span several Congresses, the current one without endYear.
const withoutStatsCounts = (member) => {
  const { currentCongressBillsSupportedCount, trackedSponsoredCount, trackedSupportedCount, ...rest } = member;
  return rest;
};
const senateTerm = (congress, startYear, endYear) => ({
  chamber: "Senate",
  memberType: "Senator",
  congress,
  startYear,
  ...(endYear ? { endYear } : {}),
  stateCode: "MN",
  stateName: "Minnesota",
});
const MEMBER_MUST_ACCEPT = [
  [
    PROCESSED_MEMBER,
    "a processed member without the stats counts (no stats row, or the stats read failed)",
    withoutStatsCounts,
  ],
  [
    PROCESSED_MEMBER,
    "a senator's terms merged across Congresses, the current one without endYear",
    (member) => ({
      ...member,
      chamber: "Senate",
      memberType: "Senator",
      district: null,
      termCount: 2,
      terms: [senateTerm(115, 2018, 2021), senateTerm(117, 2021)],
    }),
  ],
  [
    MEMBERS_MANIFEST,
    "a manifest member without the stats counts (no stats row, or the stats read failed)",
    (manifest) => ({ ...manifest, members: manifest.members.map(withoutStatsCounts) }),
  ],
];

// ── Stats, verification limit, label and App Attest cases (C2 4.2 and C3 4.4) ──
// Sub-category label rename (LLM-10, decision 1B; names from question Q1): each legacy name and its new name. Both
// spellings must validate in processed bills and manifest items until the legacy-name cleanup, which removes the legacy
// names from the enum and the legacy cases here; near-miss spellings never validate.
const RENAMED_SUB_CATEGORIES = [
  ["Social Justice", "Civil Rights and Liberties"],
  ["Identity Politics", "Heritage and Identity"],
];
const withSubCategories = (subCategories) => (bill) => ({ ...bill, subCategories });
const withManifestSubCategories = (subCategories) => (manifest) => ({
  ...manifest,
  bills: [{ ...manifest.bills[0], subCategories }, ...manifest.bills.slice(1)],
});
const LABEL_MUST_ACCEPT = RENAMED_SUB_CATEGORIES.flatMap(([legacyName, currentName]) => [
  [PROCESSED_BILL, `the legacy sub-category "${legacyName}"`, withSubCategories(["Energy", legacyName])],
  [PROCESSED_BILL, `the new sub-category "${currentName}"`, withSubCategories(["Energy", currentName])],
  [
    BILLS_MANIFEST,
    `the legacy sub-category "${legacyName}" in a manifest item`,
    withManifestSubCategories([legacyName]),
  ],
  [
    BILLS_MANIFEST,
    `the new sub-category "${currentName}" in a manifest item`,
    withManifestSubCategories([currentName]),
  ],
]);
const LABEL_MUST_REJECT = [
  [
    PROCESSED_BILL,
    'the Congress.gov policy area "Civil Rights and Liberties, Minority Issues"',
    withSubCategories(["Civil Rights and Liberties, Minority Issues"]),
  ],
  [PROCESSED_BILL, 'the misspelling "Civil Rights & Liberties"', withSubCategories(["Civil Rights & Liberties"])],
  [PROCESSED_BILL, 'the lower-case "heritage and identity"', withSubCategories(["heritage and identity"])],
  [PROCESSED_BILL, 'the lower-case legacy "social justice"', withSubCategories(["social justice"])],
  [
    BILLS_MANIFEST,
    'the misspelling "Heritage & Identity" in a manifest item',
    withManifestSubCategories(["Heritage & Identity"]),
  ],
];

// GET /bill-stats (2C, INT-08): the comparison block, the plain VoteSplit, and the weighted* fields old builds need.
const BILL_STATS = component("BillStats");
const withComparison = (edit) => (stats) => ({ ...stats, comparison: edit(stats.comparison) });
const withAllUsers = (edit) => withComparison((comparison) => ({ ...comparison, allUsers: edit(comparison.allUsers) }));
const withheld = ({ verified, ...comparison }) => ({ ...comparison, verifiedWithheld: true });
const without =
  (...keys) =>
  (value) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const STATS_MUST_ACCEPT = [
  [BILL_STATS, "a body without comparison (an older server)", without("comparison")],
  [BILL_STATS, "a withheld verified split (verified absent)", withComparison(withheld)],
  [
    BILL_STATS,
    "a comparison with no Yea or Nay votes (yeaPct null)",
    withComparison(() => ({
      allUsers: { votes: 2, yea: 0, nay: 0, abstain: 2, decisionVotes: 0, yeaPct: null },
      verifiedWithheld: true,
      minDecisionVotes: 5,
    })),
  ],
  [
    BILL_STATS,
    "companion stats with comparison (scope=companions)",
    (stats) => ({ ...stats, companionBillIds: ["BILLS-119hr1285", "BILLS-119s570"] }),
  ],
];
const STATS_MUST_REJECT = [
  [BILL_STATS, "a null comparison", (stats) => ({ ...stats, comparison: null })],
  [BILL_STATS, "a comparison with an undeclared field", withComparison((c) => ({ ...c, selfAttested: c.allUsers }))],
  [BILL_STATS, "a comparison without allUsers", withComparison(without("allUsers"))],
  [BILL_STATS, "a comparison without verifiedWithheld", withComparison(without("verifiedWithheld"))],
  [BILL_STATS, "a comparison without minDecisionVotes", withComparison(without("minDecisionVotes"))],
  [BILL_STATS, "a comparison with minDecisionVotes 0", withComparison((c) => ({ ...c, minDecisionVotes: 0 }))],
  [
    BILL_STATS,
    "a verified split while verifiedWithheld is true",
    withComparison((c) => ({ ...c, verifiedWithheld: true })),
  ],
  [BILL_STATS, "no verified split while verifiedWithheld is false", withComparison(without("verified"))],
  [BILL_STATS, "a VoteSplit without decisionVotes", withAllUsers(without("decisionVotes"))],
  [BILL_STATS, "a VoteSplit without yeaPct", withAllUsers(without("yeaPct"))],
  [
    BILL_STATS,
    "a weighted field in a VoteSplit",
    withAllUsers((split) => ({ ...split, weightedYeaPct: split.yeaPct })),
  ],
  [BILL_STATS, "a fractional (weighted) VoteSplit count", withAllUsers((split) => ({ ...split, yea: 7.5 }))],
  [BILL_STATS, "a negative VoteSplit count", withAllUsers((split) => ({ ...split, nay: -1 }))],
  [BILL_STATS, "a VoteSplit yeaPct over 100", withAllUsers((split) => ({ ...split, yeaPct: 100.5 }))],
  // Builds 1.0 and R1 decode every weighted* field as required (BillStatsService.VoteTotals), so they must stay.
  [
    BILL_STATS,
    "totals without weightedYeaPct",
    (stats) => ({ ...stats, totals: without("weightedYeaPct")(stats.totals) }),
  ],
  [
    BILL_STATS,
    "a verified segment without weightedVotes",
    (stats) => ({
      ...stats,
      segments: { ...stats.segments, verified: without("weightedVotes")(stats.segments.verified) },
    }),
  ],
];

// POST and GET /district-verification (INT-03): limitReason and the address_capped method.
const DISTRICT_VERIFICATION = component("DistrictVerification");
const verifiedAddress = (status) => ({
  ...without("limitReason", "nextStep")(status),
  verified: true,
  status: "likely_constituent",
  method: "address_geocode",
  repsSignalEligible: true,
});
const VERIFICATION_MUST_ACCEPT = [
  [DISTRICT_VERIFICATION, "a verified address without limitReason", verifiedAddress],
  [DISTRICT_VERIFICATION, "the state of a caller who never verified", () => ({ verified: false })],
];
const VERIFICATION_MUST_REJECT = [
  [DISTRICT_VERIFICATION, "an unknown limitReason", (status) => ({ ...status, limitReason: "street_limit" })],
  [DISTRICT_VERIFICATION, "a null limitReason", (status) => ({ ...status, limitReason: null })],
  [
    DISTRICT_VERIFICATION,
    "limitReason on a verified address",
    (status) => ({ ...verifiedAddress(status), limitReason: "address_limit" }),
  ],
];

// GET /civic-profile (UX-32): the theme lock's additive fields. Apps 1.1 and 1.2 decode only the first five (and ignore
// unknown keys), so a body without the new ones (a server before UX-32) stays valid.
const USER_CIVIC_PROFILE = component("UserCivicProfile");
const CIVIC_PROFILE_MUST_ACCEPT = [
  [
    USER_CIVIC_PROFILE,
    "a body without the UX-32 fields (a server before UX-32)",
    without("lockedBy", "themesReady", "minThemesRequired", "minThemeVotes"),
  ],
  [
    USER_CIVIC_PROFILE,
    "a ready profile (lockedBy null)",
    (profile) => ({
      ...profile,
      axes: { ...profile.axes, privacyVsSecurity: 0.5 },
      minVotesRequired: 25,
      isReady: true,
      lockedBy: null,
      themesReady: 3,
    }),
  ],
  [
    USER_CIVIC_PROFILE,
    "a profile locked on its votes",
    (profile) => ({ ...profile, votesUsed: 12, totalVotesWithProfile: 12, minVotesRequired: 25, lockedBy: "votes" }),
  ],
  [
    USER_CIVIC_PROFILE,
    "a profile under 25 votes locked on its themes (the 3rd theme short by more than the votes)",
    (profile) => ({ ...profile, votesUsed: 20, totalVotesWithProfile: 20, minVotesRequired: 26, lockedBy: "themes" }),
  ],
  [
    USER_CIVIC_PROFILE,
    "minVotesRequired past the 100-vote window",
    (profile) => ({ ...profile, votesUsed: 100, totalVotesWithProfile: 140, minVotesRequired: 103 }),
  ],
];
const CIVIC_PROFILE_MUST_REJECT = [
  [USER_CIVIC_PROFILE, "an unknown lockedBy", (profile) => ({ ...profile, lockedBy: "axes" })],
  [USER_CIVIC_PROFILE, "minVotesRequired 0", (profile) => ({ ...profile, minVotesRequired: 0 })],
  [USER_CIVIC_PROFILE, "a fractional themesReady", (profile) => ({ ...profile, themesReady: 2.5 })],
  [USER_CIVIC_PROFILE, "an undeclared field", (profile) => ({ ...profile, themeVotes: { localVsFederal: 8 } })],
  [USER_CIVIC_PROFILE, "a body without isReady", without("isReady")],
];

// App Attest (C3 4.3-4.4): bodies of the two routes, the header grammar and its clientData, the version header, the
// pre-sign-up ClientMetadata, and Retry-After.
const MARKER = component("AppAttestMarker");
const APP_VERSION = component("AppVersion");
const REQUEST_CLIENT_DATA = component("AppAttestRequestClientData");
const SIGN_UP_CLIENT_DATA = component("AppAttestSignUpClientData");
const CHALLENGE_REQUEST = component("AppAttestChallengeRequest");
const CHALLENGE = component("AppAttestChallenge");
const ATTEST_REQUEST = component("AppAttestAttestRequest");
const ATTEST_RESULT = component("AppAttestAttestResult");
const CLIENT_METADATA = component("PreSignUpClientMetadata");
const RETRY_AFTER = openApiPart("headers/RetryAfter/schema");
const ATTEST_HEADER_PARAMETER = openApiPart("parameters/appAttestHeader/schema");
const VERSION_HEADER_PARAMETER = openApiPart("parameters/appVersionHeader/schema");
const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
const KEY_ID = base64url(Buffer.alloc(32, 7));
const assertionMarker = (clientData, keyId = KEY_ID) =>
  `v1.a.${keyId}.${base64url(JSON.stringify(clientData))}.${base64url(Buffer.alloc(72, 3))}`;
const SAMPLE_REQUEST_CLIENT_DATA = {
  v: 1,
  purpose: "request",
  challenge: base64url(Buffer.alloc(32, 1)),
  method: "POST",
  path: "/feedback",
  bodySha256: base64url(Buffer.alloc(32, 2)),
};
const CLIENT_ERROR_CODES = ["challenge", "attest", "assert", "timeout", "disabled", "keychain"];
const APP_ATTEST_MUST_ACCEPT = [
  [MARKER, "an assertion (v1.a)", assertionMarker(SAMPLE_REQUEST_CLIENT_DATA)],
  [MARKER, "unsupported (v1.u)", "v1.u"],
  [MARKER, "the Debug bypass (v1.b)", "v1.b"],
  ...CLIENT_ERROR_CODES.map((code) => [MARKER, `the client error v1.e.${code}`, `v1.e.${code}`]),
  [
    ATTEST_HEADER_PARAMETER,
    "an assertion in the X-Billboard-App-Attest parameter",
    assertionMarker(SAMPLE_REQUEST_CLIENT_DATA),
  ],
  [VERSION_HEADER_PARAMETER, "1.2 in the X-Billboard-App-Version parameter", "1.2"],
  ...["1", "1.2", "1.2.3", "10.0.12"].map((version) => [APP_VERSION, `the version ${version}`, version]),
  [REQUEST_CLIENT_DATA, "request clientData with an unknown key (ignored)", (data) => ({ ...data, nonce: "x" })],
  [SIGN_UP_CLIENT_DATA, "sign-up clientData with an unknown key (ignored)", (data) => ({ ...data, nonce: "x" })],
  [CHALLENGE_REQUEST, "purpose assert", { purpose: "assert" }],
  [CHALLENGE, "clientMode off without a challenge", { clientMode: "off" }],
  [ATTEST_RESULT, "already_attested in development", { status: "already_attested", environment: "development" }],
  [CLIENT_METADATA, "no App Attest keys (builds 1.0 and R1)", {}],
  [CLIENT_METADATA, "a marker only (no DeviceCheck token)", { billboardAppAttest: "v1.u", billboardAppVersion: "1.2" }],
  [CLIENT_METADATA, "an unrelated string key", (metadata) => ({ ...metadata, source: "app" })],
  [RETRY_AFTER, "Retry-After 3600", 3600],
  [RETRY_AFTER, "Retry-After 0", 0],
];
const APP_ATTEST_MUST_REJECT = [
  [MARKER, "an empty marker", ""],
  [MARKER, "an unknown version (v2.u)", "v2.u"],
  [MARKER, "an upper-case prefix (V1.u)", "V1.u"],
  [MARKER, "an assertion without clientData and assertion", `v1.a.${KEY_ID}`],
  [MARKER, "a 31-byte key ID", assertionMarker(SAMPLE_REQUEST_CLIENT_DATA, base64url(Buffer.alloc(31, 7)))],
  [
    MARKER,
    "a padded base64 key ID",
    assertionMarker(SAMPLE_REQUEST_CLIENT_DATA, Buffer.alloc(32, 7).toString("base64")),
  ],
  [MARKER, "a client error without a code", "v1.e."],
  [MARKER, "an unknown client error code", "v1.e.unknown"],
  [MARKER, "a marker over 2,048 characters", `v1.a.${KEY_ID}.${"A".repeat(1366)}.${"B".repeat(683)}`],
  ...["", "1.2.3.4", "1.2-beta", "v1.2", " 1.2", "1..2"].map((version) => [
    APP_VERSION,
    `the version ${JSON.stringify(version)}`,
    version,
  ]),
  [VERSION_HEADER_PARAMETER, '"1.2 (45)" in the X-Billboard-App-Version parameter', "1.2 (45)"],
  [REQUEST_CLIENT_DATA, "clientData v 2", (data) => ({ ...data, v: 2 })],
  [REQUEST_CLIENT_DATA, 'clientData v "1"', (data) => ({ ...data, v: "1" })],
  [REQUEST_CLIENT_DATA, "request clientData with purpose signup", (data) => ({ ...data, purpose: "signup" })],
  [REQUEST_CLIENT_DATA, "request clientData without bodySha256", without("bodySha256")],
  [REQUEST_CLIENT_DATA, "a hex bodySha256", (data) => ({ ...data, bodySha256: "ab".repeat(32) })],
  [SIGN_UP_CLIENT_DATA, "sign-up clientData with purpose request", (data) => ({ ...data, purpose: "request" })],
  [SIGN_UP_CLIENT_DATA, "sign-up clientData without emailSha256", without("emailSha256")],
  [
    SIGN_UP_CLIENT_DATA,
    "the email itself instead of its hash",
    (data) => ({ ...data, emailSha256: "jane@example.com" }),
  ],
  [CHALLENGE_REQUEST, "purpose signup", { purpose: "signup" }],
  [CHALLENGE_REQUEST, "purpose ATTEST", { purpose: "ATTEST" }],
  [CHALLENGE_REQUEST, "no purpose", {}],
  [CHALLENGE, "clientMode on without a challenge", without("challenge")],
  [CHALLENGE, "clientMode on without expiresAt", without("expiresAt")],
  [CHALLENGE, "clientMode off with a challenge", (body) => ({ ...body, clientMode: "off" })],
  [CHALLENGE, "an unknown clientMode", (body) => ({ ...body, clientMode: "disabled" })],
  [CHALLENGE, "a 42-character challenge", (body) => ({ ...body, challenge: body.challenge.slice(1) })],
  [CHALLENGE, "an undeclared field", (body) => ({ ...body, purpose: "assert" })],
  [ATTEST_REQUEST, "a padded base64 keyId", (body) => ({ ...body, keyId: Buffer.alloc(32, 7).toString("base64") })],
  [ATTEST_REQUEST, "a base64url attestation", (body) => ({ ...body, attestation: "o2NmbXRv-_-_" })],
  [ATTEST_REQUEST, "an attestation without its padding", (body) => ({ ...body, attestation: "o2NmbXRvYQ" })],
  [ATTEST_REQUEST, "an attestation over 16 KB", (body) => ({ ...body, attestation: "AAAA".repeat(4097) })],
  [ATTEST_REQUEST, "no attestation", without("attestation")],
  [ATTEST_RESULT, "an unknown status", (body) => ({ ...body, status: "rejected" })],
  [ATTEST_RESULT, "an unknown environment", (body) => ({ ...body, environment: "sandbox" })],
  [ATTEST_RESULT, "no environment", without("environment")],
  [ATTEST_RESULT, "an undeclared field", (body) => ({ ...body, keyId: KEY_ID })],
  [CLIENT_METADATA, "a malformed billboardAppAttest", (metadata) => ({ ...metadata, billboardAppAttest: "v1.a.x" })],
  [CLIENT_METADATA, "a base64url DeviceCheck token", (metadata) => ({ ...metadata, billboardDeviceCheck: "ab-_" })],
  [CLIENT_METADATA, "a number as billboardAppVersion", (metadata) => ({ ...metadata, billboardAppVersion: 1.2 })],
  [CLIENT_METADATA, "a non-string value (Cognito allows strings only)", (metadata) => ({ ...metadata, retries: 2 })],
  [RETRY_AFTER, "a negative Retry-After", -1],
  [RETRY_AFTER, "a fractional Retry-After", 1.5],
  [RETRY_AFTER, "an HTTP-date Retry-After", "Fri, 09 Oct 2026 00:00:00 GMT"],
];

const MUST_REJECT = [
  [PROCESSED_BILL, "an unknown sub-category", (bill) => ({ ...bill, subCategories: ["Infrastructure"] })],
  [PROCESSED_BILL, "an unknown life area", (bill) => ({ ...bill, lifeAreas: ["Cost of Living"] })],
  [PROCESSED_BILL, "a sponsor name instead of a bioguide ID", (bill) => ({ ...bill, sponsors: ["Jane Doe"] })],
  // Actions may lack text and breakdowns may lack why (live bills do), but not the rest.
  [
    PROCESSED_BILL,
    "an action without a date",
    (bill) => ({ ...bill, actions: [{ text: "Introduced in House", type: "IntroReferral" }] }),
  ],
  // The app decodes `type` as required (ProcessedBillAction.type is a String), so a bill with such an action fails.
  [
    PROCESSED_BILL,
    "an action without a type",
    (bill) => ({ ...bill, actions: [{ actionDate: "2026-02-10", text: "Introduced in House" }] }),
  ],
  [
    PROCESSED_BILL,
    "a billBreakdown without who",
    (bill) => {
      const { who, ...billBreakdown } = bill.billBreakdown;
      return { ...bill, billBreakdown };
    },
  ],
  [PROCESSED_BILL, "a cosponsor name instead of a bioguide ID", (bill) => ({ ...bill, cosponsors: ["Jane Doe"] })],
  [PROCESSED_BILL, "an undeclared top-level field", (bill) => ({ ...bill, unexpected: true })],
  // Committee activities may lack a date and committees may lack activities (live bills do), but not the rest.
  [
    PROCESSED_BILL,
    "a committee without a chamber",
    (bill) => ({ ...bill, committees: [{ name: "Agriculture Committee" }] }),
  ],
  [
    PROCESSED_BILL,
    "a committee activity without a name",
    (bill) => ({ ...bill, committees: [{ ...bill.committees[0], activities: [{ date: "2026-02-10T15:03:15Z" }] }] }),
  ],
  [
    PROCESSED_BILL,
    "a committee activity date that is not a date-time",
    (bill) => ({
      ...bill,
      committees: [{ ...bill.committees[0], activities: [{ name: "Referred to", date: "last Tuesday" }] }],
    }),
  ],
  [PROCESSED_BILL, "a companion group with one member", withCompanionGroup(oneMember)],
  [PROCESSED_BILL, "a companion group without a relationship", withCompanionGroup(withoutRelationship)],
  [PROCESSED_BILL, "a companion group without a primaryGuid", withCompanionGroup(({ primaryGuid, ...group }) => group)],
  [
    PROCESSED_BILL,
    "a companion group with an undeclared field",
    withCompanionGroup((group) => ({ ...group, congress: "119" })),
  ],
  [
    BILLS_MANIFEST,
    "an unknown life area in a manifest item",
    (manifest) => ({ ...manifest, bills: [{ ...manifest.bills[0], lifeAreas: ["Health"] }] }),
  ],
  [BILLS_MANIFEST, "a manifest companion group with one member", withManifestCompanionGroup(oneMember)],
  [
    BILLS_MANIFEST,
    "a manifest companion group without a relationship",
    withManifestCompanionGroup(withoutRelationship),
  ],
  [SNAPSHOT_POINTER, "a pointer without a snapshotUrl", ({ snapshotUrl, ...pointer }) => pointer],
  [SNAPSHOT_POINTER, "a relative snapshotUrl", (pointer) => ({ ...pointer, snapshotUrl: "snapshots/bills.json.gz" })],
  [SNAPSHOT_POINTER, "a negative count", (pointer) => ({ ...pointer, count: -1 })],
  [SNAPSHOT_POINTER, "the manifest's bills inline", (pointer) => ({ ...pointer, bills: [] })],
  ...LABEL_MUST_REJECT,
  ...STATS_MUST_REJECT,
  ...VERIFICATION_MUST_REJECT,
  ...CIVIC_PROFILE_MUST_REJECT,
  ...APP_ATTEST_MUST_REJECT,
];

// Shapes of live processed bills the processed-bill schema must accept: Congress.gov committee shapes (CON-11), and
// the action, breakdown and cosponsor shapes a validation of every stored bill found (`npm run validate:live`). Also
// the companion-group shapes clients must keep decoding: no group (every stored bill; a server that predates
// groups), a relationship other than "identical", and more than two members (allowed for a later widening).
const unknownRelationship = (group) => ({ ...group, relationship: "substantially-identical" });
const MUST_ACCEPT = [
  [
    PROCESSED_BILL,
    "a committee activity without a date (H.R. 3838 and H.R. 4275, 119th Congress)",
    (bill) => ({
      ...bill,
      committees: [
        {
          name: "Agriculture Committee",
          chamber: "House",
          activities: [{ name: "Bills of Interest - Exchange of Letters" }],
        },
      ],
    }),
  ],
  [
    PROCESSED_BILL,
    "a committee with only subcommittee activities (H.R. 471, 119th Congress)",
    (bill) => ({
      ...bill,
      committees: [
        {
          name: "Agriculture, Nutrition, and Forestry Committee",
          chamber: "Senate",
          subcommittees: [
            {
              name: "Conservation Subcommittee",
              activities: [{ name: "Hearings By (subcommittee)", date: "2025-03-06T16:00:00Z" }],
            },
          ],
        },
      ],
    }),
  ],
  [
    PROCESSED_BILL,
    "an action without text (an Intro-S IntroReferral action of a Senate bill)",
    (bill) => ({
      ...bill,
      actions: [
        {
          actionCode: "Intro-S",
          actionDate: "2025-12-04",
          sourceSystem: { code: 0, name: "Senate" },
          type: "IntroReferral",
        },
      ],
    }),
  ],
  [
    PROCESSED_BILL,
    "a billBreakdown without why (an older summary)",
    (bill) => {
      const { why, ...billBreakdown } = bill.billBreakdown;
      return { ...bill, billBreakdown };
    },
  ],
  [
    PROCESSED_BILL,
    "a billBreakdown with an extra key",
    (bill) => ({ ...bill, billBreakdown: { ...bill.billBreakdown, lifeAreas: ["Taxes"] } }),
  ],
  [
    PROCESSED_BILL,
    "a cosponsor listed twice",
    (bill) => ({ ...bill, cosponsors: [...bill.cosponsors, bill.cosponsors[0]] }),
  ],
  [PROCESSED_BILL, "a bill without a companionGroup", ({ companionGroup, ...bill }) => bill],
  [PROCESSED_BILL, "an unknown companion relationship", withCompanionGroup(unknownRelationship)],
  [
    PROCESSED_BILL,
    "a companion group with three members",
    withCompanionGroup((group) => ({ ...group, memberGuids: [...group.memberGuids, "BILLS-119s571"] })),
  ],
  [BILLS_MANIFEST, "a manifest without companionGroups", ({ companionGroups, ...manifest }) => manifest],
  [BILLS_MANIFEST, "an empty companionGroups list", (manifest) => ({ ...manifest, companionGroups: [] })],
  [
    BILLS_MANIFEST,
    "an unknown companion relationship in the manifest",
    withManifestCompanionGroup(unknownRelationship),
  ],
  ...MEMBER_MUST_ACCEPT,
  ...LABEL_MUST_ACCEPT,
  ...STATS_MUST_ACCEPT,
  ...VERIFICATION_MUST_ACCEPT,
  ...CIVIC_PROFILE_MUST_ACCEPT,
  ...APP_ATTEST_MUST_ACCEPT,
];

/** Runs MUST_REJECT and MUST_ACCEPT. Returns the number of cases run. */
function checkCases(ajv, schemas, fixtures) {
  let count = 0;
  for (const [cases, mustAccept] of [
    [MUST_REJECT, false],
    [MUST_ACCEPT, true],
  ]) {
    for (const [key, label, payload] of cases) {
      let value = payload;
      if (typeof payload === "function") {
        if (!fixtures.has(key)) {
          // A missing entity fixture is already reported; an OpenAPI component needs one only for its cases.
          if (!schemas.has(key)) addError(`${key}: the case "${label}" needs a fixture`);
          continue;
        }
        try {
          value = payload(structuredClone(fixtures.get(key)));
        } catch (error) {
          addError(`${key}: the case "${label}" cannot be built from the fixture: ${error.message}`);
          continue;
        }
      }
      const validate = validatorFor(ajv, schemas, key);
      if (!validate) continue;
      count += 1;
      if (validate(value) === mustAccept) continue;
      addError(mustAccept ? `${key} rejects ${label}: ${formatAjvErrors(validate.errors)}` : `${key} accepts ${label}`);
    }
  }
  return count;
}

// ── Rules ajv cannot express ───────────────────────────────────────────────────────────────────

// A companion group's plain member guid: BILLS-<congress><type><number>, with no text-version suffix.
const PLAIN_BILL_GUID = /^BILLS-\d+(hconres|hjres|hres|hr|sconres|sjres|sres|s)\d+$/;

/** The companion-group rules the schema cannot express, for the group `group` found at `where`. */
function checkCompanionGroup(group, where) {
  const members = group.memberGuids;
  if (group.primaryGuid !== members[0]) addError(`${where}: primaryGuid must be memberGuids[0]`);
  if (new Set(members).size !== members.length) addError(`${where}: memberGuids must not repeat`);
  for (const guid of members) {
    if (!PLAIN_BILL_GUID.test(guid)) addError(`${where}: ${guid} is not a plain bill guid`);
  }
}

function checkCrossFieldRules(fixtures) {
  const manifest = fixtures.get(BILLS_MANIFEST);
  const groups = manifest?.companionGroups ?? [];
  const manifestGuids = new Set((manifest?.bills ?? []).map((bill) => bill.guid));
  groups.forEach((group, index) => {
    const where = `${BILLS_MANIFEST} fixture companionGroups[${index}]`;
    checkCompanionGroup(group, where);
    const missing = group.memberGuids.filter((guid) => !manifestGuids.has(guid));
    if (missing.length > 0) addError(`${where}: members not among the manifest's bills: ${missing.join(", ")}`);
    if (index > 0 && groups[index - 1].primaryGuid >= group.primaryGuid)
      addError(`${where}: companionGroups must be sorted by primaryGuid`);
  });
  const bill = fixtures.get(PROCESSED_BILL);
  if (bill?.companionGroup) {
    const where = `${PROCESSED_BILL} fixture companionGroup`;
    checkCompanionGroup(bill.companionGroup, where);
    const plainGuid = bill.guid.replace(/[a-z]+$/i, "");
    if (!bill.companionGroup.memberGuids.includes(plainGuid))
      addError(`${where}: the bill's own plain guid (${plainGuid}) is not a member`);
  }

  for (const [schemaFile, arrayKey] of [
    [BILLS_MANIFEST, "bills"],
    ["schemas/entities/congress-member-manifest.v1.schema.json", "members"],
  ]) {
    const manifest = fixtures.get(schemaFile);
    if (manifest && Array.isArray(manifest[arrayKey]) && manifest.count !== manifest[arrayKey].length) {
      addError(`${schemaFile} fixture: count must equal ${arrayKey}.length`);
    }
  }

  const release = fixtures.get("schemas/release/lambda-release-manifest.v1.schema.json");
  for (const field of ["logicalName", "functionName"]) {
    const values = (release?.artifacts ?? []).map((artifact) => artifact[field]);
    const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
    if (duplicates.length > 0)
      addError(`release fixture: duplicate artifact ${field} ${[...new Set(duplicates)].join(", ")}`);
  }

  const stats = fixtures.get(BILL_STATS);
  try {
    if (stats) checkBillStatsFixture(stats, `${BILL_STATS} fixture`);
  } catch (error) {
    addError(`${BILL_STATS} fixture: cannot check the sample: ${error.message}`);
  }
}

const PLAIN_VOTE_FIELDS = ["votes", "yea", "nay", "abstain", "decisionVotes", "yeaPct"];
const WEIGHTED_VOTE_FIELDS = {
  weightedVotes: "votes",
  weightedYea: "yea",
  weightedNay: "nay",
  weightedAbstain: "abstain",
  weightedDecisionVotes: "decisionVotes",
  weightedYeaPct: "yeaPct",
};

/** The arithmetic of one VoteBucket or VoteSplit, as services/src/shared/billStats.ts computes it. */
function checkVoteCounts(bucket, where, { weighted }) {
  if (bucket.decisionVotes !== bucket.yea + bucket.nay) addError(`${where}: decisionVotes must be yea + nay`);
  if (bucket.votes !== bucket.yea + bucket.nay + bucket.abstain)
    addError(`${where}: votes must be yea + nay + abstain`);
  const yeaPct =
    bucket.decisionVotes > 0 ? Math.round((bucket.yea / bucket.decisionVotes) * 100 * 10000) / 10000 : null;
  if (bucket.yeaPct !== yeaPct) addError(`${where}: yeaPct must be ${yeaPct}`);
  if (!weighted) return;
  for (const [weightedField, plainField] of Object.entries(WEIGHTED_VOTE_FIELDS)) {
    if (bucket[weightedField] !== bucket[plainField])
      addError(`${where}: ${weightedField} must equal ${plainField} (every vote counts 1)`);
  }
}

/**
 * The BillStats sample as fetchBillStats serves it: equal weights in every bucket, and a comparison
 * derived from totals and segments.verified (C2 3.1).
 */
function checkBillStatsFixture(stats, where) {
  const buckets = [
    ["totals", stats.totals],
    ["segments.verified", stats.segments.verified],
    ["segments.selfAttested", stats.segments.selfAttested],
  ];
  for (const [scope, rollups] of Object.entries(stats.rollups)) {
    for (const [key, rollup] of Object.entries(rollups)) {
      buckets.push([`rollups.${scope}.${key}.totals`, rollup.totals]);
      buckets.push([`rollups.${scope}.${key}.segments.verified`, rollup.segments.verified]);
      buckets.push([`rollups.${scope}.${key}.segments.selfAttested`, rollup.segments.selfAttested]);
    }
  }
  for (const [bucketPath, bucket] of buckets) checkVoteCounts(bucket, `${where} ${bucketPath}`, { weighted: true });

  const { comparison } = stats;
  if (!comparison) {
    addError(`${where}: the sample must carry comparison`);
    return;
  }
  const plainSplit = (bucket) => Object.fromEntries(PLAIN_VOTE_FIELDS.map((field) => [field, bucket[field]]));
  const sameSplit = (a, b) => PLAIN_VOTE_FIELDS.every((field) => a?.[field] === b?.[field]);
  checkVoteCounts(comparison.allUsers, `${where} comparison.allUsers`, { weighted: false });
  if (!sameSplit(comparison.allUsers, plainSplit(stats.totals)))
    addError(`${where}: comparison.allUsers must be the plain split of totals`);
  const withheld = stats.segments.verified.decisionVotes < comparison.minDecisionVotes;
  if (comparison.verifiedWithheld !== withheld)
    addError(`${where}: verifiedWithheld must be ${withheld} (segments.verified.decisionVotes < minDecisionVotes)`);
  if (!withheld && !sameSplit(comparison.verified, plainSplit(stats.segments.verified)))
    addError(`${where}: comparison.verified must be the plain split of segments.verified`);
}

/**
 * The sample ClientMetadata's billboardAppAttest assertion, when it is one (v1.a), carries a 32-byte key ID and sign-up
 * clientData that validates as AppAttestSignUpClientData.
 */
function checkClientMetadataFixture(ajv, schemas, fixtures) {
  const marker = fixtures.get(CLIENT_METADATA)?.billboardAppAttest;
  if (typeof marker !== "string" || !marker.startsWith("v1.a.")) return;
  const where = `${CLIENT_METADATA} fixture billboardAppAttest`;
  const [, , keyId, clientData] = marker.split(".");
  if (Buffer.from(keyId, "base64url").length !== 32) addError(`${where}: the key ID must be 32 bytes`);
  const validate = validatorFor(ajv, schemas, SIGN_UP_CLIENT_DATA);
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(clientData, "base64url").toString("utf8"));
  } catch (error) {
    addError(`${where}: clientData is not JSON: ${error.message}`);
    return;
  }
  if (validate && !validate(decoded)) addError(`${where}: clientData: ${formatAjvErrors(validate.errors)}`);
}

/** Every quoted string inside the first `[...]` that follows `marker` in a services source file. */
function quotedListAfter(source, marker, file) {
  const start = source.indexOf(marker);
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  if (start === -1 || open === -1 || close === -1) throw new Error(`cannot find ${marker} in ${file}`);
  return [...source.slice(open, close).matchAll(/"([^"]+)"|'([^']+)'/g)].map((match) => match[1] ?? match[2]);
}

/**
 * The quoted `"key": "value"` pairs of the object literal assigned to `const <name>` in a services source file, or []
 * when the file declares no such constant (after the legacy-name cleanup removes the aliases). Anything else inside
 * the literal (an unquoted key, a spread, a computed value) is an error, so the check never reads a partial map.
 */
function quotedPairsOf(source, name, file) {
  const declaration = new RegExp(`\\bconst\\s+${name}\\b[^=]*=\\s*\\{`).exec(source);
  if (!declaration) return [];
  const open = declaration.index + declaration[0].length;
  const close = source.indexOf("}", open);
  if (close === -1) throw new Error(`cannot find the end of ${name} in ${file}`);
  const body = source.slice(open, close).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  const pair = /(?:"([^"]+)"|'([^']+)')\s*:\s*(?:"([^"]+)"|'([^']+)')\s*,?/g;
  const rest = body.replace(pair, "").trim();
  if (rest) throw new Error(`${name} in ${file} must hold only quoted "key": "value" pairs; cannot read: ${rest}`);
  return [...body.matchAll(pair)].map((match) => [match[1] ?? match[2], match[3] ?? match[4]]);
}

// The processed-bill enums copy the lists the summarizer and preferences validate against. The sub-category enum is
// the current names (BILL_CATEGORY_DEFINITIONS) plus the legacy names still accepted during the label switch (the keys
// of LEGACY_SUB_CATEGORY_ALIASES, LLM-10), and every legacy name must map to a current name.
function checkServiceEnums(schemas) {
  const processedBill = schemas.get(PROCESSED_BILL);
  if (!processedBill) return;
  const read = (file) => fs.readFileSync(path.join(platformRoot, file), "utf8");
  const categoriesFile = "services/src/models/categories.ts";
  const lifeAreasFile = "services/src/models/lifeAreas.ts";
  try {
    const categories = read(categoriesFile);
    const subCategories = [...categories.matchAll(/subCategories:\s*\[([^\]]*)\]/g)].flatMap((match) =>
      [...match[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((value) => value[1] ?? value[2]),
    );
    const legacyAliases = quotedPairsOf(categories, "LEGACY_SUB_CATEGORY_ALIASES", categoriesFile);
    for (const [legacyName, currentName] of legacyAliases) {
      if (subCategories.includes(legacyName))
        addError(`${categoriesFile}: legacy sub-category ${legacyName} is also a current name`);
      if (!subCategories.includes(currentName))
        addError(
          `${categoriesFile}: legacy sub-category ${legacyName} maps to ${currentName}, which is not a current name`,
        );
    }
    const acceptedSubCategories = [...subCategories, ...legacyAliases.map(([legacyName]) => legacyName)];
    const lifeAreas = quotedListAfter(read(lifeAreasFile), "LIFE_AREAS", lifeAreasFile);
    for (const [label, schemaValues, serviceValues, source] of [
      [
        "$defs/subCategory",
        processedBill.$defs.subCategory.enum,
        acceptedSubCategories,
        `${categoriesFile} (current names plus LEGACY_SUB_CATEGORY_ALIASES keys)`,
      ],
      ["$defs/lifeArea", processedBill.$defs.lifeArea.enum, lifeAreas, lifeAreasFile],
    ]) {
      if (serviceValues.length === 0) throw new Error(`found no values in ${source}`);
      const missing = serviceValues.filter((value) => !schemaValues.includes(value));
      const extra = schemaValues.filter((value) => !serviceValues.includes(value));
      if (missing.length || extra.length) {
        addError(
          `processed-bill ${label} differs from ${source}` +
            `${missing.length ? `; missing: ${missing.join(", ")}` : ""}${extra.length ? `; not in services: ${extra.join(", ")}` : ""}`,
        );
      }
    }
  } catch (error) {
    addError(`service enum check: ${error.message}`);
  }
}

// ── OpenAPI ────────────────────────────────────────────────────────────────────────────────────

/**
 * Routes declared in the user API stack, as "METHOD /path auth". Reads the resource variables
 * (`const x = parent.addResource('segment')`) and the methods added to them through
 * addCognitoMethod, addPublicMethod or addMethod.
 */
function stackRoutes(source) {
  const paths = new Map([["this.userApi.root", ""]]);
  for (const match of source.matchAll(/const\s+(\w+)\s*=\s*([\w.]+)\.addResource\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const [, variable, parent, segment] = match;
    if (!paths.has(parent)) throw new Error(`resource ${variable}: unknown parent ${parent}`);
    paths.set(variable, `${paths.get(parent)}/${segment}`);
  }
  const statementAt = (index) => source.slice(index, source.indexOf(";", index));
  const routes = new Set();
  for (const match of source.matchAll(
    /\b(addCognitoMethod|addPublicMethod|(\w+)\.addMethod)\(\s*(\w+)?,?\s*['"](\w+)['"]/g,
  )) {
    const [, call, receiver, firstArgument, method] = match;
    const variable = call === "addCognitoMethod" || call === "addPublicMethod" ? firstArgument : receiver;
    if (!paths.has(variable)) continue; // the helpers' own `resource.addMethod(...)`
    const statement = statementAt(match.index);
    const auth =
      call === "addCognitoMethod" || /AuthorizationType\.COGNITO/.test(statement)
        ? "cognito"
        : /apiKeyRequired:\s*true/.test(statement)
          ? "apiKey"
          : "none";
    routes.add(`${method.toUpperCase()} ${paths.get(variable) || "/"} ${auth}`);
  }
  return routes;
}

function documentedRoutes(openApi) {
  const authOf = (security) => {
    const schemes = (security ?? []).flatMap((requirement) => Object.keys(requirement));
    if (schemes.length === 0) return "none";
    if (schemes.length === 1 && schemes[0] === "cognito") return "cognito";
    if (schemes.length === 1 && schemes[0] === "shareApiKey") return "apiKey";
    return schemes.join("+");
  };
  const routes = new Set();
  for (const [routePath, item] of Object.entries(openApi.paths ?? {})) {
    for (const method of ["get", "put", "post", "delete", "patch", "head", "options"]) {
      if (item[method])
        routes.add(`${method.toUpperCase()} ${routePath} ${authOf(item[method].security ?? openApi.security)}`);
    }
  }
  return routes;
}

/** Returns the number of routes the stack declares. */
async function checkOpenApi(openApi) {
  const openApiPath = path.join(contractsRoot, OPENAPI_FILE);
  if (!openApi) return 0;
  try {
    // validate() resolves the relative $refs into schemas/ and checks the whole document against the OAS 3.1 schema.
    await SwaggerParser.validate(openApiPath);
  } catch (error) {
    addError(`${OPENAPI_FILE}: ${error.message}`);
  }

  let declared;
  try {
    declared = stackRoutes(fs.readFileSync(path.join(platformRoot, USER_API_STACK), "utf8"));
    if (declared.size === 0) throw new Error("found no routes");
  } catch (error) {
    addError(
      `cannot read the routes in ${USER_API_STACK} (${error.message}); update stackRoutes() in contracts/scripts/check-contracts.mjs`,
    );
    return 0;
  }
  const documented = documentedRoutes(openApi);
  for (const route of declared) {
    if (!documented.has(route)) addError(`${OPENAPI_FILE} does not document ${route} from ${USER_API_STACK}`);
  }
  for (const route of documented) {
    if (!declared.has(route)) addError(`${OPENAPI_FILE} documents ${route}, which ${USER_API_STACK} does not declare`);
  }
  return declared.size;
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
  addFormats(ajv);

  const schemas = loadSchemas(ajv);
  const openApi = readJson(path.join(contractsRoot, OPENAPI_FILE));
  addOpenApiComponents(ajv, openApi);
  const fixtures = validateFixtures(ajv, schemas);
  const caseCount = checkCases(ajv, schemas, fixtures);
  checkCrossFieldRules(fixtures);
  checkClientMetadataFixture(ajv, schemas, fixtures);
  checkServiceEnums(schemas);
  const routeCount = await checkOpenApi(openApi);

  if (errors.length > 0) {
    console.error("Contract checks failed:\n");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(
    `Contract checks passed: ${schemas.size} schemas, ${fixtures.size} fixtures, ${caseCount} must-accept and ` +
      `must-reject cases, ${OPENAPI_FILE} (${routeCount} routes).`,
  );
}

await main();
