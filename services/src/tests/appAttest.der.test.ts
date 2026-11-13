import { X509Certificate } from "node:crypto";
import { DerError, childrenOf, extractAttestationNonce, readTlv } from "../shared/appAttest/der";
import { APPLE_APP_ATTESTATION_ROOT_CA_PEM } from "../shared/appAttest/appleRootCa";
import { attestationFor, chainFile } from "./fixtures/appAttest/helpers";
import { attestationNonce } from "./fixtures/appAttest/scenarios";

const leafDer = (name = "production_ios26"): Buffer => new X509Certificate(chainFile.scenarios[name].certificate).raw;

/** Replaces the first occurrence of `from` in `der` with `to` (same length). */
const patch = (der: Buffer, from: string, to: string): Buffer => {
  const out = Buffer.from(der);
  const index = out.indexOf(Buffer.from(from, "hex"));
  if (index < 0) throw new Error(`pattern ${from} not found`);
  Buffer.from(to, "hex").copy(out, index);
  return out;
};

/** A minimal certificate-shaped DER: SEQUENCE { tbs SEQUENCE { [3] { SEQUENCE { extensions } } } }. */
const wrap = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? Buffer.from([body.length])
      : body.length < 0x100
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const OID = Buffer.from("06092a864886f763640802", "hex");
const certWithExtensions = (...extensions: Buffer[]): Buffer =>
  wrap(0x30, wrap(0x30, Buffer.from("020101", "hex"), wrap(0xa3, wrap(0x30, ...extensions))));
const nonceExtension = (value: Buffer, critical = false): Buffer =>
  wrap(0x30, OID, ...(critical ? [Buffer.from("0101ff", "hex")] : []), wrap(0x04, value));
const nonceValue = (nonce: Buffer, innerTag = 0xa1, octetTag = 0x04): Buffer =>
  wrap(0x30, wrap(innerTag, wrap(octetTag, nonce)));

describe("extractAttestationNonce", () => {
  it("finds the nonce in the synthetic leaf (openssl-encoded)", () => {
    const fixture = attestationFor("production_ios26");
    expect(extractAttestationNonce(leafDer()).equals(attestationNonce(fixture.authData, fixture.challenge))).toBe(true);
  });

  it("handles long-form lengths (the certificate itself is longer than 255 bytes)", () => {
    const der = leafDer();
    expect(der[1]).toBe(0x82);
    const certificate = readTlv(der, 0);
    expect(certificate.end).toBe(der.length);
    expect(childrenOf(der, certificate).length).toBe(3);
  });

  it("reads a minimal hand-built certificate shape, with or without the critical flag", () => {
    const nonce = Buffer.alloc(32, 7);
    expect(extractAttestationNonce(certWithExtensions(nonceExtension(nonceValue(nonce))))).toEqual(nonce);
    expect(extractAttestationNonce(certWithExtensions(nonceExtension(nonceValue(nonce), true)))).toEqual(nonce);
  });

  it("rejects a certificate without the extension", () => {
    expect(() => extractAttestationNonce(leafDer("leaf_without_nonce"))).toThrow(
      new DerError("nonce extension not found"),
    );
    expect(() => extractAttestationNonce(new X509Certificate(APPLE_APP_ATTESTATION_ROOT_CA_PEM).raw)).toThrow(
      "nonce extension not found",
    );
  });

  it("rejects a wrong inner tag", () => {
    // [1] (a1) replaced with [2] (a2): no [1] element.
    expect(() => extractAttestationNonce(patch(leafDer(), "3024a1220420", "3024a2220420"))).toThrow(
      "nonce [1] element not found",
    );
    // OCTET STRING (04) replaced with INTEGER (02).
    expect(() => extractAttestationNonce(patch(leafDer(), "3024a1220420", "3024a1220220"))).toThrow(
      "nonce has the wrong tag",
    );
  });

  it("rejects a nonce of the wrong length", () => {
    const short = Buffer.alloc(31, 1);
    expect(() => extractAttestationNonce(certWithExtensions(nonceExtension(nonceValue(short))))).toThrow(
      "nonce must be 32 bytes",
    );
  });

  it("rejects the extension twice, a malformed extension and bytes after the value", () => {
    const value = nonceValue(Buffer.alloc(32, 1));
    expect(() => extractAttestationNonce(certWithExtensions(nonceExtension(value), nonceExtension(value)))).toThrow(
      "nonce extension appears twice",
    );
    expect(() => extractAttestationNonce(certWithExtensions(wrap(0x30, OID)))).toThrow("wrong shape");
    expect(() =>
      extractAttestationNonce(certWithExtensions(nonceExtension(Buffer.concat([value, Buffer.from("0500", "hex")])))),
    ).toThrow("bytes after the nonce value");
    const twoInOne = wrap(0x30, wrap(0xa1, wrap(0x04, Buffer.alloc(32)), wrap(0x04, Buffer.alloc(32))));
    expect(() => extractAttestationNonce(certWithExtensions(nonceExtension(twoInOne)))).toThrow(
      "must hold one OCTET STRING",
    );
  });

  it("rejects bytes after the certificate and a certificate without extensions", () => {
    expect(() => extractAttestationNonce(Buffer.concat([leafDer(), Buffer.from([0])]))).toThrow(
      "bytes after the certificate",
    );
    expect(() => extractAttestationNonce(wrap(0x30, wrap(0x30, Buffer.from("020101", "hex"))))).toThrow(
      "certificate has no extensions",
    );
  });
});

describe("readTlv", () => {
  it("rejects indefinite, overlong, non-minimal and overrunning lengths and high tags", () => {
    expect(() => readTlv(Buffer.from("3080", "hex"), 0)).toThrow("indefinite");
    expect(() => readTlv(Buffer.from("3085", "hex"), 0)).toThrow("too long");
    expect(() => readTlv(Buffer.from("30817f", "hex"), 0)).toThrow("not minimally encoded");
    expect(() => readTlv(Buffer.from("3082000100", "hex"), 0)).toThrow("not minimally encoded");
    expect(() => readTlv(Buffer.from("300500", "hex"), 0)).toThrow("past the end");
    expect(() => readTlv(Buffer.from("3082", "hex"), 0)).toThrow("unexpected end of DER in a length");
    expect(() => readTlv(Buffer.from("30", "hex"), 0)).toThrow("unexpected end of DER");
    expect(() => readTlv(Buffer.from("1f0100", "hex"), 0)).toThrow("high tag");
  });

  it("reads short and long forms", () => {
    expect(readTlv(Buffer.from("040100", "hex"), 0)).toEqual({ tag: 4, start: 0, valueStart: 2, end: 3 });
    const long = Buffer.concat([Buffer.from("048180", "hex"), Buffer.alloc(0x80)]);
    expect(readTlv(long, 0)).toEqual({ tag: 4, start: 0, valueStart: 3, end: 0x83 });
  });
});
