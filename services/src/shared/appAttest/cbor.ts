/**
 * A strict, bounded CBOR (RFC 8949) subset decoder for App Attest objects, which are attacker
 * controlled bytes. Whatever it extracts is checked cryptographically afterwards, so it only has to
 * be total (it returns a value or throws CborError, nothing else) and bounded (input size, nesting
 * depth, and no allocation larger than the remaining input).
 *
 * Supported: major types 0-5, that is unsigned and negative integers (safe JavaScript integers
 * only), byte strings (as Buffer), UTF-8 text (a fatal decoder), arrays and maps whose keys are
 * text or integers (as Map, so 1 and "1" stay distinct).
 * Rejected: tags, floats and simple values (true, false, null included), indefinite lengths,
 * reserved length encodings, lengths past the end of the input, duplicate map keys, nesting deeper
 * than maxDepth and input longer than maxBytes.
 */

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

export type CborMapKey = string | number;
export type CborValue = number | string | Buffer | CborValue[] | CborMap;
export type CborMap = Map<CborMapKey, CborValue>;

export interface CborDecodeOptions {
  /** Longest accepted input, in bytes. Default 16,384. */
  maxBytes?: number;
  /** Deepest accepted nesting of arrays and maps (a top-level array is depth 1). Default 8. */
  maxDepth?: number;
}

export const DEFAULT_MAX_CBOR_BYTES = 16 * 1024;
export const DEFAULT_MAX_CBOR_DEPTH = 8;

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface DecodeState {
  bytes: Uint8Array;
  position: number;
  maxDepth: number;
}

const remaining = (state: DecodeState): number => state.bytes.length - state.position;

const readArgument = (state: DecodeState, info: number): number => {
  if (info < 24) return info;
  if (info === 31) throw new CborError("indefinite lengths are not supported");
  if (info > 27) throw new CborError(`reserved additional information ${info}`);
  const size = 1 << (info - 24);
  if (remaining(state) < size) throw new CborError("unexpected end of input in an argument");
  let value = 0n;
  for (let index = 0; index < size; index += 1) {
    value = (value << 8n) | BigInt(state.bytes[state.position + index]);
  }
  state.position += size;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError("integer is too large");
  return Number(value);
};

const take = (state: DecodeState, length: number): Uint8Array => {
  if (length > remaining(state)) throw new CborError("length runs past the end of the input");
  const slice = state.bytes.subarray(state.position, state.position + length);
  state.position += length;
  return slice;
};

const readItem = (state: DecodeState, depth: number): CborValue => {
  if (remaining(state) < 1) throw new CborError("unexpected end of input");
  const initial = state.bytes[state.position];
  state.position += 1;
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (major === 6) throw new CborError("tags are not supported");
  if (major === 7) throw new CborError("floats and simple values are not supported");
  const argument = readArgument(state, info);

  switch (major) {
    case 0:
      return argument;
    case 1: {
      const value = -1 - argument;
      if (!Number.isSafeInteger(value)) throw new CborError("integer is too large");
      return value;
    }
    case 2:
      return Buffer.from(take(state, argument));
    case 3:
      try {
        return textDecoder.decode(take(state, argument));
      } catch (error) {
        if (error instanceof CborError) throw error;
        throw new CborError("text is not valid UTF-8");
      }
    case 4: {
      if (depth + 1 > state.maxDepth) throw new CborError("nesting is too deep");
      // Every item takes at least one byte, so a count above the remaining input is a lie.
      if (argument > remaining(state)) throw new CborError("array length runs past the end of the input");
      const items: CborValue[] = [];
      for (let index = 0; index < argument; index += 1) items.push(readItem(state, depth + 1));
      return items;
    }
    default: {
      // major === 5 (the only one left)
      if (depth + 1 > state.maxDepth) throw new CborError("nesting is too deep");
      if (argument * 2 > remaining(state)) throw new CborError("map length runs past the end of the input");
      const map: CborMap = new Map();
      for (let index = 0; index < argument; index += 1) {
        const key = readItem(state, depth + 1);
        if (typeof key !== "string" && typeof key !== "number") {
          throw new CborError("map keys must be text or integers");
        }
        if (map.has(key)) throw new CborError("duplicate map key");
        map.set(key, readItem(state, depth + 1));
      }
      return map;
    }
  }
};

const checkedState = (input: Uint8Array, offset: number, options: CborDecodeOptions): DecodeState => {
  if (!(input instanceof Uint8Array)) throw new CborError("input must be bytes");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CBOR_BYTES;
  if (input.length > maxBytes) throw new CborError(`input is longer than ${maxBytes} bytes`);
  if (!Number.isInteger(offset) || offset < 0 || offset > input.length) throw new CborError("offset is out of range");
  return { bytes: input, position: offset, maxDepth: options.maxDepth ?? DEFAULT_MAX_CBOR_DEPTH };
};

const totally = <T>(decode: () => T): T => {
  try {
    return decode();
  } catch (error) {
    if (error instanceof CborError) throw error;
    // Nothing above should throw anything else; keep the decoder total even so.
    throw new CborError(`malformed input (${error instanceof Error ? error.name : "unknown"})`);
  }
};

/** Decodes one item starting at `offset` and returns it with the offset just past it. */
export const decodeCborItem = (
  input: Uint8Array,
  offset = 0,
  options: CborDecodeOptions = {},
): { value: CborValue; end: number } =>
  totally(() => {
    const state = checkedState(input, offset, options);
    const value = readItem(state, 0);
    return { value, end: state.position };
  });

/** Decodes exactly one item that must fill the whole input. */
export const decodeCbor = (input: Uint8Array, options: CborDecodeOptions = {}): CborValue =>
  totally(() => {
    const { value, end } = decodeCborItem(input, 0, options);
    if (end !== input.length) throw new CborError("trailing bytes after the item");
    return value;
  });

export const isCborMap = (value: CborValue | undefined): value is CborMap => value instanceof Map;

/** True when the map has exactly these keys (no more, no fewer). */
export const hasExactKeys = (map: CborMap, keys: readonly CborMapKey[]): boolean =>
  map.size === keys.length && keys.every((key) => map.has(key));
