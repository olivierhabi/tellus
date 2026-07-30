// ---------------------------------------------------------------------------
// Pure-unit vitest config — no globalSetup, no server spawn, no Docker.
//
// Exists for two reasons:
//   1. F-P2-02 blocker: `pnpm test` cannot run without Docker (PG/OS/Keycloak).
//      A fast unit-only path lets CI and devs run real-logic tests offline.
//   2. Separation of concerns per briefing §5 item 4: "critical paths with
//      zero tests" — pure unit tests should NOT be coupled to integration
//      infra. This config enforces that separation at the tooling layer.
//
// Usage: `pnpm vitest run --config vitest.unit.config.ts`
// ---------------------------------------------------------------------------
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    root: path.resolve(__dirname),
    globals: true,
    // NO globalSetup. NO setupFiles. NO server spawn.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    reporters: ["verbose"],
    // Test-only env defaults so pure-unit files whose imports "(throw at read
    // time if unset)" on DB config (e.g. foundryEnv) can import offline
    // without Docker. These only need the vars to EXIST; no live DB/Keycloak
    // is contacted by the pure-unit lane. Values mirror the dev docker stack.
    env: {
      PGPASSWORD: "tellus123",
      PGUSER: "tellus",
      PGHOST: "localhost",
      PGPORT: "5432",
      PGDATABASE: "tellus_db",
      KEYCLOAK_ISSUER: "http://localhost:8086/realms/tellus",
      KEYCLOAK_URL: "http://localhost:8086",
      NODE_ENV: "test",
    },
    include: [
      "tests/unit/**/*-unit.test.ts",
      // Also include monday/tuesday/wednesday/thursday/friday/saturday/sunday
      // *-unit.test.ts files that are pure (do not import a live server).
      "tests/monday/unit/**/*-unit.test.ts",
      "tests/tuesday/unit/**/*-unit.test.ts",
      "tests/wednesday/unit/**/*-unit.test.ts",
      "tests/thursday/unit/**/*-unit.test.ts",
      "tests/friday/unit/**/*-unit.test.ts",
      "tests/saturday/unit/**/*-unit.test.ts",
      "tests/sunday/unit/**/*-unit.test.ts",
      "tests/foundry/unit/**/*-unit.test.ts",
      // T-04: pure-unit overlay/funnel tests (MemoryOverlayStore in-memory,
      // no Redis/PG/Quickwit). Including the whole dir keeps the offline
      // lane aligned with the funnel test surface.
      "tests/funnel/unit/**/*-unit.test.ts",
      // Quiver drive (B1..B10 + F1..F10): pure-unit tests under tests/quiver/unit/.
      "tests/quiver/unit/**/*-unit.test.ts",
      // T-10: AST-level route contract guard (no I/O beyond fs reads).
      "tests/contract/**/*.test.ts",
      // postgres-connection program: pure-unit tests for the connectivity
      // service tier (Zod contracts, error envelope, ETag helpers, FK
      // detector, type mapping, vault primitives, pg-types config).
      "tests/connectivity/unit/**/*-unit.test.ts",
    ],
    exclude: ["node_modules", "dist", "tests/**/*-integration.test.ts", "tests/**/*-e2e.test.ts"],
    sequence: { concurrent: false },
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.d.ts",
        "src/utils/gracefulShutdown.ts",
        "src/migrate.ts",
        "src/foundryMigrate.ts",
      ],
      reporter: ["text", "text-summary", "lcov", "json"],
      reportsDirectory: "coverage/unit",
    },
  },
});
