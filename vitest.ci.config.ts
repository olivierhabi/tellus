// CI-only vitest config (docs/ci.md). Identical to vitest.config.ts — same
// globalSetup, lane env, include globs, serial execution — plus:
//   * JUnit + verbose reporters, JUnit path from $JUNIT_OUTPUT so each shard
//     uploads a uniquely-named report;
//   * the quarantine list from .github/ci/test-selection.json is excluded
//     from every blocking lane, and is the ONLY thing run when
//     CI_TEST_MODE=quarantine (non-blocking job).
// Test logic is untouched: this file only changes selection and reporting.
import { readFileSync } from "fs";
import path from "path";
import { defineConfig } from "vitest/config";
import base from "./vitest.config";

interface QuarantineEntry {
  file: string;
  issue: number;
  reason: string;
}

const selection = JSON.parse(
  readFileSync(path.resolve(__dirname, ".github/ci/test-selection.json"), "utf8"),
) as { quarantine: QuarantineEntry[] };

const quarantined = selection.quarantine.map((q) => q.file);
const quarantineMode = process.env.CI_TEST_MODE === "quarantine";
const baseTest = base.test ?? {};

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: quarantineMode ? quarantined : baseTest.include,
    exclude: quarantineMode
      ? ["node_modules", "dist"]
      : [...(baseTest.exclude ?? ["node_modules", "dist"]), ...quarantined],
    reporters: ["verbose", "junit"],
    outputFile: { junit: process.env.JUNIT_OUTPUT ?? "reports/junit.xml" },
  },
});
