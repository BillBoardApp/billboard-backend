import type {
  AttributeValue,
  BatchGetItemCommandInput,
  GetItemCommandInput,
  KeysAndAttributes,
  QueryCommandInput,
  TransactWriteItemsCommandInput,
  UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";

/** The global fetch the handler calls, which the tests replace with a jest mock. */
const fetchMock = () => global.fetch as jest.Mock;

jest.mock("@aws-sdk/client-secrets-manager", () => {
  const mockSend = jest.fn();
  return {
    SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
    GetSecretValueCommand: jest.fn((input) => ({ input })),
    __mockSecretsSend: mockSend,
  };
});

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
  };
});

jest.mock("@aws-sdk/client-sqs", () => {
  const actual = jest.requireActual("@aws-sdk/client-sqs");
  const mockSend = jest.fn();
  return {
    ...actual,
    SQSClient: jest.fn(() => ({ send: mockSend })),
    __mockSqsSend: mockSend,
  };
});

process.env.TABLE_NAME = "UserPII";
process.env.PARTITION_KEY = "userId";
process.env.IP_LOOKUP_ENABLED = "false";
// The handler reads the salt from Secrets Manager by this ARN; there is no HASH_SALT variable (UA-15).
process.env.HASH_SALT_SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:Billboard/DistrictVerificationHashSalt-AbCdEf";

const { createHash } = require("crypto");
const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-dynamodb");
const { __mockSecretsSend: mockSecretsSend } = jest.requireMock("@aws-sdk/client-secrets-manager");
const { handler } = require("../handlers/districtVerification");

// A handler's first request reads the salt through the Secrets Manager mock, and "test-hash-salt" is the salt the
// expected hashes use. resetAllMocks (after each test below) empties the client factory, so it is restored here.
beforeEach(() => {
  const secretsModule = jest.requireMock("@aws-sdk/client-secrets-manager");
  secretsModule.SecretsManagerClient.mockImplementation(() => ({ send: mockSecretsSend }));
  secretsModule.GetSecretValueCommand.mockImplementation((input: unknown) => ({ input }));
  mockSecretsSend.mockResolvedValue({ SecretString: "test-hash-salt" });
});

/** Names of the AccountIntegrity metrics written as EMF lines through the console.log spy. */
const emfMetricNames = (spy: jest.SpyInstance): string[] =>
  spy.mock.calls.flatMap(([line]: unknown[]) => {
    if (typeof line !== "string" || !line.startsWith("{")) return [];
    const parsed = JSON.parse(line);
    const directive = parsed?._aws?.CloudWatchMetrics?.[0];
    if (directive?.Namespace !== "BillBoard/AccountIntegrity") return [];
    return (directive.Metrics ?? []).map((metric: { Name: string }) => metric.Name);
  });

describe("districtVerification hash salt loading", () => {
  const getEvent = {
    httpMethod: "GET",
    requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
  };
  const manualPost = {
    httpMethod: "POST",
    requestContext: {
      authorizer: { jwt: { claims: { sub: "user-1" } } },
      identity: { sourceIp: "203.0.113.7" },
    },
    body: JSON.stringify({ state: "CA", district: "12" }),
  };

  afterEach(() => {
    delete process.env.HASH_SALT;
    mockSecretsSend.mockReset();
    mockSend.mockReset();
  });

  it("fetches the salt from Secrets Manager by the configured ARN, once per container", async () => {
    mockSecretsSend.mockResolvedValue({ SecretString: "secret-salt" });
    mockSend.mockResolvedValue({ Item: { adultStatus: { S: "attested_adult" } } });

    await jest.isolateModulesAsync(async () => {
      const { handler: isolatedHandler } = require("../handlers/districtVerification");
      await isolatedHandler(getEvent);
      await isolatedHandler(getEvent);
    });

    expect(mockSecretsSend).toHaveBeenCalledTimes(1);
    expect(mockSecretsSend.mock.calls[0][0]).toEqual({ input: { SecretId: process.env.HASH_SALT_SECRET_ARN } });
  });

  it("ignores a HASH_SALT variable: the hashes use the secret's value (UA-15)", async () => {
    process.env.HASH_SALT = "environment-salt-that-must-not-be-used";
    mockSecretsSend.mockResolvedValue({ SecretString: " secret-salt\n" });
    mockSend.mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } }).mockResolvedValueOnce({});

    await jest.isolateModulesAsync(async () => {
      const { handler: isolatedHandler } = require("../handlers/districtVerification");
      const response = await isolatedHandler(manualPost);
      expect(response.statusCode).toBe(200);
    });

    const hashWith = (salt: string) => createHash("sha256").update(`${salt}:203.0.113.7`).digest("hex");
    const updateInput = mockSend.mock.calls[1]?.[0]?.input;
    expect(updateInput?.ExpressionAttributeValues[":ipHash"]).toEqual({ S: hashWith("secret-salt") });
    expect(updateInput?.ExpressionAttributeValues[":ipHash"]).not.toEqual({
      S: hashWith("environment-salt-that-must-not-be-used"),
    });
    expect(mockSecretsSend).toHaveBeenCalledTimes(1);
  });

  it("fails the request before any read or write when the secret is empty", async () => {
    mockSecretsSend.mockResolvedValue({ SecretString: "  " });
    mockSend.mockResolvedValue({ Item: { adultStatus: { S: "attested_adult" } } });
    const spies = (["log", "warn", "error"] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation(() => undefined),
    );

    try {
      await jest.isolateModulesAsync(async () => {
        const { handler: isolatedHandler } = require("../handlers/districtVerification");
        const response = await isolatedHandler(manualPost);
        expect(response.statusCode).toBe(500);
      });
      expect(mockSend).not.toHaveBeenCalled();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it("refuses to load without HASH_SALT_SECRET_ARN, even when HASH_SALT is set", () => {
    const arn = process.env.HASH_SALT_SECRET_ARN;
    delete process.env.HASH_SALT_SECRET_ARN;
    process.env.HASH_SALT = "environment-salt";
    try {
      jest.isolateModules(() => {
        expect(() => require("../handlers/districtVerification")).toThrow(
          "HASH_SALT_SECRET_ARN must be configured for districtVerification.",
        );
      });
    } finally {
      process.env.HASH_SALT_SECRET_ARN = arn;
    }
  });

  it("has no HASH_SALT fallback left in the handler", () => {
    const source = fs.readFileSync(path.join(__dirname, "../handlers/districtVerification/index.ts"), "utf8");
    expect(source).not.toMatch(/process\.env\.HASH_SALT\b(?!_SECRET_ARN)/);
  });
});

describe("districtVerification handler", () => {
  const allowAdult = () =>
    mockSend.mockResolvedValueOnce({
      Item: {
        adultStatus: { S: "attested_adult" },
      },
    });

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    for (const method of ["log", "warn", "error"] as const) {
      jest.spyOn(console, method).mockImplementation(() => undefined);
    }
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
  });

  it("returns 401 when user is unauthenticated", async () => {
    const response = await handler({ httpMethod: "GET" });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      message: "Unauthorized (missing authorizer claims)",
    });
  });

  it("returns 400 when required address fields are missing", async () => {
    allowAdult();

    const event = {
      httpMethod: "POST",
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ state: "CA", zip: "94103", line1: "1 Main St" }),
    };

    const response = await handler(event);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: "Missing or invalid address fields (line1, city, state, zip)",
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("stores likely-constituent verification using resolved district, ignoring client-settable CloudFront headers", async () => {
    allowAdult();

    fetchMock().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          addressMatches: [
            {
              addressComponents: { state: "CA" },
              geographies: {
                "119th Congressional Districts": [{ CD119FP: "12", STATEFP: "06" }],
              },
            },
          ],
        },
      }),
    });
    mockSend.mockResolvedValueOnce({});

    const event = {
      httpMethod: "POST",
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      headers: {
        "CloudFront-Viewer-Country": "US",
        "CloudFront-Viewer-Country-Region": "CA",
        "X-Forwarded-For": "1.2.3.4",
      },
      body: JSON.stringify({
        line1: "1600 Amphitheatre Pkwy",
        city: "Mountain View",
        state: "CA",
        zip: "94043",
        claimedDistrict: "12",
      }),
    };

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        verified: true,
        status: "likely_constituent",
        resolved: { state: "CA", districtId: "CA-12" },
        signals: expect.objectContaining({
          addressGeocoded: true,
          ipStateConsistency: "unknown",
          ipStateObserved: null,
          districtClaimMatch: true,
        }),
      }),
    );

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "UserPII",
          Key: { userId: { S: "user-1" } },
          UpdateExpression: expect.stringContaining("verificationStatus = :verificationStatus"),
          ExpressionAttributeValues: expect.objectContaining({
            ":verificationStatus": { S: "likely_constituent" },
            ":verificationMethod": { S: "address_geocode" },
            ":constituentVerified": { BOOL: true },
            ":resolvedState": { S: "CA" },
            ":resolvedDistrict": { S: "CA-12" },
            ":ipStateConsistency": { S: "unknown" },
            ":districtClaimMatch": { BOOL: true },
          }),
        }),
      }),
    );

    const updateInput = mockSend.mock.calls[1]?.[0]?.input;
    expect(updateInput).toBeDefined();
    expect(updateInput?.ExpressionAttributeValues).toMatchObject({
      ":verificationStatus": { S: "likely_constituent" },
      ":verificationMethod": { S: "address_geocode" },
      ":constituentVerified": { BOOL: true },
      ":resolvedState": { S: "CA" },
      ":resolvedDistrict": { S: "CA-12" },
      ":ipStateConsistency": { S: "unknown" },
      ":districtClaimMatch": { BOOL: true },
    });
    expect(updateInput?.ExpressionAttributeValues).not.toHaveProperty(":ipStateObserved");
    expect(updateInput?.UpdateExpression).toMatch(/REMOVE[^=]*ipStateObserved/);
    expect(updateInput?.ExpressionAttributeValues).not.toHaveProperty(":addressHash");
    expect(updateInput?.ExpressionAttributeValues).not.toHaveProperty(":line1");
    expect(updateInput?.ExpressionAttributeValues).not.toHaveProperty(":line2");
    expect(updateInput?.ExpressionAttributeValues).not.toHaveProperty(":city");
    expect(updateInput?.ExpressionAttributeValues).not.toHaveProperty(":zip");
  });

  it("accepts congressional district fields without FP suffix", async () => {
    allowAdult();

    fetchMock().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          addressMatches: [
            {
              addressComponents: { state: "VA" },
              geographies: {
                "119th Congressional Districts": [{ CD119: "11", BASENAME: "11" }],
              },
            },
          ],
        },
      }),
    });
    mockSend.mockResolvedValueOnce({});

    const event = {
      httpMethod: "POST",
      requestContext: { authorizer: { jwt: { claims: { sub: "user-cd119" } } } },
      body: JSON.stringify({
        line1: "1 Example Dr",
        city: "Exampleville",
        state: "VA",
        zip: "20000",
      }),
    };

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        verified: true,
        resolved: { state: "VA", districtId: "VA-11" },
      }),
    );
  });

  it("retries address geocoding with a normalized street when the first attempt has no match", async () => {
    allowAdult();

    fetchMock()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: { addressMatches: [] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            addressMatches: [
              {
                addressComponents: { state: "CA" },
                geographies: {
                  "119th Congressional Districts": [{ CD119FP: "33" }],
                },
              },
            ],
          },
        }),
      });

    mockSend.mockResolvedValueOnce({});

    const event = {
      httpMethod: "POST",
      requestContext: { authorizer: { jwt: { claims: { sub: "user-7" } } } },
      body: JSON.stringify({
        line1: "123 Main St Apt 4",
        city: "Los Angeles",
        state: "CA",
        zip: "90001",
      }),
    };

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        verified: true,
        resolved: { state: "CA", districtId: "CA-33" },
      }),
    );

    expect(fetchMock()).toHaveBeenCalledTimes(2);

    const firstCallUrl = String(fetchMock().mock.calls[0][0]);
    const secondCallUrl = String(fetchMock().mock.calls[1][0]);
    expect(firstCallUrl).toContain("street=123+Main+St+Apt+4");
    expect(secondCallUrl).toContain("street=123+Main+St");
  });

  it("falls back to one-line census geocoding when split-field geocoding has no matches", async () => {
    allowAdult();

    fetchMock()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: { addressMatches: [] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: {
            addressMatches: [
              {
                addressComponents: { state: "VA" },
                geographies: {
                  "119th Congressional Districts": [{ CD119FP: "10" }],
                },
              },
            ],
          },
        }),
      });

    mockSend.mockResolvedValueOnce({});

    const event = {
      httpMethod: "POST",
      requestContext: { authorizer: { jwt: { claims: { sub: "user-8" } } } },
      body: JSON.stringify({
        line1: "2 Example St",
        city: "Exampleville",
        state: "VA",
        zip: "20000",
      }),
    };

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        verified: true,
        resolved: { state: "VA", districtId: "VA-10" },
      }),
    );

    expect(fetchMock()).toHaveBeenCalledTimes(2);
    const firstCallUrl = String(fetchMock().mock.calls[0][0]);
    const secondCallUrl = String(fetchMock().mock.calls[1][0]);
    expect(firstCallUrl).toContain("/geographies/address?");
    expect(secondCallUrl).toContain("/geographies/onelineaddress?");
    expect(secondCallUrl).toContain("address=2+Example+St%2C+Exampleville%2C+VA%2C+20000");
  });

  it("records an IP mismatch from the provider lookup as a flag and a metric, never a downgrade (INT-02)", async () => {
    const previous = process.env.IP_LOOKUP_ENABLED;
    process.env.IP_LOOKUP_ENABLED = "true";
    jest.requireMock("@aws-sdk/client-dynamodb").DynamoDBClient.mockImplementation(() => ({ send: mockSend }));
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await jest.isolateModulesAsync(async () => {
        const { handler: isolatedHandler } = require("../handlers/districtVerification");
        allowAdult();
        mockSend.mockResolvedValueOnce({});
        fetchMock()
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              result: {
                addressMatches: [
                  {
                    addressComponents: { state: "CA" },
                    geographies: { "119th Congressional Districts": [{ CD119FP: "12" }] },
                  },
                ],
              },
            }),
          })
          .mockResolvedValueOnce({ ok: true, json: async () => ({ region_code: "NV" }) });

        const response = await isolatedHandler({
          httpMethod: "POST",
          requestContext: {
            authorizer: { jwt: { claims: { sub: "user-2" } } },
            identity: { sourceIp: "203.0.113.9" },
          },
          body: JSON.stringify({
            line1: "1 Main St",
            city: "Los Angeles",
            state: "CA",
            zip: "90001",
            claimedDistrict: "CA-99",
          }),
        });

        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual(
          expect.objectContaining({
            verified: true,
            status: "likely_constituent",
            repsSignalEligible: true,
            signals: expect.objectContaining({
              ipStateConsistency: "mismatch",
              ipStateObserved: "NV",
              districtClaimMatch: false,
            }),
          }),
        );
        const updateInput = mockSend.mock.calls[1]?.[0]?.input;
        expect(updateInput?.ExpressionAttributeValues).toMatchObject({
          ":constituentVerified": { BOOL: true },
          ":verificationStatus": { S: "likely_constituent" },
          ":ipStateConsistency": { S: "mismatch" },
          ":ipStateObserved": { S: "NV" },
        });
        expect(emfMetricNames(logSpy)).toContain("AddressVerifiedIpMismatch");
      });
    } finally {
      process.env.IP_LOOKUP_ENABLED = previous;
      logSpy.mockRestore();
    }
  });

  it("accepts manual state/district when address is not provided", async () => {
    allowAdult();
    mockSend.mockResolvedValueOnce({});

    const event = {
      httpMethod: "POST",
      requestContext: { authorizer: { jwt: { claims: { sub: "user-4" } } } },
      headers: {
        "CloudFront-Viewer-Country": "US",
        "CloudFront-Viewer-Country-Region": "CA",
      },
      body: JSON.stringify({
        state: "CA",
        district: "12",
      }),
    };

    const response = await handler(event);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        verified: false,
        status: "self_attested",
        method: "manual_state_district",
        resolved: { state: "CA", districtId: "CA-12" },
        repsSignalEligible: false,
        nextStep: "Add a full street address to verify district for representative delivery.",
      }),
    );

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "UserPII",
          Key: { userId: { S: "user-4" } },
          UpdateExpression: expect.stringContaining("verificationStatus = :verificationStatus"),
          ExpressionAttributeValues: expect.objectContaining({
            ":verificationStatus": { S: "self_attested" },
            ":verificationMethod": { S: "manual_state_district" },
            ":constituentVerified": { BOOL: false },
            ":selfAttestedState": { S: "CA" },
            ":selfAttestedDistrict": { S: "CA-12" },
          }),
        }),
      }),
    );

    const updateInput = mockSend.mock.calls[1]?.[0]?.input;
    expect(updateInput?.UpdateExpression).toContain("REMOVE districtClaimMatch, resolvedState, resolvedDistrict");
  });

  it("returns 400 when neither full address nor manual district selection is provided", async () => {
    allowAdult();

    const event = {
      httpMethod: "POST",
      requestContext: { authorizer: { jwt: { claims: { sub: "user-5" } } } },
      body: JSON.stringify({ state: "CA" }),
    };

    const response = await handler(event);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error:
        "Provide a full address (line1, city, state, zip) or provide both state and district for manual selection.",
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("returns stored verification snapshot on GET", async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        verificationStatus: { S: "likely_constituent" },
        verificationMethod: { S: "address_geocode" },
        constituentVerified: { BOOL: true },
        verifiedAt: { S: "2026-02-28T00:00:00.000Z" },
        resolvedState: { S: "CA" },
        resolvedDistrict: { S: "CA-12" },
        ipStateConsistency: { S: "match" },
        ipStateObserved: { S: "CA" },
        districtClaimMatch: { BOOL: true },
      },
    });

    const event = {
      httpMethod: "GET",
      requestContext: { authorizer: { jwt: { claims: { sub: "user-3" } } } },
    };

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      verified: true,
      status: "likely_constituent",
      method: "address_geocode",
      verifiedAt: "2026-02-28T00:00:00.000Z",
      resolved: { state: "CA", districtId: "CA-12" },
      signals: {
        addressGeocoded: true,
        ipStateConsistency: "match",
        ipStateObserved: "CA",
        districtClaimMatch: true,
      },
      repsSignalEligible: true,
    });
  });

  it("returns addressGeocoded false for manual verification snapshot", async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        verificationStatus: { S: "self_attested" },
        verificationMethod: { S: "manual_state_district" },
        constituentVerified: { BOOL: false },
        verifiedAt: { S: "2026-02-28T00:00:00.000Z" },
        resolvedState: { S: "CA" },
        resolvedDistrict: { S: "CA-12" },
        ipStateConsistency: { S: "unknown" },
      },
    });

    const event = {
      httpMethod: "GET",
      requestContext: { authorizer: { jwt: { claims: { sub: "user-6" } } } },
    };

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      verified: false,
      status: "self_attested",
      method: "manual_state_district",
      verifiedAt: "2026-02-28T00:00:00.000Z",
      resolved: { state: "CA", districtId: "CA-12" },
      signals: {
        addressGeocoded: false,
        ipStateConsistency: "unknown",
        districtClaimMatch: null,
      },
      repsSignalEligible: false,
      nextStep: "Add a full street address to verify district for representative delivery.",
    });
  });

  it("allows manual selection when adult attestation is still unknown", async () => {
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({});

    const event = {
      httpMethod: "POST",
      requestContext: { authorizer: { jwt: { claims: { sub: "user-7" } } } },
      body: JSON.stringify({
        state: "CA",
        district: "12",
      }),
    };

    const response = await handler(event);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        verified: false,
        resolved: { state: "CA", districtId: "CA-12" },
      }),
    );
  });
  describe("client IP signals (SEC-13)", () => {
    const manualEvent = (extra: Record<string, unknown>) => ({
      httpMethod: "POST",
      requestContext: { authorizer: { jwt: { claims: { sub: "user-ip" } } } },
      body: JSON.stringify({ state: "CA", district: "12" }),
      ...extra,
    });
    const saltedHash = (value: string) => createHash("sha256").update(`test-hash-salt:${value}`).digest("hex");

    it("hashes requestContext.identity.sourceIp and ignores X-Forwarded-For", async () => {
      allowAdult();
      mockSend.mockResolvedValueOnce({});

      const response = await handler(
        manualEvent({
          requestContext: {
            authorizer: { jwt: { claims: { sub: "user-ip" } } },
            identity: { sourceIp: "203.0.113.7" },
          },
          headers: { "X-Forwarded-For": "198.51.100.1, 203.0.113.7" },
        }),
      );

      expect(response.statusCode).toBe(200);
      const updateInput = mockSend.mock.calls[1]?.[0]?.input;
      expect(updateInput?.ExpressionAttributeValues[":ipHash"]).toEqual({ S: saltedHash("203.0.113.7") });
    });

    it("stores no IP hash when only X-Forwarded-For is present", async () => {
      allowAdult();
      mockSend.mockResolvedValueOnce({});

      await handler(manualEvent({ headers: { "X-Forwarded-For": "198.51.100.1" } }));

      const updateInput = mockSend.mock.calls[1]?.[0]?.input;
      expect(updateInput?.ExpressionAttributeValues).not.toHaveProperty(":ipHash");
      expect(updateInput?.UpdateExpression).toContain("ipHash");
      expect(updateInput?.UpdateExpression).toMatch(/REMOVE[^=]*ipHash/);
    });

    it("ignores a client-supplied X-App-IP-State header", async () => {
      allowAdult();
      mockSend.mockResolvedValueOnce({});

      const response = await handler(manualEvent({ headers: { "X-App-IP-State": "CA" } }));

      expect(JSON.parse(response.body)).toEqual(
        expect.objectContaining({
          signals: expect.objectContaining({ ipStateConsistency: "unknown" }),
        }),
      );
      const updateInput = mockSend.mock.calls[1]?.[0]?.input;
      expect(updateInput?.ExpressionAttributeValues[":ipStateConsistency"]).toEqual({ S: "unknown" });
      expect(updateInput?.ExpressionAttributeValues).not.toHaveProperty(":ipStateObserved");
    });

    it("looks up the IP state for sourceIp, never the forwarded address", async () => {
      const previous = process.env.IP_LOOKUP_ENABLED;
      process.env.IP_LOOKUP_ENABLED = "true";
      // resetAllMocks in afterEach clears the client factory; a freshly required
      // handler constructs a new client, so restore it.
      jest.requireMock("@aws-sdk/client-dynamodb").DynamoDBClient.mockImplementation(() => ({ send: mockSend }));
      try {
        await jest.isolateModulesAsync(async () => {
          const { handler: isolatedHandler } = require("../handlers/districtVerification");
          allowAdult();
          mockSend.mockResolvedValueOnce({});
          fetchMock().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ region_code: "CA" }),
          });

          const response = await isolatedHandler(
            manualEvent({
              requestContext: {
                authorizer: { jwt: { claims: { sub: "user-ip" } } },
                identity: { sourceIp: "203.0.113.7" },
              },
              headers: { "X-Forwarded-For": "198.51.100.1", "X-App-IP-State": "NV" },
            }),
          );

          expect(fetchMock()).toHaveBeenCalledTimes(1);
          const lookupUrl = String(fetchMock().mock.calls[0][0]);
          expect(lookupUrl).toContain("203.0.113.7");
          expect(lookupUrl).not.toContain("198.51.100.1");
          expect(JSON.parse(response.body)).toEqual(
            expect.objectContaining({
              signals: expect.objectContaining({ ipStateConsistency: "match" }),
            }),
          );
        });
      } finally {
        process.env.IP_LOOKUP_ENABLED = previous;
      }
    });
  });
});

// ─── INT-02, INT-03 and the re-stamp trigger ───────────────────────────────────
//
// These suites run the handler against an in-memory UserPII and VerifiedAddressClaims table that
// honours the exact condition expressions sent (fixtures/dynamoCondition), applies the update
// forms the handler sends, cancels a transaction the way DynamoDB does (per-item reasons), and
// rejects what DynamoDB rejects: two operations on one item in a transaction, an expression value
// or name that is not used, and a path that is both SET and REMOVEd.

const { __mockSqsSend: mockSqsSend } = jest.requireMock("@aws-sdk/client-sqs");
const { evaluateCondition, conditionalCheckFailed } = require("./fixtures/dynamoCondition");
const { addressClaimKeys } = require("../shared/addressClaims");
const {
  ADDRESS_CHANGE_WINDOW_MS,
  MAX_ADDRESS_CHANGES_PER_WINDOW,
  MAX_VERIFIED_ACCOUNTS_PER_ADDRESS,
  STREET_CLUSTER_FLAG_THRESHOLD,
} = require("../shared/abuseLimits");
const fs = require("fs");
const path = require("path");

type Row = Record<string, AttributeValue>;

/** The input of any command the fake answers, in DynamoDB's own field names. */
type DbInput = Partial<
  GetItemCommandInput &
    UpdateItemCommandInput &
    QueryCommandInput &
    BatchGetItemCommandInput &
    TransactWriteItemsCommandInput
>;

/** One entry of a TransactWriteItems request: the operation body the fake reads, whichever kind it is. */
interface TransactOp extends DbInput {
  TableName: string;
  Item?: Row;
}

const PII_TABLE = "UserPII";
const CLAIMS_TABLE = "VerifiedAddressClaims";
const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/RestampUserVotesQueue";
const DAY_MS = 24 * 60 * 60 * 1000;
const CAPPED_NEXT_STEP =
  "This address already has the most verified accounts we allow. Your district is saved; your votes count with all users but not as verified.";

const validationError = (message: string) => Object.assign(new Error(message), { name: "ValidationException" });
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

const splitTopLevel = (text: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
};

/** DynamoDB rejects an ExpressionAttributeValues or ExpressionAttributeNames entry no expression uses. */
const assertTokensUsed = (
  op: Pick<
    DbInput,
    | "UpdateExpression"
    | "ConditionExpression"
    | "KeyConditionExpression"
    | "ProjectionExpression"
    | "ExpressionAttributeValues"
    | "ExpressionAttributeNames"
  >,
) => {
  const text = [op.UpdateExpression, op.ConditionExpression, op.KeyConditionExpression, op.ProjectionExpression]
    .filter(Boolean)
    .join(" ");
  for (const token of [
    ...Object.keys(op.ExpressionAttributeValues ?? {}),
    ...Object.keys(op.ExpressionAttributeNames ?? {}),
  ]) {
    if (!new RegExp(`${token}(?![A-Za-z0-9_])`).test(text)) throw validationError(`Unused expression token ${token}`);
  }
};

/** Applies the SET/REMOVE forms the handler and shared/addressClaims send. */
const applyUpdateExpression = (
  item: Row | undefined,
  key: Row,
  op: Pick<DbInput, "UpdateExpression" | "ExpressionAttributeNames" | "ExpressionAttributeValues">,
): Row => {
  const names = op.ExpressionAttributeNames ?? {};
  const values = op.ExpressionAttributeValues ?? {};
  const attributeName = (token: string) => (token.startsWith("#") ? names[token] : token);
  const match = /^SET (.+?)(?: REMOVE (.+))?$/.exec(op.UpdateExpression!);
  if (!match) throw new Error(`Unsupported UpdateExpression: ${op.UpdateExpression}`);
  const next: Row = { ...clone(item ?? {}), ...key };
  const setNames: string[] = [];
  for (const assignment of splitTopLevel(match[1])) {
    const equals = assignment.indexOf(" = ");
    const target = attributeName(assignment.slice(0, equals).trim());
    const expression = assignment.slice(equals + 3).trim();
    setNames.push(target);
    let form: RegExpExecArray | null;
    if ((form = /^if_not_exists\((\S+), (:\w+)\) \+ (:\w+)$/.exec(expression))) {
      const base = item?.[attributeName(form[1])] ?? values[form[2]];
      next[target] = { N: String(Number(base.N) + Number(values[form[3]].N)) };
    } else if ((form = /^(\S+) - (:\w+)$/.exec(expression))) {
      next[target] = { N: String(Number(item?.[attributeName(form[1])]?.N) - Number(values[form[2]].N)) };
    } else if (/^:\w+$/.test(expression)) {
      next[target] = values[expression];
    } else {
      throw new Error(`Unsupported SET form: ${assignment}`);
    }
  }
  const removed = match[2] ? match[2].split(",").map((name) => attributeName(name.trim())) : [];
  for (const name of removed) {
    if (setNames.includes(name)) throw validationError(`Two document paths overlap: ${name}`);
    delete next[name];
  }
  return next;
};

const createFakeDb = () => {
  const tables = new Map<string, Map<string, Row>>();
  const ops: string[] = [];
  const hooks: {
    beforeTransact?: (input: DbInput) => void;
    beforeUpdate?: (input: DbInput) => void;
    beforeBatchGet?: (input: DbInput) => void;
  } = {};
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const keyId = (key: Row) =>
    Object.keys(key)
      .sort()
      .map((name) => `${name}=${key[name].S}`)
      .join("|");
  const keyOf = (tableName: string, item: Row): Row =>
    tableName === CLAIMS_TABLE ? { claimKey: item.claimKey, member: item.member } : { userId: item.userId };
  const get = (tableName: string, key: Row): Row | undefined => table(tableName).get(keyId(key));
  const put = (tableName: string, item: Row) => table(tableName).set(keyId(keyOf(tableName, item)), item);
  const remove = (tableName: string, key: Row) => table(tableName).delete(keyId(key));

  const send = async (command: { constructor: { name: string }; input: DbInput }) => {
    const name: string = command.constructor.name.replace(/Command$/, "");
    const input = command.input;
    ops.push(name);
    switch (name) {
      case "GetItem":
        assertTokensUsed(input);
        return { Item: clone(get(input.TableName!, input.Key!)) };
      case "UpdateItem": {
        assertTokensUsed(input);
        hooks.beforeUpdate?.(input);
        const current = get(input.TableName!, input.Key!);
        if (!evaluateCondition(current, input)) throw conditionalCheckFailed();
        put(input.TableName!, applyUpdateExpression(current, input.Key!, input));
        return {};
      }
      case "TransactWriteItems": {
        hooks.beforeTransact?.(input);
        const entries = input.TransactItems!.map((entry) => {
          const [kind, op] = Object.entries(entry)[0] as [string, TransactOp];
          const key = kind === "Put" ? keyOf(op.TableName, op.Item!) : op.Key!;
          return { kind, op, key, id: `${op.TableName}#${keyId(key)}` };
        });
        if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
          throw validationError("Transaction request cannot include multiple operations on one item");
        }
        const reasons = entries.map((entry) => {
          assertTokensUsed(entry.op);
          return evaluateCondition(get(entry.op.TableName, entry.key), entry.op)
            ? { Code: "None" }
            : { Code: "ConditionalCheckFailed" };
        });
        if (reasons.some((reason) => reason.Code !== "None")) {
          throw Object.assign(new Error("Transaction cancelled"), {
            name: "TransactionCanceledException",
            CancellationReasons: reasons,
          });
        }
        for (const entry of entries) {
          if (entry.kind === "Put") put(entry.op.TableName, clone(entry.op.Item!));
          else if (entry.kind === "Delete") remove(entry.op.TableName, entry.key);
          else if (entry.kind === "Update") {
            put(entry.op.TableName, applyUpdateExpression(get(entry.op.TableName, entry.key), entry.key, entry.op));
          } else throw new Error(`Unsupported transaction item ${entry.kind}`);
        }
        return {};
      }
      case "Query": {
        assertTokensUsed(input);
        if (input.TableName !== CLAIMS_TABLE) throw new Error(`Unexpected Query on ${input.TableName}`);
        expect(input.KeyConditionExpression).toBe("#k = :k AND begins_with(#m, :prefix)");
        const claimKey = input.ExpressionAttributeValues![":k"].S;
        const prefix = input.ExpressionAttributeValues![":prefix"].S!;
        const items = [...table(CLAIMS_TABLE).values()].filter(
          (item) => item.claimKey.S === claimKey && item.member.S!.startsWith(prefix),
        );
        return { Items: clone(items) };
      }
      case "BatchGetItem": {
        hooks.beforeBatchGet?.(input);
        const responses: Record<string, Row[]> = {};
        for (const [tableName, request] of Object.entries(input.RequestItems!) as [string, KeysAndAttributes][]) {
          assertTokensUsed(request);
          responses[tableName] = request
            .Keys!.map((key: Row) => get(tableName, key))
            .filter((row): row is Row => Boolean(row))
            .map(clone);
        }
        return { Responses: responses };
      }
      default:
        throw new Error(`Unexpected DynamoDB call ${name}`);
    }
  };

  return { tables, ops, hooks, send, get, put, remove, rows: (tableName: string) => [...table(tableName).values()] };
};

type FakeDb = ReturnType<typeof createFakeDb>;

const saltedHash = (value: string) => createHash("sha256").update(`test-hash-salt:${value}`).digest("hex");
const keysFor = (matched: string, unit: string): { unitKey: string; streetKey: string } =>
  addressClaimKeys(matched, unit, saltedHash);
const counterKey = (claimKey: string) => ({ claimKey: { S: claimKey }, member: { S: "#COUNT" } });
const unitCount = (fake: FakeDb, keys: { unitKey: string }) =>
  Number(fake.get(CLAIMS_TABLE, counterKey(`U#${keys.unitKey}`))?.n?.N ?? 0);
const streetCount = (fake: FakeDb, keys: { streetKey: string }) =>
  Number(fake.get(CLAIMS_TABLE, counterKey(`S#${keys.streetKey}`))?.n?.N ?? 0);
const claimOf = (fake: FakeDb, keys: { unitKey: string }, userId: string) =>
  fake.get(CLAIMS_TABLE, { claimKey: { S: `U#${keys.unitKey}` }, member: { S: `USER#${userId}` } });
const piiOf = (fake: FakeDb, userId: string) => fake.get(PII_TABLE, { userId: { S: userId } });

/** `congress`: the layer the geocoder answers on, 119 unless given. */
type Place = { fields: Record<string, string>; matched: string; state: string; cd: string; congress?: number };
const HOME: Place = {
  fields: { line1: "100 Main St", city: "Springfield", state: "IL", zip: "62701" },
  matched: "100 MAIN ST, SPRINGFIELD, IL, 62701",
  state: "IL",
  cd: "13",
};
const OTHER: Place = {
  fields: { line1: "9 Elm St", city: "Peoria", state: "IL", zip: "61602" },
  matched: "9 ELM ST, PEORIA, IL, 61602",
  state: "IL",
  cd: "16",
};

const geocodeTo = (place: Place) =>
  fetchMock().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      result: {
        addressMatches: [
          {
            matchedAddress: place.matched,
            addressComponents: { state: place.state },
            geographies: {
              [`${place.congress ?? 119}th Congressional Districts`]: [{ [`CD${place.congress ?? 119}FP`]: place.cd }],
            },
          },
        ],
      },
    }),
  }));

const asUser = (sub: string, extra: Record<string, unknown> = {}) => ({
  requestContext: { authorizer: { jwt: { claims: { sub } } } },
  ...extra,
});
const verifyAt = async (sub: string, place: Place, fieldOverrides: Record<string, string> = {}) => {
  geocodeTo(place);
  const response = await handler(
    asUser(sub, { httpMethod: "POST", body: JSON.stringify({ ...place.fields, ...fieldOverrides }) }),
  );
  return { statusCode: response.statusCode, headers: response.headers, body: JSON.parse(response.body) };
};
const selectManually = async (sub: string, state: string, district: string) => {
  const response = await handler(asUser(sub, { httpMethod: "POST", body: JSON.stringify({ state, district }) }));
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
};
const readVerification = async (sub: string) => JSON.parse((await handler(asUser(sub, { httpMethod: "GET" }))).body);

describe("districtVerification address claims and limits", () => {
  /** The verified-account cap per unit, the accounts that fill it, and the next account. */
  const CAP = MAX_VERIFIED_ACCOUNTS_PER_ADDRESS;
  const FULL_UNIT = Array.from({ length: CAP }, (_, index) => `u${index + 1}`);
  const NEXT = `u${CAP + 1}`;
  let fake: FakeDb;
  let logSpy: jest.SpyInstance;
  let sentMessages: Array<{ MessageBody?: string }>;

  const metrics = () => emfMetricNames(logSpy);
  const setMode = (mode: string | undefined) => {
    if (mode === undefined) delete process.env.VERIFICATION_LIMITS_MODE;
    else process.env.VERIFICATION_LIMITS_MODE = mode;
  };
  const resetObservations = () => {
    fake.ops.length = 0;
    sentMessages.length = 0;
    logSpy.mockClear();
  };

  beforeEach(() => {
    fake = createFakeDb();
    sentMessages = [];
    mockSend.mockReset();
    mockSend.mockImplementation(fake.send);
    mockSqsSend.mockReset();
    mockSqsSend.mockImplementation(async (command: { input: { MessageBody?: string } }) => {
      fake.ops.push("SendMessage");
      sentMessages.push(command.input);
      return { MessageId: "m-1" };
    });
    global.fetch = jest.fn();
    process.env.ADDRESS_CLAIMS_TABLE_NAME = CLAIMS_TABLE;
    process.env.VOTE_RESTAMP_QUEUE_URL = QUEUE_URL;
    setMode(undefined);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.ADDRESS_CLAIMS_TABLE_NAME;
    delete process.env.VOTE_RESTAMP_QUEUE_URL;
    setMode(undefined);
    jest.restoreAllMocks();
  });

  describe("INT-02: the IP state is a flag only, and never read from headers", () => {
    it("ignores CloudFront viewer headers in address and manual mode", async () => {
      geocodeTo(HOME);
      const headers = { "CloudFront-Viewer-Country": "US", "CloudFront-Viewer-Country-Region": "IL" };
      const address = await handler(asUser("u1", { httpMethod: "POST", headers, body: JSON.stringify(HOME.fields) }));
      const manual = await handler(
        asUser("u2", { httpMethod: "POST", headers, body: JSON.stringify({ state: "IL", district: "13" }) }),
      );

      for (const response of [address, manual]) {
        expect(JSON.parse(response.body).signals).toEqual(
          expect.objectContaining({ ipStateConsistency: "unknown", ipStateObserved: null }),
        );
      }
      expect(piiOf(fake, "u1")?.ipStateObserved).toBeUndefined();
      expect(piiOf(fake, "u2")?.ipStateObserved).toBeUndefined();
      expect(piiOf(fake, "u1")?.constituentVerified).toEqual({ BOOL: true });
    });

    it("has no header-based IP state read left in the handler", () => {
      const source = fs.readFileSync(path.join(__dirname, "../handlers/districtVerification/index.ts"), "utf8");
      expect(source).not.toMatch(/["']cloudfront-viewer/i);
      expect(source).not.toMatch(/getIpStateFromHeaders/);
    });
  });

  describe("INT-03 claim keys", () => {
    it("keys the unit, not its spelling: '#4b' on line 2 and 'Apt 4B' on line 1 share a slot, no unit is its own", async () => {
      expect((await verifyAt("u1", HOME, { line2: "#4b" })).statusCode).toBe(200);
      expect((await verifyAt("u2", HOME, { line1: "100 Main St Apt 4B" })).statusCode).toBe(200);
      expect((await verifyAt("u3", HOME)).statusCode).toBe(200);

      const unit4b = keysFor(HOME.matched, "4B");
      const noUnit = keysFor(HOME.matched, "");
      expect(unit4b.streetKey).toBe(noUnit.streetKey);
      expect(unitCount(fake, unit4b)).toBe(2);
      expect(unitCount(fake, noUnit)).toBe(1);
      expect(streetCount(fake, unit4b)).toBe(3);
      expect(piiOf(fake, "u1")?.verifiedAddressKey).toEqual({ S: unit4b.unitKey });
      expect(piiOf(fake, "u2")?.verifiedAddressKey).toEqual({ S: unit4b.unitKey });
      expect(piiOf(fake, "u3")?.verifiedStreetKey).toEqual({ S: noUnit.streetKey });
    });

    it("stores only salted hashes: neither table holds the address", async () => {
      await verifyAt("u1", HOME, { line2: "Apt 7" });
      const stored = JSON.stringify([...fake.rows(PII_TABLE), ...fake.rows(CLAIMS_TABLE)]);
      expect(stored).not.toMatch(/main|springfield|elm|apt/i);
    });
  });

  describe("INT-03 address-mode POST", () => {
    it("claims the unit, counts the unit and the street, logs the change, and queues the re-stamp before any write", async () => {
      const response = await verifyAt("u1", HOME);

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({ verified: true, status: "likely_constituent", method: "address_geocode" }),
      );
      const keys = keysFor(HOME.matched, "");
      expect(unitCount(fake, keys)).toBe(1);
      expect(streetCount(fake, keys)).toBe(1);
      expect(claimOf(fake, keys, "u1")?.claimedAt?.S).toEqual(expect.any(String));
      const pii = piiOf(fake, "u1")!;
      expect(pii.verifiedAddressKey).toEqual({ S: keys.unitKey });
      expect(pii.verifiedStreetKey).toEqual({ S: keys.streetKey });
      expect(pii.addressChangeLog.L).toHaveLength(1);
      expect(pii.resolvedDistrict).toEqual({ S: "IL-13" });

      expect(sentMessages).toEqual([{ QueueUrl: QUEUE_URL, MessageBody: '{"userId":"u1"}', DelaySeconds: 10 }]);
      expect(fake.ops.indexOf("SendMessage")).toBeGreaterThan(-1);
      expect(fake.ops.indexOf("SendMessage")).toBeLessThan(fake.ops.indexOf("TransactWriteItems"));
      expect(metrics()).toEqual(["AddressVerified"]);
    });

    it("refreshes the same unit without a claim change, a count or a re-stamp", async () => {
      await verifyAt("u1", HOME);
      resetObservations();

      const response = await verifyAt("u1", HOME, { line1: "100  main   st" });

      expect(response.statusCode).toBe(200);
      expect(response.body.verified).toBe(true);
      const keys = keysFor(HOME.matched, "");
      expect(unitCount(fake, keys)).toBe(1);
      expect(streetCount(fake, keys)).toBe(1);
      expect(piiOf(fake, "u1")?.addressChangeLog.L).toHaveLength(1);
      expect(fake.ops).not.toContain("TransactWriteItems");
      expect(fake.ops).toContain("UpdateItem");
      expect(sentMessages).toEqual([]);
      expect(metrics()).toEqual([]);
    });

    it("enforce: the account over the cap at one unit is capped as self-attested; the counter stays at the cap", async () => {
      for (const user of FULL_UNIT) expect((await verifyAt(user, HOME)).body.verified).toBe(true);
      setMode("enforce");
      resetObservations();

      const response = await verifyAt(NEXT, HOME);

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        verified: false,
        status: "self_attested",
        method: "address_capped",
        verifiedAt: expect.any(String),
        resolved: { state: "IL", districtId: "IL-13" },
        signals: {
          addressGeocoded: true,
          ipStateConsistency: "unknown",
          ipStateObserved: null,
          districtClaimMatch: null,
        },
        repsSignalEligible: false,
        limitReason: "address_limit",
        nextStep: CAPPED_NEXT_STEP,
      });
      const fixture = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "../../../contracts/fixtures/openapi/DistrictVerification.valid.json"),
          "utf8",
        ),
      );
      expect(Object.keys(response.body).sort()).toEqual(Object.keys(fixture).sort());
      expect(response.body.nextStep).toBe(fixture.nextStep);

      const keys = keysFor(HOME.matched, "");
      expect(unitCount(fake, keys)).toBe(CAP);
      expect(streetCount(fake, keys)).toBe(CAP);
      expect(claimOf(fake, keys, NEXT)).toBeUndefined();
      const pii = piiOf(fake, NEXT)!;
      expect(pii).toEqual(
        expect.objectContaining({
          verificationStatus: { S: "self_attested" },
          verificationMethod: { S: "address_capped" },
          constituentVerified: { BOOL: false },
          selfAttestedState: { S: "IL" },
          selfAttestedDistrict: { S: "IL-13" },
          verificationLimitReason: { S: "address_limit" },
        }),
      );
      for (const absent of [
        "resolvedState",
        "resolvedDistrict",
        "verifiedAddressKey",
        "verifiedStreetKey",
        "addressChangeLog",
      ]) {
        expect(pii[absent]).toBeUndefined();
      }
      expect(metrics()).toEqual(["AddressLimitReached"]);
    });

    it("watch: the account over the cap is verified, the counter passes the cap and AddressLimitReached is emitted", async () => {
      for (const user of FULL_UNIT) await verifyAt(user, HOME);
      resetObservations();

      const response = await verifyAt(NEXT, HOME);

      expect(response.body.verified).toBe(true);
      const keys = keysFor(HOME.matched, "");
      expect(unitCount(fake, keys)).toBe(CAP + 1);
      expect(claimOf(fake, keys, NEXT)).toBeDefined();
      expect(metrics()).toEqual(["AddressVerified", "AddressLimitReached"]);
    });

    it("treats any mode other than enforce as watch", async () => {
      for (const user of FULL_UNIT) await verifyAt(user, HOME);
      setMode("ENFORCE");

      expect((await verifyAt(NEXT, HOME)).body.verified).toBe(true);
      expect(unitCount(fake, keysFor(HOME.matched, ""))).toBe(CAP + 1);
    });

    it("a move releases the old claim and both old counters, and queues a re-stamp for the new district", async () => {
      await verifyAt("u1", HOME);
      resetObservations();

      const response = await verifyAt("u1", OTHER);

      expect(response.body.resolved).toEqual({ state: "IL", districtId: "IL-16" });
      const home = keysFor(HOME.matched, "");
      const other = keysFor(OTHER.matched, "");
      expect(claimOf(fake, home, "u1")).toBeUndefined();
      expect([unitCount(fake, home), streetCount(fake, home)]).toEqual([0, 0]);
      expect([unitCount(fake, other), streetCount(fake, other)]).toEqual([1, 1]);
      expect(piiOf(fake, "u1")?.verifiedAddressKey).toEqual({ S: other.unitKey });
      expect(piiOf(fake, "u1")?.addressChangeLog.L).toHaveLength(2);
      expect(sentMessages).toHaveLength(1);
    });

    it("a move between units of one street address leaves the street counter as it is", async () => {
      await verifyAt("u1", HOME, { line2: "Apt 1" });
      await verifyAt("u1", HOME, { line2: "Apt 2" });

      const unit1 = keysFor(HOME.matched, "1");
      const unit2 = keysFor(HOME.matched, "2");
      expect(unitCount(fake, unit1)).toBe(0);
      expect(unitCount(fake, unit2)).toBe(1);
      expect(streetCount(fake, unit2)).toBe(1);
    });

    it("enforce self-heal: releases claims of deleted and missing accounts, then the retry claims a slot", async () => {
      for (const user of FULL_UNIT) await verifyAt(user, HOME);
      const [deleted, failed] = FULL_UNIT;
      const missing = FULL_UNIT[FULL_UNIT.length - 1];
      fake.put(PII_TABLE, { userId: { S: deleted }, deletionStatus: { S: "completed" } });
      fake.remove(PII_TABLE, { userId: { S: missing } });
      fake.put(PII_TABLE, { ...piiOf(fake, failed)!, deletionStatus: { S: "failed" } });
      setMode("enforce");

      const response = await verifyAt(NEXT, HOME);

      expect(response.body.verified).toBe(true);
      const keys = keysFor(HOME.matched, "");
      expect(unitCount(fake, keys)).toBe(CAP - 1);
      expect(streetCount(fake, keys)).toBe(CAP - 1);
      expect(claimOf(fake, keys, deleted)).toBeUndefined();
      expect(claimOf(fake, keys, missing)).toBeUndefined();
      expect(claimOf(fake, keys, failed)).toBeDefined();
      expect(claimOf(fake, keys, NEXT)).toBeDefined();
    });

    it("enforce self-heal releases a claim whose account is mid-deletion", async () => {
      for (const user of FULL_UNIT) await verifyAt(user, HOME);
      fake.put(PII_TABLE, { ...piiOf(fake, "u1")!, deletionStatus: { S: "in_progress" } });
      setMode("enforce");

      expect((await verifyAt(NEXT, HOME)).body.verified).toBe(true);
      expect(claimOf(fake, keysFor(HOME.matched, ""), "u1")).toBeUndefined();
    });

    it("enforce: with nothing stale the self-heal does not retry the claim before capping", async () => {
      for (const user of FULL_UNIT) await verifyAt(user, HOME);
      setMode("enforce");
      resetObservations();

      expect((await verifyAt(NEXT, HOME)).body.method).toBe("address_capped");
      expect(fake.ops.filter((op) => op === "TransactWriteItems")).toHaveLength(1);
      expect(fake.ops).toEqual(expect.arrayContaining(["Query", "BatchGetItem", "UpdateItem"]));
    });

    it("enforce: a capped account releases the claim it held elsewhere in the same write", async () => {
      for (const user of FULL_UNIT) await verifyAt(user, HOME);
      await verifyAt(NEXT, OTHER);
      setMode("enforce");

      expect((await verifyAt(NEXT, HOME)).body.method).toBe("address_capped");
      const other = keysFor(OTHER.matched, "");
      expect(claimOf(fake, other, NEXT)).toBeUndefined();
      expect([unitCount(fake, other), streetCount(fake, other)]).toEqual([0, 0]);
      expect(piiOf(fake, NEXT)?.verifiedAddressKey).toBeUndefined();
      // Capping is not counted as an address change.
      expect(piiOf(fake, NEXT)?.addressChangeLog.L).toHaveLength(1);
    });

    it("GET returns limitReason while capped, and a later verification at a free address clears it", async () => {
      for (const user of FULL_UNIT) await verifyAt(user, HOME);
      setMode("enforce");
      await verifyAt(NEXT, HOME);

      expect(await readVerification(NEXT)).toEqual(
        expect.objectContaining({
          verified: false,
          status: "self_attested",
          method: "address_capped",
          resolved: { state: "IL", districtId: "IL-13" },
          signals: expect.objectContaining({ addressGeocoded: true }),
          repsSignalEligible: false,
          limitReason: "address_limit",
          nextStep: CAPPED_NEXT_STEP,
        }),
      );

      expect((await verifyAt(NEXT, OTHER)).body.verified).toBe(true);
      const after = await readVerification(NEXT);
      expect(after.verified).toBe(true);
      expect(after).not.toHaveProperty("limitReason");
      expect(piiOf(fake, NEXT)?.verificationLimitReason).toBeUndefined();
    });

    it("emits StreetClusterFlagged when a street address holds more than STREET_CLUSTER_FLAG_THRESHOLD active claims", async () => {
      const keys = keysFor(HOME.matched, "");
      fake.put(CLAIMS_TABLE, { ...counterKey(`S#${keys.streetKey}`), n: { N: String(STREET_CLUSTER_FLAG_THRESHOLD) } });

      await verifyAt("u1", HOME);

      expect(streetCount(fake, keys)).toBe(STREET_CLUSTER_FLAG_THRESHOLD + 1);
      expect(metrics()).toEqual(["AddressVerified", "StreetClusterFlagged"]);
    });
  });

  describe("INT-03 re-verification limit (MAX_ADDRESS_CHANGES_PER_WINDOW address changes in ADDRESS_CHANGE_WINDOW_MS)", () => {
    const WINDOW_DAYS = ADDRESS_CHANGE_WINDOW_MS / DAY_MS;
    /** MAX_ADDRESS_CHANGES_PER_WINDOW changes inside the window, the oldest leaving it in 10 days. */
    const FULL_LOG = [WINDOW_DAYS - 10, ...Array.from({ length: MAX_ADDRESS_CHANGES_PER_WINDOW - 2 }, () => 10), 1];
    const seedChanges = (userId: string, daysAgo: number[]) =>
      fake.put(PII_TABLE, {
        userId: { S: userId },
        addressChangeLog: { L: daysAgo.map((days) => ({ S: new Date(Date.now() - days * DAY_MS).toISOString() })) },
      });

    it("enforce: one change over the limit in the window is refused with 429 and Retry-After, and nothing changes", async () => {
      seedChanges("u1", FULL_LOG);
      const before = clone(piiOf(fake, "u1"));
      setMode("enforce");
      resetObservations();

      const response = await verifyAt("u1", HOME);

      expect(response.statusCode).toBe(429);
      expect(response.body.error).toBe("VERIFICATION_RATE_LIMITED");
      expect(response.body.message).toMatch(
        new RegExp(
          `^You can verify a new address ${MAX_ADDRESS_CHANGES_PER_WINDOW} times in ${WINDOW_DAYS} days\\. ` +
            "Try again after [A-Z][a-z]+ \\d{1,2}, \\d{4}\\.$",
        ),
      );
      const retryAfter = Number(response.headers["Retry-After"]);
      expect(Math.abs(retryAfter - 10 * 24 * 3600)).toBeLessThanOrEqual(5);
      expect(piiOf(fake, "u1")).toEqual(before);
      expect(fake.rows(CLAIMS_TABLE)).toEqual([]);
      expect(fake.ops).toEqual(["GetItem"]);
      expect(sentMessages).toEqual([]);
      expect(metrics()).toEqual(["ReverificationLimitReached"]);
    });

    it("watch: the change over the limit goes through, is counted by the metric, and the log keeps the newest", async () => {
      seedChanges("u1", FULL_LOG);

      const response = await verifyAt("u1", HOME);

      expect(response.body.verified).toBe(true);
      const log = piiOf(fake, "u1")!.addressChangeLog.L!.map((entry) => Date.parse(entry.S!));
      expect(log).toHaveLength(MAX_ADDRESS_CHANGES_PER_WINDOW);
      expect(Math.min(...log)).toBeGreaterThan(Date.now() - 11 * DAY_MS);
      expect(Math.max(...log)).toBeGreaterThan(Date.now() - 60_000);
      expect(metrics()).toEqual(["ReverificationLimitReached", "AddressVerified"]);
    });

    it("changes older than the window do not count", async () => {
      seedChanges("u1", [WINDOW_DAYS + 10, WINDOW_DAYS + 5, WINDOW_DAYS + 1]);
      setMode("enforce");

      expect((await verifyAt("u1", HOME)).statusCode).toBe(200);
      expect(metrics()).not.toContain("ReverificationLimitReached");
    });
  });

  describe("re-stamp trigger and manual mode", () => {
    it("a failed re-stamp send returns 500 before anything is written", async () => {
      mockSqsSend.mockRejectedValue(new Error("SQS unavailable"));
      setMode("enforce");

      const response = await verifyAt("u1", HOME);

      expect(response.statusCode).toBe(500);
      expect(fake.rows(CLAIMS_TABLE)).toEqual([]);
      expect(piiOf(fake, "u1")).toBeUndefined();
      expect(fake.ops).toEqual(["GetItem"]);
    });

    it("manual mode releases a held claim in the same write and queues a re-stamp (verified to self-attested)", async () => {
      await verifyAt("u1", HOME);
      resetObservations();

      const response = await selectManually("u1", "IL", "13");

      expect(response.body).toEqual(
        expect.objectContaining({ verified: false, status: "self_attested", method: "manual_state_district" }),
      );
      const keys = keysFor(HOME.matched, "");
      expect(claimOf(fake, keys, "u1")).toBeUndefined();
      expect([unitCount(fake, keys), streetCount(fake, keys)]).toEqual([0, 0]);
      const pii = piiOf(fake, "u1")!;
      expect(pii.verifiedAddressKey).toBeUndefined();
      expect(pii.verifiedStreetKey).toBeUndefined();
      expect(pii.addressChangeLog.L).toHaveLength(1);
      expect(sentMessages).toHaveLength(1);
      expect(fake.ops.indexOf("SendMessage")).toBeLessThan(fake.ops.indexOf("TransactWriteItems"));
    });

    it("manual mode for an account that is not verified queues nothing", async () => {
      await selectManually("u1", "IL", "13");
      await selectManually("u1", "IL", "16");

      expect(sentMessages).toEqual([]);
      expect(fake.ops).not.toContain("TransactWriteItems");
    });

    it("limits off (ADDRESS_CLAIMS_TABLE_NAME unset): no claim is read or written, and the re-stamp is still queued", async () => {
      delete process.env.ADDRESS_CLAIMS_TABLE_NAME;
      setMode("enforce");

      const response = await verifyAt("u1", HOME);

      expect(response.body.verified).toBe(true);
      expect(fake.ops).toEqual(["GetItem", "SendMessage", "UpdateItem"]);
      expect(fake.rows(CLAIMS_TABLE)).toEqual([]);
      expect(piiOf(fake, "u1")?.verifiedAddressKey).toBeUndefined();
    });

    describe("a re-check of the unit the account holds (REL-46, D14)", () => {
      const NEW_LINES: Place = { ...HOME, cd: "14", congress: 120 };
      const driftPii = (fields: Row, removed: string[] = []) => {
        const pii = { ...piiOf(fake, "u1")!, ...fields };
        for (const name of removed) delete pii[name];
        fake.put(PII_TABLE, pii);
      };
      /** A row verified before address claims existed: verified at HOME's district, with no claim. */
      const seedVerifiedWithoutClaim = () =>
        fake.put(PII_TABLE, {
          userId: { S: "u1" },
          constituentVerified: { BOOL: true },
          verificationStatus: { S: "likely_constituent" },
          resolvedState: { S: "IL" },
          resolvedDistrict: { S: "IL-13" },
        });

      it("only the district differs on newer lines: no re-stamp; the new district is stored and RestampSkippedDistrictOnly counted", async () => {
        await verifyAt("u1", HOME);
        resetObservations();

        const response = await verifyAt("u1", NEW_LINES);

        expect(response.body.resolved).toEqual({ state: "IL", districtId: "IL-14" });
        expect(piiOf(fake, "u1")?.resolvedDistrict).toEqual({ S: "IL-14" });
        expect(fake.ops).not.toContain("TransactWriteItems");
        expect(sentMessages).toEqual([]);
        expect(metrics()).toEqual(["RestampSkippedDistrictOnly"]);
      });

      it("the state differs: the re-stamp is queued", async () => {
        await verifyAt("u1", HOME);
        driftPii({ resolvedState: { S: "IN" }, resolvedDistrict: { S: "IN-13" } });
        resetObservations();

        await verifyAt("u1", NEW_LINES);

        expect(sentMessages).toHaveLength(1);
        expect(fake.ops.indexOf("SendMessage")).toBeLessThan(fake.ops.indexOf("UpdateItem"));
        expect(metrics()).toEqual([]);
      });

      it("the verified status differs: the re-stamp is queued", async () => {
        await verifyAt("u1", HOME);
        driftPii({ constituentVerified: { BOOL: false }, verificationStatus: { S: "self_attested" } }, [
          "resolvedState",
          "resolvedDistrict",
        ]);
        resetObservations();

        await verifyAt("u1", NEW_LINES);

        expect(sentMessages).toHaveLength(1);
        expect(metrics()).toEqual([]);
      });

      it("a verified row with no district: the re-stamp is queued", async () => {
        await verifyAt("u1", HOME);
        driftPii({}, ["resolvedDistrict"]);
        resetObservations();

        await verifyAt("u1", NEW_LINES);

        expect(sentMessages).toHaveLength(1);
        expect(metrics()).toEqual([]);
      });

      it("only the district differs on the 119th lines (a correction): the re-stamp is queued", async () => {
        await verifyAt("u1", HOME);
        resetObservations();

        await verifyAt("u1", { ...HOME, cd: "14" });

        expect(piiOf(fake, "u1")?.resolvedDistrict).toEqual({ S: "IL-14" });
        expect(sentMessages).toHaveLength(1);
        expect(metrics()).toEqual([]);
      });

      it("a new address in the same state with a new district: the re-stamp is queued", async () => {
        await verifyAt("u1", HOME);
        resetObservations();

        await verifyAt("u1", { ...OTHER, congress: 120 });

        expect(piiOf(fake, "u1")?.resolvedDistrict).toEqual({ S: "IL-16" });
        expect(sentMessages).toHaveLength(1);
        expect(metrics()).toEqual(["AddressVerified"]);
      });

      it("a verified account with no claim (verified before address claims existed): the re-stamp is queued and the claim taken", async () => {
        seedVerifiedWithoutClaim();
        resetObservations();

        await verifyAt("u1", NEW_LINES);

        expect(piiOf(fake, "u1")?.verifiedAddressKey).toEqual({ S: keysFor(HOME.matched, "").unitKey });
        expect(sentMessages).toHaveLength(1);
        expect(metrics()).toEqual(["AddressVerified"]);
      });

      it("that account re-checked once on the 119th lines sends nothing and takes its claim, so the newer lines skip", async () => {
        seedVerifiedWithoutClaim();
        resetObservations();

        await verifyAt("u1", HOME);
        expect(sentMessages).toEqual([]);
        expect(piiOf(fake, "u1")?.verifiedAddressKey).toEqual({ S: keysFor(HOME.matched, "").unitKey });
        resetObservations();

        await verifyAt("u1", NEW_LINES);

        expect(sentMessages).toEqual([]);
        expect(metrics()).toEqual(["RestampSkippedDistrictOnly"]);
      });
    });

    it("VOTE_RESTAMP_QUEUE_URL unset: verifies without queueing a re-stamp", async () => {
      delete process.env.VOTE_RESTAMP_QUEUE_URL;

      expect((await verifyAt("u1", HOME)).body.verified).toBe(true);
      expect(mockSqsSend).not.toHaveBeenCalled();
    });
  });

  describe("concurrency and drift", () => {
    it("a write that lost to a concurrent verification re-reads the row and settles on the claim that won", async () => {
      const keys = keysFor(HOME.matched, "");
      let raced = false;
      fake.hooks.beforeTransact = () => {
        if (raced) return;
        raced = true;
        // The concurrent request claimed the same unit for this account first.
        fake.put(CLAIMS_TABLE, { ...counterKey(`U#${keys.unitKey}`), n: { N: "1" } });
        fake.put(CLAIMS_TABLE, { ...counterKey(`S#${keys.streetKey}`), n: { N: "1" } });
        fake.put(CLAIMS_TABLE, {
          claimKey: { S: `U#${keys.unitKey}` },
          member: { S: "USER#u1" },
          claimedAt: { S: "x" },
        });
        fake.put(PII_TABLE, {
          userId: { S: "u1" },
          constituentVerified: { BOOL: true },
          verificationStatus: { S: "likely_constituent" },
          resolvedState: { S: "IL" },
          resolvedDistrict: { S: "IL-13" },
          verifiedAddressKey: { S: keys.unitKey },
          verifiedStreetKey: { S: keys.streetKey },
          addressChangeLog: { L: [{ S: new Date().toISOString() }] },
        });
      };

      const response = await verifyAt("u1", HOME);

      expect(response.statusCode).toBe(200);
      expect(response.body.verified).toBe(true);
      expect([unitCount(fake, keys), streetCount(fake, keys)]).toEqual([1, 1]);
      expect(piiOf(fake, "u1")?.addressChangeLog.L).toHaveLength(1);
    });

    describe("a DELETE /account-data that lands during the geocode (after the eligibility read)", () => {
      const DELETIONS = [
        ["starts (in_progress)", { deletionStatus: { S: "in_progress" } }, "ACCOUNT_DELETION_IN_PROGRESS"],
        ["completed (the tombstone)", { deletionStatus: { S: "completed" } }, "ACCOUNT_INELIGIBLE"],
      ] as const;

      it.each(DELETIONS)(
        "address mode, deletion %s: 403 %s, no claim row or count, nothing written on the row",
        async (_label, deletion, code) => {
          const keys = keysFor(HOME.matched, "");
          const deleted = { userId: { S: "u1" }, ...deletion };
          fake.hooks.beforeTransact = () => fake.put(PII_TABLE, clone(deleted));

          const response = await verifyAt("u1", HOME);

          expect(response.statusCode).toBe(403);
          expect(response.body.error).toBe(code);
          expect(claimOf(fake, keys, "u1")).toBeUndefined();
          expect([unitCount(fake, keys), streetCount(fake, keys)]).toEqual([0, 0]);
          expect(piiOf(fake, "u1")).toEqual(deleted);
        },
      );

      it.each(DELETIONS)(
        "manual mode and limits off, deletion %s: 403 %s and the row is left as the deletion wrote it",
        async (_label, deletion, code) => {
          const deleted = { userId: { S: "u1" }, ...deletion };
          fake.hooks.beforeUpdate = (input) => {
            if (input.TableName === PII_TABLE) fake.put(PII_TABLE, clone(deleted));
          };

          const manual = await selectManually("u1", "IL", "13");
          expect([manual.statusCode, manual.body.error]).toEqual([403, code]);
          expect(piiOf(fake, "u1")).toEqual(deleted);

          fake.remove(PII_TABLE, { userId: { S: "u1" } });
          delete process.env.ADDRESS_CLAIMS_TABLE_NAME;
          const address = await verifyAt("u1", HOME);
          expect([address.statusCode, address.body.error]).toEqual([403, code]);
          expect(piiOf(fake, "u1")).toEqual(deleted);
          expect(fake.rows(CLAIMS_TABLE)).toEqual([]);
        },
      );
    });

    it("a second lost race returns 500 with nothing claimed", async () => {
      let round = 0;
      fake.hooks.beforeTransact = () => {
        round += 1;
        fake.put(PII_TABLE, { userId: { S: "u1" }, verifiedAddressKey: { S: `elsewhere-${round}` } });
      };

      const response = await verifyAt("u1", HOME);

      expect(response.statusCode).toBe(500);
      expect(unitCount(fake, keysFor(HOME.matched, ""))).toBe(0);
    });

    it("a previous counter already at 0 does not block a move and never goes negative", async () => {
      await verifyAt("u1", HOME);
      const home = keysFor(HOME.matched, "");
      fake.put(CLAIMS_TABLE, { ...counterKey(`U#${home.unitKey}`), n: { N: "0" } });

      const response = await verifyAt("u1", OTHER);

      expect(response.body.verified).toBe(true);
      expect(unitCount(fake, home)).toBe(0);
      expect(streetCount(fake, home)).toBe(0);
      expect(claimOf(fake, home, "u1")).toBeUndefined();
      expect(unitCount(fake, keysFor(OTHER.matched, ""))).toBe(1);
    });

    it("a recorded claim whose row is missing does not block a move or decrement other claims' counters", async () => {
      await verifyAt("u1", HOME);
      await verifyAt("u2", HOME);
      const home = keysFor(HOME.matched, "");
      fake.remove(CLAIMS_TABLE, { claimKey: { S: `U#${home.unitKey}` }, member: { S: "USER#u1" } });

      expect((await verifyAt("u1", OTHER)).body.verified).toBe(true);
      expect([unitCount(fake, home), streetCount(fake, home)]).toEqual([2, 2]);
      expect(piiOf(fake, "u1")?.verifiedAddressKey).toEqual({ S: keysFor(OTHER.matched, "").unitKey });
    });

    it("a claim row the profile does not record is kept (already counted) instead of failing", async () => {
      const keys = keysFor(HOME.matched, "");
      fake.put(CLAIMS_TABLE, { ...counterKey(`U#${keys.unitKey}`), n: { N: "1" } });
      fake.put(CLAIMS_TABLE, { ...counterKey(`S#${keys.streetKey}`), n: { N: "1" } });
      fake.put(CLAIMS_TABLE, { claimKey: { S: `U#${keys.unitKey}` }, member: { S: "USER#u1" }, claimedAt: { S: "x" } });

      expect((await verifyAt("u1", HOME)).body.verified).toBe(true);
      expect([unitCount(fake, keys), streetCount(fake, keys)]).toEqual([1, 1]);
      expect(piiOf(fake, "u1")?.verifiedAddressKey).toEqual({ S: keys.unitKey });
    });

    /** Writes what a concurrent verification of `userId` at `place` would leave behind. */
    const concurrentVerification = (userId: string, place: Place) => {
      const keys = keysFor(place.matched, "");
      const bump = (claimKey: string) => {
        const current = Number(fake.get(CLAIMS_TABLE, counterKey(claimKey))?.n?.N ?? 0);
        fake.put(CLAIMS_TABLE, { ...counterKey(claimKey), n: { N: String(current + 1) } });
      };
      bump(`U#${keys.unitKey}`);
      bump(`S#${keys.streetKey}`);
      fake.put(CLAIMS_TABLE, {
        claimKey: { S: `U#${keys.unitKey}` },
        member: { S: `USER#${userId}` },
        claimedAt: { S: "x" },
      });
      fake.put(PII_TABLE, {
        ...(piiOf(fake, userId) ?? { userId: { S: userId } }),
        constituentVerified: { BOOL: true },
        verificationStatus: { S: "likely_constituent" },
        resolvedState: { S: place.state },
        resolvedDistrict: { S: `${place.state}-${place.cd}` },
        verifiedAddressKey: { S: keys.unitKey },
        verifiedStreetKey: { S: keys.streetKey },
      });
    };

    it("a same-unit refresh that lost to a concurrent move re-reads and claims the unit again", async () => {
      await verifyAt("u1", HOME);
      let raced = false;
      fake.hooks.beforeUpdate = () => {
        if (raced) return;
        raced = true;
        // The concurrent request moved the account to OTHER: release HOME, claim OTHER.
        const home = keysFor(HOME.matched, "");
        fake.remove(CLAIMS_TABLE, { claimKey: { S: `U#${home.unitKey}` }, member: { S: "USER#u1" } });
        fake.put(CLAIMS_TABLE, { ...counterKey(`U#${home.unitKey}`), n: { N: "0" } });
        fake.put(CLAIMS_TABLE, { ...counterKey(`S#${home.streetKey}`), n: { N: "0" } });
        concurrentVerification("u1", OTHER);
      };

      expect((await verifyAt("u1", HOME)).body.verified).toBe(true);
      const home = keysFor(HOME.matched, "");
      const other = keysFor(OTHER.matched, "");
      expect([unitCount(fake, home), streetCount(fake, home)]).toEqual([1, 1]);
      expect([unitCount(fake, other), streetCount(fake, other)]).toEqual([0, 0]);
      expect(piiOf(fake, "u1")?.verifiedAddressKey).toEqual({ S: home.unitKey });
    });

    it("a claim that lost to a concurrent check of the same unit on the old lines re-stamps once and counts no skip", async () => {
      let raced = false;
      fake.hooks.beforeTransact = () => {
        if (raced) return;
        raced = true;
        concurrentVerification("u1", HOME);
      };

      const response = await verifyAt("u1", { ...HOME, cd: "14", congress: 120 });

      expect(response.body.resolved.districtId).toBe("IL-14");
      expect(piiOf(fake, "u1")?.resolvedDistrict).toEqual({ S: "IL-14" });
      expect(sentMessages).toHaveLength(1);
      expect(metrics()).not.toContain("RestampSkippedDistrictOnly");
    });

    it("enforce: a capped write that lost to a concurrent verification elsewhere re-reads and releases that claim", async () => {
      for (const user of FULL_UNIT) await verifyAt(user, HOME);
      setMode("enforce");
      let raced = false;
      fake.hooks.beforeUpdate = (input) => {
        if (raced || input.ExpressionAttributeValues?.[":verificationMethod"]?.S !== "address_capped") return;
        raced = true;
        concurrentVerification(NEXT, OTHER);
      };

      expect((await verifyAt(NEXT, HOME)).body.method).toBe("address_capped");
      const other = keysFor(OTHER.matched, "");
      expect(claimOf(fake, other, NEXT)).toBeUndefined();
      expect([unitCount(fake, other), streetCount(fake, other)]).toEqual([0, 0]);
      expect(piiOf(fake, NEXT)?.verificationMethod).toEqual({ S: "address_capped" });
    });

    it("manual mode that lost to a concurrent verification re-reads and releases the new claim", async () => {
      let raced = false;
      fake.hooks.beforeUpdate = () => {
        if (raced) return;
        raced = true;
        concurrentVerification("u1", HOME);
      };

      expect((await selectManually("u1", "IL", "13")).statusCode).toBe(200);
      const home = keysFor(HOME.matched, "");
      expect(claimOf(fake, home, "u1")).toBeUndefined();
      expect([unitCount(fake, home), streetCount(fake, home)]).toEqual([0, 0]);
      expect(piiOf(fake, "u1")?.verifiedAddressKey).toBeUndefined();
      // The re-read showed a verified account, so the switch to self-attested is re-stamped.
      expect(sentMessages).toHaveLength(1);
    });

    it("manual mode with a recorded claim whose row is missing still saves the district", async () => {
      await verifyAt("u1", HOME);
      await verifyAt("u2", HOME);
      const home = keysFor(HOME.matched, "");
      fake.remove(CLAIMS_TABLE, { claimKey: { S: `U#${home.unitKey}` }, member: { S: "USER#u1" } });

      expect((await selectManually("u1", "IL", "13")).statusCode).toBe(200);
      expect([unitCount(fake, home), streetCount(fake, home)]).toEqual([2, 2]);
      expect(piiOf(fake, "u1")?.verifiedAddressKey).toBeUndefined();
    });

    it("a failed counter read after the claim still returns the verification", async () => {
      fake.hooks.beforeBatchGet = () => {
        throw new Error("read failed");
      };

      expect((await verifyAt("u1", HOME)).body.verified).toBe(true);
      expect(metrics()).toEqual(["AddressVerified"]);
      expect(unitCount(fake, keysFor(HOME.matched, ""))).toBe(1);
    });
  });

  describe("eligibility and validation before any claim", () => {
    it.each([
      [{ deletionStatus: { S: "in_progress" } }, "ACCOUNT_DELETION_IN_PROGRESS"],
      [{ deletionStatus: { S: "completed" } }, "ACCOUNT_INELIGIBLE"],
      [{ adultStatus: { S: "self_reported_under18" } }, "ACCOUNT_INELIGIBLE"],
    ])("refuses a POST from an ineligible account (%j) with 403 %s and writes nothing", async (fields, code) => {
      fake.put(PII_TABLE, { userId: { S: "u1" }, ...fields });
      const before = clone(fake.rows(PII_TABLE));

      const response = await verifyAt("u1", HOME);

      expect(response.statusCode).toBe(403);
      expect(response.body.error).toBe(code);
      expect(fake.ops).toEqual(["GetItem"]);
      expect(fake.rows(PII_TABLE)).toEqual(before);
      expect(sentMessages).toEqual([]);
    });

    it("an address that does not geocode gets 422 and nothing is claimed or queued", async () => {
      fetchMock().mockImplementation(async () => ({
        ok: true,
        json: async () => ({ result: { addressMatches: [] } }),
      }));

      const response = await handler(asUser("u1", { httpMethod: "POST", body: JSON.stringify(HOME.fields) }));

      expect(response.statusCode).toBe(422);
      expect(fake.ops).toEqual(["GetItem"]);
      expect(sentMessages).toEqual([]);
    });
  });
});

// REL-46: the Census layers the geocoder serves, and the vintage each request asks for.
describe("districtVerification Census layers and vintages", () => {
  const BEFORE_JAN_3 = Date.parse("2026-11-05T12:00:00Z");
  const SWITCH = Date.parse("2027-01-03T17:00:00Z");
  const OLD_VINTAGE = "ACS2025_Current";
  const NEW_VINTAGE = "Current_Current";

  let fake: FakeDb;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let sentMessages: Array<{ MessageBody?: string }>;
  let urls: URL[];

  const setClock = (ms: number) => jest.spyOn(Date, "now").mockReturnValue(ms);
  const vintages = () => urls.map((url) => url.searchParams.get("vintage"));
  const match = (state: string, geographies: Record<string, unknown>) => ({
    result: {
      addressMatches: [
        { matchedAddress: `1 CAPITOL WAY, SOMEWHERE, ${state}, 00000`, addressComponents: { state }, geographies },
      ],
    },
  });
  const ok = (body: unknown) => ({ ok: true, json: async () => body });
  const rejected = (status: number, text: string) => ({ ok: false, status, text: async () => text });
  const layer = (name: string, record: Record<string, unknown>) => ({ [name]: [record] });
  /** Every request is recorded; `answer` sees the URL and returns the fetch response. */
  const geocoder = (answer: (url: URL) => unknown) =>
    (globalThis.fetch = jest.fn(async (raw: string) => {
      const url = new URL(raw);
      urls.push(url);
      return answer(url);
    }) as unknown as typeof fetch);
  const post = async (state: string, sub = "u1") => {
    const response = await handler(
      asUser(sub, {
        httpMethod: "POST",
        body: JSON.stringify({ line1: "1 Capitol Way", city: "Somewhere", state, zip: "00000" }),
      }),
    );
    return { statusCode: response.statusCode, body: JSON.parse(response.body) };
  };
  const districtFor = async (state: string, geographies: Record<string, unknown>) => {
    geocoder(() => ok(match(state, geographies)));
    const response = await post(state);
    return { statusCode: response.statusCode, districtId: response.body.resolved?.districtId };
  };

  beforeEach(() => {
    fake = createFakeDb();
    sentMessages = [];
    urls = [];
    mockSend.mockReset();
    mockSend.mockImplementation(fake.send);
    mockSqsSend.mockReset();
    mockSqsSend.mockImplementation(async (command: { input: { MessageBody?: string } }) => {
      fake.ops.push("SendMessage");
      sentMessages.push(command.input);
      return { MessageId: "m-1" };
    });
    process.env.ADDRESS_CLAIMS_TABLE_NAME = CLAIMS_TABLE;
    process.env.VOTE_RESTAMP_QUEUE_URL = QUEUE_URL;
    delete process.env.VERIFICATION_LIMITS_MODE;
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    setClock(BEFORE_JAN_3);
  });

  afterEach(() => {
    delete process.env.ADDRESS_CLAIMS_TABLE_NAME;
    delete process.env.VOTE_RESTAMP_QUEUE_URL;
    jest.restoreAllMocks();
  });

  describe("reading the congressional layer", () => {
    it("resolves a Wyoming address on the 120th layer ({CD120 00, BASENAME at large}) to WY-AL", async () => {
      const record = {
        CD120: "00",
        GEOID: "5600",
        CDSESSN: "120",
        BASENAME: "Congressional District (at Large)",
      };

      expect(await districtFor("WY", layer("120th Congressional Districts", record))).toEqual({
        statusCode: 200,
        districtId: "WY-AL",
      });
    });

    it("resolves a Wyoming address on the 119th layer (no CDnnn field) to WY-AL", async () => {
      const record = { GEOID: "5600", CDSESSN: "119", BASENAME: "Congressional District (at Large)" };

      expect(await districtFor("WY", layer("119th Congressional Districts", record))).toEqual({
        statusCode: 200,
        districtId: "WY-AL",
      });
    });

    it("resolves a DC delegate (CD120 98, and the 119th BASENAME form) to DC-AL", async () => {
      const on120 = { CD120: "98", GEOID: "1198", CDSESSN: "120", BASENAME: "Delegate District (at Large)" };
      const on119 = { GEOID: "1198", CDSESSN: "119", BASENAME: "Delegate District (at Large)" };

      expect((await districtFor("DC", layer("120th Congressional Districts", on120))).districtId).toBe("DC-AL");
      expect((await districtFor("DC", layer("119th Congressional Districts", on119))).districtId).toBe("DC-AL");
    });

    it("resolves a Texas address on the 119th shape ({GEOID 4837, BASENAME 37}) to TX-37", async () => {
      const record = { GEOID: "4837", CDSESSN: "119", BASENAME: "37" };

      expect(await districtFor("TX", layer("119th Congressional Districts", record))).toEqual({
        statusCode: 200,
        districtId: "TX-37",
      });
    });

    it("takes the highest CDnnn in a record (CD119FP 12 and CD120 14 give 14)", async () => {
      const record = { CD119FP: "12", CD120: "14", BASENAME: "12" };

      expect((await districtFor("CA", layer("120th Congressional Districts", record))).districtId).toBe("CA-14");
    });

    it("takes the highest-numbered congressional layer when a response holds two", async () => {
      const both = {
        ...layer("119th Congressional Districts", { CD119FP: "12" }),
        ...layer("120th Congressional Districts", { CD120: "14" }),
      };
      const reversed = {
        ...layer("120th Congressional Districts", { CD120: "14" }),
        ...layer("119th Congressional Districts", { CD119FP: "12" }),
      };

      expect((await districtFor("CA", both)).districtId).toBe("CA-14");
      expect((await districtFor("CA", reversed)).districtId).toBe("CA-14");
    });

    it("falls back to the last two digits of GEOID, then to a numeric BASENAME", async () => {
      const geoidOnly = { GEOID: "2903", BASENAME: "Congressional District 3" };

      expect((await districtFor("MO", layer("119th Congressional Districts", geoidOnly))).districtId).toBe("MO-03");
      expect((await districtFor("MO", layer("119th Congressional Districts", { BASENAME: "7" }))).districtId).toBe(
        "MO-07",
      );
    });

    it("prefers CDnnn over GEOID over a numeric BASENAME", async () => {
      const all = { CD120: "10", GEOID: "4837", BASENAME: "37" };
      const noCd = { GEOID: "2903", BASENAME: "5" };

      expect((await districtFor("TX", layer("120th Congressional Districts", all))).districtId).toBe("TX-10");
      expect((await districtFor("MO", layer("119th Congressional Districts", noCd))).districtId).toBe("MO-03");
    });

    it("answers 422 when the response has no congressional layer (and for an unreadable record)", async () => {
      const states = { States: [{ GEOID: "48", BASENAME: "Texas" }] };

      expect((await districtFor("TX", states)).statusCode).toBe(422);
      expect((await districtFor("TX", layer("120th Congressional Districts", { BASENAME: "Odd" }))).statusCode).toBe(
        422,
      );
    });
  });

  describe("the geocoder vintage", () => {
    /** Street lookup finds nothing, so the one-line lookup runs too: both paths are seen. */
    const answerBothPaths = () =>
      geocoder((url) =>
        url.pathname.endsWith("/onelineaddress")
          ? ok(match("TX", layer("119th Congressional Districts", { GEOID: "4837", BASENAME: "37" })))
          : ok({ result: { addressMatches: [] } }),
      );

    it.each([
      ["TX", BEFORE_JAN_3, OLD_VINTAGE],
      ["TX", SWITCH - 1, OLD_VINTAGE],
      ["TX", SWITCH, NEW_VINTAGE],
      ["TX", Date.parse("2027-01-03T17:00:01Z"), NEW_VINTAGE],
      ["MO", BEFORE_JAN_3, OLD_VINTAGE],
      ["MO", Date.parse("2027-01-03T17:00:01Z"), OLD_VINTAGE],
    ])("%s at %d asks both the street and the one-line lookup for %s", async (state, at, expected) => {
      setClock(at);
      answerBothPaths();

      const response = await post(state);

      expect(response.statusCode).toBe(200);
      expect(urls.map((url) => url.pathname.split("/").pop())).toEqual(["address", "onelineaddress"]);
      expect(vintages()).toEqual([expected, expected]);
      expect(urls.map((url) => url.searchParams.get("benchmark"))).toEqual(["Public_AR_Current", "Public_AR_Current"]);
    });

    it("retries once with Current_Current when the geocoder rejects the vintage, and counts it", async () => {
      geocoder((url) =>
        url.searchParams.get("vintage") === OLD_VINTAGE
          ? rejected(400, '{"errors":["Invalid vintage in request"],"status":"400"}')
          : ok(match("TX", layer("120th Congressional Districts", { CD120: "10", BASENAME: "10" }))),
      );

      const response = await post("TX");

      expect(response.statusCode).toBe(200);
      expect(response.body.resolved.districtId).toBe("TX-10");
      expect(vintages()).toEqual([OLD_VINTAGE, NEW_VINTAGE]);
      expect(logSpy.mock.calls.flatMap(([line]: unknown[]) => String(line))).toEqual(
        expect.arrayContaining([expect.stringContaining('"GeocoderVintageFallback"')]),
      );
      const warning = JSON.parse(
        warnSpy.mock.calls.map(([line]: unknown[]) => String(line)).find((line) => line.includes("vintage")) ?? "{}",
      );
      expect(warning).toEqual(
        expect.objectContaining({ state: "TX", vintage: OLD_VINTAGE, fallbackVintage: NEW_VINTAGE }),
      );
    });

    it("retries once with Current_Current when the answer has no congressional layer at all", async () => {
      geocoder((url) =>
        url.searchParams.get("vintage") === OLD_VINTAGE
          ? ok(match("TX", { States: [{ GEOID: "48" }] }))
          : ok(match("TX", layer("120th Congressional Districts", { CD120: "10" }))),
      );

      const response = await post("TX");

      expect(response.statusCode).toBe(200);
      expect(vintages()).toEqual([OLD_VINTAGE, NEW_VINTAGE]);
      expect(logSpy.mock.calls.flatMap(([line]: unknown[]) => String(line))).toEqual(
        expect.arrayContaining([expect.stringContaining('"GeocoderVintageFallback"')]),
      );
    });

    it("does not retry on other errors, or when Current_Current is already the vintage", async () => {
      geocoder(() => rejected(500, "Internal Server Error"));
      expect((await post("TX")).statusCode).toBe(500);
      expect(vintages()).toEqual([OLD_VINTAGE]);

      urls.length = 0;
      setClock(SWITCH);
      geocoder(() => rejected(400, '{"errors":["Invalid vintage in request"]}'));
      expect((await post("TX")).statusCode).toBe(500);
      expect(vintages()).toEqual([NEW_VINTAGE]);

      urls.length = 0;
      geocoder(() => ok(match("TX", { States: [{ GEOID: "48" }] })));
      expect((await post("TX")).statusCode).toBe(422);
      expect(vintages().every((vintage) => vintage === NEW_VINTAGE)).toBe(true);
      expect(logSpy.mock.calls.flatMap(([line]: unknown[]) => String(line))).not.toEqual(
        expect.arrayContaining([expect.stringContaining('"GeocoderVintageFallback"')]),
      );
    });

    it("does not retry on a 404 or 429 that does not name the vintage", async () => {
      for (const status of [404, 429]) {
        urls.length = 0;
        geocoder(() => rejected(status, "Not here"));
        await post("TX");
        expect(vintages()).toEqual([OLD_VINTAGE]);
      }
      expect(logSpy.mock.calls.flatMap(([line]: unknown[]) => String(line))).not.toEqual(
        expect.arrayContaining([expect.stringContaining('"GeocoderVintageFallback"')]),
      );
    });

    it("logs the Congress number and the vintage in the stored line", async () => {
      geocoder(() => ok(match("TX", layer("119th Congressional Districts", { CDSESSN: "119", GEOID: "4837" }))));

      await post("TX");

      const stored = logSpy.mock.calls
        .map(([line]: unknown[]) => String(line))
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line))
        .find((line) => line.message === "District verification stored");
      expect(stored).toEqual(expect.objectContaining({ congress: "119", vintage: OLD_VINTAGE }));
      expect(piiOf(fake, "u1")).not.toHaveProperty("districtCongress");
    });
  });

  describe("a delegate district stored as 98", () => {
    const seedDcAs98 = (sub: string) =>
      fake.put(PII_TABLE, {
        userId: { S: sub },
        adultStatus: { S: "attested_adult" },
        constituentVerified: { BOOL: true },
        verificationStatus: { S: "likely_constituent" },
        resolvedState: { S: "DC" },
        resolvedDistrict: { S: "DC-98" },
      });
    const dcOn120 = () =>
      geocoder(() =>
        ok(
          match(
            "DC",
            layer("120th Congressional Districts", { CD120: "98", BASENAME: "Delegate District (at Large)" }),
          ),
        ),
      );

    it("re-checked as AL is not a change: no re-stamp is queued, with or without address limits", async () => {
      for (const withClaims of [true, false]) {
        if (!withClaims) delete process.env.ADDRESS_CLAIMS_TABLE_NAME;
        seedDcAs98("u1");
        dcOn120();

        const response = await post("DC");

        expect(response.statusCode).toBe(200);
        expect(response.body.resolved.districtId).toBe("DC-AL");
        expect(sentMessages).toEqual([]);
        expect(piiOf(fake, "u1")?.resolvedDistrict).toEqual({ S: "DC-AL" });
      }
    });

    it("a real change of district still queues the re-stamp", async () => {
      seedDcAs98("u1");
      geocoder(() => ok(match("TX", layer("119th Congressional Districts", { GEOID: "4837", BASENAME: "37" }))));

      await post("TX");

      expect(sentMessages).toHaveLength(1);
    });
  });

  describe("a redistricting re-check (REL-46, D14)", () => {
    const SKIPPED_LINE = "Vote re-stamp skipped: only the district changed at the same address";
    const logLines = (): Array<Record<string, unknown>> =>
      logSpy.mock.calls
        .map(([line]: unknown[]) => String(line))
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
    const verifiedOn119 = async () => {
      geocoder(() => ok(match("TX", layer("119th Congressional Districts", { GEOID: "4837", BASENAME: "37" }))));
      expect((await post("TX")).body.resolved.districtId).toBe("TX-37");
      expect(sentMessages).toHaveLength(1);
      sentMessages.length = 0;
      logSpy.mockClear();
      setClock(SWITCH);
    };
    const recheckOn120 = () => {
      geocoder(() => ok(match("TX", layer("120th Congressional Districts", { CD120: "35" }))));
      return post("TX");
    };

    it("the same address in a new district keeps past votes where they were cast: no re-stamp, counted and logged", async () => {
      await verifiedOn119();

      const response = await recheckOn120();

      expect(response.statusCode).toBe(200);
      expect(response.body.resolved.districtId).toBe("TX-35");
      expect(piiOf(fake, "u1")?.resolvedDistrict).toEqual({ S: "TX-35" });
      expect(sentMessages).toEqual([]);
      expect(emfMetricNames(logSpy)).toEqual(["RestampSkippedDistrictOnly"]);
      const skipped = logLines().find((line) => line.message === SKIPPED_LINE);
      expect(skipped).toEqual(
        expect.objectContaining({ verificationLimitsMode: "watch", congress: "120", vintage: NEW_VINTAGE }),
      );
      expect(JSON.stringify(logLines())).not.toMatch(/TX-3[57]/);
    });

    it("skips the re-stamp under enforce as well", async () => {
      await verifiedOn119();
      process.env.VERIFICATION_LIMITS_MODE = "enforce";

      expect((await recheckOn120()).body.verified).toBe(true);
      expect(sentMessages).toEqual([]);
      expect(emfMetricNames(logSpy)).toEqual(["RestampSkippedDistrictOnly"]);
    });

    it("without address limits the address is unknown, so the district change still queues the re-stamp", async () => {
      delete process.env.ADDRESS_CLAIMS_TABLE_NAME;
      await verifiedOn119();

      await recheckOn120();

      expect(sentMessages).toHaveLength(1);
      expect(emfMetricNames(logSpy)).not.toContain("RestampSkippedDistrictOnly");
      expect(logLines().map((line) => line.message)).not.toContain(SKIPPED_LINE);
    });

    it("a claim stored on the 120th lines before Jan 3 is corrected by a re-check on the 119th: the re-stamp is queued", async () => {
      geocoder(() => ok(match("TX", layer("120th Congressional Districts", { CD120: "35" }))));
      expect((await post("TX")).body.resolved.districtId).toBe("TX-35");
      sentMessages.length = 0;
      logSpy.mockClear();

      geocoder(() => ok(match("TX", layer("119th Congressional Districts", { GEOID: "4837", BASENAME: "37" }))));
      const response = await post("TX");

      expect(response.body.resolved.districtId).toBe("TX-37");
      expect(sentMessages).toHaveLength(1);
      expect(emfMetricNames(logSpy)).not.toContain("RestampSkippedDistrictOnly");
    });

    it("Missouri: a claim on the 2025 map is corrected by a re-check after Jan 3, on the 119th lines", async () => {
      geocoder(() => ok(match("MO", layer("120th Congressional Districts", { CD120: "05" }))));
      expect((await post("MO")).body.resolved.districtId).toBe("MO-05");
      sentMessages.length = 0;
      logSpy.mockClear();
      urls.length = 0;
      setClock(SWITCH);

      geocoder(() => ok(match("MO", layer("119th Congressional Districts", { GEOID: "2903", BASENAME: "3" }))));
      const response = await post("MO");

      expect(vintages()).toEqual([OLD_VINTAGE]);
      expect(response.body.resolved.districtId).toBe("MO-03");
      expect(sentMessages).toHaveLength(1);
      expect(emfMetricNames(logSpy)).not.toContain("RestampSkippedDistrictOnly");
    });

    it("a fallback to the 120th lines before Jan 3 keeps past votes on the 119th: no re-stamp", async () => {
      geocoder(() => ok(match("TX", layer("119th Congressional Districts", { GEOID: "4837", BASENAME: "37" }))));
      expect((await post("TX")).body.resolved.districtId).toBe("TX-37");
      sentMessages.length = 0;
      logSpy.mockClear();

      geocoder((url) =>
        url.searchParams.get("vintage") === OLD_VINTAGE
          ? rejected(400, '{"errors":["Invalid vintage in request"]}')
          : ok(match("TX", layer("120th Congressional Districts", { CD120: "35" }))),
      );
      const response = await post("TX");

      expect(response.body.resolved.districtId).toBe("TX-35");
      expect(sentMessages).toEqual([]);
      expect(emfMetricNames(logSpy)).toEqual(["GeocoderVintageFallback", "RestampSkippedDistrictOnly"]);
    });
  });
});

export {};
