/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  // *.generated.ts files are data, not logic to cover (eslint.config.mjs skips the same file). Instrumenting preSignUp's
  // disposable domain list, which passes Babel's 500KB limit once compiled, made Babel print a deoptimisation note on
  // every coverage run. /node_modules/ is Jest's default.
  coveragePathIgnorePatterns: ['/node_modules/', '\\.generated\\.ts$'],
  // Enforced when run with --coverage (CI does). Set 2 points below the
  // measured baseline (Sep 2026: 88.48 lines, 68.62 branches, 93.75 functions,
  // 86.00 statements); raise as coverage improves, never lower.
  coverageThreshold: {
    global: {
      lines: 86,
      branches: 66,
      functions: 91,
      statements: 84,
    },
  },
};
