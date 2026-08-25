// ---------------------------------------------------------------------------
// vitest.codeRepos.config.ts — Code Repositories integration test lane
//
// Purpose: run integration tests for the new Code Repositories surface
// (B1..B10) WITHOUT spawning the full tellus Express server, OpenSearch, or
// Keycloak. These tests talk directly to:
//   - Postgres on localhost:5432 (must be up; existing repo convention)
//   - MinIO on localhost:9000 (when wired in subsequent waves)
//
// Why a third config?
//   - vitest.unit.config.ts        — pure unit tests, no I/O.
//   - vitest.config.ts             — full e2e via globalSetup (heavy).
//   - vitest.codeRepos.config.ts   — DB-touching but server-less, fast.
//
// Glob: only tests/integration/code-repos/** are picked up. Each test file
// uses schema-isolated Postgres so concurrent test files do not interfere.
// ---------------------------------------------------------------------------

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    root: path.resolve(__dirname),
    globals: true,
    // No globalSetup, no setupFiles — these tests are self-contained.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ["verbose"],
    include: ["tests/integration/code-repos/**/*-integration.test.ts"],
    exclude: ["node_modules", "dist"],
    // DB tests share a single Postgres instance — serialize to keep schema
    // creation/drop simple and deterministic per file.
    sequence: { concurrent: false },
    fileParallelism: false,
    env: {
      PGHOST: process.env.PGHOST ?? "localhost",
      PGPORT: process.env.PGPORT ?? "5432",
      PGDATABASE: process.env.PGDATABASE ?? "tellus_db",
      PGUSER: process.env.PGUSER ?? "tellus",
      PGPASSWORD: process.env.PGPASSWORD ?? "tellus123",
      // Enable the test-mode principal opt-in so integration tests can drive
      // routes via the X-Tellus-Test-Principal header without standing up a
      // Keycloak realm. requireCodeReposAuth() ignores this header unless
      // CODE_REPOS_TEST_AUTH=1 is set, so production paths are unaffected.
      CODE_REPOS_TEST_AUTH: "1",
      // Publish-author trust gate: exercised by dedicated tests; other lanes
      // opt out explicitly (never honored in production).
      FUNCTION_EXECUTION_TRUST_MODE: "open-development",
      // Real-LLM generations (reasoning models especially) can exceed the
      // client's default 120s ceiling. Only the AI contract suite uses
      // this client; 10 min matches the suite's per-attempt budget.
      AI_ENGINE_TIMEOUT_MS: process.env.AI_ENGINE_TIMEOUT_MS ?? "600000",
    },
  },
});
