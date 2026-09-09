// Flat ESLint config (F-07): TypeScript parsing + eslint-plugin-security static
// analysis scoped to src/**. Security findings are surfaced primarily as
// warnings so the gate runs on the existing tree without a disruptive wall of
// errors, while genuinely dangerous patterns (eval-with-expression) hard-fail.
// CodeQL (.github/workflows/codeql.yml) is the deeper, blocking SAST layer.
const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const security = require("eslint-plugin-security");

module.exports = [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "**/*.d.ts"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      security,
    },
    rules: {
      // Growth guards (warn-only so the existing tree stays green): new
      // god-files should be split at review time following the 0.3.1
      // extraction pattern (one module per commit with its spec). Warnings
      // are visible in `pnpm run lint` output and in IDEs; only `error`
      // level rules fail CI.
      "max-lines": ["warn", { max: 800, skipBlankLines: true, skipComments: true }],
      complexity: ["warn", 20],
      "security/detect-eval-with-expression": "error",
      "security/detect-non-literal-require": "warn",
      "security/detect-child-process": "warn",
      "security/detect-non-literal-fs-filename": "warn",
      "security/detect-unsafe-regex": "warn",
      "security/detect-buffer-noassert": "warn",
      "security/detect-pseudoRandomBytes": "warn",
      "security/detect-possible-timing-attacks": "warn",
      // Extremely noisy with high false-positive rate on typed code; CodeQL
      // covers genuine injection sinks.
      "security/detect-object-injection": "off",
    },
  },
];
