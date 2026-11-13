import {
  AdminDeleteUserAttributesCommand,
  type CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";

/**
 * The profile attributes that apps 1.1 and earlier wrote and nothing reads (UX-36; project decisions 2026-10-29 and
 * 2026-11-12, WEB-07): political party (`custom:politicalParty`, from Profile > About you and the first-vote sheet),
 * gender and birth date (the standard `gender` and `birthdate`; 1.1 stored a birth year as YYYY-01-01). The app writes
 * them straight to Cognito with Amplify's `updateUserAttribute`, each in its own UpdateUserAttributes call, so no
 * Billboard function sees the write. App 1.2 neither shows nor writes them, and the nightly export never copies them.
 *
 * The app client is left free to write them on purpose. Taking them out of its writable attributes would make Cognito
 * refuse the call, and 1.1 then fails its whole save: onboarding stops before the topics and members are saved when a
 * party was picked, and Profile > About you before the district is saved. Instead the nightly `ExportCognitoUsers`
 * run deletes them from every user who holds one (`RETIRED_PROFILE_ATTRIBUTES_MODE` 'clear'), and
 * `npm run clear:stored-party` deletes the values stored before that (docs/RUNBOOK.md 25.2).
 */
export const RETIRED_PROFILE_ATTRIBUTES = ["custom:politicalParty", "gender", "birthdate"] as const;
export type RetiredProfileAttribute = (typeof RETIRED_PROFILE_ATTRIBUTES)[number];
export type RetiredAttributeCounts = Record<RetiredProfileAttribute, number>;

/** The CloudWatch namespace of the export's counts, shared with CleanupOrphanedUsers' account metrics. */
export const RETIRED_ATTRIBUTES_METRIC_NAMESPACE = "BillBoard/Accounts";
export const RETIRED_ATTRIBUTES_HELD_METRIC = "RetiredProfileAttributesHeld";
export const RETIRED_ATTRIBUTES_CLEARED_METRIC = "RetiredProfileAttributesCleared";
export const RETIRED_ATTRIBUTES_CLEAR_FAILED_METRIC = "RetiredProfileAttributesClearFailed";

/** One user who holds at least one retired attribute. The user name is used for the delete and never logged. */
export interface RetiredAttributeHolder {
  userName: string;
  held: RetiredProfileAttribute[];
}

export interface RetiredAttributeTally {
  /** Users holding at least one retired attribute. */
  holding: number;
  /** Users holding each attribute. */
  byAttribute: RetiredAttributeCounts;
}

export interface RetiredAttributeClearResult {
  cleared: number;
  failed: number;
  /** Error name to count, for the failed users; no user is named. */
  errorNames: Record<string, number>;
}

type CognitoSend = Pick<CognitoIdentityProviderClient, "send">;

const LIST_USERS_PAGE_SIZE = 60;

/**
 * The retired attributes a listed user holds, in RETIRED_PROFILE_ATTRIBUTES order. Cognito keeps no blank value (1.1
 * cleared one by writing ""), so an attribute that is listed is held.
 */
export const retiredAttributesHeld = (user: Pick<UserType, "Attributes">): RetiredProfileAttribute[] => {
  const names = new Set((user.Attributes ?? []).map((attribute) => attribute.Name));
  return RETIRED_PROFILE_ATTRIBUTES.filter((name) => names.has(name));
};

/** The user as a holder, or null when they hold none of the retired attributes. */
export const retiredAttributeHolder = (user: UserType): RetiredAttributeHolder | null => {
  const held = retiredAttributesHeld(user);
  return held.length > 0 ? { userName: user.Username ?? "", held } : null;
};

export const tallyRetiredAttributes = (holders: readonly RetiredAttributeHolder[]): RetiredAttributeTally => {
  const byAttribute = Object.fromEntries(RETIRED_PROFILE_ATTRIBUTES.map((name) => [name, 0])) as RetiredAttributeCounts;
  for (const holder of holders) {
    for (const name of holder.held) byAttribute[name] += 1;
  }
  return { holding: holders.length, byAttribute };
};

/**
 * Every user of the pool, and those holding a retired attribute. ListUsers answers each user with all its attributes:
 * a request naming these attributes in AttributesToGet was refused (InvalidParameterException, 2026-11-11), so the
 * full list is read and only the user name and these names are kept.
 */
export const listRetiredAttributeHolders = async (
  cognito: CognitoSend,
  userPoolId: string,
): Promise<{ users: number; holders: RetiredAttributeHolder[] }> => {
  let users = 0;
  const holders: RetiredAttributeHolder[] = [];
  let paginationToken: string | undefined;
  do {
    const page = await cognito.send(
      new ListUsersCommand({ UserPoolId: userPoolId, Limit: LIST_USERS_PAGE_SIZE, PaginationToken: paginationToken }),
    );
    for (const user of page.Users ?? []) {
      users += 1;
      const holder = retiredAttributeHolder(user);
      if (holder) holders.push(holder);
    }
    paginationToken = page.PaginationToken;
  } while (paginationToken);
  return { users, holders };
};

const errorNameOf = (error: unknown): string =>
  error instanceof Error && error.name ? error.name : typeof error === "string" ? "Error" : "UnknownError";

/**
 * Deletes each holder's retired attributes, one user at a time: AdminDeleteUserAttributes with exactly the names that
 * user holds, never another attribute. A failure is counted by its error name and the next user is tried. Deleting an
 * attribute the user no longer holds succeeds, so a rerun is safe.
 */
export const clearRetiredAttributes = async (
  cognito: CognitoSend,
  userPoolId: string,
  holders: readonly RetiredAttributeHolder[],
): Promise<RetiredAttributeClearResult> => {
  const result: RetiredAttributeClearResult = { cleared: 0, failed: 0, errorNames: {} };
  for (const holder of holders) {
    const names = holder.held.filter((name) => (RETIRED_PROFILE_ATTRIBUTES as readonly string[]).includes(name));
    try {
      if (!holder.userName) throw Object.assign(new Error("The listed user has no user name"), { name: "NoUserName" });
      if (names.length === 0) continue;
      await cognito.send(
        new AdminDeleteUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: holder.userName,
          UserAttributeNames: names,
        }),
      );
      result.cleared += 1;
    } catch (error) {
      const name = errorNameOf(error);
      result.failed += 1;
      result.errorNames[name] = (result.errorNames[name] ?? 0) + 1;
    }
  }
  return result;
};
