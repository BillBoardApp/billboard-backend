// Keeps the copies of the site's header and footer in step (website content review, item 9b). The site has no
// build step, so every page in website/ carries its own copy of the masthead and the footer. This fails when a
// page's copy differs from index.html's, ignoring whitespace and which link marks the current page, or when a
// page marks another page as current.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../website");
// The approved not-affiliated sentence (CON-13 text C5), which every page's footer carries word for word.
const FOOTER_SENTENCE =
  "Billboard is an independent project and is not affiliated with Congress or any government agency.";

const problems = [];
const fail = (page, message) => problems.push(`${page}: ${message}`);

const blocks = (html, pattern) => [...html.matchAll(pattern)].map((match) => match[0]);
const normalize = (block) => block.replace(/\s+aria-current="page"/g, "").replace(/\s+/g, " ").replace(/> </g, "><").trim();

// The page a link points at, as the page's own file name: "/" and "/index.html" are index.html.
const target = (href) => {
  const clean = href.split(/[?#]/)[0];
  if (clean === "/" || clean === "") return "index.html";
  return clean.replace(/^\//, "");
};

const read = (page) => {
  const html = readFileSync(path.join(siteDir, page), "utf8");
  const headers = blocks(html, /<header class="masthead">[\s\S]*?<\/header>/g);
  const footers = blocks(html, /<footer class="site-footer">[\s\S]*?<\/footer>/g);
  if (headers.length !== 1) fail(page, `expected one <header class="masthead">, found ${headers.length}`);
  if (footers.length !== 1) fail(page, `expected one <footer class="site-footer">, found ${footers.length}`);
  return { header: headers[0] ?? "", footer: footers[0] ?? "" };
};

const pages = readdirSync(siteDir)
  .filter((name) => name.endsWith(".html"))
  .sort();
if (!pages.includes("index.html")) {
  console.error("check-website-chrome: website/index.html is missing");
  process.exit(1);
}

const reference = read("index.html");
for (const page of pages) {
  const { header, footer } = page === "index.html" ? reference : read(page);
  if (page !== "index.html") {
    if (normalize(header) !== normalize(reference.header)) fail(page, "the masthead differs from index.html's");
    if (normalize(footer) !== normalize(reference.footer)) fail(page, "the footer differs from index.html's");
  }
  if (!footer.replace(/\s+/g, " ").includes(FOOTER_SENTENCE)) {
    fail(page, `the footer does not carry the not-affiliated sentence word for word: "${FOOTER_SENTENCE}"`);
  }
  for (const block of [header, footer]) {
    for (const [, href] of block.matchAll(/<a\s+href="([^"]*)"\s+aria-current="page"/g)) {
      if (target(href) !== page) fail(page, `marks ${href} as the current page`);
    }
  }
}

if (problems.length) {
  console.error(`check-website-chrome: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
  console.error("Copy the masthead and footer from website/index.html (website/README.md, \"Every page\").");
  process.exit(1);
}
console.log(`check-website-chrome: ok (${pages.length} pages)`);
