// The shared-bill page (/b/<guid>, /share/<guid>, /?guid=<guid>) and the landing page's routing.
//
// What the page shows is official data first, then the AI-written text in one labelled block. It never
// shows Billboard users' votes or results (INT-11: the public response carries none), the AI's theme
// scores (`civicProfile`) or the In the news fields (`isPriority`, `priorityRank`, `priorityReason`),
// even though the public response carries the last two.
//
// Labels copied from the app (Billboard/Billboard in billboard-ios, app 1.2) say where they come from,
// so a change there can be found here.

const byId = (id) => document.getElementById(id);
const APP_OPEN_URL_PREFIX = "billboard://bill?guid=";
// ContactUs.address in Features/Profile/ContactUs.swift.
const CONTACT_ADDRESS = "contact@billboard-project.com";

const setVisible = (id, visible) => {
  const el = byId(id);
  if (!el) return;
  el.classList.toggle("hidden", !visible);
};

const text = (value) => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const escapeHtml = (value) =>
  text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const safeArray = (value) => (Array.isArray(value) ? value : []);

const normalizePathname = (path) => path.replace(/\/+$/, "") || "/";

const parseRoute = () => {
  const path = normalizePathname(window.location.pathname);
  const match = path.match(/^\/(?:b|share)\/([^/]+)$/);
  if (match && match[1]) {
    return {
      mode: "share",
      guid: decodeURIComponent(match[1]),
    };
  }

  const params = new URLSearchParams(window.location.search);
  const guid = text(params.get("guid"));
  if (guid) {
    return {
      mode: "share",
      guid,
    };
  }

  return {
    mode: "landing",
    guid: "",
  };
};

// The shared bill's title and description in the browser. Link previewers do not run this script, so
// the static tags in index.html are what a shared link previews as; they are written to fit a shared
// bill as well as the home page. The landing page keeps index.html's own title and description.
const setPageMetadata = ({ title, description }) => {
  if (title) document.title = title;
  const target = document.querySelector('meta[name="description"]');
  if (target && description) target.setAttribute("content", description);
};

// Share views stay out of search results (website review O12). A static noindex in index.html would
// hide the home page too, and robots.txt keeps /b/ open so link previewers that obey it still work.
const addNoindex = () => {
  if (document.querySelector('meta[name="robots"]')) return;
  const meta = document.createElement("meta");
  meta.name = "robots";
  meta.content = "noindex";
  document.head?.append(meta);
};

// identifier.billType arrives either as the congress.gov abbreviation ("sjres")
// or as its URL slug ("senate-joint-resolution"); both map to the same label.
const BILL_TYPE_LABELS = {
  hr: "H.R.",
  s: "S.",
  hjres: "H.J.Res.",
  sjres: "S.J.Res.",
  hconres: "H.Con.Res.",
  sconres: "S.Con.Res.",
  hres: "H.Res.",
  sres: "S.Res.",
};

const BILL_TYPE_SLUGS = {
  "house-bill": "hr",
  "senate-bill": "s",
  "house-joint-resolution": "hjres",
  "senate-joint-resolution": "sjres",
  "house-concurrent-resolution": "hconres",
  "senate-concurrent-resolution": "sconres",
  "house-resolution": "hres",
  "senate-resolution": "sres",
};

// "hr" -> "house-bill": the type's part of a Congress.gov bill URL.
const CONGRESS_GOV_SLUGS = Object.fromEntries(Object.entries(BILL_TYPE_SLUGS).map(([slug, code]) => [code, slug]));

// Simple and concurrent resolutions never go to the President, so they never become law.
const RESOLUTION_TYPES = new Set(["hres", "sres", "hconres", "sconres"]);
const JOINT_RESOLUTION_TYPES = new Set(["hjres", "sjres"]);

// "HR", "hr" or "house-bill" -> "hr". Unknown types come back lowercased.
const normalizeBillType = (value) => {
  const billType = text(value).toLowerCase().replace(/[.\s]/g, "");
  return BILL_TYPE_SLUGS[billType] || billType;
};

// "hr" + "1" -> "H.R. 1"; "sjres" + "213" -> "S.J.Res. 213".
const formatBillNumber = (identifier) => {
  const abbreviation = normalizeBillType(identifier?.billType);
  const billNumber = text(identifier?.billNumber);
  if (!abbreviation || !billNumber) return "";
  const label = BILL_TYPE_LABELS[abbreviation] || abbreviation.toUpperCase();
  return `${label} ${billNumber}`;
};

const BILL_GUID_PREFIX = "BILLS-";
// Longer type codes come first, so "hres" is never read as "hr". The trailing letters are the
// text-version suffix ("ih", "is", "enr"), which the plain guid drops.
const BILL_GUID_PATTERN = /^BILLS-(\d+)(hconres|hjres|hres|hr|sconres|sjres|sres|s)(\d+)([a-z]*)$/;

// "BILLS-119hr1285ih" -> { congress: "119", billType: "hr", billNumber: "1285",
// plainGuid: "BILLS-119hr1285", suffix: "ih" }; null for anything that is not a bill guid.
const parseBillGuid = (guid) => {
  const raw = text(guid);
  if (!raw.startsWith(BILL_GUID_PREFIX)) return null;
  const match = `${BILL_GUID_PREFIX}${raw.slice(BILL_GUID_PREFIX.length).toLowerCase()}`.match(
    BILL_GUID_PATTERN,
  );
  if (!match) return null;
  const [, congress, billType, billNumber, suffix] = match;
  return {
    congress,
    billType,
    billNumber,
    plainGuid: `${BILL_GUID_PREFIX}${congress}${billType}${billNumber}`,
    suffix,
  };
};

// "BILLS-119s570" -> "S. 570"; "BILLS-119hconres82ih" -> "H.Con.Res. 82"; "" when not a bill guid.
const formatBillNumberFromGuid = (guid) => {
  const parsed = parseBillGuid(guid);
  return parsed ? formatBillNumber(parsed) : "";
};

const chamberOfBillType = (billType) => (billType.startsWith("h") ? "House" : "Senate");

// The plain guids that name this page's bill: the guid in the URL, the served guid, and the one
// built from its identifier. Any of them may carry a text-version suffix or be missing.
const ownPlainGuids = (bill, requestedGuid) => {
  const identifier = bill?.identifier;
  const fromIdentifier = `${BILL_GUID_PREFIX}${text(identifier?.congress)}${normalizeBillType(
    identifier?.billType,
  )}${text(identifier?.billNumber)}`;
  return new Set(
    [requestedGuid, bill?.guid, fromIdentifier]
      .map(parseBillGuid)
      .filter(Boolean)
      .map((parsed) => parsed.plainGuid),
  );
};

// companionGroup (APPF-23) is served only for a bill with an identical bill in the other chamber,
// and names every member by plain guid. Returns the other members, each once, as
// { guid, chamber, number }; [] when the bill is not grouped, when no member is this bill, or when a
// member guid does not parse (that member is skipped).
const describeCompanions = (companionGroup, ownGuids) => {
  const members = safeArray(companionGroup?.memberGuids).map(parseBillGuid).filter(Boolean);
  if (!members.some((member) => ownGuids.has(member.plainGuid))) return [];

  const seen = new Set(ownGuids);
  return members
    .filter((member) => {
      if (seen.has(member.plainGuid)) return false;
      seen.add(member.plainGuid);
      return true;
    })
    .map((member) => ({
      guid: member.plainGuid,
      chamber: chamberOfBillType(member.billType),
      number: formatBillNumberFromGuid(member.plainGuid),
    }));
};

// The text before the companion's number: "Also introduced in the Senate as " + "S. 570".
// renderCompanions links the number to the companion's own share page.
const companionSentencePrefix = (companion) => `Also introduced in the ${companion.chamber} as `;

const ordinal = (value) => {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
};

// The Congress as a number, or null when the identifier does not give one.
const congressNumber = (identifier) => {
  const congress = text(identifier?.congress);
  return /^\d+$/.test(congress) ? Number(congress) : null;
};

// "119" -> "119th Congress".
const formatCongress = (identifier) => {
  const congress = congressNumber(identifier);
  return congress ? `${ordinal(congress)} Congress` : "";
};

// The bill on Congress.gov, built from its Congress, type and number:
// https://www.congress.gov/bill/119th-congress/house-bill/1285. "" when one of them is unknown.
const congressGovUrl = ({ congress, billType, billNumber }) => {
  const number = Number(congress);
  const slug = CONGRESS_GOV_SLUGS[normalizeBillType(billType)];
  const bill = text(billNumber);
  if (!Number.isInteger(number) || number < 1 || !slug || !/^\d+$/.test(bill)) return "";
  return `https://www.congress.gov/bill/${ordinal(number)}-congress/${slug}/${bill}`;
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// congress.gov action dates are calendar dates ("2026-02-27"); committee
// activity dates are UTC timestamps. Format calendar dates in UTC so they do
// not shift back a day, and timestamps in Washington time.
const formatDate = (value) => {
  const raw = text(value);
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: DATE_ONLY_PATTERN.test(raw) ? "UTC" : "America/New_York",
  }).format(date);
};

const joinList = (values) => safeArray(values).map(text).filter(Boolean).join(", ");

// Former topic names (LLM-10) and the names they became; mirrors LEGACY_SUB_CATEGORY_ALIASES in
// services/src/models/categories.ts. A bill not yet relabelled, or a share response CloudFront still
// caches, can carry a former name; it is shown under the current one, once. Remove once no stored bill or
// cached share response carries a former name.
const LEGACY_TOPIC_NAMES = {
  "Social Justice": "Civil Rights and Liberties",
  "Identity Politics": "Heritage and Identity",
};

const currentTopicName = (value) =>
  Object.prototype.hasOwnProperty.call(LEGACY_TOPIC_NAMES, value) ? LEGACY_TOPIC_NAMES[value] : value;

const topicList = (values) =>
  joinList([...new Set(safeArray(values).map(text).filter(Boolean).map(currentTopicName))]);

// ---------- Actions, as the app lists them (Domain/Utils/BillDisplayFormatting.swift) ----------

// actionTypeLabel: a plain label for a Congress.gov action type; null for an empty or unknown type,
// so internal codes such as "IntroReferral" are never shown raw.
const ACTION_TYPE_LABELS = {
  introreferral: "Introduced and referred",
  committee: "Committee action",
  calendars: "Placed on calendar",
  floor: "Floor action",
  discharge: "Discharged from committee",
  president: "Sent to the President",
  becamelaw: "Became law",
  veto: "Veto",
  resolvingdifferences: "Resolving differences",
};

const actionTypeLabel = (rawType) => {
  const key = text(rawType)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return key && Object.prototype.hasOwnProperty.call(ACTION_TYPE_LABELS, key) ? ACTION_TYPE_LABELS[key] : null;
};

const actionDate = (action) => text(action?.actionDate);

// timelineText: an action's own text, or its type label when it has none; null when it has neither.
const timelineText = (action) => text(action?.text) || actionTypeLabel(action?.type);

// timelineTypeLabel: the label under an action's line; null when the line already is the label.
const timelineTypeLabel = (action) => (text(action?.text) ? actionTypeLabel(action?.type) : null);

// timelineActions: oldest first, without a repeat of the same date and text (several sources give them).
// An action without text is listed by its type label only when no action with text shares its date
// (Congress.gov gives an Intro-S IntroReferral action no text beside the Senate's own introduction line).
const timelineActions = (actions) => {
  const list = safeArray(actions).filter((action) => action && typeof action === "object");
  const datesWithText = new Set(list.filter((action) => text(action.text)).map(actionDate));
  const newestFirst = [...list].sort((a, b) => {
    const da = actionDate(a);
    const db = actionDate(b);
    if (da !== db) return da > db ? -1 : 1;
    const ta = typeof a.text === "string" ? a.text : "";
    const tb = typeof b.text === "string" ? b.text : "";
    if (ta === tb) return 0;
    return ta > tb ? -1 : 1;
  });

  const seen = new Set();
  const out = [];
  newestFirst.forEach((action) => {
    const date = actionDate(action);
    if (!text(action.text) && datesWithText.has(date)) return;
    const line = timelineText(action);
    if (!line) return;
    const key = `${date}|${line.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(action);
  });
  return out.reverse();
};

// The introduction: Congress.gov's "Introduced in House" or "Introduced in Senate" line, else the first
// introduction-and-referral action. Null when the bill has neither.
const findIntroduction = (actions) => {
  const timeline = timelineActions(actions);
  return (
    timeline.find((action) => /^introduced in (the )?(house|senate)\b/i.test(text(action.text))) ||
    timeline.find((action) => actionTypeLabel(action.type) === ACTION_TYPE_LABELS.introreferral) ||
    null
  );
};

// ---------- Ended note (REL-46 D16; website review 5.4) ----------

// A Congress's two years end at noon Eastern on January 3 of the odd year after them (20th Amendment,
// from the 74th Congress on): the 119th ends on 2027-01-03 at 12:00 EST, which is 17:00 UTC.
const FIRST_JANUARY_CONGRESS = 74;
const congressEndYear = (congress) => 1789 + 2 * congress;
const congressEndTime = (congress) => Date.UTC(congressEndYear(congress), 0, 3, 17);
// Passed bills wait until February 1 of that year, at midnight Eastern (05:00 UTC). Bills passed in late
// December are signed in early January, and the actions that make them Became law come later still,
// so before then a Passed bill may already be law.
const passedHoldTime = (congress) => Date.UTC(congressEndYear(congress), 1, 1, 5);

const ENDED_NOTE_STATUSES = new Set(["New", "Updated", "Passed", "Failed"]);

// A joint resolution proposing a constitutional amendment goes to the states, not the President, so it never
// "becomes law": once Congress passes it, it is finished there.
const proposesConstitutionalAmendment = (bill) =>
  /\bamendment to the constitution\b/i.test(`${text(bill?.officialTitle)} ${text(bill?.title)}`);

// Action codes 8000 and 17000 are a passage in the House and the Senate (RUNBOOK 4.11).
const PASSAGE_CODES = new Set(["8000", "17000"]);

// Actions that say the bill became law, even when its status does not yet.
const actionsShowLaw = (actions) =>
  safeArray(actions).some((action) => {
    const type = text(action?.type).toLowerCase();
    const line = text(action?.text);
    return (
      type === "becamelaw" ||
      text(action?.actionCode) === "36000" ||
      /became (public|private) law/i.test(line) ||
      /signed by (the )?president/i.test(line)
    );
  });

// Actions that show the bill passed a chamber or reached the President, whatever its status says.
const actionsShowPassage = (actions) =>
  safeArray(actions).some((action) => {
    const type = text(action?.type).toLowerCase();
    return PASSAGE_CODES.has(text(action?.actionCode)) || type === "president" || type === "veto";
  });

// The note for a bill whose Congress has ended without it becoming law, or "" for none:
// "The 119th Congress ended on January 3, 2027. This bill did not become law. To move forward it would
// have to be introduced again." It is held when in doubt, because a wrong "did not become law" on a
// bill that was signed is a public factual error:
// - before the Congress's end, for a bill that became law, and for a status the page does not know;
// - for a Passed bill (or one whose actions show a passage) until February 1 of the end year;
// - for a passed simple or concurrent resolution, which is finished and never becomes law;
// - for a passed joint resolution proposing a constitutional amendment, which goes to the states instead.
const endedNote = (bill, now = Date.now()) => {
  const congress = congressNumber(bill?.identifier);
  const billType = normalizeBillType(bill?.identifier?.billType);
  const status = text(bill?.billStatus);
  if (!congress || congress < FIRST_JANUARY_CONGRESS || !BILL_TYPE_LABELS[billType]) return "";
  if (!ENDED_NOTE_STATUSES.has(status) || now < congressEndTime(congress)) return "";
  if (actionsShowLaw(bill?.actions)) return "";

  const passed = status === "Passed" || actionsShowPassage(bill?.actions);
  const ended = `The ${ordinal(congress)} Congress ended on January 3, ${congressEndYear(congress)}.`;
  const again = "To move forward it would have to be introduced again.";
  if (RESOLUTION_TYPES.has(billType)) {
    return passed ? "" : `${ended} This resolution was not agreed to. ${again}`;
  }
  if (JOINT_RESOLUTION_TYPES.has(billType) && proposesConstitutionalAmendment(bill)) {
    return passed ? "" : `${ended} This proposed amendment did not pass Congress. ${again}`;
  }
  if (passed && now < passedHoldTime(congress)) return "";
  const kind = JOINT_RESOLUTION_TYPES.has(billType) ? "joint resolution" : "bill";
  return `${ended} This ${kind} did not become law. ${again}`;
};

// The 1.3 app's stamp for a past Congress's bill: "Ended with the 119th Congress".
const endedStampWord = (bill) => `Ended with the ${ordinal(congressNumber(bill?.identifier))} Congress`;

// ---------- Loading ----------

class BillLoadError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

const fetchBill = async (guid) => {
  const res = await fetch(`/public/processed-bill?guid=${encodeURIComponent(guid)}`);
  if (!res.ok) {
    throw new BillLoadError(res.status);
  }

  const bill = await res.json();
  if (!bill || typeof bill !== "object") {
    throw new Error("Unexpected payload format");
  }

  return bill;
};

// ---------- Front matter ----------

// The status as both apps label it: Finalized (the bill became law, REL-44) reads "Became law".
const statusLabel = (value) => {
  const status = text(value);
  return status === "Finalized" ? "Became law" : status;
};

// The stamp's look (Civic Record spec 3.2): the colour carries the meaning, the word says it. Only the
// bill's outcomes are stamped: "New" and "Updated" describe Billboard's feed, not the bill (a 2025 bill
// still in committee reads "New"), so for those the page shows the latest action instead.
const STATUS_STAMP_CLASSES = {
  Passed: "stamp-passed",
  Failed: "stamp-failed",
  Finalized: "stamp-became-law",
};

// Shows a stamp at the docket line's trailing edge. `spokenPrefix` is read by screen readers only
// ("Status: "), so the word is not run into the docket text before it.
const renderStamp = (word, stampClass, spokenPrefix = "") => {
  const stamp = byId("bill-stamp");
  if (!stamp || !word) return;
  stamp.className = ["stamp", stampClass].filter(Boolean).join(" ");
  stamp.replaceChildren();
  if (spokenPrefix) {
    const prefix = document.createElement("span");
    prefix.className = "visually-hidden";
    prefix.textContent = spokenPrefix;
    stamp.append(prefix);
  }
  stamp.append(word);
  setVisible("bill-docket", true);
};

// The docket line (spec 3.1): "H.R. 1285 · House · 119th Congress", the number in ink 2, with the
// stamp at the trailing edge. When the bill has no official title its number is the heading, so the
// docket line leaves the number out. Built from text nodes, never markup.
const renderDocket = (bill, { numberIsHeading, ended }) => {
  const target = byId("bill-number");
  if (!target) return;

  const identifier = bill?.identifier;
  const abbreviation = normalizeBillType(identifier?.billType);
  const billNumber = numberIsHeading ? "" : formatBillNumber(identifier);
  const chamber = BILL_TYPE_LABELS[abbreviation] && text(identifier?.billNumber) ? chamberOfBillType(abbreviation) : "";
  const rest = [chamber, formatCongress(identifier)].filter(Boolean);

  target.replaceChildren();
  if (billNumber) {
    const number = document.createElement("span");
    number.className = "docket-number";
    number.textContent = billNumber;
    target.append(number);
  }
  if (rest.length) {
    target.append(`${billNumber ? " · " : ""}${rest.join(" · ")}`);
  }

  const status = text(bill?.billStatus);
  if (Object.prototype.hasOwnProperty.call(STATUS_STAMP_CLASSES, status)) {
    renderStamp(statusLabel(status), STATUS_STAMP_CLASSES[status], "Status: ");
  } else if (ended) {
    renderStamp(endedStampWord(bill), "stamp-dim stamp-wrap", "Status: ");
  }

  if (billNumber || rest.length) setVisible("bill-docket", true);
};

// The heading: the bill's official title, or its number when the record has none (older records, such
// as H.R. 1285's, carry no officialTitle). The AI headline is never moved here: it stays in the
// labelled AI block.
const renderHeading = (bill) => {
  const heading = byId("bill-title");
  const officialTitle = text(bill?.officialTitle);
  const billNumber = formatBillNumber(bill?.identifier);
  if (!heading) return { numberIsHeading: false, heading: "" };

  if (officialTitle) {
    heading.textContent = officialTitle;
    heading.classList.add("bill-title-official");
    return { numberIsHeading: false, heading: officialTitle };
  }
  heading.textContent = billNumber || "Shared bill";
  return { numberIsHeading: Boolean(billNumber), heading: billNumber };
};

// "Last updated Mar 6, 2026 · 3:00 PM" from storedAt, in the reader's time zone, as the app's bill page
// shows it (BillFrontMatter.lastUpdatedText). A no-break space keeps the "·" at the end of a line.
const renderLastUpdated = (bill) => {
  const target = byId("bill-updated");
  const raw = text(bill?.storedAt);
  if (!target || !raw) return;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return;

  const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(date);
  target.textContent = `Last updated ${day} · ${time}`;
  setVisible("bill-updated", true);
};

const renderEndedNote = (note) => {
  const target = byId("bill-ended");
  if (!target || !note) return;
  target.textContent = note;
  setVisible("bill-ended", true);
};

// ---------- The AI block ----------

const ledgerRows = (rows) =>
  rows
    .map(
      ([label, value]) =>
        `<div class="ledger-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join("");

// Report a problem (Features/Bills/BillAINote.swift, ReportProblem): an email whose subject names the
// bill's number and title, "Report a problem: H.R. 1234, Clean Energy Reporting Act", with its ID in the
// body, "Bill ID: BILLS-119hr1234ih".
const reportProblemUrl = (bill) => {
  const name = [formatBillNumber(bill?.identifier), text(bill?.title) || text(bill?.officialTitle)]
    .filter(Boolean)
    .join(", ");
  const subject = name ? `Report a problem: ${name}` : "Report a problem";
  const guid = text(bill?.guid);
  const fields = [`subject=${encodeURIComponent(subject)}`];
  if (guid) fields.push(`body=${encodeURIComponent(`Bill ID: ${guid}\r\n\r\n`)}`);
  return `mailto:${CONTACT_ADDRESS}?${fields.join("&")}`;
};

const renderBreakdown = (breakdown) => {
  const list = byId("breakdown-list");
  if (!list || !breakdown || typeof breakdown !== "object") return false;

  // BillDisplayFormatting.breakdownRows: only the fields with text.
  const fields = [
    ["Who", breakdown.who],
    ["What", breakdown.what],
    ["How", breakdown.how],
    ["When", breakdown.when],
    ["Where", breakdown.where],
    ["Why", breakdown.why],
  ].filter(([, value]) => text(value));

  if (!fields.length) return false;
  list.innerHTML = ledgerRows(fields);
  setVisible("bill-breakdown", true);
  return true;
};

// Topics and life areas are assigned by the AI too, so they sit inside its block.
const renderAiTags = (bill) => {
  const list = byId("ai-tags");
  if (!list) return false;
  const rows = [
    ["Topics", topicList(bill?.subCategories)],
    ["Life areas", joinList(bill?.lifeAreas)],
  ].filter(([, value]) => value);
  if (!rows.length) return false;
  list.innerHTML = ledgerRows(rows);
  setVisible("ai-tags", true);
  return true;
};

// The headline, Why it matters, the Breakdown, the Summary, the topics and life areas: all written or
// assigned by the AI, shown as one block under the app's line, "Written with AI from the official text ·
// Report a problem" (BillAINote.text, ReportProblem.title).
const renderAiBlock = (bill) => {
  const headline = text(bill?.title);
  const soWhat = text(bill?.soWhat);
  // Kept on purpose: `summary` is optional in processed-bill.v1.schema.json, but no services writer
  // sets it yet (billSummarizer's buildProcessedBill omits it), so real bills leave it hidden. Only the
  // contracts fixture exercises it.
  const summary = text(bill?.summary);
  let shown = false;

  if (headline) {
    byId("bill-headline").textContent = headline;
    setVisible("bill-headline", true);
    shown = true;
  }
  if (soWhat) {
    byId("bill-so-what").textContent = soWhat;
    setVisible("bill-overview", true);
    shown = true;
  }
  if (renderBreakdown(bill?.billBreakdown)) shown = true;
  if (summary) {
    byId("bill-summary-text").textContent = summary;
    setVisible("bill-summary", true);
    shown = true;
  }
  if (renderAiTags(bill)) shown = true;

  const report = byId("report-problem-link");
  if (report) report.href = reportProblemUrl(bill);
  setVisible("bill-ai", shown);
};

// ---------- Where it stands, How Congress voted, Committees, Actions, Source ----------

const actionLine = (action) => {
  const line = timelineText(action);
  const date = formatDate(action?.actionDate);
  return date ? `${line} (${date})` : line;
};

// The introduction's date and the latest action in Congress's own words, with its date. The status
// word is the docket line's stamp, so it is not repeated here.
const renderStanding = (bill) => {
  const list = byId("standing-list");
  if (!list) return;
  const timeline = timelineActions(bill?.actions);
  const introduction = findIntroduction(bill?.actions);
  const latest = timeline.length ? timeline[timeline.length - 1] : null;

  const rows = [
    ["Introduced", introduction ? formatDate(introduction.actionDate) : ""],
    ["Latest action", latest ? actionLine(latest) : ""],
  ].filter(([, value]) => value);
  if (!rows.length) return;

  list.innerHTML = ledgerRows(rows);
  setVisible("bill-standing", true);
};

const formatCount = (value) => new Intl.NumberFormat("en-US").format(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;

// CongressChamberTally (Features/Bills/BillDetailStatsSections.swift): each chamber's roll call, the
// House's first. Official Congress data, not Billboard users' votes, so it is never sealed.
const chamberTallies = (officialVotes) =>
  [
    ["House", officialVotes?.house],
    ["Senate", officialVotes?.senate],
  ]
    .filter(([, vote]) => vote && isCount(vote.yea) && isCount(vote.nay))
    .map(([chamber, vote]) => ({
      chamber,
      yea: vote.yea,
      nay: vote.nay,
      present: isCount(vote.present) ? vote.present : null,
      notVoting: isCount(vote.notVoting) ? vote.notVoting : null,
      result: text(vote.resultText),
    }));

// "2 present · 6 not voting" (CongressChamberTally.otherCaption); "" without both figures.
const tallyCaption = (tally) =>
  tally.present !== null && tally.notVoting !== null
    ? `${formatCount(tally.present)} present · ${formatCount(tally.notVoting)} not voting`
    : "";

// "House: 231 Yea, 196 Nay, 2 present, 6 not voting. Passed." (CongressChamberTally.accessibilityLabel).
const tallySpoken = (tally) => {
  const parts = [`${formatCount(tally.yea)} Yea`, `${formatCount(tally.nay)} Nay`];
  if (tally.present !== null) parts.push(`${formatCount(tally.present)} present`);
  if (tally.notVoting !== null) parts.push(`${formatCount(tally.notVoting)} not voting`);
  const result = tally.result ? ` ${tally.result.replace(/[.!?]?$/, ".")}` : "";
  return `${tally.chamber}: ${parts.join(", ")}.${result}`;
};

const element = (tag, className, textContent) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (textContent !== undefined) el.textContent = textContent;
  return el;
};

// A chamber's roll call as the app's phone form draws it: "✓ YEA" and "✕ NAY" over a heavy rule, the
// chamber with its figures, the split bar with its 50% tick, "2 PRESENT · 6 NOT VOTING" and the result.
// The drawing is hidden from screen readers, which read the app's one sentence instead. Built from DOM
// nodes; the bar's widths are set through element.style, which the CSP allows.
const tallyBlock = (tally) => {
  const block = element("div", "tally");
  block.append(element("p", "visually-hidden", tallySpoken(tally)));

  const sheet = element("div", "tally-sheet");
  sheet.setAttribute("aria-hidden", "true");
  const head = element("div", "tally-head");
  head.append(element("span"), element("span", "tally-yea", "✓ Yea"), element("span", "tally-nay", "✕ Nay"));
  const row = element("div", "tally-row");
  row.append(
    element("span", "tally-chamber", tally.chamber),
    element("span", "tally-figure", formatCount(tally.yea)),
    element("span", "tally-figure", formatCount(tally.nay)),
  );
  const bar = element("div", "tally-bar");
  const total = tally.yea + tally.nay;
  if (total > 0) {
    const yea = element("span", "tally-bar-yea");
    yea.style.width = `${(tally.yea / total) * 100}%`;
    const nay = element("span", "tally-bar-nay");
    nay.style.width = `${(tally.nay / total) * 100}%`;
    bar.append(yea, nay);
  }
  sheet.append(head, row, bar);
  const caption = tallyCaption(tally);
  if (caption) sheet.append(element("p", "tally-caption docket", caption));
  if (tally.result) sheet.append(element("p", "tally-result", tally.result));
  block.append(sheet);
  return block;
};

const renderOfficialVotes = (bill) => {
  const target = byId("votes-list");
  if (!target) return;
  const tallies = chamberTallies(bill?.officialVotes);
  if (!tallies.length) return;
  target.replaceChildren(...tallies.map(tallyBlock));
  setVisible("bill-votes", true);
};

// BillCommitteesSection.rows: the chamber as the label, the committee, and what it did with the date,
// each activity once.
const renderCommittees = (committees) => {
  const list = byId("committee-list");
  if (!list) return;

  const safeCommittees = safeArray(committees);
  if (!safeCommittees.length) return;

  // A ledger (spec 3.6): the chamber as the label, the committee and its activities as the answer.
  list.innerHTML = safeCommittees
    .map((committee) => {
      const chamber = text(committee?.chamber);
      const name = text(committee?.name) || "Committee";

      const seen = new Set();
      const activities = safeArray(committee?.activities)
        .map((activity) => {
          const activityName = text(activity?.name);
          if (!activityName || seen.has(activityName.toLowerCase())) return "";
          seen.add(activityName.toLowerCase());
          const activityDate = formatDate(activity?.date);
          return activityDate ? `${activityName} (${activityDate})` : activityName;
        })
        .filter(Boolean);

      const detail = activities.length
        ? `<span class="ledger-note">${activities.map((item) => escapeHtml(item)).join(" · ")}</span>`
        : "";
      return `<div class="ledger-row"><dt>${escapeHtml(chamber || "Committee")}</dt><dd>${escapeHtml(
        name,
      )}${detail}</dd></div>`;
    })
    .join("");

  setVisible("bill-committees", true);
};

// BillActionsSection: oldest first, each once, in Congress's words; the plain type label under it,
// never a raw code.
const renderActions = (actions) => {
  const list = byId("actions-list");
  if (!list) return;

  const timeline = timelineActions(actions);
  if (!timeline.length) return;

  // A ledger (spec 3.6): the date as the label, the action and its type as the answer.
  list.innerHTML = timeline
    .map((action) => {
      // BillActionsSection.undatedLabel.
      const date = formatDate(action?.actionDate) || "No date";
      const type = timelineTypeLabel(action);
      return `<div class="ledger-row"><dt>${escapeHtml(date)}</dt><dd>${escapeHtml(timelineText(action))}${
        type ? `<span class="ledger-note">${escapeHtml(type)}</span>` : ""
      }</dd></div>`;
    })
    .join("");

  setVisible("bill-actions", true);
};

const isHost = (url, domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`);

// The bill's own page: `link` (Congress.gov), else the bill's text on GovInfo from its guid, as the app
// does (BillLinkSection). Only https links to those two sites are shown.
const billSource = (bill) => {
  const raw = text(bill?.link);
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" && isHost(url, "congress.gov")) {
        return { href: url.href, label: "Read the bill on Congress.gov" };
      }
      if (url.protocol === "https:" && isHost(url, "govinfo.gov")) {
        return { href: url.href, label: "Read the bill on GovInfo" };
      }
    } catch {
      // Not a URL: fall back to the guid.
    }
  }
  const guid = text(bill?.guid);
  if (/^BILLS-[0-9A-Za-z]+$/.test(guid)) {
    return { href: `https://www.govinfo.gov/app/details/${encodeURIComponent(guid)}`, label: "Read the bill on GovInfo" };
  }
  return null;
};

const renderSource = (bill) => {
  const link = byId("bill-source-link");
  const source = billSource(bill);
  if (!link || !source) return;
  link.href = source.href;
  link.textContent = source.label;
  setVisible("bill-source", true);
};

// ---------- Invite ----------

// iPhone, iPod touch, and iPad (which asks for the desktop site and reports itself as a Mac with touch).
const isAppleTouchDevice = () => {
  const nav = typeof navigator === "undefined" ? null : navigator;
  if (!nav) return false;
  if (/iPhone|iPad|iPod/.test(nav.userAgent || "")) return true;
  return nav.platform === "MacIntel" && Number(nav.maxTouchPoints) > 1;
};

// "Open in app" (billboard://) only where the app can be installed; everywhere else it is an error. A
// small secondary link until universal links ship (website review item 14).
const renderOpenInApp = (guid) => {
  const openInApp = byId("open-app-link");
  if (!openInApp) return;
  openInApp.href = `${APP_OPEN_URL_PREFIX}${encodeURIComponent(guid)}`;
  setVisible("open-app-link", isAppleTouchDevice());
};

// ---------- Page ----------

// Tells assistive tech the share heading region has finished updating, so it
// announces the loaded title (or the error) once.
const finishLoading = () => {
  byId("share-status")?.setAttribute("aria-busy", "false");
};

// Adds one line per companion under the heading, outside the live region so the loaded-title
// announcement is unchanged. Built from DOM nodes and text, never markup, so a guid cannot inject
// HTML and nothing needs an inline style. Ungrouped bills add nothing.
const renderCompanions = (bill, guid) => {
  byId("bill-companions")?.remove();

  const companions = describeCompanions(bill?.companionGroup, ownPlainGuids(bill, guid));
  const anchor = byId("share-status");
  if (!companions.length || !anchor) return;

  const container = document.createElement("div");
  container.id = "bill-companions";
  container.className = "companion-notes";
  companions.forEach((companion) => {
    const link = document.createElement("a");
    link.className = "inline-link";
    link.href = `/b/${encodeURIComponent(companion.guid)}`;
    link.textContent = companion.number;

    const line = document.createElement("p");
    line.className = "companion-note";
    line.append(companionSentencePrefix(companion), link);
    container.append(line);
  });
  anchor.after(container);
};

const renderBill = (bill, guid, now = Date.now()) => {
  const note = endedNote(bill, now);
  const { numberIsHeading, heading } = renderHeading(bill);
  renderDocket(bill, { numberIsHeading, ended: Boolean(note) });
  setVisible("bill-subtitle", false);
  renderCompanions(bill, guid);
  renderEndedNote(note);
  renderLastUpdated(bill);

  renderAiBlock(bill);
  renderStanding(bill);
  renderOfficialVotes(bill);
  renderCommittees(bill?.committees);
  renderActions(bill?.actions);
  renderSource(bill);
  // Results stay sealed on the web: the public response carries no Billboard votes (INT-11).
  setVisible("bill-results", true);
  renderOpenInApp(guid);

  const billNumber = formatBillNumber(bill?.identifier);
  const congress = formatCongress(bill?.identifier);
  setPageMetadata({
    title: `${[billNumber, congress].filter(Boolean).join(", ") || "Shared bill"} | Billboard`,
    description: numberIsHeading ? "" : heading,
  });
};

// The error, in plain words, with the bill on Congress.gov when its number can be read from the link,
// and a link home (index.html).
const renderError = (error, guid) => {
  const notFound = error instanceof BillLoadError && (error.status === 404 || error.status === 400);
  byId("message").textContent = notFound
    ? "We couldn't find this bill. The link may be incomplete, or the bill may no longer be in Billboard."
    : "We couldn't load this bill right now. Please try again later.";

  const parsed = parseBillGuid(guid);
  const number = parsed ? formatBillNumber(parsed) : "";
  const href = parsed ? congressGovUrl(parsed) : "";
  const link = byId("error-source-link");
  if (link && number && href) {
    link.href = href;
    link.textContent = `Look up ${number} on Congress.gov`;
    setVisible("error-source", true);
  }
  setVisible("share-error", true);
  setVisible("bill-subtitle", false);
  renderStamp("Couldn't load", "stamp-danger");
  byId("bill-title").textContent = "Bill unavailable";
  setPageMetadata({ title: "Bill unavailable | Billboard", description: "" });
};

const showMode = (mode) => {
  setVisible("landing-view", mode === "landing");
  setVisible("share-view", mode === "share");
  // The shared bill is set on the document ground, like the app's bill page (styles.css).
  document.body.dataset.view = mode;
  // A shared bill is not the home page, so the masthead does not mark Home as the current page there.
  if (mode === "share") {
    document.querySelector('.site-nav a[aria-current="page"]')?.removeAttribute("aria-current");
    addNoindex();
  }
};

const main = async () => {
  const route = parseRoute();
  showMode(route.mode);

  // The landing page keeps index.html's title and description.
  if (route.mode === "landing") return;

  try {
    const bill = await fetchBill(route.guid);
    renderBill(bill, route.guid);
  } catch (error) {
    renderError(error, route.guid);
  } finally {
    finishLoading();
  }
};

main();
