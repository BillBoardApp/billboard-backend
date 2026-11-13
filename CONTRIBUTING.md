# Contributing to billboard-backend

Thank you for helping. This repository holds Billboard's API contracts, Lambda services, CDK infrastructure and
public website. The iOS app is the separate [billboard-ios](https://github.com/BillBoardApp/billboard-ios) repository,
with its own `CONTRIBUTING.md`. Start with [README.md](README.md) for the layout and the commands.

This repository builds and deploys the production service. Accepted pull requests are merged here, and the
project's maintainers deploy them as "What maintainers do" describes.

## Licence of contributions

Both Billboard repositories are under the [Apache License 2.0](LICENSE). Under its section 5, anything you submit for
inclusion is under that same licence, with no extra terms. The project does not accept contributions under other
terms. There is no contributor licence agreement and no sign-off line to add.

The copyright line in [NOTICE](NOTICE) reads "The Billboard Authors". That means everyone who has contributed to
Billboard. You keep the copyright in your contribution, and git history is the record of who did what. The project
keeps no list of names: there is no AUTHORS file, and the project's docs and release notes name no one.

Please do not add copyright headers or author lines to files you write. Keep any header that third-party code
already carries.

Your commit name and email address become part of the public history. Commit with your GitHub noreply address
(GitHub Settings > Emails). The pull request checks reject other addresses.

The licence does not cover the Billboard name and logos. See [TRADEMARKS.md](TRADEMARKS.md).

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Security problems: do not open an issue or a pull request. Follow [SECURITY.md](SECURITY.md).
- Never commit secrets, credentials, `.env` files, real user data, or logs and output from a real deployment. Tests
  use synthetic data only (`example.com` addresses, made-up IDs, AWS's documentation account IDs).

## AI-assisted contributions

The project is developed with an AI coding agent, Claude Code. It works under the direction of the project's
maintainers, who are responsible for what it commits. Its commits carry a `Co-Authored-By:` trailer that names the
model. Its changes go through pull requests and the same required checks as yours, and it may merge its own pull
requests once those checks pass. It never approves a production deploy.

You may use AI tools too. The rules are the same for every change, however it was written:

- **Understand and stand behind every line.** You must be able to explain any part of your change in review, and fix
  it if it is wrong. "The tool wrote it" is not an answer.
- **Say when a tool did a lot of the work.** If an AI tool wrote a substantial part of the change, such as whole
  functions, tests or documents, say so in the pull request and name the tool. Small completions need no note. Do not
  add a co-author line for the tool.
- **Keep the checks green.** Run the local checks before you open the pull request, with no warnings. Do not weaken,
  skip or delete tests, lint rules or the coverage gate to make a change pass.
- **Check the facts.** AI tools can be confidently wrong. Check anything about bills, laws, votes or members of
  Congress against Congress.gov or the source the code uses. Check that any package or API a tool suggests really
  exists.
- **Never paste secrets or personal data into a tool.** That means no keys, tokens, passwords, `.env` files or logs
  from a real deployment, and nobody's email address, street address or votes. Use the synthetic test data in the
  repository.
- **Keep tool files out.** Do not commit your tool's settings, prompts or memory files, such as `CLAUDE.md`,
  `AGENTS.md` or a `.claude/` folder.
- **Keep pull requests reviewable.** We may close a large generated change that nobody asked for. Open an issue first
  for anything big.

**How this fits the licence.** A tool's help does not change section 5 of the Apache License. You are the contributor,
not the tool. By submitting, you confirm you have the right to license the change under Apache-2.0. Use only tools
whose terms allow that. Do not submit output that copies someone else's code or text, such as a long passage you
recognize or a file with another licence header, unless you name its source and its licence is compatible with
Apache-2.0.

## Local checks

Use Node 24 (`.nvmrc`). From the repository root:

```bash
npm run setup     # npm ci in contracts/, services/ and infra/
npm run verify    # check, typecheck, lint, tests, esbuild bundles, offline synth and a release build
```

`npm run verify` is what `.github/workflows/pr.yml` runs on every pull request; it needs no AWS credentials. The same
workflow checks the pull request's commits for secrets and for addresses other than GitHub noreply ones. Everything
must pass with no warnings. Paste the `Tests:` lines into the pull request.

Dependency install scripts are reviewed: `allowScripts` in `services/package.json` and `infra/package.json` approves
esbuild's install script (for its exact version) and denies the others, which the install does not need. When an
update changes that list (a new esbuild version, a new package with a script), `npm ci` warns and
`npm install-scripts ls` names it; read the script, then run `npm install-scripts approve <pkg>` or `deny <pkg>` in that
package and commit the change. If your own npm config sets `allow-scripts`, npm warns that it ignores it here; set it
for global installs only (`npm install -g --allow-scripts=<pkg> <pkg>`). Both packages also override `test-exclude`
under `babel-plugin-istanbul` to 8.x, so Jest's coverage no longer pulls in deprecated `glob` versions; remove that
override once `babel-plugin-istanbul` itself depends on `test-exclude` 8.

Some npm scripts in `services/` (`backfill:*`, `repair:*`, `eval:*`, `probe:*` and similar) and in `infra/`
(`cdk deploy`, `release:*`) act on whatever AWS account your credentials point at. Never run them against an account
you do not own.

## contracts/

The source of truth for the wire format. Details: [contracts/README.md](contracts/README.md).

- Edit the schema, run `npm run generate`, and commit the schema and `generated/` together. Never edit `generated/`
  by hand; `npm run check` fails when it differs from what the schemas produce.
- Add optional fields in place. A breaking change goes into a new versioned file (`*.v2.schema.json`).
- A change to `generated/swift/UserAPIContractsV1.swift` also needs `./scripts/syncContracts.sh` in `billboard-ios`,
  in a pull request there.

## services/

One directory per Lambda under `src/handlers/`. Details: [services/README.md](services/README.md).

- Tests live in `src/tests/**/*.test.ts` and stay offline: mock the AWS SDK clients. Keep the coverage gate in
  `jest.config.js`; never lower it.
- `npm run lint` (ESLint; errors fail) and `npm run format:check` (Prettier; `npm run format` rewrites).
- A new handler needs its directory with `index.ts`, a Lambda in the right infra stack, and a row in the handler
  table of `services/README.md`.
- Anti-abuse limits live only in `src/shared/abuseLimits.ts` and `infra/lib/config/abuse-limits.ts`, with the values
  production runs. Tests read them from there. A change to one is a change to production: say so in the pull request.

## infra/

The CDK app. Details: [infra/README.md](infra/README.md).

- `npm test` in `infra/` synthesizes every stack offline and checks it, including `security.test.ts`.
- Review `infra/cdk.out/` after `npm run synth` for resources that would be replaced (changed logical IDs, table,
  bucket, queue or secret names, key schemas, the Cognito pool) and list them in the pull request.
- Routes live in `addRoutes` in `lib/stacks/user-api-service.ts`; add or change a route there and in
  `contracts/openapi/user-api.v1.json` together.
- The workflows are tested too (`test/workflows.test.ts`, `test/deploy-workflow.test.ts`): GitHub-hosted runners only,
  and AWS access only from the approved deploy job.

## website/

Static files, no build step. Serve it with `python3 -m http.server 8080 --bind 127.0.0.1 --directory website`.
CloudFront serves it with a strict Content Security Policy: no inline scripts or styles, `style` attributes, `on*`
handlers, `data:` URIs, web fonts or third-party origins. `privacy.html` is legal text; say so in the pull request
when you change it.

## Running your own build

**Builds from source.** You may build the app from `billboard-ios` and use it with the project's hosted service.
The bundled `Billboard/Billboard/amplifyconfiguration.json` points at that service, the same one the App Store app
uses. So your build signs in and reads bills there. Votes and sign-ups also go through the app integrity check. A
build you sign yourself cannot pass it, so the service may limit or refuse them. The
[privacy policy](https://billboard-project.com/privacy.html) applies to your account as it does in the App Store app.

- Push notifications depend on the project's Apple developer account, so they may not work in a build you sign
  yourself.
- The service can require a newer app version. Keep your build up to date with `main`.
- The signed-in UI tests skip themselves when no test login is set, and the smoke-test runner stops with a message.
  Do not set one up with an account on the hosted service.

### Acceptable use of the hosted service

If you use the project's hosted service from anything other than the project's App Store or TestFlight builds (a
build you made, or your own code):

- **Use your own account and vote as yourself.** Do not create accounts in bulk or with throwaway email addresses.
- **Keep test votes few.** Votes count toward results other people see.
- **No scripts or bots.** Do not script sign-ups, votes or reads, scrape the service or the share site, or load-test
  it. For bill data in bulk, use Congress.gov and GovInfo.
- **Respect the limits and checks.** Do not try to get around the service's limits, sign-up checks or app integrity
  check. If you find a way, report it privately as [SECURITY.md](SECURITY.md) describes, and do not use it.
- **Leave other people alone.** Do not try to see how anyone else voted or get into other accounts, and do not enter
  anyone else's email address or street address.

**The hosted service is production.** The project's hosted service (the website and share site at
billboard-project.com, and the sign-in and API in the app's `amplifyconfiguration.json`) is not a test environment.
Do not point scripts or load tests at it. To experiment, deploy your own copy ([infra/README.md](infra/README.md)).

The project may limit, suspend or delete accounts, votes or builds that break these rules. It may change or stop the
service at any time, and builds from older or changed code may stop working.

### If you ship a build or run a service

Please run your own backend. This applies if you give a build to other people (through TestFlight, the App Store or
any other way), or if you run any part of this code as a service for others. The hosted service's limits, costs and
privacy policy are set for the project's own app, and your users would be outside them. This is a request about the
service, not a condition of the licence: Apache-2.0 lets you use the code freely.

1. Deploy `billboard-backend` in your own AWS account, following "Deploying your own copy" in its
   [infra/README.md](https://github.com/BillBoardApp/billboard-backend/blob/main/infra/README.md#deploying-your-own-copy).
   You need Amazon Bedrock model access, a Congress.gov API key from api.data.gov, an Apple developer account (for
   push notifications and App Attest) and your own domain.
2. In `services/src/shared/appAttest/config.ts`, set `APPLE_TEAM_ID` and `APP_BUNDLE_ID` to your own, and set
   `APP_ID_HASH` to the SHA-256 of your App ID (`<team ID>.<bundle ID>`). Use the same team and bundle ID in the
   Xcode project.
3. In the app, replace the values in `Billboard/Billboard/amplifyconfiguration.json` with your stack outputs
   `UserPoolId`, `UserPoolClientId` and `UserApiUrl`. Set `WEBSITE_BASE_URL` and `SHARE_SITE_BASE_URL` in
   `Billboard/Info.plist` to your own domain.
4. Use your own app name, icon and bundle ID, as [TRADEMARKS.md](TRADEMARKS.md) asks.
5. Publish your own privacy policy. The project's policy covers only its hosted service.

## What maintainers do

The project's maintainers:

- triage issues, review pull requests (sometimes with AI help), ask for changes and merge;
- approve check runs for outside pull requests. GitHub holds those runs until one of the maintainers approves them,
  and they run with a read-only token and no secrets;
- start and approve every production deploy;
- make app release builds and submit them to the App Store;
- handle security and conduct reports in private.

| You can | Done only by the project's maintainers |
|---|---|
| Open issues and pull requests | Merging to `main` |
| Run every check and test locally, with no credentials | Approving check runs for outside pull requests |
| Build the app and use it with the hosted service | Starting and approving production deploys |
| Deploy your own copy in your own AWS account | TestFlight and App Store releases |
| | Holding secrets, AWS access and Apple credentials |

**How a change reaches production.** A merge to `main` in `billboard-backend` runs the checks and builds a release,
but it does not deploy. A deploy is started by hand from `main`: first a preview of what would change, then the
deploy itself. GitHub holds each of these runs in the `production` environment until the project's maintainers
approve it. The repository's workflows can reach AWS only from an approved run on `main`. The AI agent never approves
a deploy.

**App releases.** Release builds of `billboard-ios` are made by hand from `main` in Xcode Cloud. A version goes to the
App Store only after the server changes it needs are live.

**Secrets and access.** Outside contributors never get secrets, deploy access, AWS access or write access. Pull
request checks need none of them. If part of your change can only be checked against a real deployment, say so in
the pull request, and the maintainers will check that part.

## Staying neutral

Billboard is for every voter, whatever their views. Changes must keep it that way:

- No wording, ordering, defaults or notifications that take the side of a party, candidate, bill or cause.
- Bill summaries say what a bill does, not whether it is good. If you change the summary prompts or the list of loaded
  words, explain why in the pull request and show output from before and after.
- Facts about bills, votes and members must come from official sources such as Congress.gov, GovInfo and the Senate.

## Commit messages and pull requests

One line, sentence case, no trailing period, usually starting with a present participle, such as
`Adding bill outcomes` or `Fixing congress member terms retention`; prefix bug fixes with `Bug fix:`. Fill in the
pull request template. Keep pull requests focused: one change, with its tests.
