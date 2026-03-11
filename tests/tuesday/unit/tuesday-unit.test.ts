// ---------------------------------------------------------------------------
// Tuesday Unit Tests — Tasks 1-30 (Day 2 modules)
//
// Runs all inline self-tests for Tuesday's modules via the self-test bridge.
// Each module is a separate Vitest test case with proper timing, failure
// isolation, and reporting.
//
// 21 modules, ~1654 assertions total.
// ---------------------------------------------------------------------------

import { describe } from "vitest";
import { runModuleSelfTests } from "../../helpers/selfTestBridge";

describe("Tuesday Unit Tests", () => {
  runModuleSelfTests([
    { name: "Type Mapper",               file: "src/services/mapping/typeMapper.ts",                task: "Task 1"  },
    { name: "Mapping Diff",              file: "src/services/opensearch/mappingDiff.ts",            task: "Task 3"  },
    { name: "Refresh Utility",           file: "src/services/opensearch/refreshUtil.ts",            task: "Task 5"  },
    { name: "CSV Reader",               file: "src/services/indexing/csvReader.ts",                 task: "Task 7"  },
    { name: "Type Converter",           file: "src/services/indexing/typeConverter.ts",              task: "Task 8"  },
    { name: "Row Transformer",          file: "src/services/indexing/rowTransformer.ts",             task: "Task 9"  },
    { name: "Batch Document Builder",   file: "src/services/indexing/batchDocumentBuilder.ts",       task: "Task 10" },
    { name: "Primary Key Validator",    file: "src/services/indexing/primaryKeyValidator.ts",        task: "Task 11" },
    { name: "Indexing Orchestrator",    file: "src/services/indexing/indexingOrchestrator.ts",       task: "Task 12" },
    { name: "Funnel Pipeline State",    file: "src/models/funnelState.ts",                          task: "Task 13" },
    { name: "Datasource Validator",     file: "src/services/indexing/datasourceValidator.ts",        task: "Task 14" },
    { name: "Data Sampler",             file: "src/services/indexing/dataSampler.ts",                task: "Task 15" },
    { name: "Error Collector",          file: "src/services/indexing/errorCollector.ts",             task: "Task 17" },
    { name: "Progress Tracker",         file: "src/services/indexing/progressTracker.ts",            task: "Task 18" },
    { name: "Verifier",                 file: "src/services/indexing/verifier.ts",                   task: "Task 19" },
    { name: "Object Counter",           file: "src/services/opensearch/objectCounter.ts",            task: "Task 20" },
    { name: "Edit Merger",              file: "src/services/indexing/editMerger.ts",                 task: "Task 21" },
    { name: "Property Change Handler",  file: "src/services/indexing/propertyChangeHandler.ts",      task: "Task 25" },
    { name: "Auto-Create Hook",         file: "src/services/indexing/autoCreateHook.ts",             task: "Task 26" },
    { name: "Test Data Generator",      file: "src/tests/helpers/testDataGenerator.ts",              task: "Task 29" },
    { name: "Health Check Endpoint",    file: "src/routes/health.ts",                                task: "Task 30" },
  ]);
});
