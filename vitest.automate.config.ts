import { defineConfig } from "vitest/config";
import path from "path";

// Automate domain tests are hermetic and intentionally avoid the repository's
// integration global setup (database reseed, Keycloak and API server).
export default defineConfig({
  test: {
    root: path.resolve(__dirname),
    globals: true,
    include: ["tests/unit/automate/**/*-unit.test.ts"],
    testTimeout: 30_000,
  },
});
