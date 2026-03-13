// ---------------------------------------------------------------------------
// Sunday Integration Test Context — shared state passed between suites
// ---------------------------------------------------------------------------

export interface SundayTestContext {
  ontologyId: string;
  interfaceId: string;
  interfaceApiName: string;
  objectType1ApiName: string;
  objectType2ApiName: string;
}

export function createContext(): SundayTestContext {
  return {
    ontologyId: "",
    interfaceId: "",
    interfaceApiName: "",
    objectType1ApiName: "",
    objectType2ApiName: "",
  };
}
