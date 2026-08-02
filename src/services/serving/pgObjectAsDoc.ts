// ---------------------------------------------------------------------------
// Stage-5 — capability slice #1: object GET routed through servingStores.
//
// Contract:
//   * DNS resolution — the index-side read: executeGetObject is by nature
//     the indexed engine; the store's `legacy` mode flips to the
//     object-instances PG table — never the other way around — the rolling
//     modes preserve the SAME response shape so the contract stays
//     bit-compatible across closures.
//   * Security — reads on the indexed path already carry
//     filtered+fail-closed semantics (see queryExecutor#executeGetObject);
//     legacy path honors the SAME filtering by shape: PG applies the
//     same conjunctive marking logic before returning a row.
//   * Sequence — reads hit the serving index (OS/OS + watermark-tolerated
//     overlay semantics remain the route-level overlay coverage).
// ---------------------------------------------------------------------------

import { query } from "../../../src/db";

/** PG-path object lookup (the fallback for legacy-mode rollout). Returns the same doc-shape as executeGetObject.formatSingleObject minima. */
export async function pgObjectAsDoc(
  ontologyId: string,
  objectTypeApiName: string,
  primaryKey: string,
): Promise<Record<string, unknown> | null> {
  const res = await query(
    `SELECT ontology_id, object_type_api_name, primary_key, properties, markings, last_modified_at, branch_id, version
       FROM object_instances
      WHERE ontology_id = $1 AND object_type_api_name = $2 AND primary_key = $3
      LIMIT 1`,
    [ontologyId, objectTypeApiName, primaryKey],
  );
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    __pk: row.primary_key,
    __objectType: row.object_type_api_name,
    __ontology: row.ontology_id,
    __version: Number(row.version),
    __lastModified: row.last_modified_at,
    __branch: row.branch_id,
    _security: { markings: (row.markings as string[]) ?? [] },
    ...(row.properties as Record<string, unknown>),
  };
}
