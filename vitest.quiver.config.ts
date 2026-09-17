// Vitest config for the Quiver drive (B1..B10, F1..F10).
//
// Bypasses the heavy globalSetup the rest of the suite uses (which spawns
// a live server and pings Keycloak) — the Quiver integration tests connect
// to Postgres directly and run an Express app via supertest in-process.
//
// Picks up:
//   tests/quiver/unit/**/*-unit.test.ts        (no I/O)
//   tests/quiver/integration/**/*-integration.test.ts (PG-bound)
//   tests/quiver/e2e/**/*-e2e.test.ts          (PG + spawned server)
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    root: path.resolve(__dirname),
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tolerate transient HTTP-parse / socket-reuse glitches that surface
    // sporadically under the full-suite run (one per ~3 runs, different
    // test each time, all pass in isolation). The actual contracts are
    // proven by the cypress E2E gates against the live container.
    retry: 2,
    reporters: ["verbose"],
    include: [
      "tests/quiver/unit/**/*-unit.test.ts",
      "tests/quiver/integration/**/*-integration.test.ts",
      "tests/quiver/e2e/**/*-e2e.test.ts",
    ],
    exclude: ["node_modules", "dist"],
    sequence: { concurrent: false },
    fileParallelism: false,
    env: {
      // Quiver test-auth bypass opt-in (x-test-user is honoured only when
      // this flag is set) + the shared harness token that authenticates the
      // caller (X-Tellus-Test-Auth-Token, timing-safe). VITEST-LANE-ONLY
      // public constant — see vitest.config.ts. A real deployment MUST use
      // a private token in its gitignored env, never this literal.
      QUIVER_ALLOW_TEST_AUTH: "1",
      CODE_REPOS_TEST_AUTH_TOKEN:
        "vitest-lane-9f2c6b4e8a1d3f5c7b9e0d2a4c6f8e1b3d5a7c9e1f3b5d7a9c1e3f5b7d9a1c3",
    },
    coverage: {
      provider: "v8",
      include: [
        "src/services/quiver/**/*.ts",
        "src/routes/quiver/**/*.ts",
      ],
      exclude: ["**/*.d.ts"],
      reporter: ["text", "text-summary", "lcov", "json"],
      reportsDirectory: "coverage/quiver",
    },
  },
});
