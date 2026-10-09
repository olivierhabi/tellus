// Funnel out-of-process lane (CI job `funnel-oop` + nightly funnel-scale).
// Same lane env as vitest.config.ts, but the global setup only bootstraps the
// database (migrations + environment seal) — no API server, Keycloak or
// OpenSearch — because these suites drive the funnel activities directly
// against Postgres + MinIO + the DuckDB CLI.
import { defineConfig } from "vitest/config";
import base from "./vitest.config";

const baseTest = (base as { test?: Record<string, unknown> }).test ?? {};
const scaleOnly = process.env.TELLUS_FUNNEL_LANE === "scale";

export default defineConfig({
  ...(base as object),
  test: {
    ...baseTest,
    globalSetup: "tests/funnel/stackOnly.globalSetup.ts",
    setupFiles: [],
    include: scaleOnly
      ? ["tests/funnel/scale/*.scale.test.ts"]
      : [
          "tests/funnel/integration/indexing-closeout-*-integration.test.ts",
          "tests/funnel/integration/funnel-fleet-sim-integration.test.ts",
          "tests/funnel/scale/*.scale.test.ts",
        ],
    testTimeout: 4 * 3_600_000,
    hookTimeout: 600_000,
  },
});
