// Flat list of life areas and subcategories.
// Populate or edit these values as needed.
export const LIFE_AREAS = [
  "Utility Bills",
  "Home Energy",
  "Student Loans",
  "Health Insurance",
  "Taxes",
  "Medical Costs",
  "Transportation",
  "Local Development",
  "Online Privacy",
  "Digital Security",
  "Social Media",
  "Digital Services",
  "Pet Ownership",
] as const;

type LifeAreaName = (typeof LIFE_AREAS)[number];

export const isLifeAreaName = (value: string): value is LifeAreaName => LIFE_AREAS.includes(value as LifeAreaName);
