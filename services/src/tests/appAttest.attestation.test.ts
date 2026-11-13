import { X509Certificate, createHash } from "node:crypto";
import {
  APPLE_APP_ATTESTATION_ROOT_CA_PEM,
  APPLE_APP_ATTESTATION_ROOT_CA_SHA256,
  appleAppAttestationRoot,
} from "../shared/appAttest/appleRootCa";
import { attestationEnvironment, verifyAttestation } from "../shared/appAttest/attestation";
import { APP_ID, APP_ID_HASH } from "../shared/appAttest/config";
import { RawCbor, encodeCbor, type Encodable } from "./fixtures/appAttest/cborEncode";
import { attestationFor, chainFile, fixtureNow, otherRoot, sha256, syntheticRoot } from "./fixtures/appAttest/helpers";
import { SCENARIOS, attestationNonce, nonceExtensionDerHex } from "./fixtures/appAttest/scenarios";

const verifyScenario = (name: string, overrides: Partial<Parameters<typeof verifyAttestation>[0]> = {}) => {
  const fixture = attestationFor(name);
  return verifyAttestation({
    attestation: fixture.attestation,
    keyId: fixture.keyId,
    challenge: fixture.challenge,
    now: fixture.now,
    root: syntheticRoot,
    ...overrides,
  });
};

describe("pinned Apple App Attestation Root CA", () => {
  it("has the pinned SHA-256 fingerprint, subject, key and validity, and is self-signed", () => {
    const root = new X509Certificate(APPLE_APP_ATTESTATION_ROOT_CA_PEM);
    expect(createHash("sha256").update(root.raw).digest("hex")).toBe(APPLE_APP_ATTESTATION_ROOT_CA_SHA256);
    expect(APPLE_APP_ATTESTATION_ROOT_CA_SHA256).toBe(
      "1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932",
    );
    expect(root.subject).toContain("CN=Apple App Attestation Root CA");
    expect(root.subject).toContain("O=Apple Inc.");
    expect(root.serialNumber).toBe("0BF3BE0EF1CDD2E0FB8C6E721F621798");
    expect(root.ca).toBe(true);
    expect(root.publicKey.asymmetricKeyDetails?.namedCurve).toBe("secp384r1");
    expect(Date.parse(root.validFrom)).toBe(Date.parse("2020-03-18T18:32:53Z"));
    expect(Date.parse(root.validTo)).toBe(Date.parse("2045-03-15T00:00:00Z"));
    expect(root.checkIssued(root) && root.verify(root.publicKey)).toBe(true);
  });

  it("is the default root, so a chain from any other root is rejected in production", () => {
    expect(appleAppAttestationRoot().fingerprint256).toBe(
      new X509Certificate(APPLE_APP_ATTESTATION_ROOT_CA_PEM).fingerprint256,
    );
    const fixture = attestationFor("production_ios26");
    const result = verifyAttestation({
      attestation: fixture.attestation,
      keyId: fixture.keyId,
      challenge: fixture.challenge,
      now: fixture.now,
    });
    expect(result).toMatchObject({ ok: false, reason: "chain" });
  });
});

describe("App ID constants", () => {
  it("APP_ID_HASH is SHA-256 of the App ID", () => {
    expect(APP_ID).toBe("9R36JN7XJ5.com.billboardproject.app");
    expect(createHash("sha256").update(APP_ID).digest().equals(APP_ID_HASH)).toBe(true);
  });
});

describe("synthetic fixtures", () => {
  it("carry, for every scenario, the nonce of the authenticator data the scenario describes", () => {
    for (const scenario of SCENARIOS) {
      const fixture = attestationFor(scenario.name);
      const leaf = new X509Certificate(chainFile.scenarios[scenario.name].certificate);
      const expectedExtension = nonceExtensionDerHex(attestationNonce(fixture.authData, fixture.challenge));
      expect(leaf.raw.toString("hex").includes(expectedExtension)).toBe(scenario.nonce !== "absent");
    }
  });
});

describe("verifyAttestation: scenarios (one defect each)", () => {
  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario.expect] as const))("%s", (name, expected) => {
    const result = verifyScenario(name);
    expect(result).toMatchObject(expected);
  });

  it("returns the leaf's SPKI and the receipt on success", () => {
    const fixture = attestationFor("production_ios26");
    const result = verifyScenario("production_ios26");
    if (!result.ok) throw new Error(`expected success, got ${result.reason}`);
    expect(
      result.publicKeySpki.equals(
        new X509Certificate(fixture.leafDer).publicKey.export({ type: "spki", format: "der" }),
      ),
    ).toBe(true);
    expect(result.receipt.equals(fixture.receipt)).toBe(true);
    expect(result.aaguid).toBe("production");
    expect(result).not.toHaveProperty("validationCategory");
  });

  it("records the iOS 27 extensions when present and leaves them out on iOS 26", () => {
    expect(verifyScenario("production_ios27_testflight")).toMatchObject({
      validationCategory: 2,
      bundleVersion: "1.2",
    });
    expect(verifyScenario("production_ios26")).not.toHaveProperty("bundleVersion");
  });
});

describe("verifyAttestation: chain and clock", () => {
  it("rejects a chain verified against the wrong root", () => {
    expect(verifyScenario("production_ios26", { root: otherRoot })).toMatchObject({ ok: false, reason: "chain" });
  });

  it("rejects an expired leaf and a leaf not yet valid", () => {
    const leaf = new X509Certificate(chainFile.scenarios.production_ios26.certificate);
    const afterExpiry = new Date(Date.parse(leaf.validTo) + 24 * 60 * 60 * 1000);
    const beforeStart = new Date(Date.parse(leaf.validFrom) - 24 * 60 * 60 * 1000);
    expect(verifyScenario("production_ios26", { now: afterExpiry })).toMatchObject({
      ok: false,
      reason: "certificate_validity",
    });
    expect(verifyScenario("production_ios26", { now: beforeStart })).toMatchObject({
      ok: false,
      reason: "certificate_validity",
    });
  });

  it("rejects a leaf that was not issued by the intermediate in x5c", () => {
    // This leaf was issued by the not-a-CA intermediate; x5c pairs it with the real CA.
    const foreignLeaf = new X509Certificate(chainFile.scenarios.intermediate_not_ca.certificate).raw;
    const fixture = attestationFor("production_ios26", ({ attStmt, authData }) => {
      const intermediate = (attStmt.get("x5c") as Buffer[])[1];
      return new Map<string, Encodable>([
        ["fmt", "apple-appattest"],
        [
          "attStmt",
          new Map<string, Encodable>([
            ["x5c", [foreignLeaf, intermediate]],
            ["receipt", Buffer.from("r")],
          ]),
        ],
        ["authData", authData],
      ]);
    });
    expect(verifyAttestation({ ...fixture, root: syntheticRoot })).toMatchObject({
      ok: false,
      reason: "chain",
      detail: "leaf is not signed by the intermediate",
    });
  });

  it("rejects an intermediate that the root did not sign", () => {
    const fixture = attestationFor("production_ios26", ({ attStmt, authData }) => {
      const leafDer = (attStmt.get("x5c") as Buffer[])[0];
      return new Map<string, Encodable>([
        ["fmt", "apple-appattest"],
        [
          "attStmt",
          new Map<string, Encodable>([
            ["x5c", [leafDer, otherRoot.raw]],
            ["receipt", Buffer.from("r")],
          ]),
        ],
        ["authData", authData],
      ]);
    });
    expect(verifyAttestation({ ...fixture, root: syntheticRoot })).toMatchObject({
      ok: false,
      reason: "chain",
      detail: "intermediate is not signed by the root",
    });
  });

  it("rejects a third certificate in x5c and a single one", () => {
    const three = attestationFor("production_ios26", ({ attStmt, authData }) => {
      const x5c = attStmt.get("x5c") as Buffer[];
      return new Map<string, Encodable>([
        ["fmt", "apple-appattest"],
        [
          "attStmt",
          new Map<string, Encodable>([
            ["x5c", [...x5c, syntheticRoot.raw]],
            ["receipt", Buffer.from("r")],
          ]),
        ],
        ["authData", authData],
      ]);
    });
    expect(verifyAttestation({ ...three, root: syntheticRoot })).toMatchObject({ ok: false, reason: "x5c_count" });
    const one = attestationFor("production_ios26", ({ attStmt, authData }) => {
      const x5c = attStmt.get("x5c") as Buffer[];
      return new Map<string, Encodable>([
        ["fmt", "apple-appattest"],
        [
          "attStmt",
          new Map<string, Encodable>([
            ["x5c", [x5c[0]]],
            ["receipt", Buffer.from("r")],
          ]),
        ],
        ["authData", authData],
      ]);
    });
    expect(verifyAttestation({ ...one, root: syntheticRoot })).toMatchObject({ ok: false, reason: "x5c_count" });
  });

  it("rejects certificate bytes that do not parse", () => {
    const fixture = attestationFor(
      "production_ios26",
      ({ authData }) =>
        new Map<string, Encodable>([
          ["fmt", "apple-appattest"],
          [
            "attStmt",
            new Map<string, Encodable>([
              ["x5c", [Buffer.from("not a cert"), Buffer.from("x")]],
              ["receipt", Buffer.from("r")],
            ]),
          ],
          ["authData", authData],
        ]),
    );
    expect(verifyAttestation({ ...fixture, root: syntheticRoot })).toMatchObject({
      ok: false,
      reason: "certificate_parse",
    });
  });
});

describe("verifyAttestation: nonce and key ID", () => {
  it("rejects a different challenge (nonce mismatch)", () => {
    expect(
      verifyScenario("production_ios26", { challenge: attestationFor("development_develop").challenge }),
    ).toMatchObject({
      ok: false,
      reason: "nonce_mismatch",
    });
  });

  it("rejects authenticator data other than the one certified (nonce mismatch)", () => {
    const fixture = attestationFor(
      "production_ios26",
      ({ attStmt }) =>
        new Map<string, Encodable>([
          ["fmt", "apple-appattest"],
          ["attStmt", attStmt],
          ["authData", attestationFor("development_develop").authData],
        ]),
    );
    expect(verifyAttestation({ ...fixture, root: syntheticRoot })).toMatchObject({
      ok: false,
      reason: "nonce_mismatch",
    });
  });

  it("rejects a key ID that is not the hash of the leaf key", () => {
    expect(verifyScenario("production_ios26", { keyId: sha256("another key") })).toMatchObject({
      ok: false,
      reason: "key_id_mismatch",
    });
    expect(verifyScenario("production_ios26", { keyId: Buffer.alloc(16) })).toMatchObject({
      ok: false,
      reason: "key_id_mismatch",
    });
  });
});

describe("verifyAttestation: object format", () => {
  const formatCase = (object: Encodable) => {
    const fixture = attestationFor("production_ios26");
    return verifyAttestation({ ...fixture, attestation: encodeCbor(object), root: syntheticRoot });
  };

  it("rejects bytes that are not CBOR and oversized input", () => {
    const fixture = attestationFor("production_ios26");
    expect(verifyAttestation({ ...fixture, attestation: Buffer.from([0xff]), root: syntheticRoot })).toMatchObject({
      ok: false,
      reason: "cbor",
    });
    expect(verifyAttestation({ ...fixture, attestation: Buffer.alloc(17 * 1024), root: syntheticRoot })).toMatchObject({
      ok: false,
      reason: "too_large",
    });
  });

  it("rejects a wrong fmt, missing or extra keys, and wrong value types", () => {
    const fixture = attestationFor("production_ios26");
    const attStmt = new Map<string, Encodable>([
      ["x5c", [fixture.leafDer, fixture.intermediateDer]],
      ["receipt", fixture.receipt],
    ]);
    expect(
      formatCase(
        new Map<string, Encodable>([
          ["fmt", "packed"],
          ["attStmt", attStmt],
          ["authData", fixture.authData],
        ]),
      ),
    ).toMatchObject({ ok: false, reason: "format" });
    expect(
      formatCase(
        new Map<string, Encodable>([
          ["fmt", "apple-appattest"],
          ["attStmt", attStmt],
        ]),
      ),
    ).toMatchObject({ ok: false, reason: "format" });
    expect(
      formatCase(
        new Map<string, Encodable>([
          ["fmt", "apple-appattest"],
          ["attStmt", attStmt],
          ["authData", fixture.authData],
          ["extra", 1],
        ]),
      ),
    ).toMatchObject({ ok: false, reason: "format" });
    expect(
      formatCase(
        new Map<string, Encodable>([
          ["fmt", "apple-appattest"],
          ["attStmt", new Map<string, Encodable>([["x5c", [fixture.leafDer, fixture.intermediateDer]]])],
          ["authData", fixture.authData],
        ]),
      ),
    ).toMatchObject({ ok: false, reason: "format" });
    expect(
      formatCase(
        new Map<string, Encodable>([
          ["fmt", "apple-appattest"],
          ["attStmt", attStmt],
          ["authData", "text, not bytes"],
        ]),
      ),
    ).toMatchObject({ ok: false, reason: "format" });
    expect(
      formatCase(
        new Map<string, Encodable>([
          ["fmt", "apple-appattest"],
          [
            "attStmt",
            new Map<string, Encodable>([
              ["x5c", ["a", "b"]],
              ["receipt", fixture.receipt],
            ]),
          ],
          ["authData", fixture.authData],
        ]),
      ),
    ).toMatchObject({ ok: false, reason: "format" });
    expect(formatCase([1, 2, 3])).toMatchObject({ ok: false, reason: "format" });
    expect(formatCase(new RawCbor(Buffer.from([0xa0])))).toMatchObject({ ok: false, reason: "format" });
  });
});

describe("attestationEnvironment", () => {
  it.each([
    ["production", undefined, "production"],
    ["production", 2, "production"],
    ["production", 4, "production"],
    ["production", 3, "development"],
    ["production", 7, "development"],
    ["development", undefined, "development"],
    ["development", 4, "development"],
    ["sandbox", 2, "development"],
  ] as const)("aaguid %s with category %s is %s", (aaguid, category, expected) => {
    expect(attestationEnvironment(aaguid, category)).toBe(expected);
  });

  it("uses the certificates' own dates as the test clock", () => {
    const now = fixtureNow();
    const leaf = new X509Certificate(chainFile.scenarios.production_ios26.certificate);
    expect(now.getTime()).toBeGreaterThan(Date.parse(leaf.validFrom));
    expect(now.getTime()).toBeLessThan(Date.parse(leaf.validTo));
  });
});
