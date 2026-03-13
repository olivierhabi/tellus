// ---------------------------------------------------------------------------
// Friday Unit Tests — Tasks 16-30 (Day 5 modules)
//
// Runs all inline self-tests for Friday's modules via the self-test bridge.
// Each module is a separate Vitest test case with proper timing, failure
// isolation, and reporting.
//
// Note: Most Friday modules (actions/*, routes/*, middleware/*) do NOT have
// inline self-tests. They are exercised via integration and E2E tests.
// Only src/indexer.ts has a self-test block.
//
// 1 module, assertions vary.
// ---------------------------------------------------------------------------

import { describe } from "vitest";
import { runModuleSelfTests } from "../../helpers/selfTestBridge";

describe("Friday Unit Tests", () => {
  runModuleSelfTests([
    { name: "Indexer",  file: "src/indexer.ts",  task: "Task 16" },
  ]);
});
