import { randomUUID } from "node:crypto";
import type {
  AdminDeleteUserCommandInput,
  AdminGetUserCommandInput,
  ListUsersCommandInput,
  SignUpCommandInput,
} from "@aws-sdk/client-cognito-identity-provider";
import type { PreSignUpTriggerEvent } from "aws-lambda";

/**
 * A fake Cognito user pool shaped like BillboardUserPool (UsernameAttributes [email], self sign-up, email
 * verification by code), reached through a mocked CognitoIdentityProviderClient's send. Enough of Cognito for
 * the sign-up filter check and PreSignUpCheck to run against each other offline:
 *
 * - SignUp: the client id must match; the password must meet the pool policy (8 or more, upper, lower, digit,
 *   symbol) or InvalidPasswordException; an address another user already has is UsernameExistsException.
 *   Otherwise the PreSignUp trigger (when attached) runs with a PreSignUp_SignUp event whose userName is the
 *   new account's generated UUID; a throw from it becomes UserLambdaValidationException "PreSignUp failed
 *   with error <message>." and no user. The address is checked again once the trigger returns, so of two
 *   parallel sign-ups of one address only the first to finish creates a user (the other is
 *   UsernameExistsException). The user is created UNCONFIRMED with sub = username.
 * - Usernames and addresses are case-sensitive, as in the live pool (UsernameConfiguration unset):
 *   Filter-Probe@x and filter-probe@x are two users. ListUsers' email filter is case-sensitive here too
 *   (`listUsersCaseSensitive`), the stricter reading of what AWS leaves undocumented.
 * - AdminGetUser and AdminDeleteUser take the username (sub) or the exact email.
 * - ListUsers supports `email = "x"`, `email ^= "x"` and `cognito:user_status = "X"` (case-insensitive, as AWS
 *   documents it), AttributesToGet, Limit and pagination, and can lag (`listUsersLagMs`: users created that
 *   recently are not listed), as AWS says it may. `ignoreStatusFilter` lists every user for a status filter, to
 *   prove a caller does not rely on the filter alone.
 * - A user is enabled unless seeded with `enabled: false` (AdminGetUser and ListUsers report it as Enabled).
 * - `faults` lets a test throw instead of, or after, any call.
 */

export interface FakeUser {
  username: string;
  sub: string;
  email: string;
  status: "UNCONFIRMED" | "CONFIRMED" | "FORCE_CHANGE_PASSWORD";
  createdAt: Date;
  /** Default true. */
  enabled?: boolean;
}

/** The input of any command the fake pool answers, in Cognito's own field names. */
export type PoolInput = Partial<
  SignUpCommandInput & AdminGetUserCommandInput & AdminDeleteUserCommandInput & ListUsersCommandInput
>;
export type PoolCall = { name: string; input: PoolInput };
export type Trigger = (event: PreSignUpTriggerEvent) => Promise<unknown>;

export const cognitoError = (name: string, message = `${name} from the fake pool`): Error =>
  Object.assign(new Error(message), { name });

const PASSWORD_SYMBOLS = /[\^$*.[\]{}()?"!@#%&/\\,><':;|_~`=+\- ]/;

export const meetsPasswordPolicy = (password: unknown): boolean =>
  typeof password === "string" &&
  password.length >= 8 &&
  /[A-Z]/.test(password) &&
  /[a-z]/.test(password) &&
  /[0-9]/.test(password) &&
  PASSWORD_SYMBOLS.test(password);

export interface FakePoolFaults {
  /** Runs before a SignUp for this address; may throw (TooManyRequests, a timeout, ...). */
  beforeSignUp?: (address: string) => Promise<void> | void;
  /** Runs after a SignUp created its user; a throw here is CodeDeliveryFailure-style (the user stays). */
  afterSignUp?: (address: string, user: FakeUser) => void;
  /** Runs before AdminDeleteUser; may throw. */
  beforeDelete?: (username: string) => void;
  /** Runs before AdminGetUser; may throw. */
  beforeGet?: (username: string) => void;
}

export class FakeCognitoPool {
  readonly users = new Map<string, FakeUser>();
  readonly calls: PoolCall[] = [];
  /** Every password SignUp was given, so tests can check no log line holds one. */
  readonly passwords: string[] = [];
  /** Every sub this pool ever gave out (seeded or signed up), so tests can check no log line holds one. */
  readonly subs: string[] = [];
  /** Each SignUp's address and what it answered: the new sub, or the error's name and message. */
  readonly signUpResults: Array<{ address: string; sub?: string; error?: { name: string; message: string } }> = [];
  trigger: Trigger | null = null;
  faults: FakePoolFaults = {};
  listUsersLagMs = 0;
  listUsersCaseSensitive = true;
  ignoreStatusFilter = false;

  constructor(
    readonly userPoolId: string,
    readonly clientId: string,
    readonly now: () => number = Date.now,
  ) {}

  seed(input: Partial<FakeUser> & { email: string }): FakeUser {
    const sub = input.sub ?? randomUUID();
    this.subs.push(sub);
    const user: FakeUser = {
      username: input.username ?? sub,
      sub,
      email: input.email,
      status: input.status ?? "CONFIRMED",
      createdAt: input.createdAt ?? new Date(this.now()),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    };
    this.users.set(user.username, user);
    return user;
  }

  find(usernameOrEmail: string): FakeUser | undefined {
    return this.users.get(usernameOrEmail) ?? [...this.users.values()].find((user) => user.email === usernameOrEmail);
  }

  usernames(): string[] {
    return [...this.users.keys()].sort();
  }

  callsNamed(name: string): PoolCall[] {
    return this.calls.filter((call) => call.name === name);
  }

  send = async (command: { constructor: { name: string }; input: PoolInput }, _options?: unknown): Promise<unknown> => {
    const call: PoolCall = { name: command.constructor.name, input: command.input };
    this.calls.push(call);
    if (call.name !== "SignUpCommand" && call.input.UserPoolId !== this.userPoolId) {
      throw cognitoError("ResourceNotFoundException");
    }
    switch (call.name) {
      case "SignUpCommand":
        try {
          const response = (await this.signUp(call.input as SignUpCommandInput)) as { UserSub: string };
          this.signUpResults.push({ address: call.input.Username!, sub: response.UserSub });
          return response;
        } catch (error) {
          const { name, message } = error as Error;
          this.signUpResults.push({ address: call.input.Username!, error: { name, message } });
          throw error;
        }
      case "AdminGetUserCommand":
        return this.adminGetUser(call.input.Username!);
      case "AdminDeleteUserCommand":
        return this.adminDeleteUser(call.input.Username!);
      case "ListUsersCommand":
        return this.listUsers(call.input);
      default:
        throw new Error(`Unexpected Cognito command ${call.name}`);
    }
  };

  private assertAddressFree(address: string): void {
    if ([...this.users.values()].some((user) => user.email === address)) {
      throw cognitoError("UsernameExistsException", "An account with the given email already exists.");
    }
  }

  private async signUp(input: SignUpCommandInput): Promise<unknown> {
    if (input.ClientId !== this.clientId) throw cognitoError("ResourceNotFoundException");
    const address = input.Username!;
    const email = (input.UserAttributes ?? []).find((attribute) => attribute.Name === "email")?.Value;
    if (email !== address) throw cognitoError("InvalidParameterException");
    this.passwords.push(String(input.Password));
    if (!meetsPasswordPolicy(input.Password)) throw cognitoError("InvalidPasswordException");
    await this.faults.beforeSignUp?.(address);
    this.assertAddressFree(address);
    const sub = randomUUID();
    this.subs.push(sub);
    if (this.trigger) {
      const event = {
        version: "1",
        region: "us-east-1",
        userPoolId: this.userPoolId,
        userName: sub,
        callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: this.clientId },
        triggerSource: "PreSignUp_SignUp",
        request: {
          userAttributes: { email },
          ...(input.ClientMetadata ? { clientMetadata: input.ClientMetadata } : {}),
        },
        response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
      } as PreSignUpTriggerEvent;
      try {
        await this.trigger(event);
      } catch (error) {
        throw cognitoError(
          "UserLambdaValidationException",
          `PreSignUp failed with error ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    }
    this.assertAddressFree(address);
    const user: FakeUser = { username: sub, sub, email, status: "UNCONFIRMED", createdAt: new Date(this.now()) };
    this.users.set(sub, user);
    this.faults.afterSignUp?.(address, user);
    return {
      UserSub: sub,
      UserConfirmed: false,
      CodeDeliveryDetails: { DeliveryMedium: "EMAIL", AttributeName: "email", Destination: "s***@b***" },
    };
  }

  private attributesOf(user: FakeUser): Array<{ Name: string; Value: string }> {
    return [
      { Name: "sub", Value: user.sub },
      { Name: "email", Value: user.email },
      { Name: "email_verified", Value: String(user.status === "CONFIRMED") },
    ];
  }

  private adminGetUser(username: string): unknown {
    this.faults.beforeGet?.(username);
    const user = this.find(username);
    if (!user) throw cognitoError("UserNotFoundException", "User does not exist.");
    return {
      Username: user.username,
      UserAttributes: this.attributesOf(user),
      UserStatus: user.status,
      UserCreateDate: new Date(user.createdAt),
      Enabled: user.enabled ?? true,
    };
  }

  private adminDeleteUser(username: string): unknown {
    this.faults.beforeDelete?.(username);
    const user = this.find(username);
    if (!user) throw cognitoError("UserNotFoundException", "User does not exist.");
    this.users.delete(user.username);
    return {};
  }

  private listUsers(input: PoolInput): unknown {
    const match = /^email\s*(\^=|=)\s*"([^"]*)"$/.exec(String(input.Filter ?? ""));
    const status = /^cognito:user_status\s*=\s*"([^"]*)"$/.exec(String(input.Filter ?? ""));
    if (input.Filter !== undefined && !match && !status) throw cognitoError("InvalidParameterException");
    const fold = (value: string) => (this.listUsersCaseSensitive ? value : value.toLowerCase());
    const visible = [...this.users.values()]
      .filter((user) => this.now() - user.createdAt.getTime() >= this.listUsersLagMs)
      .filter((user) => {
        if (status) return this.ignoreStatusFilter || user.status.toLowerCase() === status[1].toLowerCase();
        if (!match) return true;
        const [, operator, value] = match;
        return operator === "=" ? fold(user.email) === fold(value) : fold(user.email).startsWith(fold(value));
      })
      .sort((left, right) => left.username.localeCompare(right.username));
    const start = input.PaginationToken ? Number(input.PaginationToken) : 0;
    const limit = input.Limit ?? 60;
    const page = visible.slice(start, start + limit);
    const wanted: string[] | undefined = input.AttributesToGet;
    return {
      Users: page.map((user) => ({
        Username: user.username,
        Attributes: this.attributesOf(user).filter((attribute) => !wanted || wanted.includes(attribute.Name)),
        UserStatus: user.status,
        UserCreateDate: new Date(user.createdAt),
        Enabled: user.enabled ?? true,
      })),
      ...(start + limit < visible.length ? { PaginationToken: String(start + limit) } : {}),
    };
  }
}
