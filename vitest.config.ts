import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    // ---------------------------------------------------------------------------
    // Global settings
    // ---------------------------------------------------------------------------
    root: path.resolve(__dirname),
    globals: true,

    // Timeouts — integration tests can be slow
    testTimeout: 120_000,
    hookTimeout: 120_000,

    // Reporter — verbose in CI, default locally
    reporters: process.env.CI ? ["verbose", "junit"] : ["verbose"],
    outputFile: process.env.CI ? { junit: "test-results.xml" } : undefined,

    // ---------------------------------------------------------------------------
    // Test file discovery
    //
    // Only files matching *-unit.test.ts, *-integration.test.ts, or
    // *-e2e.test.ts are picked up. This excludes legacy suite files
    // (ontology.test.ts, cleanup.test.ts, etc.) which export run()
    // functions but don't contain Vitest describe/it blocks.
    // ---------------------------------------------------------------------------
    include: [
      "tests/**/*-unit.test.ts",
      "tests/**/*-integration.test.ts",
      "tests/**/*-e2e.test.ts",
    ],
    exclude: ["node_modules", "dist"],

    // ---------------------------------------------------------------------------
    // Workspace-like separation via projects
    // ---------------------------------------------------------------------------
    // Tests are organized by day (monday, tuesday) and type (unit, integration).
    // Vitest discovers all .test.ts files and groups them by directory.

    // Ensure sequential execution for integration tests that share state
    sequence: {
      concurrent: false,
    },

    // Environment
    env: {
      PGHOST: "localhost",
      PGDATABASE: "tellus_db",
      PGUSER: "tellus",
      PGPASSWORD: "tellus123",
      // F-09: Disable rate limiter during tests to prevent cross-run
      // 429 failures when vitest restarts within the same 60s window.
      RATE_LIMIT_MAX: "999999",
    },

    // Coverage configuration — scoped to modules exercised by unit tests.
    //
    // Integration-only modules (Temporal workers, Iceberg/Lakekeeper clients,
    // Flink/Parquet runtime, DuckDB pool, deploymentService, OTel bootstrap,
    // structured logger, pipeline routes) are intentionally excluded from the
    // `unit` coverage flag. They're exercised by integration/e2e suites and
    // should be reported under a separate flag (e.g. `integration`) once the
    // integration CI job is wired for coverage upload.
    coverage: {
      provider: "v8",
      include: [
        // Monday
        "src/utils/typeSystem.ts",
        "src/utils/apiNameValidator.ts",
        "src/utils/responseFormatter.ts",
        "src/utils/structValidator.ts",
        "src/utils/columnMappingValidator.ts",
        "src/services/fileScannerService.ts",
        "src/utils/schemaDiff.ts",
        // Tuesday
        "src/services/mapping/typeMapper.ts",
        "src/services/opensearch/mappingDiff.ts",
        "src/services/opensearch/refreshUtil.ts",
        "src/services/indexing/csvReader.ts",
        "src/services/indexing/typeConverter.ts",
        "src/services/indexing/rowTransformer.ts",
        "src/services/indexing/batchDocumentBuilder.ts",
        "src/services/indexing/primaryKeyValidator.ts",
        "src/services/indexing/indexingOrchestrator.ts",
        "src/models/funnelState.ts",
        "src/services/indexing/datasourceValidator.ts",
        "src/services/indexing/dataSampler.ts",
        "src/services/indexing/errorCollector.ts",
        "src/services/indexing/progressTracker.ts",
        "src/services/indexing/verifier.ts",
        "src/services/opensearch/objectCounter.ts",
        "src/services/indexing/editMerger.ts",
        "src/services/indexing/propertyChangeHandler.ts",
        "src/services/indexing/autoCreateHook.ts",
        "src/routes/health.ts",
        "src/routes/healthCheck.ts",
        // Wednesday
        "src/services/propertyResolver.ts",
        "src/services/queryValidator.ts",
        "src/services/queryTranslator.ts",
        "src/services/paginationService.ts",
        "src/services/objectResponseFormatter.ts",
        "src/utils/queryErrors.ts",
        "src/utils/typeCoercion.ts",
        // Thursday
        "src/models/linkType.ts",
        "src/services/linkResolverService.ts",
        // Friday
        "src/indexer.ts",
        // Saturday
        "src/services/uploadService.ts",
        "src/services/datasetDatasourceService.ts",
        "src/services/autoIndexService.ts",
        "src/services/mappingSuggestionService.ts",
        "src/utils/fileReader.ts",
        "src/utils/typeConverter.ts",
        "src/utils/generateApiDocs.ts",
        // Sunday
        "src/services/interfaceValidator.ts",
        "src/services/interfaceQueryService.ts",
        "src/services/propertyMetadataService.ts",
        "src/middleware/requestValidator.ts",
        "src/middleware/inputSanitizer.ts",
        "src/routes/systemHealth.ts",
        "src/middleware/notFoundHandler.ts",
        "src/utils/gracefulShutdown.ts",
        "src/services/opensearch/resilience.ts",
        "src/utils/pgResilience.ts",
        "src/services/markingUnion.ts",
        "src/services/traceContext.ts",
        "src/services/throughputGuard.ts",
        "src/utils/apiReferenceGenerator.ts",
      ],
      exclude: [
        "**/*.d.ts",
        "src/utils/gracefulShutdown.ts", // runs in subprocess due to async signal handlers
      ],
      reporter: ["text", "text-summary", "lcov", "json"],
      reportsDirectory: "coverage",
    },
  },
});
