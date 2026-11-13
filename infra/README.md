# infra

The AWS CDK app for Billboard: 15 stacks in one AWS account and region. The entry point is `bin/billboard-infra.ts`.
Lambda code comes from `../services` as a release (zips plus a manifest), the share site from `../website`, and the
release types from `../contracts`.

This app is what production runs: `.github/workflows/deploy.yml` deploys it from `main` once the project's maintainers
approve the run ([../docs/DEPLOYING.md](../docs/DEPLOYING.md)). Its configuration holds the production values, except
the AWS account ID, which the deploy workflow passes from a secret.

## Commands

Run `npm run setup` once at the repository root (it runs `npm ci` here), then, from this directory:

| Command | What it does | AWS |
|---|---|---|
| `npm test` | Jest suites in `test/`: every stack synthesized offline and checked, the release flow, `security.test.ts` (deletion protection, encryption, TLS, WAF, route authorization, IAM) | none |
| `npm run typecheck` | `tsc --noEmit` | none |
| `npm run synth` | `cdk synth --quiet --no-lookups --no-notices` into `cdk.out/` | none, if no credentials are loaded (below) |
| `npm run release:check-deploy-guard -- --diff <cdk-diff.txt> --templates cdk.out` | Fails if a `cdk diff` replaces or deletes a Cognito pool or client, a table, a bucket, a secret or the feedback stream mapping (`--allow <Stack>/<LogicalId>` for an intended one) | none |
| `npx cdk diff` | Compares the synthesized stacks with a deployed account | reads |
| `npx cdk deploy` | Deploys stacks | **writes** |
| `npm run release:sync-prod-alias-versions -- --templates cdk.out` | Copies each live `prod` alias version into its SSM pin (`--dry-run` only reads) | **writes** |
| `npm run release:deploy-lambdas -- --outputs cdk-outputs.json` | Starts CodeDeploy for every changed `prod` alias and waits | **writes** |

The last four act on whatever account your credentials point at. `npm test` also checks the repository's workflows
(`test/workflows.test.ts`, `test/deploy-workflow.test.ts`).

**Offline synth.** `bin/billboard-infra.ts` uses `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` when set and falls
back to the account and region in `lib/config/deployment-identity.ts` (AWS's documentation example account; the deploy
workflow sets `CDK_DEFAULT_ACCOUNT` to the real one). With credentials, a profile or a region loaded,
the CDK CLI calls STS and fills those in from your environment. The app looks nothing up. To be sure synth stays
offline:

```bash
env -u AWS_PROFILE -u AWS_DEFAULT_REGION AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null npm run synth
```

### Synth inputs

| Input | Kind | Effect |
|---|---|---|
| `BILLBOARD_RELEASE_MANIFEST_FILE`, `BILLBOARD_RELEASE_ID` | env | Build Lambda code from that release. Each artifact's key must be `artifacts/<logicalName>/<sha256>.zip`; a deploy run given `release_id` checks each zip's hash before synth. Without them the templates point at `<handler>.zip` keys |
| `BILLBOARD_STRICT_RELEASE=true` | env | Fail unless every Lambda comes from the manifest and every manifest artifact is used (root `npm run release:synth` sets it) |
| `BILLS_API_POLLER_RESERVED_CONCURRENCY` | env | Unset: reserve 1; `off`: none; an integer ≥ 1: that many |
| `FETCH_RAW_BILLS_RESERVED_CONCURRENCY`, `ENRICH_OFFICIAL_VOTES_RESERVED_CONCURRENCY`, `BILL_SUMMARIZER_RESERVED_CONCURRENCY` | env | Optional reservations, unset by default |
| `shareSiteSourcePath` | context | Site directory; defaults to `../website` |
| `shareSiteCustomDomain` (or the flat `shareSite*` keys) | context | The share site's custom domain |
| `monitoringSlackWorkspaceId`, `monitoringSlackChannelId` | context | Slack channel for alarms (AWS Chatbot); unset, the values in `lib/config/deployment-identity.ts`; an empty string for either turns the Chatbot configurations off |
| `monitoringSlackPageChannelId` | context | Optional second Slack channel for pages; unset, pages go to the alarm channel |
| `userApiSmokeTestSecretName`, `userApiSmokeTestFixturesSecretName`, `userApiSmokeTestWriteChecksEnabled` | context | Turn on the canary's signed-in checks (a secret holding a test account's sign-in) |

## Configuration modules

| File | What it holds |
|---|---|
| `lib/config/deployment-identity.ts` | The AWS account and region, the Route 53 hosted zone, the Slack workspace and channel, the GitHub repository allowed to deploy (`GitHubOidcStack`), and the fixed S3 bucket names. The production values, except the account: AWS's documentation example stands in for it |
| `lib/config/abuse-limits.ts` | Every anti-abuse limit, throttle, alarm threshold and switch (App Attest, the account-integrity modes, the sign-up filter and its daily check, the WAF rate rules, the unconfirmed sign-up cleanup), with the values production runs. `services/src/shared/abuseLimits.ts` mirrors some of them and `test/abuse-limits.test.ts` checks both |
| `lib/config/*-constants.ts`, `bedrock-models.ts`, `email-constants.ts` | Table, queue and function names, schedules, capacity settings, the Bedrock models, the email domain |

Every switch is read by its handler from the environment, and a value the handler does not recognise means the mild
mode (`watch`, or `plan` for the vote re-stamp), never the stricter one. A switch change is a constant change in a
pull request, with the test that pins it, plus a deploy.

## Stacks

In creation order (`bin/billboard-infra.ts`). Every Lambda has a `prod` alias, an error alarm and a CodeDeploy
deployment group in its stack.

| Stack | What it holds |
|---|---|
| `SharedInfraStack` | The Lambda artifacts bucket; the notification-type and member-stats queues (with DLQs) shared across stacks; the scheduled-job failure queue |
| `EmailStack` | The SES domain identity (Easy DKIM, custom MAIL FROM), its DNS records in the existing hosted zone, the domain's DMARC record and the configuration set for account email |
| `CongressIntegrationServiceStack` | Ingestion from congress.gov: `BillsApiPoller`, `FetchRawBill`, `EnrichOfficialVotes`, `FetchCongressMembersList`, `FetchRawCongressMembers`, their queues and the poller cursor |
| `PriorityServiceStack` | `BillPriorityResolver` (Amazon Bedrock, hourly) and the `BillPriority` table |
| `UserAPIServiceStack` | The Cognito user pool and app clients, the API Gateway REST API with its web ACL, the user-facing Lambdas (votes, preferences, district verification, App Attest, the pre-sign-up check, digests, account deletion and cleanup), and the canary |
| `ShareSiteStack` | The private site bucket, the CloudFront distribution with WAF, the SPA rewrite function, a `/public/*` behaviour proxied to the user API, the certificate, DNS records and the upload of `../website` |
| `NotificationServiceStack` | The notification pipeline (`NotificationType`, `UserMatcher`, `NotificationFanout`, `NotificationDispatcher`, `UserNotifier`), its queues and table, and the SNS platform application for APNs |
| `SummarizerServiceStack` | `BillDiffer`, `BillSummarizer` (Amazon Bedrock), `CongressMemberSummarizer` |
| `UserStoreStack` | The user tables |
| `AnalyticsServiceStack` | `CongressMemberStats`, `BillStatsAggregator` and its `UserFeedback` stream mapping |
| `CongressStoreStack` | The bill and member buckets, `BillsManifest` and `CongressMembersManifest` and the functions that build them |
| `AggregateDataStoreStack` | The member stats and profile tables |
| `MonitoringStack` | The alarm and page topics, the Slack channel configurations (AWS Chatbot), the `BillboardOps` dashboard, the operational alarms (144 metric alarms and 3 composites) and a monthly cost budget |
| `GitHubOidcStack` | Two roles `.github/workflows/deploy.yml` assumes through the account's existing GitHub OIDC provider, trusted only from this repository's `main`: one that publishes Lambda releases to the artifacts bucket, one that deploys through the CDK bootstrap roles |
| `SecurityBaselineStack` | A multi-region CloudTrail trail and its bucket, and cost-allocation tags on every stack |

Store stacks own tables, buckets and queues but grant nothing: each service stack grants its own functions access by
fixed name (`lib/stacks/helpers/data-store-refs.ts`).

## Lambda release flow

CloudFormation creates each Lambda's function, versions, `prod` alias, error alarm and CodeDeploy deployment group,
but it does not move `prod` aliases. Each alias is pinned to its live version through the SSM parameter
`/billboard/prod/lambda-alias-versions/<function>/prod`, which the template resolves at deploy time. A deploy runs:

1. `npm run release:build` at the root (deterministic zips and a manifest) and an upload of the release to the
   artifacts bucket (`../scripts/ci/publish-release.sh`);
2. `npx cdk synth --quiet` with the strict release variables;
3. `npm run release:sync-prod-alias-versions -- --templates cdk.out`;
4. `npx cdk deploy --app cdk.out --all --require-approval never --outputs-file cdk-outputs.json`;
5. `npm run release:deploy-lambdas -- --outputs cdk-outputs.json`.

Step 5 shifts API handlers 10% for 10 minutes, then 100%; queue, stream and scheduled workers shift all at once. A
function's alias error alarm rolls it back during its shift. Deterministic builds make unchanged Lambdas no-ops. For the
production service, `.github/workflows/deploy.yml` runs these steps after a `cdk diff` and the deploy guard
([../docs/DEPLOYING.md](../docs/DEPLOYING.md)).

## Monitoring

Alerts go to Slack only, through AWS Chatbot, in two tiers. Two composite alarms page (`Billboard-Page-AppBroken` and
`Billboard-Page-PushesDown`, on `BillboardPageTopic`); every other alarm in `MonitoringStack` notifies
`BillboardAlarmTopic` through `notify()` in `lib/stacks/monitoring.ts`. Nothing in code subscribes an email address, or
any other endpoint, to either topic.

The alarms: 144 metric alarms and 3 composites in `MonitoringStack`, and 198 in the app with the 51 of the service
stacks (each Lambda alias's error alarm, which its CodeDeploy deployment group watches, the API deployment groups' own
5XX and canary alarms, and the WAF sign-up alarm). `test/monitoring.test.ts` pins these totals: a pull request that
adds an alarm changes both places in this file.

## Deploying your own copy

1. Replace `lib/config/deployment-identity.ts` with your account, region, hosted zone, Slack IDs, GitHub repository
   and globally unique bucket names (the operator scripts in `../services/scripts` and
   `../scripts/ci/build-release.sh` default to the bucket names too). Review `lib/config/abuse-limits.ts`: it holds the
   production service's limits and switch positions.
2. Change the domain in `lib/config/email-constants.ts` and the share site's domain, and the App Attest app ID
   (team and bundle ID) in `../services/src/shared/appAttest/config.ts`.
3. Bootstrap the account (`npx cdk bootstrap`), create a GitHub OIDC provider if you deploy from Actions, and
   authorize your Slack workspace in AWS Chatbot.
4. Create the secrets the stacks read but do not create: `CongressAPIKey` (an api.data.gov key for Congress.gov) and
   the APNs credentials in `Billboard/ApnsCredentials`; optionally `Billboard/AppleDeviceCheckKey` (DeviceCheck) and
   a canary sign-in secret. `Billboard/DistrictVerificationHashSalt`, `Billboard/SharePublicOriginApiKey` and the
   sign-up check's probe token are generated by the stacks.
5. Request access to the Amazon Bedrock models named in `lib/config/bedrock-models.ts`.
6. Run the release flow above, from your machine or from your own copy of `.github/workflows/deploy.yml`. The workflow
   expects a protected environment named `production` with an `AWS_ACCOUNT_ID` secret, and the roles in
   `GitHubOidcStack` trust the repository named in `deployment-identity.ts`.
