// ---------------------------------------------------------------------------
// Integration Test Context — shared state passed between test suites
//
// Each integration test module receives this context to read/write shared
// state (like ontologyId) that flows across the test lifecycle.
// ---------------------------------------------------------------------------

export interface TestContext {
  ontologyId: string;
  exportData: any;
}

export function createContext(): TestContext {
  return {
    ontologyId: "",
    exportData: null,
  };
}
