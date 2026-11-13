import {
  APP_ATTEST_HEADER,
  base64url,
  bodySha256,
  compareVersions,
  decodeBase64url,
  decodeStandardBase64,
  emailSha256,
  isBelowMinimumVersion,
  keyIdPrefix,
  parseCognitoGroups,
  parseMarker,
  rawBody,
  readHeader,
} from "../shared/appAttest/wire";
import { asApiGatewayEvent } from "./fixtures/awsEvents";
import { b64u, generateDeviceKey, sha256 } from "./fixtures/appAttest/helpers";

// contracts/fixtures/openapi/PreSignUpClientMetadata.valid.json and AppAttestSignUpClientData.valid.json
const CONTRACT_MARKER =
  "v1.a.iInD91fLmBNJf1uM35LYM2FQ9DOE3FNDPD-tKlX7pkw.eyJ2IjoxLCJwdXJwb3NlIjoic2lnbnVwIiwiY2hhbGxlbmdlIjoiUm1FeG1FaGtTdUlhb0ZtMkoyaTRXMGdYSEFldmltbU5NSVZ0a1haNE5qRSIsImVtYWlsU2hhMjU2IjoiakllMGljNDF6eTR2T2ZnT0tDeXk2QVNUS2xhaUU1Zy03clFvUUgxRHRTMCJ9.omlzaWduYXR1cmVYRgBz7CZtT7Stvz0QSqcU-fEQMv2KttiCn8QLUshvZIXXkozC69Rkbz_j83S-EdkFv0vidfqG84idgqn33F5B3TIwMQ";

describe("parseMarker", () => {
  it("reads every form", () => {
    expect(parseMarker(undefined)).toEqual({ kind: "missing" });
    expect(parseMarker("")).toEqual({ kind: "missing" });
    expect(parseMarker("v1.u")).toEqual({ kind: "unsupported" });
    expect(parseMarker("v1.b")).toEqual({ kind: "bypass" });
    for (const code of ["challenge", "attest", "assert", "timeout", "disabled", "keychain"]) {
      expect(parseMarker(`v1.e.${code}`)).toEqual({ kind: "client_error", code });
    }
    expect(parseMarker("v1.e.somethingNew")).toEqual({ kind: "client_error", code: "other" });
    expect(parseMarker("v1.e.")).toEqual({ kind: "client_error", code: "other" });
  });

  it("re-encodes a non-canonical key ID spelling to the canonical table key", () => {
    const canonical = generateDeviceKey().keyId;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    // For 32 bytes the last character's two low bits are spare; setting one keeps the same bytes.
    const respelled = canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.at(-1) as string) | 1];
    expect(respelled).not.toBe(canonical);
    const parsed = parseMarker(`v1.a.${respelled}.Yw.Yw`);
    expect(parsed).toMatchObject({ kind: "assertion", keyId: canonical });
  });

  it("reads an assertion, including the contract's sample", () => {
    const parsed = parseMarker(CONTRACT_MARKER);
    expect(parsed.kind).toBe("assertion");
    if (parsed.kind !== "assertion") return;
    expect(parsed.keyId).toBe("iInD91fLmBNJf1uM35LYM2FQ9DOE3FNDPD-tKlX7pkw");
    expect(parsed.keyIdBytes.length).toBe(32);
    expect(JSON.parse(parsed.clientData.toString("utf8"))).toMatchObject({ v: 1, purpose: "signup" });
    expect(parsed.assertion.length).toBeGreaterThan(0);
  });

  it.each([
    [5, "marker_not_text"],
    ["v2.a.x.y.z", "marker_unknown_form"],
    ["v1.x", "marker_unknown_form"],
    ["v1.a.only.two", "marker_segments"],
    ["v1.a.a.b.c.d", "marker_segments"],
    ["v1.a.a+b.Yw.Yw", "marker_base64url"],
    ["v1.a.a=.Yw.Yw", "marker_base64url"],
    ["v1.a.abcde.Yw.Yw", "marker_base64url"],
    [`v1.a.${b64u(Buffer.alloc(31))}.Yw.Yw`, "key_id_length"],
    [`v1.a.${b64u(Buffer.alloc(32))}..Yw`, "client_data_length"],
    [`v1.a.${b64u(Buffer.alloc(32))}.Yw.`, "assertion_length"],
    [`v1.e.${"x".repeat(2048)}`, "marker_too_long"],
  ] as const)("refuses %j as %s", (marker, reason) => {
    expect(parseMarker(marker)).toEqual({ kind: "malformed", reason });
  });
});

describe("headers and body", () => {
  it("reads a header case-insensitively, preferring the first multi-value entry", () => {
    expect(readHeader(asApiGatewayEvent({ headers: { "X-Billboard-App-Attest": "v1.u" } }), APP_ATTEST_HEADER)).toBe(
      "v1.u",
    );
    expect(readHeader(asApiGatewayEvent({ headers: { "x-billboard-app-attest": "v1.b" } }), APP_ATTEST_HEADER)).toBe(
      "v1.b",
    );
    expect(
      readHeader(
        asApiGatewayEvent({
          headers: { "X-Billboard-App-Attest": "v1.u" },
          multiValueHeaders: { "x-billboard-app-attest": ["v1.b", "v1.u"] },
        }),
        APP_ATTEST_HEADER,
      ),
    ).toBe("v1.b");
    expect(readHeader(asApiGatewayEvent({}), APP_ATTEST_HEADER)).toBeUndefined();
    expect(readHeader(asApiGatewayEvent({ headers: null }), APP_ATTEST_HEADER)).toBeUndefined();
  });

  it("hashes the exact raw body bytes, base64-decoding when API Gateway did", () => {
    const body = '{"billId":"b","feedback":"Yea"}';
    expect(bodySha256(asApiGatewayEvent({ body }))).toBe(b64u(sha256(Buffer.from(body))));
    expect(bodySha256(asApiGatewayEvent({ body: Buffer.from(body).toString("base64"), isBase64Encoded: true }))).toBe(
      b64u(sha256(Buffer.from(body))),
    );
    expect(bodySha256(asApiGatewayEvent({ body: null }))).toBe(b64u(sha256(Buffer.alloc(0))));
    expect(rawBody(asApiGatewayEvent({})).length).toBe(0);
  });
});

describe("encodings and hashes", () => {
  it("base64url round-trips and is strict", () => {
    const bytes = generateDeviceKey().keyIdBytes;
    expect(decodeBase64url(base64url(bytes))?.equals(bytes)).toBe(true);
    expect(decodeBase64url("ab+/")).toBeNull();
    expect(decodeBase64url("abc=")).toBeNull();
    expect(decodeBase64url("abcde")).toBeNull();
    expect(decodeBase64url(5 as unknown as string)).toBeNull();
  });

  it("standard base64 is strict about its alphabet and padding", () => {
    expect(decodeStandardBase64("o2NmbXRvYXBwbGUtYXBwYXR0ZXN0")?.toString()).toContain("apple-appattest");
    expect(decodeStandardBase64("YQ==")?.toString()).toBe("a");
    expect(decodeStandardBase64("YQ")).toBeNull();
    expect(decodeStandardBase64("Y-_=")).toBeNull();
    expect(decodeStandardBase64("")).toBeNull();
  });

  it("emailSha256 trims and lower-cases", () => {
    expect(emailSha256("  Voter@Example.COM ")).toBe(b64u(sha256("voter@example.com")));
    expect(emailSha256("voter@example.com")).toHaveLength(43);
  });

  it("keyIdPrefix keeps 8 characters", () => {
    expect(keyIdPrefix("iInD91fLmBNJf1uM35LYM2FQ9DOE3FNDPD-tKlX7pkw")).toBe("iInD91fL");
    expect(keyIdPrefix(undefined)).toBeUndefined();
  });
});

describe("versions", () => {
  it.each([
    ["1.2", "1.2", 0],
    ["1.2", "1.2.0", 0],
    ["1.10", "1.9", 1],
    ["1.2", "1.3", -1],
    ["2", "1.9.9", 1],
    ["1.2.1", "1.2", 1],
  ] as const)("compareVersions(%s, %s) has sign %d", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  it("isBelowMinimumVersion treats missing and unreadable as below, and an empty minimum as no gate", () => {
    expect(isBelowMinimumVersion(undefined, null)).toBe(false);
    expect(isBelowMinimumVersion("1.0", null)).toBe(false);
    expect(isBelowMinimumVersion(undefined, "1.2")).toBe(true);
    expect(isBelowMinimumVersion("banana", "1.2")).toBe(true);
    expect(isBelowMinimumVersion("1.1.9", "1.2")).toBe(true);
    expect(isBelowMinimumVersion("1.2", "1.2")).toBe(false);
    expect(isBelowMinimumVersion(" 1.3 ", "1.2")).toBe(false);
  });
});

describe("parseCognitoGroups", () => {
  it.each([
    [
      ["Testers", "Admins"],
      ["Testers", "Admins"],
    ],
    ["[Testers Admins]", ["Testers", "Admins"]],
    ["Testers,Admins", ["Testers", "Admins"]],
    ['["Testers","Admins"]', ["Testers", "Admins"]],
    ["Testers", ["Testers"]],
    ["[]", []],
    ["", []],
    [undefined, []],
    [42, []],
  ] as const)("%j", (claim, expected) => {
    expect(parseCognitoGroups(claim)).toEqual(expected);
  });
});
