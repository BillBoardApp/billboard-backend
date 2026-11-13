import { normalizeBillTypeCode, parseBillGuid, type BillTypeCode } from "./billCompanions";

/** The citation prefix of each bill type, as the apps print it. */
const CITATION_PREFIX: Readonly<Record<BillTypeCode, string>> = {
  hr: "H.R.",
  s: "S.",
  hjres: "H.J.Res.",
  sjres: "S.J.Res.",
  hconres: "H.Con.Res.",
  sconres: "S.Con.Res.",
  hres: "H.Res.",
  sres: "S.Res.",
};

// "77", or the number with its type in front ("hr77", "H.R. 77").
const BILL_NUMBER_RE = /^[a-z. ]*?(\d+)$/i;

function typedNumber(billType: unknown, billNumber: unknown): string | null {
  const type = normalizeBillTypeCode(billType);
  const raw = typeof billNumber === "number" ? String(billNumber) : typeof billNumber === "string" ? billNumber : "";
  const match = BILL_NUMBER_RE.exec(raw.trim());
  const number = match ? Number.parseInt(match[1], 10) : 0;
  return type && number > 0 ? `${CITATION_PREFIX[type]} ${number}` : null;
}

/**
 * The bill's number as the apps show it ("H.R. 77", "S.J.Res. 213", "H.Res. 826"): from its type and number
 * when both are usable, else from its GovInfo guid ("BILLS-119hr77ih"). Null when neither is. The same rule as
 * the app's BillDisplayFormatting.officialBillNumber.
 */
export function officialBillNumber(input: { billType?: unknown; billNumber?: unknown; guid?: unknown }): string | null {
  const typed = typedNumber(input.billType, input.billNumber);
  if (typed) {
    return typed;
  }

  const parsed = parseBillGuid(input.guid);
  return parsed ? typedNumber(parsed.billType, parsed.billNumber) : null;
}
