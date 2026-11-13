import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { gzipSync } from "zlib";
import { emitEmbeddedMetrics } from "../../shared/metrics";
import {
  RETIRED_ATTRIBUTES_CLEAR_FAILED_METRIC,
  RETIRED_ATTRIBUTES_CLEARED_METRIC,
  RETIRED_ATTRIBUTES_HELD_METRIC,
  RETIRED_ATTRIBUTES_METRIC_NAMESPACE,
  type RetiredAttributeCounts,
  type RetiredAttributeHolder,
  clearRetiredAttributes,
  retiredAttributeHolder,
  tallyRetiredAttributes,
} from "../../shared/retiredProfileAttributes";

// Nightly export of the Cognito user pool (REC-02). Password hashes cannot be exported from
// Cognito, so this is what lets people be re-invited if the pool is ever lost or replaced.
// Each line is one user: the sub, email and account state that re-inviting needs, plus
// custom:state and custom:district so a restored account keeps its representatives. Nothing
// else is copied: not custom:politicalParty (political opinion is special-category data), not
// the optional standard attributes (gender, birthdate, name, address, phone), and not any
// custom attribute added later. ListUsers returns no tokens or password material. The bucket
// keeps each export for 14 days (UserAPIServiceStack).
//
// UX-36 (WEB-07): after the export is written, the same run deletes the retired profile attributes (political party,
// gender and birth date, shared/retiredProfileAttributes.ts) from every listed user who holds one, so a value an app
// 1.1 save writes is gone within a day. RETIRED_PROFILE_ATTRIBUTES_MODE 'clear' deletes; any other value only counts.
// The summary and the metrics give counts only, never a user. A failed delete fails the run after the export is
// written, so the Errors alarm fires and Lambda's retries run the export and the deletes again (docs/RUNBOOK.md 25.2).

const USER_POOL_ID = process.env.USER_POOL_ID;
const EXPORT_BUCKET = process.env.EXPORT_BUCKET;
const RETIRED_ATTRIBUTES_MODE: "clear" | "count" =
  process.env.RETIRED_PROFILE_ATTRIBUTES_MODE === "clear" ? "clear" : "count";

const EXPORT_PREFIX = "cognito-users/";
// ListUsers returns at most 60 users per page.
const LIST_USERS_PAGE_SIZE = 60;
// An allowlist, so a custom attribute added to the pool later is not exported by default.
const EXPORTED_CUSTOM_ATTRIBUTES = ["custom:district", "custom:state"] as const;
type ExportedCustomAttribute = (typeof EXPORTED_CUSTOM_ATTRIBUTES)[number];

const cognito = new CognitoIdentityProviderClient({});
const s3 = new S3Client({});

// Custom attributes keep their Cognito names (for example "custom:state"), which are also the
// column names Cognito's CSV user import expects. A user without one has no such key.
type ExportedCognitoUser = {
  sub: string | null;
  email: string | null;
  email_verified: boolean | null;
  status: string | null;
  enabled: boolean | null;
  created: string | null;
} & Partial<Record<ExportedCustomAttribute, string>>;

type RetiredAttributesSummary = {
  mode: "clear" | "count";
  /** Users holding at least one retired attribute when the pool was listed. */
  holding: number;
  byAttribute: RetiredAttributeCounts;
  cleared: number;
  failed: number;
  errorNames: Record<string, number>;
};

type CognitoUserExportSummary = {
  bucket: string;
  key: string;
  users: number;
  pages: number;
  byStatus: Record<string, number>;
  bytes: number;
  retiredAttributes: RetiredAttributesSummary;
};

const toIsoString = (value: Date | undefined): string | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;

const toBoolean = (value: string | undefined): boolean | null =>
  value === "true" ? true : value === "false" ? false : null;

const toExportedUser = (user: UserType): ExportedCognitoUser => {
  const attributes = new Map<string, string>();
  for (const attribute of user.Attributes ?? []) {
    if (attribute.Name && attribute.Value !== undefined) attributes.set(attribute.Name, attribute.Value);
  }

  const exported: ExportedCognitoUser = {
    sub: attributes.get("sub") ?? null,
    email: attributes.get("email") ?? null,
    email_verified: toBoolean(attributes.get("email_verified")),
    status: user.UserStatus ?? null,
    enabled: typeof user.Enabled === "boolean" ? user.Enabled : null,
    created: toIsoString(user.UserCreateDate),
  };
  for (const name of EXPORTED_CUSTOM_ATTRIBUTES) {
    const value = attributes.get(name);
    if (value !== undefined) exported[name] = value;
  }
  return exported;
};

// UTC date of the run, so one object per day; a rerun on the same day replaces that day's object.
const exportKeyFor = (now: Date): string => `${EXPORT_PREFIX}${now.toISOString().slice(0, 10)}.jsonl.gz`;

export const handler = async (): Promise<CognitoUserExportSummary> => {
  if (!USER_POOL_ID) throw new Error("Missing env var USER_POOL_ID");
  if (!EXPORT_BUCKET) throw new Error("Missing env var EXPORT_BUCKET");

  const lines: string[] = [];
  const byStatus: Record<string, number> = {};
  const holders: RetiredAttributeHolder[] = [];
  let pages = 0;
  let paginationToken: string | undefined;

  do {
    const response = await cognito.send(
      new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        Limit: LIST_USERS_PAGE_SIZE,
        PaginationToken: paginationToken,
      }),
    );
    pages += 1;

    for (const user of response.Users ?? []) {
      const exported = toExportedUser(user);
      const status = exported.status ?? "UNKNOWN";
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      lines.push(JSON.stringify(exported));
      const holder = retiredAttributeHolder(user);
      if (holder) holders.push(holder);
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  if (lines.length === 0) {
    console.warn("Cognito user pool listed no users; writing an empty export", { userPoolId: USER_POOL_ID });
  }

  const key = exportKeyFor(new Date());
  const body = gzipSync(lines.length > 0 ? `${lines.join("\n")}\n` : "");

  await s3.send(
    new PutObjectCommand({
      Bucket: EXPORT_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/gzip",
    }),
  );

  const tally = tallyRetiredAttributes(holders);
  const cleared =
    RETIRED_ATTRIBUTES_MODE === "clear" && holders.length > 0
      ? await clearRetiredAttributes(cognito, USER_POOL_ID, holders)
      : { cleared: 0, failed: 0, errorNames: {} };

  const summary: CognitoUserExportSummary = {
    bucket: EXPORT_BUCKET,
    key,
    users: lines.length,
    pages,
    byStatus,
    bytes: body.length,
    retiredAttributes: { mode: RETIRED_ATTRIBUTES_MODE, ...tally, ...cleared },
  };
  console.log("Exported Cognito users", summary);
  emitEmbeddedMetrics(
    RETIRED_ATTRIBUTES_METRIC_NAMESPACE,
    [
      { name: RETIRED_ATTRIBUTES_HELD_METRIC, value: tally.holding },
      { name: RETIRED_ATTRIBUTES_CLEARED_METRIC, value: cleared.cleared },
      { name: RETIRED_ATTRIBUTES_CLEAR_FAILED_METRIC, value: cleared.failed },
    ],
    { properties: { retiredAttributesMode: RETIRED_ATTRIBUTES_MODE } },
  );
  if (cleared.failed > 0) {
    throw new Error(
      `The export is written, but the retired profile attributes of ${cleared.failed} user(s) could not be deleted ` +
        `(${Object.entries(cleared.errorNames)
          .map(([name, count]) => `${name}: ${count}`)
          .join(", ")})`,
    );
  }
  return summary;
};
