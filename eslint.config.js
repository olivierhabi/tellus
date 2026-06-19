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
