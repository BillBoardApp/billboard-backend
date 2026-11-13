/**
 * A minimal DER walker that reads the App Attest nonce out of the leaf certificate. Node's
 * X509Certificate does not expose custom extensions. It runs only on certificate bytes whose
 * signature has already been verified against the pinned root, and it is strict anyway: definite
 * minimal lengths of at most four bytes, no high tag numbers, no length past its parent.
 *
 * Path: Certificate SEQUENCE, then tbsCertificate SEQUENCE, then [3] extensions, then the
 * Extension whose extnID is 1.2.840.113635.100.8.2; its extnValue OCTET STRING holds a SEQUENCE
 * containing [1], which holds one OCTET STRING of 32 bytes: the nonce.
 */

import { NONCE_EXTENSION_OID_DER } from "./config";

export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerError";
  }
}

export interface Tlv {
  tag: number;
  /** Offset of the tag byte. */
  start: number;
  valueStart: number;
  /** Offset just past the value. */
  end: number;
}

const TAG_SEQUENCE = 0x30;
const TAG_OID = 0x06;
const TAG_BOOLEAN = 0x01;
const TAG_OCTET_STRING = 0x04;
const TAG_EXTENSIONS = 0xa3;
const TAG_NONCE_WRAPPER = 0xa1;

export const NONCE_LENGTH = 32;

/** Reads the TLV at `offset`; it must end at or before `limit`. */
export const readTlv = (der: Buffer, offset: number, limit: number = der.length): Tlv => {
  if (offset + 2 > limit) throw new DerError("unexpected end of DER");
  const tag = der[offset];
  if ((tag & 0x1f) === 0x1f) throw new DerError("high tag numbers are not supported");
  const first = der[offset + 1];
  let length: number;
  let valueStart: number;
  if (first < 0x80) {
    length = first;
    valueStart = offset + 2;
  } else {
    const count = first & 0x7f;
    if (count === 0) throw new DerError("indefinite lengths are not allowed in DER");
    if (count > 4) throw new DerError("length is too long");
    if (offset + 2 + count > limit) throw new DerError("unexpected end of DER in a length");
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + der[offset + 2 + index];
    if (der[offset + 2] === 0 || length < 0x80) throw new DerError("length is not minimally encoded");
    valueStart = offset + 2 + count;
  }
  const end = valueStart + length;
  if (end > limit) throw new DerError("length runs past the end of its parent");
  return { tag, start: offset, valueStart, end };
};

/** The TLVs directly inside a constructed TLV, which must fill it exactly. */
export const childrenOf = (der: Buffer, parent: Tlv): Tlv[] => {
  const children: Tlv[] = [];
  let offset = parent.valueStart;
  while (offset < parent.end) {
    const child = readTlv(der, offset, parent.end);
    children.push(child);
    offset = child.end;
  }
  return children;
};

const expectTag = (tlv: Tlv | undefined, tag: number, what: string): Tlv => {
  if (!tlv || tlv.tag !== tag) throw new DerError(`${what} has the wrong tag`);
  return tlv;
};

/** The 32-byte nonce from the App Attest leaf certificate's DER. Throws DerError otherwise. */
export const extractAttestationNonce = (certificateDer: Buffer): Buffer => {
  const certificate = expectTag(readTlv(certificateDer, 0), TAG_SEQUENCE, "certificate");
  if (certificate.end !== certificateDer.length) throw new DerError("bytes after the certificate");
  const tbs = expectTag(childrenOf(certificateDer, certificate)[0], TAG_SEQUENCE, "tbsCertificate");
  const extensionsWrapper = childrenOf(certificateDer, tbs).find((child) => child.tag === TAG_EXTENSIONS);
  if (!extensionsWrapper) throw new DerError("certificate has no extensions");
  const wrapperChildren = childrenOf(certificateDer, extensionsWrapper);
  if (wrapperChildren.length !== 1) throw new DerError("extensions wrapper must hold one SEQUENCE");
  const extensions = expectTag(wrapperChildren[0], TAG_SEQUENCE, "extensions");

  let extnValue: Tlv | undefined;
  for (const extension of childrenOf(certificateDer, extensions)) {
    expectTag(extension, TAG_SEQUENCE, "extension");
    const parts = childrenOf(certificateDer, extension);
    const oid = expectTag(parts[0], TAG_OID, "extension id");
    if (!certificateDer.subarray(oid.start, oid.end).equals(NONCE_EXTENSION_OID_DER)) continue;
    if (extnValue) throw new DerError("nonce extension appears twice");
    if (parts.length === 3) expectTag(parts[1], TAG_BOOLEAN, "extension critical flag");
    else if (parts.length !== 2) throw new DerError("nonce extension has the wrong shape");
    extnValue = expectTag(parts[parts.length - 1], TAG_OCTET_STRING, "extension value");
  }
  if (!extnValue) throw new DerError("nonce extension not found");

  const inner = expectTag(readTlv(certificateDer, extnValue.valueStart, extnValue.end), TAG_SEQUENCE, "nonce value");
  if (inner.end !== extnValue.end) throw new DerError("bytes after the nonce value");
  const wrapper = childrenOf(certificateDer, inner).find((child) => child.tag === TAG_NONCE_WRAPPER);
  if (!wrapper) throw new DerError("nonce [1] element not found");
  const nonceParts = childrenOf(certificateDer, wrapper);
  if (nonceParts.length !== 1) throw new DerError("nonce [1] element must hold one OCTET STRING");
  const nonce = expectTag(nonceParts[0], TAG_OCTET_STRING, "nonce");
  if (nonce.end - nonce.valueStart !== NONCE_LENGTH) throw new DerError(`nonce must be ${NONCE_LENGTH} bytes`);
  return Buffer.from(certificateDer.subarray(nonce.valueStart, nonce.end));
};
