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

// Zero-friction offline lane: `pnpm install && npm run test:unit` works on a
// fresh clone with NO docker compose up and NO exported secrets.
//
// PGPASSWORD is set to a NON-FUNCTIONAL sentinel on purpose. The pure-unit
// lane is proven (CI + local runs with a bogus password) to never open a
// live DB connection — several modules only need the var to EXIST at import
// time (e.g. foundryEnv throws when it is unset). A sentinel is SAFER than
// fail-fast here: any test that ever attempts a real PG connection fails
// authentication loudly instead of silently succeeding against a dev
// database. A real exported PGPASSWORD is still honored when present (it
// simply goes unused), so CI needs no change.
const UNIT_LANE_PGPASSWORD_SENTINEL = "unit-lane-no-live-db";

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
    // is contacted by the pure-unit lane (proven: the lane passes end to end
    // with a bogus PGPASSWORD). Non-secret values mirror the dev docker
    // stack; PGPASSWORD falls back to a non-functional sentinel (see above).
    env: {
      PGPASSWORD: process.env.PGPASSWORD ?? UNIT_LANE_PGPASSWORD_SENTINEL,
      PGUSER: "tellus",
      PGHOST: "localhost",
      PGPORT: "5432",
      PGDATABASE: "tellus_db",
      KEYCLOAK_ISSUER: "http://localhost:8086/realms/tellus",
      KEYCLOAK_URL: "http://localhost:8086",
      NODE_ENV: "test",
      // Test lanes exercise publish ROUTES as the feature surface, not the
      // author gate; the gate itself is covered by dedicated unit tests
      // (tests/unit/functions/executionPolicy-unit.test.ts) under the real
      // default mode. open-development is only honored outside production.
      FUNCTION_EXECUTION_TRUST_MODE: "open-development",
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
      // Coverage FLOOR (ratchet): CI fails when the unit lane drops below
      // these. Measured 2026-09-09 at lines ~37.9 / branches ~30.5 with
      // 390+ unit files; the floor sits just under that to absorb
      // run-to-run noise while blocking genuine regressions. Policy:
      // raise-only — any PR that lifts coverage should lift these numbers
      // in the same commit; NEVER lower them. The 70 lines / 60 branches
      // aspiration from the audit is tracked (not yet enforced): reaching
      // it requires the deferred test program for the PG/OS/Kafka-bound
      // modules (see .github/workflows/coverage-gate.yml RATCHET tier).
      thresholds: {
        lines: 37,
        branches: 30,
        functions: 0,
        statements: 0,
      },
    },
  },
});
