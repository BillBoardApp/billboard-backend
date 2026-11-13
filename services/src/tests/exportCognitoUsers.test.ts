import type { ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { gunzipSync } from "zlib";
import { applyTestEnv } from "./fixtures/env";

// Declared outside the factories so the handler, loaded in an isolated registry, shares them.
const mockCognitoSend = jest.fn();
const mockS3Send = jest.fn();

jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  ...jest.requireActual("@aws-sdk/client-cognito-identity-provider"),
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
}));

jest.mock("@aws-sdk/client-s3", () => ({
  ...jest.requireActual("@aws-sdk/client-s3"),
  S3Client: jest.fn(() => ({ send: mockS3Send })),
}));

type Handler = () => Promise<{
  bucket: string;
  key: string;
  users: number;
  pages: number;
  byStatus: Record<string, number>;
  bytes: number;
  retiredAttributes: {
    mode: string;
    holding: number;
    byAttribute: Record<string, number>;
    cleared: number;
    failed: number;
    errorNames: Record<string, number>;
  };
}>;

const NO_RETIRED_ATTRIBUTES = {
  mode: "count",
  holding: 0,
  byAttribute: { "custom:politicalParty": 0, gender: 0, birthdate: 0 },
  cleared: 0,
  failed: 0,
  errorNames: {},
};

let restoreEnv: (() => void) | undefined;

const loadHandler = (env: Record<string, string | undefined>): Handler => {
  restoreEnv?.();
  restoreEnv = applyTestEnv(env);
  let handler: Handler | undefined;
  jest.isolateModules(() => {
    handler = require("../handlers/exportCognitoUsers").handler;
  });
  return handler!;
};

const cognitoUser = (sub: string, overrides: Record<string, unknown> = {}) => ({
  Username: sub,
  Enabled: true,
  UserStatus: "CONFIRMED",
  UserCreateDate: new Date("2026-03-01T12:00:00.000Z"),
  UserLastModifiedDate: new Date("2026-03-02T12:00:00.000Z"),
  Attributes: [
    { Name: "sub", Value: sub },
    { Name: "email", Value: `${sub}@example.com` },
    { Name: "email_verified", Value: "true" },
  ],
  ...overrides,
});

const exportedLines = (): Array<Record<string, unknown>> => {
  const body: Buffer = mockS3Send.mock.calls[0][0].input.Body;
  return gunzipSync(body)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
};

describe("exportCognitoUsers handler (REC-02)", () => {
  beforeEach(() => {
    mockCognitoSend.mockReset();
    mockS3Send.mockReset();
    mockS3Send.mockResolvedValue({});
    jest.useFakeTimers({ now: new Date("2026-09-24T03:15:00.000Z"), doNotFake: ["nextTick", "setImmediate"] });
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    restoreEnv?.();
    restoreEnv = undefined;
  });

  it("pages through ListUsers and writes one gzipped JSON line per user under cognito-users/<date>", async () => {
    const handler = loadHandler({ USER_POOL_ID: "us-east-1_pool", EXPORT_BUCKET: "billboard-cognito-export" });
    mockCognitoSend
      .mockResolvedValueOnce({ Users: [cognitoUser("u-1"), cognitoUser("u-2")], PaginationToken: "page-2" })
      .mockResolvedValueOnce({
        Users: [cognitoUser("u-3", { UserStatus: "UNCONFIRMED", Enabled: false })],
      });

    const summary = await handler();

    const listInputs = mockCognitoSend.mock.calls.map(([command]: [ListUsersCommand]) => command.input);
    expect(listInputs).toEqual([
      { UserPoolId: "us-east-1_pool", Limit: 60, PaginationToken: undefined },
      { UserPoolId: "us-east-1_pool", Limit: 60, PaginationToken: "page-2" },
    ]);

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const put = mockS3Send.mock.calls[0][0].input;
    expect(put).toMatchObject({
      Bucket: "billboard-cognito-export",
      Key: "cognito-users/2026-09-24.jsonl.gz",
      ContentType: "application/gzip",
    });
    expect(exportedLines().map((line) => line.sub)).toEqual(["u-1", "u-2", "u-3"]);
    expect(exportedLines()[2]).toEqual({
      sub: "u-3",
      email: "u-3@example.com",
      email_verified: true,
      status: "UNCONFIRMED",
      enabled: false,
      created: "2026-03-01T12:00:00.000Z",
    });

    expect(summary).toEqual({
      bucket: "billboard-cognito-export",
      key: "cognito-users/2026-09-24.jsonl.gz",
      users: 3,
      pages: 2,
      byStatus: { CONFIRMED: 2, UNCONFIRMED: 1 },
      bytes: put.Body.length,
      retiredAttributes: NO_RETIRED_ATTRIBUTES,
    });
    expect(console.log).toHaveBeenCalledWith("Exported Cognito users", summary);
  });

  it("keeps state and district, and drops political party and every other attribute (REC-02)", async () => {
    const handler = loadHandler({ USER_POOL_ID: "us-east-1_pool", EXPORT_BUCKET: "billboard-cognito-export" });
    mockCognitoSend.mockResolvedValueOnce({
      Users: [
        cognitoUser("u-1", {
          Attributes: [
            { Name: "sub", Value: "u-1" },
            { Name: "email", Value: "u-1@example.com" },
            { Name: "email_verified", Value: "false" },
            { Name: "custom:state", Value: "VA" },
            { Name: "custom:politicalParty", Value: "Independent" },
            { Name: "custom:district", Value: "08" },
            { Name: "custom:birthYear", Value: "1987" },
            { Name: "gender", Value: "Nonbinary" },
            { Name: "birthdate", Value: "1987-05-04" },
            { Name: "address", Value: "1 Main St" },
            { Name: "given_name", Value: "Pat" },
            { Name: "family_name", Value: "Doe" },
            { Name: "phone_number", Value: "+15555550100" },
          ],
          MFAOptions: [{ DeliveryMedium: "SMS", AttributeName: "phone_number" }],
        }),
      ],
    });

    await handler();

    const [line] = exportedLines();
    expect(line).toEqual({
      sub: "u-1",
      email: "u-1@example.com",
      email_verified: false,
      status: "CONFIRMED",
      enabled: true,
      created: "2026-03-01T12:00:00.000Z",
      "custom:district": "08",
      "custom:state": "VA",
    });
    const raw = gunzipSync(mockS3Send.mock.calls[0][0].input.Body).toString("utf8");
    for (const dropped of [
      "politicalParty",
      "Independent",
      "birthYear",
      "1987",
      "Nonbinary",
      "1 Main St",
      "Pat",
      "Doe",
      "+15555550100",
      "MFAOptions",
      "Username",
      "LastModified",
    ]) {
      expect(raw).not.toContain(dropped);
    }
  });

  it("writes nulls for fields Cognito leaves out", async () => {
    const handler = loadHandler({ USER_POOL_ID: "us-east-1_pool", EXPORT_BUCKET: "billboard-cognito-export" });
    mockCognitoSend.mockResolvedValueOnce({ Users: [{ Username: "u-9" }] });

    await handler();

    expect(exportedLines()).toEqual([
      { sub: null, email: null, email_verified: null, status: null, enabled: null, created: null },
    ]);
  });

  it("writes an empty export and warns when the pool lists no users", async () => {
    const handler = loadHandler({ USER_POOL_ID: "us-east-1_pool", EXPORT_BUCKET: "billboard-cognito-export" });
    mockCognitoSend.mockResolvedValueOnce({ Users: [] });

    const summary = await handler();

    expect(summary.users).toBe(0);
    expect(exportedLines()).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith("Cognito user pool listed no users; writing an empty export", {
      userPoolId: "us-east-1_pool",
    });
  });

  it("fails without writing anything when ListUsers fails", async () => {
    const handler = loadHandler({ USER_POOL_ID: "us-east-1_pool", EXPORT_BUCKET: "billboard-cognito-export" });
    mockCognitoSend
      .mockResolvedValueOnce({ Users: [cognitoUser("u-1")], PaginationToken: "page-2" })
      .mockRejectedValueOnce(new Error("TooManyRequestsException"));

    await expect(handler()).rejects.toThrow("TooManyRequestsException");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("propagates an S3 write failure so the invocation errors", async () => {
    const handler = loadHandler({ USER_POOL_ID: "us-east-1_pool", EXPORT_BUCKET: "billboard-cognito-export" });
    mockCognitoSend.mockResolvedValueOnce({ Users: [cognitoUser("u-1")] });
    mockS3Send.mockReset();
    mockS3Send.mockRejectedValueOnce(new Error("AccessDenied"));

    await expect(handler()).rejects.toThrow("AccessDenied");
  });

  it.each([
    [{ USER_POOL_ID: undefined, EXPORT_BUCKET: "billboard-cognito-export" }, "Missing env var USER_POOL_ID"],
    [{ USER_POOL_ID: "us-east-1_pool", EXPORT_BUCKET: undefined }, "Missing env var EXPORT_BUCKET"],
  ])("refuses to run without its configuration (%p)", async (env, message) => {
    const handler = loadHandler(env);

    await expect(handler()).rejects.toThrow(message);
    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

// UX-36 (WEB-07): after the export, the run deletes political party, gender and birth date from the users who hold
// one, with RETIRED_PROFILE_ATTRIBUTES_MODE 'clear' only, and never names a user.
describe("exportCognitoUsers: the retired profile attributes (UX-36)", () => {
  const POOL_ENV = { USER_POOL_ID: "us-east-1_pool", EXPORT_BUCKET: "billboard-cognito-export" };
  const withAttributes = (sub: string, extra: Array<{ Name: string; Value: string }>) =>
    cognitoUser(sub, {
      Attributes: [
        { Name: "sub", Value: sub },
        { Name: "email", Value: `${sub}@example.com` },
        { Name: "custom:state", Value: "VA" },
        { Name: "custom:district", Value: "08" },
        ...extra,
      ],
    });
  const users = () => [
    withAttributes("u-party", [{ Name: "custom:politicalParty", Value: "Independent" }]),
    withAttributes("u-plain", []),
    withAttributes("u-all", [
      { Name: "gender", Value: "Nonbinary" },
      { Name: "custom:politicalParty", Value: "Green" },
      { Name: "birthdate", Value: "1987-01-01" },
    ]),
  ];
  const callsNamed = (name: string) =>
    mockCognitoSend.mock.calls
      .map(([command]) => command)
      .filter((command) => command.constructor.name === name)
      .map((command) => command.input);
  let order: string[];

  beforeEach(() => {
    order = [];
    mockCognitoSend.mockReset();
    mockS3Send.mockReset();
    mockS3Send.mockImplementation(async () => {
      order.push("PutObject");
      return {};
    });
    jest.useFakeTimers({ now: new Date("2026-12-02T08:00:00.000Z"), doNotFake: ["nextTick", "setImmediate"] });
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    restoreEnv?.();
    restoreEnv = undefined;
  });

  const respond = (failFor: string | null = null) =>
    mockCognitoSend.mockImplementation(
      async (command: { constructor: { name: string }; input: { Username?: string } }) => {
        order.push(command.constructor.name);
        if (command.constructor.name === "ListUsersCommand") return { Users: users() };
        if (command.input.Username === failFor) {
          throw Object.assign(new Error(`User ${failFor} could not be updated`), { name: "TooManyRequestsException" });
        }
        return {};
      },
    );

  const loggedText = (): string => (console.log as jest.Mock).mock.calls.map((call) => JSON.stringify(call)).join("\n");

  it("only counts them when the mode is not 'clear', and deletes nothing", async () => {
    const handler = loadHandler({ ...POOL_ENV, RETIRED_PROFILE_ATTRIBUTES_MODE: "count" });
    respond();

    const summary = await handler();

    expect(callsNamed("AdminDeleteUserAttributesCommand")).toEqual([]);
    expect(summary.retiredAttributes).toEqual({
      mode: "count",
      holding: 2,
      byAttribute: { "custom:politicalParty": 2, gender: 1, birthdate: 1 },
      cleared: 0,
      failed: 0,
      errorNames: {},
    });
  });

  it("reads an unset or unknown mode as count", async () => {
    for (const mode of [undefined, "CLEAR", "on"]) {
      const handler = loadHandler({ ...POOL_ENV, RETIRED_PROFILE_ATTRIBUTES_MODE: mode });
      mockCognitoSend.mockReset();
      respond();
      const summary = await handler();
      expect(summary.retiredAttributes.mode).toBe("count");
      expect(callsNamed("AdminDeleteUserAttributesCommand")).toEqual([]);
    }
  });

  it("with 'clear', deletes exactly the names each holder holds, after the export is written", async () => {
    const handler = loadHandler({ ...POOL_ENV, RETIRED_PROFILE_ATTRIBUTES_MODE: "clear" });
    respond();

    const summary = await handler();

    expect(callsNamed("AdminDeleteUserAttributesCommand")).toEqual([
      { UserPoolId: "us-east-1_pool", Username: "u-party", UserAttributeNames: ["custom:politicalParty"] },
      {
        UserPoolId: "us-east-1_pool",
        Username: "u-all",
        UserAttributeNames: ["custom:politicalParty", "gender", "birthdate"],
      },
    ]);
    expect(order).toEqual([
      "ListUsersCommand",
      "PutObject",
      "AdminDeleteUserAttributesCommand",
      "AdminDeleteUserAttributesCommand",
    ]);
    expect(summary.retiredAttributes).toEqual({
      mode: "clear",
      holding: 2,
      byAttribute: { "custom:politicalParty": 2, gender: 1, birthdate: 1 },
      cleared: 2,
      failed: 0,
      errorNames: {},
    });
    // The export still leaves them out, and the logs name no user and no value.
    const raw = gunzipSync(mockS3Send.mock.calls[0][0].input.Body).toString("utf8");
    expect(raw).not.toMatch(/politicalParty|Independent|Green|Nonbinary|1987/);
    const logged = loggedText();
    for (const secret of ["u-party", "u-all", "u-plain", "example.com", "Independent", "Green", "Nonbinary", "1987"]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain("RetiredProfileAttributesHeld");
    expect(logged).toContain("RetiredProfileAttributesCleared");
  });

  it("with 'clear' and nobody holding one, makes no delete call", async () => {
    const handler = loadHandler({ ...POOL_ENV, RETIRED_PROFILE_ATTRIBUTES_MODE: "clear" });
    mockCognitoSend.mockResolvedValueOnce({ Users: [withAttributes("u-plain", [])] });

    const summary = await handler();

    expect(mockCognitoSend).toHaveBeenCalledTimes(1);
    expect(summary.retiredAttributes).toEqual({ ...NO_RETIRED_ATTRIBUTES, mode: "clear" });
  });

  it("with 'clear', a failed delete fails the run after the export, still tries the others, and names no user", async () => {
    const handler = loadHandler({ ...POOL_ENV, RETIRED_PROFILE_ATTRIBUTES_MODE: "clear" });
    respond("u-party");

    const run = handler();

    await expect(run).rejects.toThrow(
      "The export is written, but the retired profile attributes of 1 user(s) could not be deleted (TooManyRequestsException: 1)",
    );
    await run.catch((error: Error) => expect(error.message).not.toContain("u-party"));
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(callsNamed("AdminDeleteUserAttributesCommand").map((input) => input.Username)).toEqual(["u-party", "u-all"]);
    expect(console.log).toHaveBeenCalledWith(
      "Exported Cognito users",
      expect.objectContaining({
        retiredAttributes: expect.objectContaining({
          cleared: 1,
          failed: 1,
          errorNames: { TooManyRequestsException: 1 },
        }),
      }),
    );
    expect(loggedText()).not.toContain("u-party");
  });
});
