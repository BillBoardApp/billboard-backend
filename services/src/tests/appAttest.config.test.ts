import { APP_ATTEST_DEFAULTS } from "../shared/abuseLimits";
import {
  AAGUID_DEVELOPMENT,
  AAGUID_PRODUCTION,
  AAGUID_SANDBOX,
  appAttestConfigFromEnv,
  parseAppVersion,
  parseClientMode,
  parseMode,
} from "../shared/appAttest/config";

describe("App Attest switches (C3 3.1)", () => {
  it("with nothing set, everything is off and the documented defaults apply", () => {
    expect(appAttestConfigFromEnv({})).toEqual({
      mode: "off",
      deviceCheckMode: "off",
      clientMode: "off",
      developmentAllowed: false,
      maxAccountsPerKey: APP_ATTEST_DEFAULTS.maxAccountsPerKey,
      deviceMaxAccounts: APP_ATTEST_DEFAULTS.deviceMaxAccounts,
      deviceCounterWindowMonths: APP_ATTEST_DEFAULTS.deviceCounterWindowMonths,
      failClosed: false,
      minAppVersion: null,
      challengeTtlSeconds: APP_ATTEST_DEFAULTS.challengeTtlSeconds,
      tableName: null,
      exemptGroup: APP_ATTEST_DEFAULTS.exemptGroup,
      deviceCheckSecretName: null,
    });
  });

  it("reads observe-only values (watch, DeviceCheck off, client on)", () => {
    expect(
      appAttestConfigFromEnv({
        APP_ATTEST_TABLE_NAME: "AppAttest",
        APP_ATTEST_MODE: "watch",
        DEVICE_CHECK_MODE: "off",
        APP_ATTEST_CLIENT_MODE: "on",
        APP_ATTEST_ALLOWED_ENVIRONMENTS: "production",
        APP_ATTEST_MAX_ACCOUNTS_PER_KEY: String(APP_ATTEST_DEFAULTS.maxAccountsPerKey),
        APP_ATTEST_FAIL_CLOSED: "false",
        MIN_APP_VERSION: "",
        APP_ATTEST_CHALLENGE_TTL_SECONDS: String(APP_ATTEST_DEFAULTS.challengeTtlSeconds),
        APP_ATTEST_EXEMPT_GROUP: "ExemptTesters",
        DEVICE_CHECK_SECRET_NAME: "Billboard/AppleDeviceCheckKey",
      }),
    ).toMatchObject({
      mode: "watch",
      deviceCheckMode: "off",
      clientMode: "on",
      developmentAllowed: false,
      failClosed: false,
    });
  });

  it("an unset table name forces App Attest and the client mode off; DeviceCheck needs its secret name", () => {
    expect(appAttestConfigFromEnv({ APP_ATTEST_MODE: "enforce", APP_ATTEST_CLIENT_MODE: "on" })).toMatchObject({
      mode: "off",
      clientMode: "off",
    });
    expect(appAttestConfigFromEnv({ DEVICE_CHECK_MODE: "watch" }).deviceCheckMode).toBe("off");
    expect(appAttestConfigFromEnv({ DEVICE_CHECK_MODE: "watch", DEVICE_CHECK_SECRET_NAME: "s" }).deviceCheckMode).toBe(
      "watch",
    );
  });

  it("parseMode: unset is off, known values in any case, anything else is watch (never blocks)", () => {
    expect(parseMode(undefined)).toBe("off");
    expect(parseMode("  ")).toBe("off");
    expect(parseMode("OFF")).toBe("off");
    expect(parseMode(" Watch ")).toBe("watch");
    expect(parseMode("ENFORCE")).toBe("enforce");
    expect(parseMode("enforced")).toBe("watch");
    expect(parseMode("true")).toBe("watch");
  });

  it("parseClientMode: only on is on (off is the kill-switch side)", () => {
    expect(parseClientMode("on")).toBe("on");
    expect(parseClientMode(" ON ")).toBe("on");
    expect(parseClientMode("off")).toBe("off");
    expect(parseClientMode("yes")).toBe("off");
    expect(parseClientMode(undefined)).toBe("off");
  });

  it("numbers fall back to the default when out of range or not whole", () => {
    const env = (values: Record<string, string>) => appAttestConfigFromEnv({ APP_ATTEST_TABLE_NAME: "T", ...values });
    expect(env({ DEVICE_MAX_ACCOUNTS: "2" }).deviceMaxAccounts).toBe(2);
    expect(env({ DEVICE_MAX_ACCOUNTS: "4" }).deviceMaxAccounts).toBe(APP_ATTEST_DEFAULTS.deviceMaxAccounts);
    expect(env({ DEVICE_MAX_ACCOUNTS: "0" }).deviceMaxAccounts).toBe(APP_ATTEST_DEFAULTS.deviceMaxAccounts);
    expect(env({ APP_ATTEST_MAX_ACCOUNTS_PER_KEY: "5" }).maxAccountsPerKey).toBe(5);
    expect(env({ APP_ATTEST_MAX_ACCOUNTS_PER_KEY: "2.5" }).maxAccountsPerKey).toBe(
      APP_ATTEST_DEFAULTS.maxAccountsPerKey,
    );
    expect(env({ APP_ATTEST_CHALLENGE_TTL_SECONDS: "10" }).challengeTtlSeconds).toBe(
      APP_ATTEST_DEFAULTS.challengeTtlSeconds,
    );
    expect(env({ APP_ATTEST_CHALLENGE_TTL_SECONDS: "600" }).challengeTtlSeconds).toBe(600);
    expect(env({ DEVICE_COUNTER_WINDOW_MONTHS: "6" }).deviceCounterWindowMonths).toBe(6);
  });

  it("development keys are allowed only when listed; fail-closed only with true", () => {
    const env = (values: Record<string, string>) => appAttestConfigFromEnv({ APP_ATTEST_TABLE_NAME: "T", ...values });
    expect(env({ APP_ATTEST_ALLOWED_ENVIRONMENTS: "production,development" }).developmentAllowed).toBe(true);
    expect(env({ APP_ATTEST_ALLOWED_ENVIRONMENTS: " Production , DEVELOPMENT " }).developmentAllowed).toBe(true);
    expect(env({ APP_ATTEST_ALLOWED_ENVIRONMENTS: "production" }).developmentAllowed).toBe(false);
    expect(env({ APP_ATTEST_FAIL_CLOSED: "TRUE" }).failClosed).toBe(true);
    expect(env({ APP_ATTEST_FAIL_CLOSED: "1" }).failClosed).toBe(false);
  });

  it("MIN_APP_VERSION accepts one to three dotted numbers only", () => {
    expect(parseAppVersion("1.2")).toBe("1.2");
    expect(parseAppVersion(" 2.0.1 ")).toBe("2.0.1");
    expect(parseAppVersion("1")).toBe("1");
    expect(parseAppVersion("1.2.3.4")).toBeNull();
    expect(parseAppVersion("v1.2")).toBeNull();
    expect(parseAppVersion(12)).toBeNull();
    expect(appAttestConfigFromEnv({ MIN_APP_VERSION: "beta" }).minAppVersion).toBeNull();
  });

  it("aaguids are Apple's three values", () => {
    expect(AAGUID_PRODUCTION.toString("latin1")).toBe("appattest\0\0\0\0\0\0\0");
    expect(AAGUID_DEVELOPMENT.toString("latin1")).toBe("appattestdevelop");
    expect(AAGUID_SANDBOX.toString("latin1")).toBe("appattestsandbox");
  });
});
