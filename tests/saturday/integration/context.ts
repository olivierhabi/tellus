// ---------------------------------------------------------------------------
// Saturday Integration Test Context — shared state passed between suites
// ---------------------------------------------------------------------------

export interface SaturdayTestContext {
  ontologyId: string;
  datasetId: string;
  transactionId: string;
  objectTypeApiName: string;
  employeeCsvPath: string;
  companyCsvPath: string;
}

export function createContext(): SaturdayTestContext {
  return {
    ontologyId: "",
    datasetId: "",
    transactionId: "",
    objectTypeApiName: "",
    employeeCsvPath: "",
    companyCsvPath: "",
  };
}
