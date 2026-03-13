// ---------------------------------------------------------------------------
// Sunday Unit Tests — Tasks 7, 10, 14, 17-23
//
// Runs all inline self-tests for Sunday's utility and service modules via
// the self-test bridge. Each module is a separate Vitest test case with
// proper timing, failure isolation, and reporting.
// ---------------------------------------------------------------------------

import { describe } from "vitest";
import { runModuleSelfTests } from "../../helpers/selfTestBridge";

describe("Sunday Unit Tests", () => {
  runModuleSelfTests([
    { name: "Interface Validator",          file: "src/services/interfaceValidator.ts",           task: "Task 7"  },
    { name: "Interface Query Service",      file: "src/services/interfaceQueryService.ts",        task: "Task 10" },
    { name: "Property Metadata Service",    file: "src/services/propertyMetadataService.ts",      task: "Task 14" },
    { name: "Request Validator Middleware",  file: "src/middleware/requestValidator.ts",            task: "Task 17" },
    { name: "Input Sanitizer Middleware",    file: "src/middleware/inputSanitizer.ts",              task: "Task 18" },
    { name: "System Health Routes",         file: "src/routes/systemHealth.ts",                    task: "Task 19" },
    { name: "Not Found Handler",            file: "src/middleware/notFoundHandler.ts",              task: "Task 20" },
    { name: "Graceful Shutdown",            file: "src/utils/gracefulShutdown.ts",                  task: "Task 21" },
    { name: "OpenSearch Resilience",        file: "src/services/opensearch/resilience.ts",          task: "Task 22" },
    { name: "PostgreSQL Resilience",        file: "src/utils/pgResilience.ts",                      task: "Task 23" },
    { name: "API Reference Generator",     file: "src/utils/apiReferenceGenerator.ts",             task: "Task 25" },
  ]);
});
