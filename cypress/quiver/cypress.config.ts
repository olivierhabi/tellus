// Cypress config for the Quiver e2e suite.
//
// The full Cypress binary is not in package.json devDependencies (D-14):
// the verification harness (`scripts/quiver-verify.sh`) skips this step
// unless `CYPRESS_BIN` is exported. The specs in `cypress/quiver/e2e/*.cy.ts`
// are written and ready to run when the binary is installed (typically in CI).
//
// `baseUrl` resolves from QUIVER_API_URL or http://127.0.0.1:7311.
import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    baseUrl:
      process.env.QUIVER_API_URL ?? "http://127.0.0.1:7311",
    specPattern: "cypress/quiver/e2e/**/*.cy.ts",
    supportFile: false,
    fixturesFolder: "cypress/quiver/fixtures",
    screenshotsFolder: "cypress/quiver/screenshots",
    videosFolder: "cypress/quiver/videos",
    video: false,
    defaultCommandTimeout: 10_000,
  },
});
