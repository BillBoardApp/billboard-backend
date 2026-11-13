import { randomBytes } from "node:crypto";
import {
  CborError,
  decodeCbor,
  decodeCborItem,
  hasExactKeys,
  isCborMap,
  type CborValue,
} from "../shared/appAttest/cbor";
import { encodeCbor, type Encodable } from "./fixtures/appAttest/cborEncode";

const hex = (value: string): Buffer => Buffer.from(value.replace(/\s+/g, ""), "hex");

describe("decodeCbor: RFC 8949 Appendix A vectors in the supported subset", () => {
  it.each([
    ["00", 0],
    ["01", 1],
    ["17", 23],
    ["1818", 24],
    ["1903e8", 1000],
    ["1a000f4240", 1000000],
    ["1b000000e8d4a51000", 1000000000000],
    ["20", -1],
    ["29", -10],
    ["3863", -100],
    ["3903e7", -1000],
    ["60", ""],
    ["6161", "a"],
    ["6449455446", "IETF"],
    ["62225c", '"\\'],
    ["62c3bc", "ü"],
    ["63e6b0b4", "水"],
  ])("%s", (input, expected) => {
    expect(decodeCbor(hex(input))).toEqual(expected);
  });

  it("decodes byte strings as Buffers", () => {
    expect(decodeCbor(hex("40"))).toEqual(Buffer.alloc(0));
    expect(decodeCbor(hex("4401020304"))).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("decodes arrays and maps (as Map, keeping integer and text keys apart)", () => {
    expect(decodeCbor(hex("80"))).toEqual([]);
    expect(decodeCbor(hex("83010203"))).toEqual([1, 2, 3]);
    expect(decodeCbor(hex("8301820203820405"))).toEqual([1, [2, 3], [4, 5]]);
    const map = decodeCbor(hex("a201020304"));
    expect(map).toEqual(
      new Map([
        [1, 2],
        [3, 4],
      ]),
    );
    const mixed = decodeCbor(hex("a2 6161 01 01 6162"));
    expect(isCborMap(mixed)).toBe(true);
    if (isCborMap(mixed)) {
      expect(mixed.get("a")).toBe(1);
      expect(mixed.get(1)).toBe("b");
      expect(mixed.has("1")).toBe(false);
    }
  });

  it("round-trips the encoder used by the tests, including a COSE key shape", () => {
    const value = new Map<string | number, Encodable>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.alloc(32, 1)],
      ["text", ["x", 70000, -70000, Buffer.from("y")]],
    ]);
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });

  it("decodeCborItem returns the end offset and allows trailing bytes; decodeCbor does not", () => {
    expect(decodeCborItem(hex("0102"), 0)).toEqual({ value: 1, end: 1 });
    expect(decodeCborItem(hex("0102"), 1)).toEqual({ value: 2, end: 2 });
    expect(() => decodeCbor(hex("0102"))).toThrow(new CborError("trailing bytes after the item"));
  });

  it("hasExactKeys checks the key set", () => {
    const map = new Map<string | number, CborValue>([
      ["a", 1],
      ["b", 2],
    ]);
    expect(hasExactKeys(map, ["a", "b"])).toBe(true);
    expect(hasExactKeys(map, ["a"])).toBe(false);
    expect(hasExactKeys(map, ["a", "c"])).toBe(false);
  });
});

describe("decodeCbor: rejections", () => {
  const rejects = (input: Buffer | string, message: RegExp, options = {}) => {
    const bytes = typeof input === "string" ? hex(input) : input;
    expect(() => decodeCbor(bytes, options)).toThrow(CborError);
    expect(() => decodeCbor(bytes, options)).toThrow(message);
  };

  it("truncated input", () => {
    rejects("", /unexpected end of input/);
    rejects("19 03", /unexpected end of input in an argument/);
    rejects("44 0102", /past the end/);
    rejects("82 01", /array length runs past/);
    // Three items in three bytes, but the first takes two: the third is missing.
    rejects("83 1801 02", /unexpected end of input/);
  });

  it("indefinite lengths", () => {
    rejects("5f 41 01 ff", /indefinite/);
    rejects("9f 01 ff", /indefinite/);
    rejects("bf 61 61 01 ff", /indefinite/);
  });

  it("reserved additional information", () => {
    rejects("1c", /reserved/);
    rejects("1d", /reserved/);
    rejects("1e", /reserved/);
  });

  it("tags", () => {
    rejects("c1 1a 514b67b0", /tags/);
  });

  it("floats and simple values, including true, false and null", () => {
    rejects("f9 3c00", /floats and simple values/);
    rejects("fa 47c35000", /floats and simple values/);
    rejects("fb 3ff199999999999a", /floats and simple values/);
    rejects("f4", /floats and simple values/);
    rejects("f5", /floats and simple values/);
    rejects("f6", /floats and simple values/);
  });

  it("duplicate map keys", () => {
    rejects("a2 6161 01 6161 02", /duplicate map key/);
    rejects("a2 01 01 01 02", /duplicate map key/);
  });

  it("map keys that are not text or integers", () => {
    rejects("a1 41 61 01", /map keys/);
    rejects("a1 80 01", /map keys/);
  });

  it("nesting deeper than 8 (depth 8 is accepted)", () => {
    const nested = (depth: number) => Buffer.concat([Buffer.alloc(depth, 0x81), Buffer.from([0x00])]);
    expect(() => decodeCbor(nested(8))).not.toThrow();
    rejects(nested(9), /too deep/);
    rejects(Buffer.concat([Buffer.alloc(8, 0x81), Buffer.from([0xa1, 0x01, 0x02])]), /too deep/);
  });

  it("a length larger than the input", () => {
    rejects("5a ffffffff 00", /past the end/);
    rejects("9a ffffffff 00", /array length runs past/);
    rejects("ba ffffffff 00", /map length runs past/);
    rejects("7a 7fffffff 61", /past the end/);
  });

  it("integers beyond the safe range", () => {
    rejects("1b ffffffffffffffff", /too large/);
    rejects("3b 001fffffffffffff", /too large/);
  });

  it("invalid UTF-8 text", () => {
    rejects("62 c328", /UTF-8/);
    rejects("61 ff", /UTF-8/);
  });

  it("oversized input", () => {
    rejects(Buffer.alloc(16 * 1024 + 1), /longer than 16384 bytes/);
    rejects(hex("4401020304"), /longer than 4 bytes/, { maxBytes: 4 });
  });

  it("offsets out of range and non-byte input", () => {
    expect(() => decodeCborItem(hex("01"), 5)).toThrow(/offset is out of range/);
    expect(() => decodeCborItem("01" as unknown as Uint8Array)).toThrow(/input must be bytes/);
  });
});

describe("decodeCbor: totality on random input", () => {
  it("10,000 random byte strings each decode or throw CborError, quickly", () => {
    const started = Date.now();
    const durations: number[] = [];
    let decoded = 0;
    for (let index = 0; index < 10_000; index += 1) {
      const bytes = randomBytes(1 + (index % 64));
      const before = performance.now();
      try {
        decodeCbor(bytes);
        decoded += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(CborError);
      }
      durations.push(performance.now() - before);
    }
    // A single GC pause on a shared CI runner can stall one decode past 20 ms, so the bound is on the 99.9th
    // percentile; the looser ceiling on the slowest still catches an input that makes the decoder pathologically slow.
    durations.sort((a, b) => a - b);
    expect(durations[Math.floor(durations.length * 0.999)]).toBeLessThan(20);
    expect(durations[durations.length - 1]).toBeLessThan(250);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(decoded).toBeGreaterThan(0);
  });
});
