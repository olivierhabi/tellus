// ---------------------------------------------------------------------------
// ontology.ts — single-ontology test helper
// ---------------------------------------------------------------------------
// "One Enterprise, One Ontology": ontologies can no longer be created at
// runtime (POST /api/v1/ontology → 409 ONTOLOGY_SINGLETON). Integration tests
// that previously created a throwaway ontology for setup now resolve the single
// canonical enterprise ontology instead. This helper centralises that so the
// suites don't each hard-code the id.
// ---------------------------------------------------------------------------

import { api } from "./api";

/** Fixed identity of the single enterprise ontology (mirrors the backend). */
export const ENTERPRISE_ONTOLOGY_UUID = "00000000-0000-0000-0000-000000000001";
export const ENTERPRISE_ONTOLOGY_RID =
  `ri.ontology.main.ontology.${ENTERPRISE_ONTOLOGY_UUID}`;

/**
 * Resolve the canonical enterprise ontology id for test setup. Hits the
 * `default` alias (the backend collapses it to the singleton). Falls back to
 * the fixed UUID if the response shape is unexpected.
 */
export async function ensureCanonicalOntologyId(): Promise<string> {
  const res = await api("GET", "/api/v1/ontology/default");
  return (
    res.body?.data?.ontologyId ??
    res.body?.ontologyId ??
    ENTERPRISE_ONTOLOGY_UUID
  );
}
