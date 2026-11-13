import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { verifyAssertion } from "../shared/appAttest/assertion";
import { checkRequestClientData, checkSignUpClientData, emailSha256, parseMarker } from "../shared/appAttest/wire";
import { RawCbor, encodeCbor, type Encodable } from "./fixtures/appAttest/cborEncode";
import { categoryBytes } from "./fixtures/appAttest/scenarios";
import {
  assertionAuthData,
  assertionMarker,
  b64u,
  challengeOf,
  generateDeviceKey,
  requestClientData,
  sha256,
  signAssertion,
  signUpClientData,
} from "./fixtures/appAttest/helpers";

const device = generateDeviceKey();
const clientData = requestClientData({ challenge: challengeOf("a"), body: '{"billId":"b","feedback":"Yea"}' });

const assertionWith = (input: {
  counter?: number;
  clientDataOverride?: Buffer;
  rpIdHash?: Buffer;
  extensions?: Record<string, number | string | Uint8Array>;
  key?: typeof device;
}) =>
  signAssertion({
    privateKey: (input.key ?? device).privateKey,
    authenticatorData: assertionAuthData({
      counter: input.counter ?? 1,
      rpIdHash: input.rpIdHash,
      extensions: input.extensions,
    }),
    clientData: input.clientDataOverride ?? clientData,
  });

const verify = (assertion: Buffer, overrides: Partial<Parameters<typeof verifyAssertion>[0]> = {}) =>
  verifyAssertion({ assertion, clientData, publicKeySpki: device.publicKeySpki, storedCounter: 0, ...overrides });

describe("verifyAssertion", () => {
  it("accepts a valid assertion and returns its counter", () => {
    expect(verify(assertionWith({ counter: 1 }))).toEqual({ ok: true, counter: 1 });
    expect(verify(assertionWith({ counter: 42 }), { storedCounter: 41 })).toEqual({ ok: true, counter: 42 });
  });

  it("reads the iOS 27 extensions when present", () => {
    expect(
      verify(
        assertionWith({
          counter: 2,
          extensions: { apple_validation_category_01: categoryBytes(4), apple_bundle_version_01: "1.2" },
        }),
      ),
    ).toEqual({ ok: true, counter: 2, validationCategory: 4, bundleVersion: "1.2" });
    expect(verify(assertionWith({ counter: 2, extensions: { apple_validation_category_01: 2 } }))).toEqual({
      ok: true,
      counter: 2,
      validationCategory: 2,
    });
  });

  it("ignores an unreadable extensions map (it is under the key's signature)", () => {
    const authenticatorData = Buffer.concat([assertionAuthData({ counter: 3, flags: 0x80 }), Buffer.from([0xff])]);
    const assertion = signAssertion({ privateKey: device.privateKey, authenticatorData, clientData });
    expect(verify(assertion)).toEqual({ ok: true, counter: 3 });
  });

  it("rejects a signature from another key", () => {
    expect(verify(assertionWith({ key: generateDeviceKey() }))).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects a signature over other clientData", () => {
    const other = requestClientData({ challenge: challengeOf("b") });
    expect(verify(assertionWith({ clientDataOverride: other }))).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects a signature over the nonce itself instead of its SHA-256 (the convention is pinned)", () => {
    const authenticatorData = assertionAuthData({ counter: 1 });
    const nonce = sha256(authenticatorData, sha256(clientData));
    // ECDSA over SHA-256(SHA-256(nonce)) instead of SHA-256(nonce).
    const signature = signBytes("sha256", sha256(nonce), device.privateKey);
    const assertion = encodeCbor(
      new Map<string, Encodable>([
        ["signature", signature],
        ["authenticatorData", authenticatorData],
      ]),
    );
    expect(verify(assertion)).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects a counter equal to or lower than the stored one, unless a replay allows equal", () => {
    expect(verify(assertionWith({ counter: 5 }), { storedCounter: 5 })).toEqual({
      ok: false,
      reason: "counter_not_increasing",
    });
    expect(verify(assertionWith({ counter: 4 }), { storedCounter: 5 })).toEqual({
      ok: false,
      reason: "counter_not_increasing",
    });
    expect(verify(assertionWith({ counter: 5 }), { storedCounter: 5, allowEqualCounter: true })).toEqual({
      ok: true,
      counter: 5,
    });
    expect(verify(assertionWith({ counter: 4 }), { storedCounter: 5, allowEqualCounter: true })).toEqual({
      ok: false,
      reason: "counter_not_increasing",
    });
  });

  it("rejects an RP ID hash for another app", () => {
    expect(verify(assertionWith({ rpIdHash: sha256("TEAMID0000.com.example.other") }))).toEqual({
      ok: false,
      reason: "rp_id_mismatch",
    });
  });

  it("rejects short authenticator data, bad CBOR, wrong keys and types, and a bad public key", () => {
    const short = encodeCbor(
      new Map<string, Encodable>([
        ["signature", Buffer.alloc(70)],
        ["authenticatorData", Buffer.alloc(36)],
      ]),
    );
    expect(verify(short)).toEqual({ ok: false, reason: "auth_data_short" });
    expect(verify(Buffer.from([0xff]))).toEqual({ ok: false, reason: "cbor" });
    expect(verify(encodeCbor({ signature: Buffer.alloc(1) }))).toEqual({ ok: false, reason: "format" });
    expect(verify(encodeCbor({ signature: "x", authenticatorData: Buffer.alloc(37) }))).toEqual({
      ok: false,
      reason: "format",
    });
    expect(verify(encodeCbor({ signature: Buffer.alloc(1), authenticatorData: Buffer.alloc(37), extra: 1 }))).toEqual({
      ok: false,
      reason: "format",
    });
    expect(verify(assertionWith({}), { publicKeySpki: Buffer.from("not a key") })).toEqual({
      ok: false,
      reason: "public_key",
    });
    expect(verify(encodeCbor(new RawCbor(Buffer.from([0x80]))))).toEqual({ ok: false, reason: "format" });
  });

  it("rejects an oversized assertion and a garbage signature", () => {
    expect(verify(Buffer.alloc(513))).toEqual({ ok: false, reason: "too_large" });
    const authenticatorData = assertionAuthData({ counter: 1 });
    const garbage = encodeCbor(
      new Map<string, Encodable>([
        ["signature", Buffer.from("garbage")],
        ["authenticatorData", authenticatorData],
      ]),
    );
    expect(verify(garbage)).toEqual({ ok: false, reason: "signature" });
  });

  it("works with an SPKI exported the way the attest route stores it", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const assertion = signAssertion({ privateKey, authenticatorData: assertionAuthData({ counter: 9 }), clientData });
    expect(verify(assertion, { publicKeySpki: publicKey.export({ type: "spki", format: "der" }) })).toEqual({
      ok: true,
      counter: 9,
    });
  });
});

describe("clientData checks (assertion binding)", () => {
  const binding = {
    method: "POST",
    path: "/feedback",
    bodySha256: b64u(sha256(Buffer.from('{"billId":"b","feedback":"Yea"}'))),
  };

  it("accepts the request clientData and ignores unknown keys", () => {
    expect(checkRequestClientData(clientData, binding)).toEqual({ ok: true, challenge: challengeOf("a") });
    const extra = requestClientData({
      challenge: challengeOf("a"),
      body: '{"billId":"b","feedback":"Yea"}',
      extra: { future: true },
    });
    expect(checkRequestClientData(extra, binding)).toEqual({ ok: true, challenge: challengeOf("a") });
  });

  it.each([
    ["method", { method: "PUT" }, "client_data_method"],
    ["path", { path: "/setFeedback" }, "client_data_path"],
    ["body hash", { body: '{"billId":"b","feedback":"Nay"}' }, "client_data_body"],
  ] as const)("rejects a %s mismatch", (_label, change, reason) => {
    const data = requestClientData({ challenge: challengeOf("a"), body: '{"billId":"b","feedback":"Yea"}', ...change });
    expect(checkRequestClientData(data, binding)).toEqual({ ok: false, reason });
  });

  it("rejects a wrong purpose, version, challenge type and non-JSON", () => {
    const base = { challenge: challengeOf("a"), body: '{"billId":"b","feedback":"Yea"}' };
    expect(checkRequestClientData(requestClientData({ ...base, extra: { purpose: "signup" } }), binding)).toEqual({
      ok: false,
      reason: "client_data_purpose",
    });
    expect(checkRequestClientData(requestClientData({ ...base, extra: { v: 2 } }), binding)).toEqual({
      ok: false,
      reason: "client_data_version",
    });
    expect(checkRequestClientData(requestClientData({ ...base, extra: { challenge: 5 } }), binding)).toEqual({
      ok: false,
      reason: "client_data_challenge",
    });
    expect(checkRequestClientData(Buffer.from("not json"), binding)).toEqual({ ok: false, reason: "client_data_json" });
    expect(checkRequestClientData(Buffer.from("[1]"), binding)).toEqual({ ok: false, reason: "client_data_json" });
    expect(checkRequestClientData(Buffer.from([0xff, 0xfe]), binding)).toEqual({
      ok: false,
      reason: "client_data_json",
    });
  });

  it("checks the sign-up email hash, trimmed and lower-cased, and the purpose", () => {
    const data = signUpClientData({ challenge: challengeOf("s"), email: "  Voter@Example.COM " });
    expect(checkSignUpClientData(data, emailSha256("voter@example.com"))).toEqual({
      ok: true,
      challenge: challengeOf("s"),
    });
    expect(checkSignUpClientData(data, emailSha256("other@example.com"))).toEqual({
      ok: false,
      reason: "client_data_email",
    });
    expect(checkSignUpClientData(clientData, emailSha256("voter@example.com"))).toEqual({
      ok: false,
      reason: "client_data_purpose",
    });
  });
});

describe("oversized marker segments", () => {
  it("are refused before any verification", () => {
    const keyId = device.keyId;
    expect(
      parseMarker(assertionMarker({ keyId, clientData: Buffer.alloc(1025, 0x61), assertion: Buffer.alloc(10) })),
    ).toEqual({
      kind: "malformed",
      reason: "client_data_length",
    });
    expect(
      parseMarker(assertionMarker({ keyId, clientData: Buffer.alloc(10, 0x61), assertion: Buffer.alloc(513) })),
    ).toEqual({
      kind: "malformed",
      reason: "assertion_length",
    });
  });
});
