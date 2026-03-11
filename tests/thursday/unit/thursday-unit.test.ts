// ---------------------------------------------------------------------------
// Thursday Unit Tests
//
// Uses the selfTestBridge to execute inline self-tests for Thursday modules.
// ---------------------------------------------------------------------------

import { describe } from "vitest";
import { runModuleSelfTest } from "../../helpers/selfTestBridge";

describe("Thursday Unit Tests", () => {
  runModuleSelfTest("Link Type Model", "src/models/linkType.ts", "Tasks 1-6");
  runModuleSelfTest("Link Resolver Service", "src/services/linkResolverService.ts", "Tasks 7-24");
});
