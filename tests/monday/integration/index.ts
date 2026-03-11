// ---------------------------------------------------------------------------
// Integration Test Orchestrator
//
// Discovers and runs all integration test modules in the correct order.
// Each module exports a `run(runner, ctx)` function that receives the
// shared Runner and TestContext.
//
// To add a new integration test suite:
//   1. Create a new file: tests/monday/integration/<domain>.test.ts
//   2. Export: async function run(t: Runner, ctx: TestContext): Promise<void>
//   3. Add it to the `suites` array below in the correct order
//
// Run: npm run test:monday
//      npm run test:monday:integration
//      npx tsx tests/monday/integration/index.ts
// ---------------------------------------------------------------------------

import { Runner } from "../../helpers/runner";
import { api, BASE_URL } from "../../helpers/api";
import { ensureServer, stopServer } from "../../helpers/server";
import { createContext } from "./context";

// --- Suite registry (order matters — tests share state via ctx) -----------

import * as ontology from "./ontology.test";
import * as objectType from "./objectType.test";
import * as property from "./property.test";
import * as datasource from "./datasource.test";
import * as statistics from "./statistics.test";
import * as lifecycle from "./lifecycle.test";
import * as exportImport from "./exportImport.test";
import * as validation from "./validation.test";
import * as cleanup from "./cleanup.test";

interface Suite {
  name: string;
  run: (t: Runner, ctx: any) => Promise<void>;
}

const suites: Suite[] = [
  { name: "Ontology CRUD",          run: ontology.run },
  { name: "Object Type CRUD",       run: objectType.run },
  { name: "Property CRUD",          run: property.run },
  { name: "Datasource & Scanning",  run: datasource.run },
  { name: "Statistics",             run: statistics.run },
  { name: "Lifecycle Operations",   run: lifecycle.run },
  { name: "Export/Import",          run: exportImport.run },
  { name: "Validation & Guards",    run: validation.run },
  { name: "Cleanup & Cascades",     run: cleanup.run },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nRunning integration tests against ${BASE_URL}\n`);

  const runner = new Runner();
  const ctx = createContext();

  await ensureServer();

  for (const suite of suites) {
    await suite.run(runner, ctx);
  }

  runner.summary("Integration");

  // Post-suite cleanup
  await cleanup.cleanupLeftovers();

  stopServer();
  process.exit(runner.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  stopServer();
  process.exit(1);
});
