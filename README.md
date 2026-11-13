# billboard-backend

The backend of [Billboard](https://billboard-project.com), an iOS app that turns U.S. legislation into clear,
plain-English summaries. People follow bills, see what a bill does and why it matters, vote Yea, Nay or Abstain,
compare their votes with other users and with members of Congress, and get notified as bills move.

This repository holds the API contracts, the AWS Lambda services, the AWS CDK infrastructure and the public website.
It builds and deploys the production service: what is merged to `main` here is what runs, once the project's
maintainers deploy it ([docs/DEPLOYING.md](docs/DEPLOYING.md)). The iOS app lives in its own repository,
[billboard-ios](https://github.com/BillBoardApp/billboard-ios).

## What is here

| Directory | What it is | Details |
|---|---|---|
| `contracts/` | JSON schemas, the OpenAPI description of the user API, fixtures, and the TypeScript and Swift types generated from them | [contracts/README.md](contracts/README.md) |
| `services/` | 48 Lambda handlers in TypeScript (esbuild, Jest), one per directory under `src/handlers/`, plus operator scripts | [services/README.md](services/README.md) |
| `infra/` | The CDK app: 15 stacks in one AWS account and region | [infra/README.md](infra/README.md) |
| `website/` | The static public site: landing page, Help, How Billboard works, privacy policy, roadmap and the `/b/<guid>` share page | [website/README.md](website/README.md) |
| `scripts/ci/` | `build-release.sh` (deterministic Lambda zips and a release manifest), `publish-release.sh` (its upload), the layout guard `check-layout.sh`, and the commit-safety check's two scripts | |
| `.github/workflows/` | `pr.yml` (the checks every pull request runs) and `deploy.yml` (the production pipeline) | [docs/DEPLOYING.md](docs/DEPLOYING.md) |
| `docs/` | How deploys work, and a glossary of the IDs that code comments cite | [docs/README.md](docs/README.md) |

How data flows: congress.gov → `BillsApiPoller` → raw bills in S3 → `BillSummarizer` (Amazon Bedrock) → processed
bills in S3 → manifests in DynamoDB → the user API (API Gateway, Cognito) → the iOS app. Changes to processed bills
also feed the notification pipeline (SNS → APNs), and the share site reads one public API route through CloudFront.
Self-service sign-ups pass a Cognito pre-sign-up trigger, and votes, address verifications and sign-ups are checked
against account-integrity limits and Apple App Attest, each behind a switch.

## Build and test locally

You need Node 24 (`.nvmrc`; `nvm use` finds it), npm, `bash` and `git`. No AWS account, credentials or secrets.

```bash
npm run setup     # npm ci in contracts/, services/ and infra/
npm run check     # contracts (schemas, fixtures, OpenAPI against the routes, generated code up to date), layout, website
npm run typecheck # tsc --noEmit in services/ and infra/
npm run lint      # ESLint and the Prettier check in services/
npm test          # services tests with the coverage gate, then infra tests
```

`npm run verify` runs all of that plus the esbuild bundles, an offline `cdk synth` and a release build; it is what
every pull request must pass. Never run `npm install` or `npm ci` at the root: each package keeps its own lockfile.
To be sure no AWS credentials are picked up, run the commands like this:

```bash
env -u AWS_PROFILE -u AWS_DEFAULT_REGION AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null npm run verify
```

To look at the website, serve it on loopback only:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory website
```

## Root commands

| Command | What it does |
|---|---|
| `npm run setup` | `npm ci` in `contracts/`, `services/` and `infra/` |
| `npm run check` | Contracts check, the layout guard, `node --check website/app.js`, the website's masthead and footer check and its `app.js` unit checks |
| `npm run generate` | Rewrites `contracts/generated/` from the schemas |
| `npm run typecheck` | `tsc --noEmit` in `services/` and `infra/` |
| `npm run lint` | ESLint (errors only) and the Prettier check in `services/` |
| `npm test` | Services tests with the coverage gate, then infra tests |
| `npm run build` | esbuild bundle of every handler into `services/src/handlers/<name>/dist/` |
| `npm run synth` | Offline `cdk synth` of all stacks into `infra/cdk.out/` |
| `npm run release:build` | `scripts/ci/build-release.sh .release`: deterministic zips, `manifest.json`, `release-id` and `version` |
| `npm run release:synth` | Strict synth against `.release/manifest.json` into `.release/cdk.out/` |
| `npm run verify` | All of the above, in order |

## How the app uses the contracts

`contracts/` is the single source of truth for the wire format between the app and the backend:

- The schemas under `contracts/schemas/` and `contracts/openapi/user-api.v1.json` describe every entity and route.
  `npm run generate` turns them into `contracts/generated/ts/` and `contracts/generated/swift/UserAPIContractsV1.swift`.
- `services/` and `infra/` import the generated TypeScript in place, by relative import; there is no copy.
  `npm run check` fails if `generated/` differs from what the schemas produce, or if a route in
  `infra/lib/stacks/user-api-service.ts` is missing from the OpenAPI file.
- The iOS app copies the generated Swift file: `billboard-ios/scripts/syncContracts.sh` reads
  `../billboard-backend/contracts/generated/swift/UserAPIContractsV1.swift` (`--check` compares without copying).
  A change to the Swift contract therefore needs a matching pull request in `billboard-ios`.

## Layout rules

`services/` and `infra/` read `contracts/` in place, by relative TypeScript import. There is no copy and no sync step:

- `services/` imports contracts through `services/src/contracts/index.ts`, a one-line re-export of
  `contracts/generated/ts/user-api-contracts-v1.ts`.
- `infra/` imports `../../../contracts/generated/ts/...` directly, so `infra/tsconfig.json` has `"rootDir": ".."`.
  Nothing runs `dist/`: the CDK app and the tests use ts-node and ts-jest from source.

`scripts/ci/check-layout.sh` (part of `npm run check`) enforces:

- `contracts/package.json` has no `"type"` and no `dependencies` (its check tools are devDependencies).
- `contracts/generated/ts/*.ts` import nothing.
- There is no `tsconfig.json` at the root or in `contracts/`, no root `package-lock.json` and no `workspaces`.
- The Swift contract stays at `contracts/generated/swift/UserAPIContractsV1.swift` (the app's sync script reads it there).
- `services/` and `infra/` hold no copy of contracts.

Not machine-enforced, but keep them: the per-package `.gitignore` files stay where they are (hoisting infra's `*.js`
rule to the root would hide `website/app.js`), and `website/` never gets a `package.json` or build output, because the
directory is the site.

## Configuration

The production service's configuration is in the open, in this repository:

- **Deployment identity.** `infra/lib/config/deployment-identity.ts` holds the AWS account, hosted zone, Slack
  channel and GitHub repository the stacks deploy for, and the fixed bucket names. The AWS account ID is the one value
  that is not published: the file carries AWS's documentation example account, and the deploy workflow passes the
  real one from the `production` environment's secret.
- **Anti-abuse values.** `infra/lib/config/abuse-limits.ts` and `services/src/shared/abuseLimits.ts` hold every
  limit, throttle, detection threshold and switch of the abuse defences, with the values production runs.
- **Operations.** The project's operations runbook is not public. Code comments that cite it or the project's
  trackers (such as `RUNBOOK 14.2` or `REL-53`) are explained in [docs/README.md](docs/README.md); the code next to such
  a reference is meant to stand on its own.

To run the stack yourself you need your own AWS account (with Amazon Bedrock model access), a Congress.gov API key,
Apple developer credentials for push notifications and App Attest, and your own domain. Start from "Deploying your own
copy" in [infra/README.md](infra/README.md#deploying-your-own-copy).

## Contributing, security and licence

- How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are accepted under the Apache License 2.0,
  with no sign-off.
- Report vulnerabilities privately: [SECURITY.md](SECURITY.md). Do not open a public issue.
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Licence: the code is licensed under the Apache License 2.0 ([LICENSE](LICENSE)). The Billboard name and logos are
  not; see [TRADEMARKS.md](TRADEMARKS.md). Third-party software and data keep their own licences:
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
