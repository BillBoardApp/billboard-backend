/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
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
