const toHex = (value: number): string => value.toString(16).padStart(2, "0");

export function deterministicUuidFromString(value: string): string {
  const bytes = new Uint8Array(16);

  for (const [index, byte] of Buffer.from(value, "utf8").entries()) {
    bytes[index % 16] = (bytes[index % 16] + byte) & 0xff;
  }

  const hex = Array.from(bytes, toHex).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}
