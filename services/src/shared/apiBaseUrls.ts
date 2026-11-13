export const CONGRESS_API_BASE_URL = (process.env.CONGRESS_API_BASE_URL || "https://api.congress.gov/v3").replace(
  /\/$/,
  "",
);
