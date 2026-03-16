import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    // ---------------------------------------------------------------------------
    // Global settings
    // ---------------------------------------------------------------------------
    root: path.resolve(__dirname),
    globals: true,

    // Timeouts — integration tests can be slow
    testTimeout: 120_000,
    hookTimeout: 120_000,

    // Reporter — verbose in CI, default locally
    reporters: process.env.CI ? ["verbose", "junit"] : ["verbose"],
    outputFile: process.env.CI ? { junit: "test-results.xml" } : undefined,

    // ---------------------------------------------------------------------------
    // Test file discovery
    //
    // Only files matching *-unit.test.ts, *-integration.test.ts, or
    // *-e2e.test.ts are picked up. This excludes legacy suite files
    // (ontology.test.ts, cleanup.test.ts, etc.) which export run()
    // functions but don't contain Vitest describe/it blocks.
    // ---------------------------------------------------------------------------
    include: [
      "tests/**/*-unit.test.ts",
      "tests/**/*-integration.test.ts",
      "tests/**/*-e2e.test.ts",
    ],
    exclude: ["node_modules", "dist"],

    // ---------------------------------------------------------------------------
    // Workspace-like separation via projects
    // ---------------------------------------------------------------------------
    // Tests are organized by day (monday, tuesday) and type (unit, integration).
    // Vitest discovers all .test.ts files and groups them by directory.

    // Ensure sequential execution for integration tests that share state
    sequence: {
      concurrent: false,
    },

    // Environment
    env: {
      PGHOST: "localhost",
      PGDATABASE: "tellus_db",
      PGUSER: "tellus",
      PGPASSWORD: "tellus123",
    },

    // Coverage configuration
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/server.ts",
        "src/migrate.ts",
        "src/seed.ts",
        "src/tests/**",
        "**/*.d.ts",
      ],
      reporter: ["text", "text-summary", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
