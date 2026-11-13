export {};

const mockSecretsManagerSend = jest.fn();
const mockSecretsManagerClient = jest.fn(() => ({ send: mockSecretsManagerSend }));

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn((...args: unknown[]) => (mockSecretsManagerClient as jest.Mock)(...args)),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

type CongressApiKeyModule = typeof import("../shared/congressApiKey");

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const originalSecretName = process.env.SECRET_NAME;

let mod: CongressApiKeyModule;
let now: number;

const secretResponse = (secret: unknown) => ({ SecretString: JSON.stringify(secret) });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

beforeEach(() => {
  jest.resetModules();
  mockSecretsManagerSend.mockReset();
  mockSecretsManagerClient.mockClear();
  process.env.SECRET_NAME = "congress-api-secret";
  now = Date.parse("2026-09-24T12:00:00.000Z");
  jest.spyOn(Date, "now").mockImplementation(() => now);
  mod = require("../shared/congressApiKey") as CongressApiKeyModule;
});

afterEach(() => {
  jest.restoreAllMocks();
  if (originalSecretName === undefined) {
    delete process.env.SECRET_NAME;
  } else {
    process.env.SECRET_NAME = originalSecretName;
  }
});

describe("getCongressApiKey", () => {
  it("reads the congressApiKey field from the secret named by SECRET_NAME", async () => {
    mockSecretsManagerSend.mockResolvedValue(secretResponse({ congressApiKey: "key-1" }));

    await expect(mod.getCongressApiKey()).resolves.toBe("key-1");
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);
    expect(mockSecretsManagerSend.mock.calls[0][0]).toEqual({ input: { SecretId: "congress-api-secret" } });
  });

  it("reads SECRET_NAME at call time", async () => {
    process.env.SECRET_NAME = "changed-after-import";
    mockSecretsManagerSend.mockResolvedValue(secretResponse({ congressApiKey: "key-1" }));

    await mod.getCongressApiKey();
    expect(mockSecretsManagerSend.mock.calls[0][0]).toEqual({ input: { SecretId: "changed-after-import" } });
  });

  it("trims surrounding whitespace from the key", async () => {
    mockSecretsManagerSend.mockResolvedValue(secretResponse({ congressApiKey: "  key-1\n" }));
    await expect(mod.getCongressApiKey()).resolves.toBe("key-1");
  });

  it("creates the default client lazily and only once", async () => {
    expect(mockSecretsManagerClient).not.toHaveBeenCalled();
    mockSecretsManagerSend.mockResolvedValue(secretResponse({ congressApiKey: "key-1" }));

    await mod.getCongressApiKey();
    mod.invalidateCongressApiKey();
    await mod.getCongressApiKey();

    expect(mockSecretsManagerClient).toHaveBeenCalledTimes(1);
  });

  it("uses an injected client instead of the default", async () => {
    const injected = { send: jest.fn().mockResolvedValue(secretResponse({ congressApiKey: "injected" })) };

    await expect(mod.getCongressApiKey(injected as never)).resolves.toBe("injected");
    expect(injected.send).toHaveBeenCalledTimes(1);
    expect(mockSecretsManagerSend).not.toHaveBeenCalled();
    expect(mockSecretsManagerClient).not.toHaveBeenCalled();
  });

  it("caches the key for 15 minutes and then re-reads it", async () => {
    mockSecretsManagerSend
      .mockResolvedValueOnce(secretResponse({ congressApiKey: "key-1" }))
      .mockResolvedValueOnce(secretResponse({ congressApiKey: "key-2" }));

    await expect(mod.getCongressApiKey()).resolves.toBe("key-1");

    now += FIFTEEN_MINUTES - 1;
    await expect(mod.getCongressApiKey()).resolves.toBe("key-1");
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(mod.getCongressApiKey()).resolves.toBe("key-2");
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(2);
    expect(mod.CONGRESS_API_KEY_TTL_MS).toBe(FIFTEEN_MINUTES);
  });

  it("shares one Secrets Manager read between concurrent callers", async () => {
    const pending = deferred<{ SecretString: string }>();
    mockSecretsManagerSend.mockReturnValueOnce(pending.promise);

    const calls = Promise.all([mod.getCongressApiKey(), mod.getCongressApiKey(), mod.getCongressApiKey()]);
    pending.resolve(secretResponse({ congressApiKey: "shared" }));

    await expect(calls).resolves.toEqual(["shared", "shared", "shared"]);
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    mockSecretsManagerSend
      .mockRejectedValueOnce(new Error("AccessDenied"))
      .mockResolvedValueOnce(secretResponse({ congressApiKey: "key-1" }));

    await expect(mod.getCongressApiKey()).rejects.toThrow("AccessDenied");
    await expect(mod.getCongressApiKey()).resolves.toBe("key-1");
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an empty SecretString", { SecretString: "" }, "Secret value is empty"],
    ["no SecretString", {}, "Secret value is empty"],
    ["a missing field", secretResponse({ other: "x" }), "congressApiKey not found in secret"],
    ["a blank field", secretResponse({ congressApiKey: "   " }), "congressApiKey not found in secret"],
    ["a non-string field", secretResponse({ congressApiKey: 123 }), "congressApiKey not found in secret"],
    ["a JSON null secret", { SecretString: "null" }, "congressApiKey not found in secret"],
  ])("rejects %s with the existing handler error message", async (_label, response, message) => {
    mockSecretsManagerSend.mockResolvedValue(response);
    await expect(mod.getCongressApiKey()).rejects.toThrow(message);
  });

  it("rejects a secret that is not JSON", async () => {
    mockSecretsManagerSend.mockResolvedValue({ SecretString: "not-json" });
    await expect(mod.getCongressApiKey()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("rejects without calling Secrets Manager when SECRET_NAME is unset", async () => {
    delete process.env.SECRET_NAME;
    await expect(mod.getCongressApiKey()).rejects.toThrow("SECRET_NAME environment variable is not set");
    expect(mockSecretsManagerSend).not.toHaveBeenCalled();
  });
});

describe("invalidateCongressApiKey", () => {
  it("forces the next call to re-read Secrets Manager", async () => {
    mockSecretsManagerSend
      .mockResolvedValueOnce(secretResponse({ congressApiKey: "old" }))
      .mockResolvedValueOnce(secretResponse({ congressApiKey: "rotated" }));

    await expect(mod.getCongressApiKey()).resolves.toBe("old");
    mod.invalidateCongressApiKey();
    await expect(mod.getCongressApiKey()).resolves.toBe("rotated");
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(2);
  });

  it("stops a read that started before invalidation from repopulating the cache", async () => {
    const stale = deferred<{ SecretString: string }>();
    mockSecretsManagerSend
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(secretResponse({ congressApiKey: "fresh" }))
      .mockResolvedValueOnce(secretResponse({ congressApiKey: "unexpected" }));

    const staleCall = mod.getCongressApiKey();
    mod.invalidateCongressApiKey();
    const freshCall = mod.getCongressApiKey();

    stale.resolve(secretResponse({ congressApiKey: "stale" }));
    await expect(staleCall).resolves.toBe("stale");
    await expect(freshCall).resolves.toBe("fresh");

    await expect(mod.getCongressApiKey()).resolves.toBe("fresh");
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(2);
  });

  it("is safe to call before any key was read", () => {
    expect(() => mod.invalidateCongressApiKey()).not.toThrow();
  });
});

describe("isCongressApiAuthFailureStatus", () => {
  it.each([401, 403])("returns true for %p", (status) => {
    expect(mod.isCongressApiAuthFailureStatus(status)).toBe(true);
  });

  it.each([200, 400, 404, 429, 500])("returns false for %p", (status) => {
    expect(mod.isCongressApiAuthFailureStatus(status)).toBe(false);
  });
});
