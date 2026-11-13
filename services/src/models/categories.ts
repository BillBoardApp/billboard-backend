export const BILL_CATEGORY_DEFINITIONS = [
  {
    name: "Economic Policy",
    subCategories: [
      "Fiscal Policy",
      "Monetary Policy",
      "Labor and Employment",
      "Trade and Globalization",
      "Social Welfare",
    ] as const,
  },
  {
    name: "Social Policy",
    subCategories: [
      "Healthcare",
      "Education",
      "Housing",
      "Civil Rights and Liberties",
      "Family and Gender Policy",
    ] as const,
  },
  {
    name: "Environmental and Energy Policy",
    subCategories: ["Climate Change", "Energy", "Conservation and Natural Resources", "Pollution Control"] as const,
  },
  {
    name: "Foreign Policy and Defense",
    subCategories: [
      "Diplomacy",
      "Military and Defense",
      "Trade and Sanctions",
      "Immigration and Border Control",
      "Humanitarian Intervention",
    ] as const,
  },
  {
    name: "Governance and Institutional Policy",
    subCategories: [
      "Constitutional and Legal Issues",
      "Elections and Voting",
      "Transparency and Accountability",
      "Local vs. Federal Power",
    ] as const,
  },
  {
    name: "Science, Technology, and Infrastructure",
    subCategories: [
      "Technology Regulation",
      "Transportation",
      "Research and Innovation",
      "Telecommunications",
    ] as const,
  },
  {
    name: "Cultural and Ethical Issues",
    subCategories: [
      "Religion and State",
      "Heritage and Identity",
      "Freedom of Speech and Press",
      "Ethics in Policy",
    ] as const,
  },
] as const;

type BillCategoryDefinition = (typeof BILL_CATEGORY_DEFINITIONS)[number];
type BillCategoryName = BillCategoryDefinition["name"];
type BillSubCategoryName = BillCategoryDefinition["subCategories"][number];

export interface BillCategoryReference {
  category: BillCategoryName;
  subCategory: BillSubCategoryName;
}

const BILL_CATEGORIES = BILL_CATEGORY_DEFINITIONS.map(
  (definition) => definition.name,
) as ReadonlyArray<BillCategoryName>;
const BILL_SUBCATEGORIES = BILL_CATEGORY_DEFINITIONS.flatMap(
  (definition) => definition.subCategories,
) as ReadonlyArray<BillSubCategoryName>;

export const BILL_SUBCATEGORY_TO_CATEGORY: Record<BillSubCategoryName, BillCategoryName> =
  BILL_CATEGORY_DEFINITIONS.reduce(
    (acc, definition) => {
      for (const subCategory of definition.subCategories) {
        acc[subCategory] = definition.name;
      }
      return acc;
    },
    {} as Record<BillSubCategoryName, BillCategoryName>,
  );

export const isBillCategoryName = (value: string): value is BillCategoryName =>
  BILL_CATEGORIES.includes(value as BillCategoryName);

/** A current sub-category name only; legacy names (LEGACY_SUB_CATEGORY_ALIASES) are not current. */
export const isBillSubCategoryName = (value: string): value is BillSubCategoryName =>
  BILL_SUBCATEGORIES.includes(value as BillSubCategoryName);

// ── Legacy names (LLM-10, decision 1B) ──────────────────────────────────────────────────────────────
// Former sub-category names and the current name each became. Both renames keep their parent category, so a legacy
// name maps to exactly one current name. Stored bills, follows and vote snapshots may still carry a legacy name until
// the relabel script has run, and old app builds may still send one, so both spellings are accepted and mapped to the
// current name until a later cleanup removes this map. The contracts check reads the quoted keys and values here:
// the processed-bill schema's sub-category enum must equal the current names plus these keys, and every value must be
// a current name. Keep the keys and values as quoted string literals.

export const LEGACY_SUB_CATEGORY_ALIASES = {
  "Social Justice": "Civil Rights and Liberties",
  "Identity Politics": "Heritage and Identity",
} as const satisfies Readonly<Record<string, BillSubCategoryName>>;

type LegacySubCategoryName = keyof typeof LEGACY_SUB_CATEGORY_ALIASES;
/** A sub-category name accepted on input: a current name or a legacy one. */
export type AcceptedSubCategoryName = BillSubCategoryName | LegacySubCategoryName;

/** A legacy sub-category name (a key of LEGACY_SUB_CATEGORY_ALIASES; inherited object keys never match). */
export const isLegacySubCategoryName = (value: string): value is LegacySubCategoryName =>
  Object.prototype.hasOwnProperty.call(LEGACY_SUB_CATEGORY_ALIASES, value);

/** A current sub-category name, or a legacy one still accepted during the label switch. */
export const isAcceptedSubCategoryName = (value: string): value is AcceptedSubCategoryName =>
  isBillSubCategoryName(value) || isLegacySubCategoryName(value);

/**
 * The current name for a legacy sub-category name; any other value (a current name, or an unknown string) is returned
 * unchanged, so callers that filter unknown labels still do so afterwards.
 */
export function canonicalSubCategory(name: AcceptedSubCategoryName): BillSubCategoryName;
export function canonicalSubCategory(name: string): string;
export function canonicalSubCategory(name: string): string {
  return isLegacySubCategoryName(name) ? LEGACY_SUB_CATEGORY_ALIASES[name] : name;
}

/**
 * Every spelling of a sub-category: its current name first, then each legacy name that maps to it. For lookups and
 * deletes that must match rows written under either name. An unknown value is returned on its own.
 */
export const subCategoryNameVariants = (name: string): string[] => {
  const current = canonicalSubCategory(name);
  const legacy = Object.entries(LEGACY_SUB_CATEGORY_ALIASES)
    .filter(([, target]) => target === current)
    .map(([legacyName]) => legacyName);
  return [current, ...legacy];
};

/**
 * The legacy name of a renamed sub-category, given its current or its legacy name ("Civil Rights and Liberties" and
 * "Social Justice" both give "Social Justice"); undefined for every other value. Read from LEGACY_SUB_CATEGORY_ALIASES,
 * so the two cannot drift; each current name has one legacy name at most. Both renames keep their parent, so the
 * legacy name's parent category is the current name's (BILL_SUBCATEGORY_TO_CATEGORY). Builds 1.0 and R1 know a renamed
 * label only by its legacy name, so `GET /preferences` returns it under that name to requests without
 * `X-Billboard-App-Version`. Looked up on each call, not kept in a module-level map: esbuild keeps a top-level
 * `new Map(...)` in every bundle that imports this file, used or not, which would change (and deploy) every Lambda
 * that reads the categories instead of FetchPreferences alone.
 */
export const legacySubCategoryName = (name: string): LegacySubCategoryName | undefined => {
  const current = canonicalSubCategory(name);
  return (Object.keys(LEGACY_SUB_CATEGORY_ALIASES) as LegacySubCategoryName[]).find(
    (legacyName) => LEGACY_SUB_CATEGORY_ALIASES[legacyName] === current,
  );
};
