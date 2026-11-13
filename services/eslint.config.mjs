// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// Node globals used by the CommonJS scripts (the TypeScript files get them from @types/node).
const nodeGlobals = {
  __dirname: "readonly",
  __filename: "readonly",
  Buffer: "readonly",
  console: "readonly",
  process: "readonly",
  setTimeout: "readonly",
};

export default defineConfig(
  {
    // The disposable-domain list is written by scripts/updateDisposableDomains.ts (npm run update:disposable-domains).
    ignores: ["**/dist/**", "coverage/**", "src/handlers/preSignUp/disposableDomains.generated.ts"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests require() handlers after setting env vars or registering mocks, so the module sees them at load time.
    files: ["src/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["**/*.cjs", "**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: nodeGlobals },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
