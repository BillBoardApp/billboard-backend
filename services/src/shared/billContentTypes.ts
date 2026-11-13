const ALL_BILL_CONTENT_TYPES = ["bills", "joint_resolutions", "other_resolutions"] as const;

export type BillContentTypePreference = (typeof ALL_BILL_CONTENT_TYPES)[number];

export const isBillContentTypePreference = (value: unknown): value is BillContentTypePreference =>
  typeof value === "string" && ALL_BILL_CONTENT_TYPES.includes(value as BillContentTypePreference);

const normalizeBillTypeToContentType = (rawBillType: unknown): BillContentTypePreference | null => {
  if (typeof rawBillType !== "string") {
    return null;
  }

  const normalized = rawBillType.trim().toLowerCase();

  switch (normalized) {
    case "house-bill":
    case "senate-bill":
    case "hr":
    case "s":
      return "bills";
    case "house-joint-resolution":
    case "senate-joint-resolution":
    case "hjres":
    case "sjres":
      return "joint_resolutions";
    case "house-concurrent-resolution":
    case "senate-concurrent-resolution":
    case "house-resolution":
    case "senate-resolution":
    case "hconres":
    case "sconres":
    case "hres":
    case "sres":
      return "other_resolutions";
    default:
      return null;
  }
};

export const billTypeMatchesContentPreferences = (
  rawBillType: unknown,
  allowedContentTypes: ReadonlySet<BillContentTypePreference> | null | undefined,
): boolean => {
  if (!allowedContentTypes || allowedContentTypes.size === 0) {
    return true;
  }

  const normalized = normalizeBillTypeToContentType(rawBillType);
  if (!normalized) {
    return true;
  }

  return allowedContentTypes.has(normalized);
};
