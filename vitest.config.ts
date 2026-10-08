import { defineConfig } from "vitest/config";
import path from "path";
// Single source of truth for the ISOLATED integration-lane identity
// (FUNN-ISO-1). globalSetup pins the same values into its own process via
// the module's import side effect; workers need them here (fresh process).
import { LANE } from "./tests/laneEnv";

// Test credentials are never baked into the repo. PGPASSWORD must come from
// the environment (CI secret or a local export — see .env.test.example) and
// the config fails fast when it is missing instead of falling back to an
// inline literal.
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Export it before running this suite (see .env.test.example).`,
    );
  }
  return value;
}

export default defineConfig({
  test: {
    // ---------------------------------------------------------------------------
    // Global settings
    // ---------------------------------------------------------------------------
    root: path.resolve(__dirname),
    globals: true,

    // F-05 FIX: globalSetup spawns the server process with RATE_LIMIT_MAX
    // propagated so integration tests (which hit http://localhost:3000) do
    // not get 429'd by the server's default limit of 200 req/min.
    globalSetup: "tests/globalSetup.ts",

    // F-01 FIX (Phase A2): setupFiles runs BEFORE every test file in the
    // worker and obtains a Keycloak JWT for the `alice` archetype, installing
    // it on the shared api() helper so all integration tests are
    // authenticated by default. Tests that want unauth or a different
    // archetype opt in explicitly via setAuthToken(...) / getToken("bob").
    setupFiles: ["tests/setupFiles.ts"],

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
      // QA connectivity suite is named with a dotted suffix per request.
      "tests/connectivity/integration/qa-additional.integration.test.ts",
    ],
    exclude: ["node_modules", "dist"],

    // ---------------------------------------------------------------------------
    // Workspace-like separation via projects
    // ---------------------------------------------------------------------------
    // Tests are organized by day (monday, tuesday) and type (unit, integration).
    // Vitest discovers all .test.ts files and groups them by directory.

    // Ensure sequential execution for integration tests that share state.
    // `concurrent: false` serializes tests within a single file. To also
    // serialize across files, we disable file parallelism below. This is
    // necessary because the whole integration suite talks to a single
    // spawned server process (see tests/globalSetup.ts), and shared
    // in-process state (rate-limiter windows keyed on `batch:anonymous`,
    // overlay cache, action type registry) would otherwise race. Phase A2
    // (F-01 JWTs) will let each suite run with its own user and re-enable
    // parallelism for throughput.
    sequence: {
      concurrent: false,
    },
    fileParallelism: false,

    // Environment — ISOLATED integration lane (FUNN-ISO-1).
    // NOTE: PGDATABASE is deliberately NOT tellus_db anymore. The whole lane
    // (DB, environment seal, Temporal ns/queue, Keycloak realm, OpenSearch
    // index prefix, MinIO bucket, API stamp) targets the dedicated
    // tellus_tests environment; the destructive-test guard refuses to let
    // any destructive helper under this config reach shared dev resources.
    env: {
      ...LANE,
      PGHOST: "localhost",
      PGUSER: "tellus",
      PGPASSWORD: requiredEnv("PGPASSWORD"),
      // F-09: Disable rate limiter during tests to prevent cross-run
      // 429 failures when vitest restarts within the same 60s window.
      RATE_LIMIT_MAX: "999999",
      // Match the elevated batch limit from globalSetup so rate-limiter
      // tests can read it and calibrate request counts accordingly.
      // Kept in sync with tests/globalSetup.ts:BATCH_RATE_LIMIT_MAX.
      BATCH_RATE_LIMIT_MAX: "500",
      // Code Repositories test-mode principal opt-in (G-C-11). Tests under
      // tests/integration/code-repos/** drive Express routes by setting an
      // X-Tellus-Test-Principal header; requireCodeReposAuth() ignores it
      // unless this env var equals "1". Mirrors vitest.codeRepos.config.ts:46.
      // Production code paths NEVER consult this header — the env var is the
      // single gate, and it is only set in test configs.
      CODE_REPOS_TEST_AUTH: "1",
      // Shared harness token for the test-principal bypass (X-Tellus-Test-
      // Auth-Token). VITEST-LANE-ONLY public constant: the in-process lane
      // server is never network-reachable, so a fixed lane value is safe
      // here. A real deployment MUST set a private token in its gitignored
      // env — NEVER this literal (the flag only enables test mode; the token
      // is what authenticates the caller).
      CODE_REPOS_TEST_AUTH_TOKEN:
        "vitest-lane-9f2c6b4e8a1d3f5c7b9e0d2a4c6f8e1b3d5a7c9e1f3b5d7a9c1e3f5b7d9a1c3",
      // OpenSearch Basic auth — the shared dev cluster runs the security
      // plugin enabled; lanes connect with the committed demo creds (the
      // deployment's private override, if any, wins via process.env).
      // CI runs a plain-http OpenSearch service and exports OPENSEARCH_URL;
      // honor it instead of forcing https (ERR_SSL_PACKET_LENGTH_TOO_LONG).
      OPENSEARCH_URL: process.env.OPENSEARCH_URL ?? "https://localhost:9200",
      OPENSEARCH_USERNAME: "admin",
      OPENSEARCH_PASSWORD:
        process.env.OPENSEARCH_PASSWORD ?? "Str0ng!P@ssw0rd-Tellus-9a7b3Cz",
      // Publish-author trust gate: exercised by dedicated tests; other lanes
      // opt out explicitly (never honored in production).
      FUNCTION_EXECUTION_TRUST_MODE: "open-development",
      // Same ceiling the osv2 lane raised in e9f7ec4: the spawned lane
      // server's boot-time indexing storm can hold OpenSearch writes past
      // the 5 s default, flaking tests that seed OS docs directly.
      OPENSEARCH_REQUEST_TIMEOUT: "10000",
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
        // ---------------------------------------------------------------
        // PHASE A EXIT GATE — Critical-path modules (branch coverage ≥ 80%)
        // Per remediation brief Phase A Exit Gate: editApplicator,
        // actionExecutor, queryExecutor, branchMergeService,
        // linkViolationEnforcer, all route handlers must be measured.
        // ---------------------------------------------------------------
        "src/actions/editApplicator.ts",
        "src/actions/actionExecutor.ts",
        "src/actions/actionValidator.ts",
        "src/actions/idempotency.ts",
        "src/actions/objectChecker.ts",
        "src/actions/parameterValidator.ts",
        "src/actions/propertyValidator.ts",
        "src/actions/ruleCompiler.ts",
        "src/services/queryExecutor.ts",
        "src/services/branchMergeService.ts",
        "src/services/linkViolationEnforcer.ts",
        "src/services/linkResolverService.ts",
        "src/services/auditEventService.ts",
        "src/services/security/documentSecurity.ts",
        "src/services/opensearch/client.ts",
        "src/middleware/globalAuth.ts",
        "src/middleware/keycloakAuth.ts",
        "src/middleware/securityContext.ts",
        "src/middleware/patSecurityGate.ts",
        "src/middleware/rateLimiter.ts",
        "src/middleware/errorHandler.ts",
        "src/routes/objects.ts",
        "src/routes/actions.ts",
        "src/routes/links.ts",
        "src/routes/search.ts",
        "src/routes/ontology.ts",
        "src/routes/audit.ts",
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
      // Enforcement floor for the integration lane. The unit lane
      // (vitest.unit.config.ts: lines 37 / branches 30, raise-only ratchet)
      // is the authoritative gate; this floor sits deliberately lower as a
      // tripwire so the default `vitest run --coverage` lane cannot regress
      // to zero unnoticed. Raise-only — never lower these numbers.
      thresholds: {
        lines: 25,
        branches: 20,
        functions: 0,
        statements: 0,
      },
    },
  },
});
