// ---------------------------------------------------------------------------
// interfaceInheritance.ts — cycle detection for interface parent DAG
// ---------------------------------------------------------------------------
// Ontology Platform spec §Task 8:
//   "Cycle detection in interface inheritance DAG (recursive CTE with cycle
//    check). Property type compatibility validation on implementation
//    mapping. Polymorphic query performance: max 20 implementing types
//    per query."
//
// We use a recursive CTE on the interface table: walk parent links upward
// from a candidate parent and fail if we ever hit `candidateId` (which
// would mean setting `candidateId.parent = parentId` closes a cycle).
// ---------------------------------------------------------------------------

import { query } from "../db";
import { OntologyError } from "../utils/queryErrors";

/**
 * Throws INTERFACE_CYCLE_DETECTED if assigning `parentId` as the parent of
 * `childId` would produce a cycle in the interface inheritance DAG.
 *
 * - `childId` and `parentId` equal → immediate cycle.
 * - If `parentId` already has `childId` in its ancestor chain → cycle.
 * - `parentId` null is always allowed (clearing the parent).
 */
export async function assertNoInheritanceCycle(
  childId: string,
  parentId: string | null
): Promise<void> {
  if (parentId === null || parentId === undefined) return;
  if (childId === parentId) {
    throw new OntologyError(
      "An interface cannot inherit from itself.",
      "INTERFACE_CYCLE_DETECTED",
      400,
      { childId, parentId }
    );
  }

  // Walk parentId's ancestors and see if childId appears in the chain.
  const result = await query(
    `
    WITH RECURSIVE ancestors AS (
      SELECT interface_id, parent_interface_id, 1 AS depth
        FROM interface
       WHERE interface_id = $1
      UNION ALL
      SELECT i.interface_id, i.parent_interface_id, a.depth + 1
        FROM interface i
        JOIN ancestors a ON i.interface_id = a.parent_interface_id
       WHERE a.depth < 100  -- cheap safety net against pre-existing cycles
    )
    SELECT interface_id FROM ancestors WHERE interface_id = $2 LIMIT 1
    `,
    [parentId, childId]
  );

  if (result.rows.length > 0) {
    throw new OntologyError(
      "Interface inheritance would create a cycle.",
      "INTERFACE_CYCLE_DETECTED",
      400,
      { childId, parentId }
    );
  }
}

/**
 * Return all ancestors of an interface (parent, grandparent, ...) in order
 * closest-first. Used for property-mapping validation across the chain.
 */
export async function listAncestors(interfaceId: string): Promise<string[]> {
  const result = await query(
    `
    WITH RECURSIVE ancestors AS (
      SELECT interface_id, parent_interface_id, 1 AS depth
        FROM interface
       WHERE interface_id = $1
      UNION ALL
      SELECT i.interface_id, i.parent_interface_id, a.depth + 1
        FROM interface i
        JOIN ancestors a ON i.interface_id = a.parent_interface_id
       WHERE a.depth < 100
    )
    SELECT interface_id FROM ancestors WHERE interface_id <> $1 ORDER BY depth
    `,
    [interfaceId]
  );
  return result.rows.map((r: { interface_id: string }) => r.interface_id);
}
