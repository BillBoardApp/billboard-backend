// Unit checks for website/app.js, the shared-bill page, run without a browser. A wrong "did not become law" on
// a bill that was signed is a public factual error, so the ended note (REL-46 D16, website content review 5.4)
// is checked against faked dates: January 3 before and after noon Eastern, February 1, resolutions, Passed bills,
// and a later Congress. Also the app's action list, the roll-call tallies, Report a problem and the source link.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const appPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../website/app.js");

// Enough of a browser for app.js to load on the landing route; the functions under test touch no page.
const context = vm.createContext({
  URL,
  URLSearchParams,
  Intl,
  console,
  window: { location: { pathname: "/", search: "" } },
  document: {
    getElementById: () => null,
    querySelector: () => null,
    body: { dataset: {} },
    head: null,
  },
  navigator: { userAgent: "node", platform: "", maxTouchPoints: 0 },
});
vm.runInContext(readFileSync(appPath, "utf8"), context, { filename: "website/app.js" });
const app = vm.runInContext(
  "({ endedNote, timelineActions, timelineText, timelineTypeLabel, findIntroduction, chamberTallies, tallySpoken, tallyCaption, reportProblemUrl, billSource, congressGovUrl, STATUS_STAMP_CLASSES })",
  context,
);

// Values from app.js belong to the vm's realm (its own Array and Object), so compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

let checks = 0;
const check = (name, fn) => {
  try {
    fn();
    checks += 1;
  } catch (error) {
    console.error(`test-website-app: ${name}`);
    throw error;
  }
};

const at = (iso) => Date.parse(iso);
const bill = (billType, billStatus, extra = {}) => ({
  identifier: { congress: "119", billType, billNumber: "12" },
  billStatus,
  actions: [],
  ...extra,
});
const BILL_NOTE =
  "The 119th Congress ended on January 3, 2027. This bill did not become law. To move forward it would have to be introduced again.";
const RESOLUTION_NOTE =
  "The 119th Congress ended on January 3, 2027. This resolution was not agreed to. To move forward it would have to be introduced again.";

// Noon Eastern on January 3, 2027 is 17:00 UTC (EST).
const BEFORE_NOON = at("2027-01-03T16:59:59Z");
const NOON = at("2027-01-03T17:00:00Z");
const JAN_31_LATE = at("2027-02-01T04:59:59Z"); // 23:59:59 Eastern on January 31
const FEB_1 = at("2027-02-01T05:00:00Z"); // midnight Eastern on February 1

check("no note before the Congress ends", () => {
  for (const status of ["New", "Updated", "Failed", "Passed"]) {
    assert.equal(app.endedNote(bill("hr", status), at("2026-12-18T12:00:00Z")), "");
    assert.equal(app.endedNote(bill("hr", status), BEFORE_NOON), "");
  }
});

check("New, Updated and Failed bills get the note from noon Eastern on January 3", () => {
  for (const status of ["New", "Updated", "Failed"]) {
    assert.equal(app.endedNote(bill("hr", status), NOON), BILL_NOTE);
    assert.equal(app.endedNote(bill("s", status), FEB_1), BILL_NOTE);
  }
});

check("Passed bills wait until February 1, midnight Eastern", () => {
  assert.equal(app.endedNote(bill("hr", "Passed"), NOON), "");
  assert.equal(app.endedNote(bill("hr", "Passed"), JAN_31_LATE), "");
  assert.equal(app.endedNote(bill("hr", "Passed"), FEB_1), BILL_NOTE);
});

check("a bill that became law never gets the note", () => {
  assert.equal(app.endedNote(bill("hr", "Finalized"), FEB_1), "");
  const signed = { actionDate: "2027-01-05", text: "Signed by President.", type: "President" };
  assert.equal(app.endedNote(bill("hr", "Passed", { actions: [signed] }), FEB_1), "");
  const law = { actionDate: "2027-01-05", text: "Became Public Law No: 119-300.", type: "BecameLaw", actionCode: "36000" };
  assert.equal(app.endedNote(bill("hr", "Updated", { actions: [law] }), NOON), "");
});

check("a bill whose actions show a passage waits like a Passed bill", () => {
  const passage = { actionDate: "2026-12-20", text: "Passed/agreed to in Senate.", type: "Floor", actionCode: "17000" };
  assert.equal(app.endedNote(bill("hr", "Updated", { actions: [passage] }), NOON), "");
  assert.equal(app.endedNote(bill("hr", "Failed", { actions: [passage] }), JAN_31_LATE), "");
  assert.equal(app.endedNote(bill("hr", "Failed", { actions: [passage] }), FEB_1), BILL_NOTE);
  const presented = { actionDate: "2026-12-30", text: "Presented to President.", type: "President" };
  assert.equal(app.endedNote(bill("s", "New", { actions: [presented] }), NOON), "");
});

check("simple and concurrent resolutions: resolution wording, none once agreed to", () => {
  for (const type of ["hres", "sres", "hconres", "sconres", "house-resolution"]) {
    assert.equal(app.endedNote(bill(type, "New"), NOON), RESOLUTION_NOTE);
    assert.equal(app.endedNote(bill(type, "Failed"), NOON), RESOLUTION_NOTE);
    assert.equal(app.endedNote(bill(type, "Passed"), NOON), "");
    assert.equal(app.endedNote(bill(type, "Passed"), FEB_1), "");
    assert.equal(app.endedNote(bill(type, "New"), BEFORE_NOON), "");
  }
});

check("joint resolutions can become law, so they follow the bill rule in their own words", () => {
  const note = BILL_NOTE.replace("This bill", "This joint resolution");
  assert.equal(app.endedNote(bill("hjres", "New"), NOON), note);
  assert.equal(app.endedNote(bill("sjres", "Passed"), NOON), "");
  assert.equal(app.endedNote(bill("sjres", "Passed"), FEB_1), note);
});

check("a proposed constitutional amendment never 'did not become law'", () => {
  const amendment = (status, extra = {}) =>
    bill("hjres", status, { officialTitle: "Proposing an amendment to the Constitution of the United States relative to the length of terms.", ...extra });
  const note =
    "The 119th Congress ended on January 3, 2027. This proposed amendment did not pass Congress. To move forward it would have to be introduced again.";
  assert.equal(app.endedNote(amendment("New"), NOON), note);
  assert.equal(app.endedNote(amendment("Failed"), FEB_1), note);
  assert.equal(app.endedNote(amendment("Passed"), NOON), "");
  assert.equal(app.endedNote(amendment("Passed"), FEB_1), "");
  assert.equal(app.endedNote(bill("sjres", "Passed", { title: "Proposing an amendment to the Constitution" }), FEB_1), "");
});

check("the text comes from the Congress number, so later Congresses work too", () => {
  const later = { identifier: { congress: "120", billType: "s", billNumber: "4" }, billStatus: "New" };
  assert.equal(app.endedNote(later, at("2027-06-01T12:00:00Z")), "");
  assert.equal(app.endedNote(later, at("2029-01-03T16:59:59Z")), "");
  assert.equal(
    app.endedNote(later, at("2029-01-03T17:00:00Z")),
    "The 120th Congress ended on January 3, 2029. This bill did not become law. To move forward it would have to be introduced again.",
  );
  const first = { identifier: { congress: "121", billType: "hr", billNumber: "1" }, billStatus: "New" };
  assert.equal(
    app.endedNote(first, at("2031-01-03T17:00:00Z")),
    "The 121st Congress ended on January 3, 2031. This bill did not become law. To move forward it would have to be introduced again.",
  );
});

check("no note when the status, the type or the Congress is unknown", () => {
  assert.equal(app.endedNote(bill("hr", ""), FEB_1), "");
  assert.equal(app.endedNote(bill("hr", "Pending"), FEB_1), "");
  assert.equal(app.endedNote(bill("xyz", "New"), FEB_1), "");
  assert.equal(app.endedNote({ identifier: { congress: "abc", billType: "hr" }, billStatus: "New" }, FEB_1), "");
  assert.equal(app.endedNote({ identifier: { congress: "73", billType: "hr" }, billStatus: "New" }, FEB_1), "");
  assert.equal(app.endedNote(null, FEB_1), "");
});

check("only outcomes are stamped", () => {
  assert.deepEqual(plain(Object.keys(app.STATUS_STAMP_CLASSES).sort()), ["Failed", "Finalized", "Passed"]);
});

check("actions as the app lists them: oldest first, each once, no raw codes", () => {
  const actions = [
    { actionCode: "8000", actionDate: "2026-02-27", text: "On passage Passed by the Yeas and Nays: 231 - 196.", type: "Floor" },
    { actionCode: "H8D000", actionDate: "2026-02-27", text: "On passage Passed by the Yeas and Nays: 231 - 196.", type: "Floor" },
    { actionCode: "H11100", actionDate: "2026-02-10", text: "Referred to the House Committee on Energy and Commerce.", type: "IntroReferral" },
    { actionDate: "2026-02-10", text: "Introduced in House", type: "IntroReferral" },
    { actionDate: "2026-02-10", type: "IntroReferral" },
    { actionDate: "2026-02-12", type: "Committee" },
    { actionDate: "2026-02-13", type: "SomethingNew" },
  ];
  const timeline = app.timelineActions(actions);
  assert.deepEqual(
    plain(timeline.map((action) => app.timelineText(action))),
    [
      "Introduced in House",
      "Referred to the House Committee on Energy and Commerce.",
      "Committee action",
      "On passage Passed by the Yeas and Nays: 231 - 196.",
    ],
  );
  assert.deepEqual(
    plain(timeline.map((action) => app.timelineTypeLabel(action))),
    ["Introduced and referred", "Introduced and referred", null, "Floor action"],
  );
  assert.equal(app.findIntroduction(actions).actionDate, "2026-02-10");
  assert.equal(app.timelineActions(undefined).length, 0);
});

check("roll calls are worded as the app words them", () => {
  const tallies = app.chamberTallies({
    senate: { yea: 60, nay: 40, present: 0, notVoting: 0, resultText: "Bill Passed" },
    house: { yea: 1231, nay: 196, present: 2, notVoting: 6, resultText: "Passed" },
  });
  assert.deepEqual(
    plain(tallies.map((tally) => tally.chamber)),
    ["House", "Senate"],
  );
  assert.equal(app.tallySpoken(tallies[0]), "House: 1,231 Yea, 196 Nay, 2 present, 6 not voting. Passed.");
  assert.equal(app.tallyCaption(tallies[0]), "2 present · 6 not voting");
  assert.equal(app.chamberTallies({ house: { yea: "1", nay: 2 } }).length, 0);
  assert.equal(app.chamberTallies(undefined).length, 0);
});

check("Report a problem names the bill, as the app's ReportProblem does", () => {
  const url = app.reportProblemUrl({
    identifier: { congress: "119", billType: "hr", billNumber: "1285" },
    title: "Clean Energy Access Act & more",
    guid: "BILLS-119hr1285ih",
  });
  assert.equal(
    url,
    "mailto:contact@billboard-project.com?subject=Report%20a%20problem%3A%20H.R.%201285%2C%20Clean%20Energy%20Access%20Act%20%26%20more&body=Bill%20ID%3A%20BILLS-119hr1285ih%0D%0A%0D%0A",
  );
  assert.equal(app.reportProblemUrl({}), "mailto:contact@billboard-project.com?subject=Report%20a%20problem");
});

check("the source is Congress.gov from link, else GovInfo from the guid, https only", () => {
  assert.deepEqual(plain(app.billSource({ link: "https://www.congress.gov/bill/119th-congress/house-bill/1285" })), {
    href: "https://www.congress.gov/bill/119th-congress/house-bill/1285",
    label: "Read the bill on Congress.gov",
  });
  assert.deepEqual(plain(app.billSource({ link: "javascript:alert(1)", guid: "BILLS-119hr1285ih" })), {
    href: "https://www.govinfo.gov/app/details/BILLS-119hr1285ih",
    label: "Read the bill on GovInfo",
  });
  assert.equal(app.billSource({ link: "https://example.com/x" }), null);
  assert.equal(
    app.congressGovUrl({ congress: "119", billType: "sconres", billNumber: "7" }),
    "https://www.congress.gov/bill/119th-congress/senate-concurrent-resolution/7",
  );
  assert.equal(app.congressGovUrl({ congress: "119", billType: "zz", billNumber: "7" }), "");
});

console.log(`test-website-app: ok (${checks} checks)`);
