/**
 * A minimal CBOR encoder for building App Attest test objects (attestation and assertion objects,
 * COSE keys, authenticator-data extensions). Test-only: the service only decodes.
 *
 * Numbers must be safe integers. A Map keeps its key order and key types (integers or text); a
 * plain object encodes as a map with text keys. RawCbor splices bytes in as they are, for
 * malformed-input tests.
 */

export class RawCbor {
  constructor(readonly bytes: Buffer) {}
}

export type Encodable =
  | number
  | string
  | Uint8Array
  | RawCbor
  | Encodable[]
  | Map<string | number, Encodable>
  | { [key: string]: Encodable };

/** The head of an item: major type and argument, shortest form. */
export const cborHead = (major: number, argument: number): Buffer => {
  if (argument < 24) return Buffer.from([(major << 5) | argument]);
  if (argument < 0x100) return Buffer.from([(major << 5) | 24, argument]);
  if (argument < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(argument, 1);
    return out;
  }
  if (argument < 0x100000000) {
    const out = Buffer.alloc(5);
    out[0] = (major << 5) | 26;
    out.writeUInt32BE(argument, 1);
    return out;
  }
  const out = Buffer.alloc(9);
  out[0] = (major << 5) | 27;
  out.writeBigUInt64BE(BigInt(argument), 1);
  return out;
};

export const encodeCbor = (value: Encodable): Buffer => {
  if (value instanceof RawCbor) return value.bytes;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`cannot encode ${value}`);
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(encodeCbor)]);
  const entries: [string | number, Encodable][] = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([
    cborHead(5, entries.length),
    ...entries.flatMap(([key, entry]) => [encodeCbor(key), encodeCbor(entry)]),
  ]);
};
