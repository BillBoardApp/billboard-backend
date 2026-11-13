export const isSyntheticEvent = (event: unknown): boolean => {
  if (!event || typeof event !== "object") return false;
  const e = event as Record<string, unknown>;
  if (e["source"] === "synthetic-test") return true;
  if (typeof e["x-synthetic-test"] === "string" && e["x-synthetic-test"].toLowerCase() === "true") return true;
  return false;
};
