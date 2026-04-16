// ---------------------------------------------------------------------------
// linkCycleDetection.ts — prevent infinite traversals in the link graph
// ---------------------------------------------------------------------------
// Ontology Platform spec §Task 7:
//   "Cycle detection in link graph (prevent infinite traversals)."
//
// Links form a directed graph over object types. Adding a new link from
// A → B would create a cycle if B has a path back to A via any chain of
// existing links. We enforce this with a recursive CTE walking forward
// from B until it either (a) visits A (cycle) or (b) runs out of
// successors (safe).
//
// Note: a cycle in the link graph is not always incorrect — many real
// ontologies have self-referential or circular object structures. We
// therefore enforce it only for traversal-bounded link types (those used
// in Search Around, where an infinite loop would wreck a query).
// ---------------------------------------------------------------------------

import { query } from "../db";
import { OntologyError } from "../utils/queryErrors";

/**
 * Throws LINK_CYCLE_DETECTED if adding a link from
 * `sourceObjectTypeId → targetObjectTypeId` would close a cycle in the
 * existing link graph.
 */
export async function assertNoLinkCycle(
  ontologyId: string,
  sourceObjectTypeId: string,
  targetObjectTypeId: string
): Promise<void> {
  if (sourceObjectTypeId === targetObjectTypeId) {
    // Self-links are allowed (e.g., "reports to" on Employee) — skip.
    return;
  }
  const result = await query(
    `
    WITH RECURSIVE walk AS (
      SELECT target_object_type AS node, 1 AS depth
        FROM link_type
       WHERE ontology_id = $1 AND source_object_type = $2
      UNION
      SELECT lt.target_object_type, w.depth + 1
        FROM link_type lt
        JOIN walk w ON lt.source_object_type = w.node
       WHERE lt.ontology_id = $1 AND w.depth < 50
    )
    SELECT 1 FROM walk WHERE node = $3 LIMIT 1
    `,
    [ontologyId, targetObjectTypeId, sourceObjectTypeId]
  );
  if (result.rowCount && result.rowCount > 0) {
    throw new OntologyError(
      "Adding this link would create a cycle in the link graph.",
      "LINK_CYCLE_DETECTED",
      400,
      { sourceObjectTypeId, targetObjectTypeId }
    );
  }
}
