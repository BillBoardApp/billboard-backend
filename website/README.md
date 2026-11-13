# website

The static public site for Billboard: the landing page, Help, How Billboard works, the privacy policy, the roadmap and
the read-only shared-bill page. There is no build step and no `package.json`: this directory is the site.
`infra/lib/stacks/share-site.ts` (`ShareSiteStack`) publishes it to S3 behind CloudFront at `billboard-project.com` and
`share.billboard-project.com`.

## Files

| File | What it is |
|---|---|
| `index.html` | Landing page, and the shell for the shared-bill view. Its static preview tags (`og:*`, `twitter:*`) are written to fit a shared bill as well as the home page, because link previewers do not run `app.js`; there is no `og:url`. It carries the Smart App Banner (`apple-itunes-app`, app ID 6757132060) |
| `app.js` | Client-side routing for `/b/<guid>`, `/share/<guid>` and `/?guid=<guid>`, and the shared-bill page (below). The landing page keeps `index.html`'s own title and description |
| `styles.css` | Styles for every page, in the app's Civic Record design (below) |
| `support.html` | Help: contact, deleting an account (in the app, or by email for someone without it: section 8.3 of the operations runbook, which is kept private), signing in, where you vote, reporting a problem with a summary, results and accessibility. |
| `about.html` | How Billboard works: who runs it, where the data comes from, what the AI does and does not do, staying neutral, how results work, and the data fetcher |
| `privacy.html` | Privacy policy (legal-facing text: say so in the pull request when you change it) |
| `roadmap.html` | Roadmap page |
| `robots.txt` | `Disallow: /public/`, so crawlers do not call the bill API. `/b/` stays open, because some link previewers obey `robots.txt`; `app.js` keeps share views out of search with a `noindex` instead |
| `favicon.ico`, `apple-touch-icon.png` | The 1.2 app icon at 16, 32 and 48 px (on its rounded navy tile) and at 180 px (full-bleed navy, which iOS rounds itself), drawn from the same layers as `assets/favicon.svg` |
| `assets/favicon.svg` | Favicon, and the app icon beside the App Store button: the 1.2 app icon's layers (`AppIcon.icon/Assets/*.svg` in the app repository), drawn flat |
| `assets/share-preview.png` | Social preview image (1200 × 630): the app icon's artwork alone, centred on the masthead navy. It sets no type, so it carries no font licence |
| `.gitignore` | Ignores `.DS_Store` |

The icons and the preview image come from the app icon. They are Billboard marks, which the Apache License does not
cover: see `TRADEMARKS.md` at the root of the repository.

## The shared-bill page

`app.js` fetches `/public/processed-bill?guid=<guid>` and renders, top to bottom:

1. **Front matter, official data first.** The not-affiliated line; the docket line (number, chamber, Congress) with a
   stamp; the heading, which is the bill's `officialTitle`, or its number when the record has none (the AI headline
   never takes its place); the companion line when the response has a `companionGroup` (APPF-23) that includes this
   bill ("Also introduced in the Senate as S. 570", linking to the other bill's page); the ended note; the last-updated
   time.
2. **The AI block**, set off by a rule down its edge and headed by the app's line, "Written with AI from the official
   text · Report a problem". Report a problem is a `mailto:` whose subject names the bill, as the app's
   `ReportProblem` writes it. Inside: the plain-language headline, Why it matters, the Bill Breakdown, the Summary
   (only the contracts fixture has one), and the topics and life areas, which the AI assigns too.
3. **Where it stands**: the introduction's date and the latest action in Congress's words. **How Congress voted**:
   each chamber's roll call from `officialVotes`, worded as the app's `CongressChamberTally`. **Committees** and
   **Actions** as the app lists them (`BillDisplayFormatting.timelineActions`): oldest first, each once, with plain
   type labels and never a raw code such as `IntroReferral`.
4. **Source**: "Read the bill on Congress.gov" from `link`, else GovInfo from the guid, as the app's `BillLinkSection`.
5. **Results**, drawn sealed, with the invite to vote in the app, the App Store button and, on iPhone and iPad only,
   "Open in app" (`billboard://`).

Rules the page keeps:

- **Stamps only for outcomes.** Passed, Failed and Became law (`Finalized`) are stamped. New and Updated describe
  Billboard's feed, not the bill, so they get no stamp; Where it stands shows the latest action instead. The status is
  not repeated as a row.
- **The ended note** (REL-46 D16), worked out from the date: "The 119th Congress ended on January 3, 2027. This bill
  did not become law. To move forward it would have to be introduced again." A Congress ends at noon Eastern on
  January 3 of the odd year after it, and the text is built from the bill's Congress, so it works for every Congress.
  New, Updated and Failed bills get it from then; a Passed bill, or one whose actions show a passage or the President,
  waits until February 1, because the actions that make a bill Became law can arrive weeks after it is signed. A bill
  that became law, or whose actions say so, never gets it, and nor does a status the page does not know. Simple and
  concurrent resolutions never become law: a passed one gets none, an unpassed one "This resolution was not agreed
  to". Joint resolutions say "This joint resolution did not become law". With the note, a New or Updated bill is
  stamped "Ended with the 119th Congress", as app 1.3 plans to.
- **Never shown:** Billboard users' votes or results (the public response carries none, INT-11), the AI's theme
  scores (`civicProfile`) and the In the news fields (`isPriority`, `priorityRank`, `priorityReason`), although the
  public response carries the last two.
- **Errors in plain words**, with the bill on Congress.gov when its number can be read from the link, and a link home.
- **Out of search**: share views add `<meta name="robots" content="noindex">`.
- **Labels from the app** carry a note in `app.js` naming the Swift file they come from, so a change in the app can be
  found here.

`app.js` renders the public processed-bill response described by `contracts/schemas/entities/processed-bill.v1.schema.json`.
When that contract changes, check the share page. CloudFront caches `/public/*` answers (60 seconds by default, at most
5 minutes), so the page can trail the API by that much: a companion appears or disappears up to a minute after the API
changes (section 12 of the operations runbook, which is kept private).

## Design

The site uses Civic Record, the design app 1.2 shipped with, so a shared bill reads like the bill page in the app. The
values in `styles.css` come from the app's `Theme/BillboardTheme.swift` (`BillboardPalette`) and are set as custom
properties on `:root`, with a dark set (`prefers-color-scheme: dark`) and an Increase Contrast set
(`prefers-contrast: more`). Keep to the app's rules when you change a page:

- Paper below, ink on it. Navy is only the masthead; brand teal only the wordmark's BOARD and the current page in the
  masthead.
- Colour carries meaning only, and always with the word: the status stamps (Updated, Passed, Failed, Became law) and
  the Yea and Nay heads and bars of How Congress voted and the sealed Results sheet. Links and buttons are ink.
- One face per job, from the reader's own system fonts (the CSP allows no font files): a condensed sans for
  headlines and the wordmark, a serif for reading text, a monospace for the docket (numbers, dates, stamps), and the
  system sans for everything else.
- Rules, not boxes: a thick-over-thin rule under front matter, a 2 px rule over section heads, hairlines between
  sections and dotted rules between ledger rows. No shadows, gradients or animation.
- Never official-looking: no seals, flags, domes or government emblems.
- Text contrast meets WCAG 2.2 AA in light and dark, and 7:1 under Increase Contrast, by the same maths as
  `BillboardColorMath` in the app's `Theme/BillboardTheme.swift`. Check any new text and background pair.

The shared bill never shows other people's votes: the public response carries none (INT-11), so its Results section
is drawn sealed.

## Every page

Each page carries its own copy of the masthead and the footer, since there is no build step. Copy them from
`index.html` when you add a page, and mark the current page with `aria-current="page"` on its own link only. The
footer is short: the approved not-affiliated sentence, word for word ("Billboard is
an independent project and is not affiliated with Congress or any government agency."), then How Billboard works,
Help and Privacy. `scripts/ci/check-website-chrome.mjs` (in `npm run check`) fails when a page's masthead or footer
differs from `index.html`'s, when a footer lacks that sentence, or when a page marks another page as current.

## Keeping it current

Several pages copy text that changes elsewhere: the App Store text (the landing page), the app's labels, the AI line
and the About sentence (the shared bill, the landing page and How Billboard works), help steps that name app screens,
and the roadmap. With each app release, check the landing page, Help and the roadmap against it. Help, How Billboard
works and the roadmap carry a "Last reviewed" date: change it when you check them. Keep version numbers, counts of
states and polling schedules out of the copy. Help's line about the new House maps comes out by 2027-03-31 (a comment
beside it says so).

## Local preview

From the repository root:

```bash
node --check website/app.js
python3 -m http.server 8080 --bind 127.0.0.1 --directory website
```

Open http://127.0.0.1:8080/, `/support.html`, `/about.html`, `/privacy.html` and `/roadmap.html`. `--bind 127.0.0.1`
keeps the server off your local network. Only CloudFront serves the share routes (`/b/<guid>`, `/share/<guid>`) and
the extensionless `/privacy`, `/roadmap`, `/support` and `/about`, and proxies `/public/processed-bill` to the API, so
locally `/?guid=<guid>` shows the share shell and then its plain "couldn't load" error.

`npm run check` at the root checks `app.js` with `node --check`, runs `scripts/ci/check-website-chrome.mjs` (above) and
`scripts/ci/test-website-app.mjs`, which loads `app.js` in Node and checks the ended note on faked dates (January 3
before and after noon Eastern, February 1, resolutions, Passed bills, a later Congress), the action list, the
roll-call wording, Report a problem and the source link. The infra tests package this directory.

## Content Security Policy

CloudFront serves every page with `SHARE_SITE_CONTENT_SECURITY_POLICY` from `infra/lib/stacks/share-site.ts`:
`default-src 'none'`, with `script-src`, `style-src`, `img-src` and `connect-src` limited to `'self'`, plus
`base-uri 'none'`, `form-action 'none'` and `frame-ancestors 'none'`. The local server sends no policy, so anything
it blocks works locally and breaks only in production. Do not add:

- inline `<script>` or `<style>` blocks, `style="..."` attributes (in HTML or in markup that `app.js` builds), or `on*`
  handler attributes such as `onclick`;
- `data:` or `blob:` URIs, or images, scripts, styles or `fetch` calls from any other origin (plain `<a href>` links to
  other sites are fine);
- fonts of any kind, including self-hosted ones (there is no `font-src`);
- forms, iframes or a `<base>` tag.

Setting properties through `element.style` in `app.js` is allowed. If a change needs anything on the list, change the
policy in `share-site.ts` in the same pull request.

## What gets published, and when

- Everything in this directory is uploaded to the site bucket except `SHARE_SITE_ASSET_EXCLUDES` in `share-site.ts`:
  `.git*`, `.github`, Markdown files, `.DS_Store` and `.nvmrc`. Do not add scripts, notes or other non-site files.
- The site is published by a deployment, and a deployment is the **full** release, not just the site: `cdk deploy` of
  every stack, then CodeDeploy for any Lambda whose code changed (`../infra/README.md`, "Lambda release flow"). Which
  pipeline, branch or approval starts one is the deployer's own setup.
- Each deploy that changes the site re-syncs the bucket (removing files that are gone) and invalidates `/*` on the
  CloudFront distribution, so new or renamed pages and assets need no infra change. The bucket deployment sets each
  file's content type from its extension (`robots.txt` text, `favicon.ico` an icon). An extensionless route such as
  `/support` needs a line in the CloudFront function in `share-site.ts` and its test; a path the function does not
  know is served the landing page.
