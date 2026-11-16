// Checks website/.well-known/security.txt (RFC 9116): the fields the RFC requires (Contact, and Expires exactly once),
// the ones the project publishes (Policy, Canonical, Preferred-Languages), and that Expires is more than 30 days away,
// so the file is renewed before it goes stale. npm run check runs it, and so does npm run verify in CI and before each
// deploy. How to renew: website/README.md, "security.txt".
//
// Usage: node scripts/ci/check-security-txt.mjs [--now=<RFC 3339 date-time>]
// --now stands in for the current time, to try the renewal message.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELATIVE_PATH = "website/.well-known/security.txt";
const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", RELATIVE_PATH);
// The URL the file is published at. The share host serves the same file, and may be listed as a second Canonical.
const SITE_CANONICAL = "https://billboard-project.com/.well-known/security.txt";
const DAY_MS = 24 * 60 * 60 * 1000;
// Fail this many days before Expires, so there is a month to renew it.
const RENEW_DAYS_BEFORE = 30;
// RFC 9116 section 2.5.5 recommends an Expires less than a year away.
const MAX_DAYS_AHEAD = 366;
// A renewal sets Expires to midnight UTC this many days from today: just under a year.
const RENEW_TO_DAYS = 364;
// The fields RFC 9116 section 2.5 defines, and CSAF, which the IANA registry adds. Names are case-insensitive.
const KNOWN_FIELDS = [
  "Acknowledgments",
  "Canonical",
  "Contact",
  "CSAF",
  "Encryption",
  "Expires",
  "Hiring",
  "Policy",
  "Preferred-Languages",
];
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

const usage = () => {
  console.error("Usage: node scripts/ci/check-security-txt.mjs [--now=<RFC 3339 date-time>]");
  process.exit(2);
};
let now = new Date();
for (const arg of process.argv.slice(2)) {
  const match = /^--now=(.+)$/.exec(arg);
  if (!match || !RFC3339_DATE_TIME.test(match[1])) usage();
  now = new Date(match[1]);
}

const problems = [];
const fail = (message) => problems.push(message);
const formatDate = (date) => date.toISOString().replace(/\.000Z$/, "Z");
const renewalDate = () =>
  formatDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + RENEW_TO_DAYS)));
const renewHow = () =>
  `Renew it: set Expires to a date-time just under a year from today, such as ${renewalDate()}, check that the ` +
  `other fields are still right, and deploy the site (website/README.md, "security.txt").`;

let bytes;
try {
  bytes = readFileSync(FILE);
} catch (error) {
  console.error(`check-security-txt: cannot read ${RELATIVE_PATH} (${error.code ?? error.message}).`);
  process.exit(1);
}
let text = "";
try {
  text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
} catch {
  fail("the file is not valid UTF-8 (RFC 9116 section 4)");
}
if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
  fail("the file starts with a byte order mark; save it as UTF-8 without one");
}

const fields = new Map();
text.split("\n").forEach((rawLine, index) => {
  const line = rawLine.replace(/\r$/, "");
  if (line.trim() === "" || line.startsWith("#")) return;
  const match = /^([A-Za-z0-9-]+): (\S.*?)\s*$/.exec(line);
  if (!match) {
    fail(`line ${index + 1} is neither a comment nor a "Name: value" field: ${JSON.stringify(line)}`);
    return;
  }
  const name = KNOWN_FIELDS.find((known) => known.toLowerCase() === match[1].toLowerCase());
  if (!name) {
    fail(`line ${index + 1}: "${match[1]}" is not an RFC 9116 field (${KNOWN_FIELDS.join(", ")})`);
    return;
  }
  fields.set(name, [...(fields.get(name) ?? []), { value: match[2], line: index + 1 }]);
});
const valuesOf = (name) => (fields.get(name) ?? []).map(({ value }) => value);

// Contact has its own check below.
for (const [name, entries] of fields) {
  for (const { value, line } of entries) {
    if (name !== "Contact" && /^http:/i.test(value)) {
      fail(`line ${line}: ${name} is a web URI, so it must begin with https://`);
    }
  }
}

const contacts = valuesOf("Contact");
if (contacts.length === 0) fail("there is no Contact field; RFC 9116 requires at least one");
for (const contact of contacts) {
  if (!/^(https:\/\/|mailto:|tel:)\S+$/i.test(contact)) {
    fail(`Contact "${contact}" must be an https:// URL, a mailto: address or a tel: number`);
  }
}

for (const name of ["Policy", "Canonical"]) {
  if (valuesOf(name).length === 0) fail(`there is no ${name} field`);
}
if (valuesOf("Canonical").length > 0 && !valuesOf("Canonical").includes(SITE_CANONICAL)) {
  fail(`no Canonical field gives the URL the file is published at, ${SITE_CANONICAL}`);
}

const languages = valuesOf("Preferred-Languages");
if (languages.length !== 1) {
  fail(`Preferred-Languages must appear once (it appears ${languages.length} times)`);
} else if (!languages[0].split(",").every((tag) => LANGUAGE_TAG.test(tag.trim()))) {
  fail(`Preferred-Languages "${languages[0]}" must be a comma-separated list of language tags, such as en`);
}

const expiries = valuesOf("Expires");
let expiresNote = "";
if (expiries.length !== 1) {
  fail(
    expiries.length === 0
      ? `there is no Expires field; RFC 9116 requires one. ${renewHow()}`
      : `Expires must appear only once (it appears ${expiries.length} times)`,
  );
} else if (!RFC3339_DATE_TIME.test(expiries[0]) || Number.isNaN(Date.parse(expiries[0]))) {
  fail(`Expires "${expiries[0]}" is not an RFC 3339 date-time, such as ${renewalDate()}`);
} else {
  const expires = new Date(expiries[0]);
  const daysLeft = Math.floor((expires.getTime() - now.getTime()) / DAY_MS);
  expiresNote = `Expires ${expiries[0]}, in ${daysLeft} days`;
  if (expires.getTime() - now.getTime() <= RENEW_DAYS_BEFORE * DAY_MS) {
    const when = expires.getTime() <= now.getTime() ? "has passed, so the file is stale" : `is ${daysLeft} days away`;
    fail(
      `Expires (${expiries[0]}) ${when}. This check fails from ${RENEW_DAYS_BEFORE} days before Expires. ${renewHow()}`,
    );
  } else if (expires.getTime() - now.getTime() > MAX_DAYS_AHEAD * DAY_MS) {
    fail(
      `Expires (${expiries[0]}) is more than a year away; RFC 9116 recommends less than a year. Use a date such as ` +
        `${renewalDate()}.`,
    );
  }
}

if (problems.length) {
  console.error(`check-security-txt: ${problems.length} problem(s) in ${RELATIVE_PATH}\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`check-security-txt: ok (${expiresNote})`);
