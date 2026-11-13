import {
  BILL_CATEGORY_DEFINITIONS,
  BILL_SUBCATEGORY_TO_CATEGORY,
  LEGACY_SUB_CATEGORY_ALIASES,
  canonicalSubCategory,
  isAcceptedSubCategoryName,
  isBillSubCategoryName,
  isLegacySubCategoryName,
  legacySubCategoryName,
  subCategoryNameVariants,
} from "../models/categories";

const currentNames = BILL_CATEGORY_DEFINITIONS.flatMap((definition) => [...definition.subCategories]) as string[];

describe("categories model: label rename (LLM-10)", () => {
  it("lists the new names under their old parents and neither old name", () => {
    expect(BILL_SUBCATEGORY_TO_CATEGORY["Civil Rights and Liberties"]).toBe("Social Policy");
    expect(BILL_SUBCATEGORY_TO_CATEGORY["Heritage and Identity"]).toBe("Cultural and Ethical Issues");
    expect(currentNames).not.toContain("Social Justice");
    expect(currentNames).not.toContain("Identity Politics");
    expect(new Set(currentNames).size).toBe(currentNames.length);
  });

  it("maps each legacy name to one current name, and no legacy name is current", () => {
    expect(LEGACY_SUB_CATEGORY_ALIASES).toEqual({
      "Social Justice": "Civil Rights and Liberties",
      "Identity Politics": "Heritage and Identity",
    });
    for (const [legacyName, currentName] of Object.entries(LEGACY_SUB_CATEGORY_ALIASES)) {
      expect(isBillSubCategoryName(currentName)).toBe(true);
      expect(isBillSubCategoryName(legacyName)).toBe(false);
    }
  });

  it("isBillSubCategoryName accepts current names only", () => {
    expect(isBillSubCategoryName("Civil Rights and Liberties")).toBe(true);
    expect(isBillSubCategoryName("Heritage and Identity")).toBe(true);
    expect(isBillSubCategoryName("Social Justice")).toBe(false);
    expect(isBillSubCategoryName("Identity Politics")).toBe(false);
  });

  it("isAcceptedSubCategoryName accepts both spellings and still rejects unknown labels", () => {
    for (const name of ["Civil Rights and Liberties", "Heritage and Identity", "Social Justice", "Identity Politics"]) {
      expect(isAcceptedSubCategoryName(name)).toBe(true);
    }
    expect(isAcceptedSubCategoryName("Energy")).toBe(true);
    for (const name of ["Infrastructure", "social justice", "Civil Rights", "Heritage & Identity", "", "constructor"]) {
      expect(isAcceptedSubCategoryName(name)).toBe(false);
    }
  });

  it("isLegacySubCategoryName ignores inherited object keys", () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(isLegacySubCategoryName(name)).toBe(false);
    }
    expect(isLegacySubCategoryName("Social Justice")).toBe(true);
  });

  it("canonicalSubCategory maps legacy names and leaves every other value unchanged", () => {
    expect(canonicalSubCategory("Social Justice")).toBe("Civil Rights and Liberties");
    expect(canonicalSubCategory("Identity Politics")).toBe("Heritage and Identity");
    expect(canonicalSubCategory("Civil Rights and Liberties")).toBe("Civil Rights and Liberties");
    expect(canonicalSubCategory("Energy")).toBe("Energy");
    expect(canonicalSubCategory("Infrastructure")).toBe("Infrastructure");
    expect(canonicalSubCategory("toString")).toBe("toString");
    // Idempotent: applying it twice gives the same name.
    for (const name of [...currentNames, ...Object.keys(LEGACY_SUB_CATEGORY_ALIASES)]) {
      expect(canonicalSubCategory(canonicalSubCategory(name))).toBe(canonicalSubCategory(name));
      expect(isBillSubCategoryName(canonicalSubCategory(name))).toBe(true);
    }
  });

  it("canonicalSubCategory of an accepted name has a parent category", () => {
    const raw: string = "Identity Politics";
    if (!isAcceptedSubCategoryName(raw)) throw new Error("expected an accepted name");
    expect(BILL_SUBCATEGORY_TO_CATEGORY[canonicalSubCategory(raw)]).toBe("Cultural and Ethical Issues");
  });

  it("subCategoryNameVariants lists the current name first, then its legacy names", () => {
    expect(subCategoryNameVariants("Civil Rights and Liberties")).toEqual([
      "Civil Rights and Liberties",
      "Social Justice",
    ]);
    expect(subCategoryNameVariants("Social Justice")).toEqual(["Civil Rights and Liberties", "Social Justice"]);
    expect(subCategoryNameVariants("Identity Politics")).toEqual(["Heritage and Identity", "Identity Politics"]);
    expect(subCategoryNameVariants("Energy")).toEqual(["Energy"]);
    expect(subCategoryNameVariants("Infrastructure")).toEqual(["Infrastructure"]);
  });

  it("legacySubCategoryName turns LEGACY_SUB_CATEGORY_ALIASES around, one legacy name per current name", () => {
    // A second legacy name for one current name could not be returned: legacySubCategoryName gives one.
    const currentNames = Object.values(LEGACY_SUB_CATEGORY_ALIASES);
    expect(new Set(currentNames).size).toBe(currentNames.length);
    for (const [legacyName, currentName] of Object.entries(LEGACY_SUB_CATEGORY_ALIASES)) {
      expect(legacySubCategoryName(currentName)).toBe(legacyName);
    }
  });

  it("legacySubCategoryName gives a renamed label's legacy name from either name, and nothing for other values", () => {
    expect(legacySubCategoryName("Civil Rights and Liberties")).toBe("Social Justice");
    expect(legacySubCategoryName("Social Justice")).toBe("Social Justice");
    expect(legacySubCategoryName("Heritage and Identity")).toBe("Identity Politics");
    expect(legacySubCategoryName("Identity Politics")).toBe("Identity Politics");
    for (const name of ["Energy", "Social Policy", "social justice", "Civil Rights", "", "toString", "constructor"]) {
      expect(legacySubCategoryName(name)).toBeUndefined();
    }
  });

  it("files each legacy name under the parent builds 1.0 and R1 hard-code for it", () => {
    // SubscriptionsConfig.subcategoryGroups and BillsStore.categoryForManifestSubcategory in billboard-app 1.0 and R1.
    const parentIn10AndR1: Record<string, string> = {
      "Social Justice": "Social Policy",
      "Identity Politics": "Cultural and Ethical Issues",
    };
    expect(Object.keys(LEGACY_SUB_CATEGORY_ALIASES)).toEqual(Object.keys(parentIn10AndR1));
    for (const [legacyName, currentName] of Object.entries(LEGACY_SUB_CATEGORY_ALIASES)) {
      expect(BILL_SUBCATEGORY_TO_CATEGORY[currentName]).toBe(parentIn10AndR1[legacyName]);
    }
  });
});
