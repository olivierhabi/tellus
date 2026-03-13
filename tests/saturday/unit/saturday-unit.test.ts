// ---------------------------------------------------------------------------
// Saturday Unit Tests — Tasks 2, 6, 9-12, 14, 25, 27
//
// Runs all inline self-tests for Saturday's utility and service modules via
// the self-test bridge. Each module is a separate Vitest test case with
// proper timing, failure isolation, and reporting.
// ---------------------------------------------------------------------------

import { describe } from "vitest";
import { runModuleSelfTests } from "../../helpers/selfTestBridge";

describe("Saturday Unit Tests", () => {
  runModuleSelfTests([
    { name: "Upload Service",                file: "src/services/uploadService.ts",              task: "Task 2"  },
    { name: "Dataset Datasource Service",    file: "src/services/datasetDatasourceService.ts",   task: "Task 6"  },
    { name: "Auto-Index Service",            file: "src/services/autoIndexService.ts",           task: "Task 9"  },
    { name: "Mapping Suggestion Service",    file: "src/services/mappingSuggestionService.ts",   task: "Task 10" },
    { name: "File Reader Utility",           file: "src/utils/fileReader.ts",                    task: "Task 11" },
    { name: "Type Converter Utility",        file: "src/utils/typeConverter.ts",                 task: "Task 12" },
    { name: "Health Check Endpoint",         file: "src/routes/healthCheck.ts",                  task: "Task 25" },
    { name: "API Doc Generator",             file: "src/utils/generateApiDocs.ts",               task: "Task 26" },
    { name: "Test Data Generator",           file: "tests/utils/testDataGenerator.ts",           task: "Task 27" },
  ]);
});
