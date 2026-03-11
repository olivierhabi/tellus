// ---------------------------------------------------------------------------
// Monday Unit Tests — Tasks 7-9, 22-24, 27
//
// Runs all inline self-tests for Monday's utility modules via the
// self-test bridge. Each module is a separate Vitest test case with
// proper timing, failure isolation, and reporting.
// ---------------------------------------------------------------------------

import { describe } from "vitest";
import { runModuleSelfTests } from "../../helpers/selfTestBridge";

describe("Monday Unit Tests", () => {
  runModuleSelfTests([
    { name: "Type System (23 base types)",  file: "src/utils/typeSystem.ts",              task: "Task 7"  },
    { name: "API Name Validator",           file: "src/utils/apiNameValidator.ts",         task: "Task 8"  },
    { name: "Response Formatter",           file: "src/utils/responseFormatter.ts",        task: "Task 9"  },
    { name: "Struct Validator",             file: "src/utils/structValidator.ts",           task: "Task 22" },
    { name: "Column Mapping Validator",     file: "src/utils/columnMappingValidator.ts",    task: "Task 23" },
    { name: "File Scanner Service",         file: "src/services/fileScannerService.ts",    task: "Task 24" },
    { name: "Schema Diff",                  file: "src/utils/schemaDiff.ts",               task: "Task 27" },
  ]);
});
