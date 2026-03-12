// ---------------------------------------------------------------------------
// Wednesday Unit Tests — Tasks 1-30 (Day 3 modules)
//
// Runs all inline self-tests for Wednesday's modules via the self-test bridge.
// ---------------------------------------------------------------------------

import { describe } from "vitest";
import { runModuleSelfTests } from "../../helpers/selfTestBridge";

describe("Wednesday Unit Tests", () => {
  runModuleSelfTests([
    { name: "Property Resolver",         file: "src/services/propertyResolver.ts",           task: "Task 1"  },
    { name: "Query Validator",           file: "src/services/queryValidator.ts",              task: "Task 2"  },
    { name: "Query Translator",          file: "src/services/queryTranslator.ts",             task: "Tasks 3-5" },
    { name: "Pagination Service",        file: "src/services/paginationService.ts",           task: "Task 6"  },
    { name: "Object Response Formatter", file: "src/services/objectResponseFormatter.ts",     task: "Task 7"  },
    { name: "Query Error Classes",       file: "src/utils/queryErrors.ts",                    task: "Task 15" },
    { name: "Type Coercion",            file: "src/utils/typeCoercion.ts",                    task: "Task 20" },
  ]);
});
