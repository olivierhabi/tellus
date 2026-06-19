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
