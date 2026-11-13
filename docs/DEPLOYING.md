# Deploying

How a change in this repository reaches the production service, and what checks it on the way. Only the project's
maintainers start and approve deploys ([CONTRIBUTING.md](../CONTRIBUTING.md), "What maintainers do"). To run your own
copy instead, see "Deploying your own copy" in [infra/README.md](../infra/README.md#deploying-your-own-copy).

## In short

1. A pull request runs `.github/workflows/pr.yml`: `npm run verify` and the commit-safety check. Both must pass before
   it merges.
2. The merge to `main` runs `.github/workflows/deploy.yml`, which verifies and builds the Lambda release for that
   commit. That is all a push does: it never reaches AWS.
3. One of the project's maintainers starts a diff run on `main`. GitHub holds it in the `production` environment until
   one of the project's maintainers approves it. It publishes the release and shows the CloudFormation diff.
4. If the diff shows what the change should, one of the project's maintainers starts a deploy run with that release,
   and it waits for approval the same way. Then it deploys.

```bash
gh workflow run deploy.yml -R BillBoardApp/billboard-backend --ref main -f mode=diff
gh workflow run deploy.yml -R BillBoardApp/billboard-backend --ref main -f mode=deploy -f release_id=<release id>
gh run watch -R BillBoardApp/billboard-backend
```

The release id is in the diff run's summary (`Release: services-<date>-<sha>`). Reject a waiting run you do not want
at once: only one run holds the production lock at a time, and the others queue behind it.

## The deploy workflow

`deploy.yml` has three jobs, all on GitHub-hosted runners:

| Job | What it does | AWS |
|---|---|---|
| `plan` | Picks the mode: `off` for a push or a run from any other branch; the `mode` input (`diff` or `deploy`) for a manual run on `main` | none |
| `build` | `npm run setup` and `npm run verify`; checks the release belongs to this commit; in diff and deploy runs, keeps the release (zips and manifest) as the `lambda-release` artifact for 7 days | none |
| `deploy` | Everything below, in the `production` environment | yes |

The `deploy` job, once approved:

1. publishes the release this run built to the artifacts bucket (`scripts/ci/publish-release.sh`: zips first, the
   manifest last), with the release role, before any package is installed; a run given `release_id` skips this;
2. clears those credentials;
3. installs `infra/`, takes the deploy role, synthesizes the app strictly against the release manifest, runs
   `cdk diff` against production and the deploy guard (below); a diff run also shows the alias pins a deploy would
   write, and stops there;
4. in deploy mode only: writes the alias pins, runs `cdk deploy --all`, then moves each changed Lambda's `prod` alias
   with CodeDeploy.

API handlers shift 10% for 10 minutes, then 100%; queue, stream and scheduled workers shift all at once. All shifts run
in parallel and take about 11 minutes, and the job waits up to 45. An alarm of the function's deployment group in ALARM
during its shift rolls that function back. Problems that show later (the canary's alarm needs two failed runs out of
three, 15 minutes apart) are not rolled back by themselves: revert, or roll back the code (below).

A deploy that updates an EventBridge rule or Scheduler schedule sets it back to `ENABLED`, so do not deploy while a rule
is disabled on purpose.

## Who can reach AWS

- The two roles in `infra/lib/stacks/github-oidc.ts` trust only this repository's `deploy.yml` on `main`, in the
  `production` environment, through GitHub's OIDC provider. The repository's OIDC subject template puts the repository
  and owner IDs, the environment and the workflow file with its branch into each token's subject, and the roles match
  that subject exactly. Pull requests, forks, other branches and other workflows get no token they accept. Until the
  move to this repository is closed out, the roles also trust the `main` branch of the private repository the project
  deployed from before; that subject is then removed.
- Only the `deploy` job asks for an OIDC token (`id-token: write`), and only it runs in the `production` environment,
  which lets only `main` in and waits for the project's maintainers to approve. `infra/test/workflows.test.ts` fails if
  another job or workflow asks for a token or uses a secret, uses a runner that is not GitHub-hosted, or is started by
  anything but `pull_request`, `push` or `workflow_dispatch`.
- The release role lists, reads and writes the artifacts bucket and nothing else, for at most an hour.
- The deploy role reaches CloudFormation and the CDK assets bucket only through the CDK bootstrap roles. Otherwise it
  grants the release manifest download, `lambda:GetAlias`, the alias pin parameters and the CodeDeploy and alarm reads
  of `release:deploy-lambdas`. A diff run narrows it further with an inline session policy (the manifest download,
  `lambda:GetAlias` and the bootstrap roles a change-set diff assumes), so it cannot write an alias pin or start a
  CodeDeploy deployment. The bootstrap deploy role can still change stacks, so a diff run is narrowed, not read-only.
  `infra/test/deploy-workflow.test.ts` keeps the roles, the session policy and the workflow's AWS calls in step.
- The AWS account ID is the `production` environment's `AWS_ACCOUNT_ID` secret. The role ARNs and `CDK_DEFAULT_ACCOUNT`
  are built from it, so GitHub masks it in the logs; the diff summary leaves it out too. The account in
  `infra/lib/config/deployment-identity.ts` is AWS's documentation example.
- Runs keep no deploy record. Logs are kept 30 days.

A step that fails with `AccessDenied` needs the denied role widened in `github-oidc.ts`, never an admin role. An IAM
change applies only once a deploy run's `cdk deploy` has deployed `GitHubOidcStack`.

## The deploy guard

Right after the diff, in both modes, the step "Block replacing or deleting stateful resources"
(`infra/scripts/checkDeployGuard.ts`) reads the `cdk diff` output and fails the run, before anything is written, when
the diff would:

- replace or delete a Cognito user pool or app client, a DynamoDB table, an S3 bucket or a Secrets Manager secret;
- replace or delete `BillStatsAggregator`'s `UserFeedback` stream mapping (a new mapping starts at `LATEST`, so votes in
  the gap never reach the stats);
- change or remove a bill poller cursor parameter (any CloudFormation update resets the cursor). Creating one is
  allowed;
- replace or delete the SES domain identity in `EmailStack` (new DKIM keys stay unverified for a while, and sign-up
  codes go out through it).

A replaced SQS queue or mapping is a warning only. The guard also fails a diff that is cut short: every stack in
`cdk.out` must have its section. For an intentional replacement, back up or move the data first, then name each
resource in a manual run; a push can never pass the override:

```bash
gh workflow run deploy.yml -R BillBoardApp/billboard-backend --ref main -f mode=deploy -f release_id=<release id> \
  -f allow_replacements=<Stack>/<LogicalId>   # comma-separate several
```

To check a diff locally against the `cdk.out` it was made from:
`cd infra && npm run release:check-deploy-guard -- --diff cdk-diff.txt --templates cdk.out`.

## Reading a diff

Each `prod` alias takes its version from its pin, `/billboard/prod/lambda-alias-versions/<Function>/prod` in SSM, which
CloudFormation reads only when it updates the alias. So a stack whose template changed also lists, for each such
function, `[~] AWS::Lambda::Alias <Function>ProdAlias` with only `FunctionVersion` changing, and `cdk deploy` leaves
those aliases as they are. Judge a diff by its other lines: `Code`, `Version`, IAM and everything else. The Lambda code
is compiled into the release zips, so a code change shows only as a new `Code` and `Version` for that function. The
release builds are deterministic, so an unchanged function shows no lines at all.

## Rolling back

- **A whole change:** revert it on `main` through a pull request, then diff and deploy as usual. This rolls back
  infrastructure and Lambda code together.
- **Lambda code only:** deploy an earlier release. Every published release keeps its manifest at
  `releases/<release id>/manifest.json` and its zips under content-addressed keys. A run given `release_id` publishes
  nothing and synthesizes `main` with that release's Lambda code:

  ```bash
  gh workflow run deploy.yml -R BillBoardApp/billboard-backend --ref main -f mode=diff -f release_id=<earlier release id>
  ```

## Pull request checks

`pr.yml` runs on every pull request to `main`, with a read-only token, no secrets and no cloud credentials:

- `verify`: `npm run setup` and `npm run verify` (contracts, layout, typecheck, lint, tests with the coverage gate,
  esbuild bundles, an offline synth and a strict synth of a fresh release);
- `commit-safety`: gitleaks (a pinned release, checked against its SHA-256 in `scripts/ci/install-gitleaks.sh`) over
  the pull request's commits, with `.gitleaks.toml`, and `scripts/ci/check-commit-identities.sh`, which passes only
  GitHub noreply addresses, GitHub's own web-flow address, the project's address and the AI co-author trailer.

Pull requests from forks run only after one of the project's maintainers approves the run.
