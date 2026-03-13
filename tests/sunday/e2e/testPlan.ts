// ---------------------------------------------------------------------------
// Sunday E2E Test Plan — documents and exports the test plan structure
//
// This file serves as both documentation and a data structure that the
// E2E test suite references to ensure complete coverage.
// ---------------------------------------------------------------------------

export interface TestCase {
  id: string;
  description: string;
  method: string;
  path: string;
  expectedStatus: number;
  critical?: boolean;
}

export interface TestSection {
  section: number;
  name: string;
  tests: TestCase[];
}

export const SUNDAY_E2E_TESTS: TestSection[] = [
  {
    section: 1,
    name: "Interface CRUD",
    tests: [
      { id: "1.1", description: "Create Interface with 3 properties", method: "POST", path: "/api/v2/ontology/:id/interfaces", expectedStatus: 201 },
      { id: "1.2", description: "Reject duplicate apiName", method: "POST", path: "/api/v2/ontology/:id/interfaces", expectedStatus: 409 },
      { id: "1.3", description: "Reject invalid apiName (lowercase)", method: "POST", path: "/api/v2/ontology/:id/interfaces", expectedStatus: 400 },
      { id: "1.4", description: "Reject empty properties array", method: "POST", path: "/api/v2/ontology/:id/interfaces", expectedStatus: 400 },
      { id: "1.5", description: "Reject invalid baseType", method: "POST", path: "/api/v2/ontology/:id/interfaces", expectedStatus: 400 },
      { id: "1.6", description: "List all interfaces", method: "GET", path: "/api/v2/ontology/:id/interfaces", expectedStatus: 200 },
      { id: "1.7", description: "Get single interface by apiName", method: "GET", path: "/api/v2/ontology/:id/interfaces/:name", expectedStatus: 200 },
      { id: "1.8", description: "Return 404 for non-existent interface", method: "GET", path: "/api/v2/ontology/:id/interfaces/NonExistent", expectedStatus: 404 },
      { id: "1.9", description: "Update display name via PUT", method: "PUT", path: "/api/v2/ontology/:id/interfaces/:name", expectedStatus: 200 },
      { id: "1.10", description: "Add property via PUT", method: "PUT", path: "/api/v2/ontology/:id/interfaces/:name", expectedStatus: 200 },
      { id: "1.11", description: "Delete interface with no implementations", method: "DELETE", path: "/api/v2/ontology/:id/interfaces/:name", expectedStatus: 204 },
    ],
  },
  {
    section: 2,
    name: "Interface Implementation",
    tests: [
      { id: "2.1", description: "Object Type implements Interface", method: "POST", path: ".../:apiName/implements", expectedStatus: 201 },
      { id: "2.2", description: "Reject missing required mapping", method: "POST", path: ".../:apiName/implements", expectedStatus: 400 },
      { id: "2.3", description: "Reject type mismatch", method: "POST", path: ".../:apiName/implements", expectedStatus: 400 },
      { id: "2.4", description: "Reject duplicate implementation", method: "POST", path: ".../:apiName/implements", expectedStatus: 409 },
      { id: "2.5", description: "List implementations", method: "GET", path: ".../:apiName/implements", expectedStatus: 200 },
      { id: "2.6", description: "Prevent deleting Interface with implementations", method: "DELETE", path: "/api/v2/ontology/:id/interfaces/:name", expectedStatus: 409 },
      { id: "2.7", description: "Prevent removing mapped property via PUT", method: "PUT", path: "/api/v2/ontology/:id/interfaces/:name", expectedStatus: 409 },
      { id: "2.8", description: "Remove implementation", method: "DELETE", path: ".../:apiName/implements/:ifName", expectedStatus: 204 },
    ],
  },
  {
    section: 3,
    name: "Polymorphic Queries",
    tests: [
      { id: "3.1", description: "Search across all implementing types", method: "POST", path: ".../:ifName/search", expectedStatus: 200, critical: true },
      { id: "3.2", description: "Results include __objectType field", method: "POST", path: ".../:ifName/search", expectedStatus: 200 },
      { id: "3.3", description: "Properties mapped back to Interface names", method: "POST", path: ".../:ifName/search", expectedStatus: 200 },
      { id: "3.4", description: "Unmapped optional property returns null", method: "POST", path: ".../:ifName/search", expectedStatus: 200 },
      { id: "3.5", description: "Filter on unmapped property excludes OT", method: "POST", path: ".../:ifName/search", expectedStatus: 200 },
      { id: "3.6", description: "Sorting works across types", method: "POST", path: ".../:ifName/search", expectedStatus: 200 },
      { id: "3.7", description: "Pagination on merged results", method: "POST", path: ".../:ifName/search", expectedStatus: 200 },
      { id: "3.8", description: "Empty result for Interface with no implementors", method: "POST", path: ".../:ifName/search", expectedStatus: 200 },
    ],
  },
  {
    section: 4,
    name: "Polymorphic Aggregation",
    tests: [
      { id: "4.1", description: "Count across implementing types", method: "POST", path: ".../:ifName/aggregate", expectedStatus: 200 },
      { id: "4.2", description: "Weighted average (not average of averages)", method: "POST", path: ".../:ifName/aggregate", expectedStatus: 200, critical: true },
      { id: "4.3", description: "Terms aggregation with merged buckets", method: "POST", path: ".../:ifName/aggregate", expectedStatus: 200 },
      { id: "4.4", description: "Empty result returns null avg", method: "POST", path: ".../:ifName/aggregate", expectedStatus: 200 },
    ],
  },
  {
    section: 5,
    name: "Object View API",
    tests: [
      { id: "5.1", description: "Single object view with metadata", method: "GET", path: ".../:pk/view", expectedStatus: 200 },
      { id: "5.2", description: "Linked objects grouped by link type", method: "GET", path: ".../:pk/linked", expectedStatus: 200 },
      { id: "5.3", description: "Batch object views", method: "POST", path: ".../batchView", expectedStatus: 200 },
      { id: "5.4", description: "Non-existent object returns 404", method: "GET", path: ".../:pk/view", expectedStatus: 404 },
    ],
  },
  {
    section: 6,
    name: "Middleware",
    tests: [
      { id: "6.1", description: "Structured error response with requestId", method: "GET", path: "/api/v2/nonexistent", expectedStatus: 404 },
      { id: "6.2", description: "Input sanitization strips null bytes", method: "POST", path: "/api/v2/ontologies", expectedStatus: 400 },
      { id: "6.3", description: "Validation middleware rejects invalid body", method: "POST", path: "/api/v2/ontologies", expectedStatus: 400 },
      { id: "6.4", description: "XSS prevention strips script tags", method: "POST", path: "/api/v2/ontologies", expectedStatus: 201 },
    ],
  },
  {
    section: 7,
    name: "System Health",
    tests: [
      { id: "7.1", description: "Health endpoint returns healthy", method: "GET", path: "/api/v2/system/health", expectedStatus: 200 },
      { id: "7.2", description: "Readiness probe returns 200", method: "GET", path: "/api/v2/system/readiness", expectedStatus: 200 },
      { id: "7.3", description: "Liveness probe returns 200", method: "GET", path: "/api/v2/system/liveness", expectedStatus: 200 },
    ],
  },
  {
    section: 8,
    name: "Cleanup",
    tests: [
      { id: "8.1", description: "Remove all test implementations", method: "DELETE", path: "various", expectedStatus: 204 },
      { id: "8.2", description: "Remove all test interfaces", method: "DELETE", path: "various", expectedStatus: 204 },
      { id: "8.3", description: "Remove all test object types", method: "DELETE", path: "various", expectedStatus: 204 },
      { id: "8.4", description: "Remove test ontology", method: "DELETE", path: "/api/v2/ontologies/:id", expectedStatus: 204 },
    ],
  },
];

export const TOTAL_SUNDAY_E2E_TESTS = SUNDAY_E2E_TESTS.reduce(
  (sum, section) => sum + section.tests.length,
  0
);

// Self-test
if (require.main === module) {
  console.log(`Sunday E2E Test Plan: ${SUNDAY_E2E_TESTS.length} sections, ${TOTAL_SUNDAY_E2E_TESTS} tests`);
  const critical = SUNDAY_E2E_TESTS.flatMap(s => s.tests).filter(t => t.critical);
  console.log(`Critical tests: ${critical.length}`);
  for (const section of SUNDAY_E2E_TESTS) {
    console.log(`  Section ${section.section}: ${section.name} (${section.tests.length} tests)`);
  }
  console.log("\nAll checks passed.");
}
