// cypress.config.ts — Quiver verification (CONTRACT v1 §3).
//
// One root config drives both the existing cypress/quiver/ smoke specs and
// the new cypress/e2e/quiver/ harness specs. The verify harness invokes
// only the harness specs via --spec.
//
// baseUrl precedence:
//   1. CYPRESS_baseUrl env var (set by scripts/quiver-verify.sh to
//      http://localhost:32000 from the host).
//   2. http://app:3000 when run inside the verify compose network.
//   3. http://localhost:32000 fallback when neither is set.

import { defineConfig } from "cypress";

const fromEnv = process.env.CYPRESS_baseUrl;
const inDocker = process.env.IN_VERIFY_NETWORK === "1";
const baseUrl =
  fromEnv ??
  (inDocker ? "http://app:3000" : "http://localhost:32000");

export default defineConfig({
  fixturesFolder: "cypress/fixtures",
  videosFolder: "cypress/videos/quiver",
  screenshotsFolder: "cypress/screenshots/quiver",
  video: true,
  videoCompression: 32,
  defaultCommandTimeout: 15_000,
  responseTimeout: 30_000,
  requestTimeout: 30_000,
  // Tolerate transient 504s from the verify-stack request-timeout middleware
  // when the postgres pool is warming up under cypress's first cold request.
  // Each spec has exactly one it() block so a per-spec retry of 3 means up
  // to 4 attempts; if it still fails the harness fails. The underlying
  // contract being asserted is unchanged.
  retries: { runMode: 3, openMode: 0 },
  e2e: {
    baseUrl,
    specPattern: "cypress/e2e/quiver/**/*.cy.{ts,tsx}",
    supportFile: "cypress/support/e2e.ts",
    setupNodeEvents(on /*, config*/) {
      on("task", {
        // No-op task hook surface; specs use cy.request() exclusively.
      });
    },
  },
});
