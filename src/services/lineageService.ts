// ---------------------------------------------------------------------------
// lineageService.ts — ontology DAG lineage for governance page (Task 30)
// ---------------------------------------------------------------------------
// Spec: "Lineage DAG: computed from FK relationships in metadata. Max
// depth = 5. Nodes: object types, action types, function types. Edges:
// actions that modify type, functions that read type, links between
// types."
// ---------------------------------------------------------------------------

import { query } from "../db";

export interface LineageNode {
  id: string;
  label: string;
  kind: "objectType" | "actionType" | "function" | "linkType";
}

export interface LineageEdge {
  from: string;
  to: string;
  kind: "link" | "action_modifies" | "function_reads";
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  truncated: boolean;
}

export const MAX_LINEAGE_DEPTH = 5;

export async function computeLineage(
  ontologyId: string,
  rootApiName: string,
  depth: number = MAX_LINEAGE_DEPTH
): Promise<LineageGraph> {
  const effectiveDepth = Math.min(depth, MAX_LINEAGE_DEPTH);
  const visited = new Set<string>();
  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];
  const queue: Array<{ apiName: string; depth: number }> = [
    { apiName: rootApiName, depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = `ot:${current.apiName}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const row = await query(
      "SELECT object_type_id, display_name FROM object_type WHERE ontology_id = $1 AND api_name = $2",
      [ontologyId, current.apiName]
    );
    if (row.rowCount === 0) continue;
    nodes.push({
      id: key,
      label: row.rows[0].display_name,
      kind: "objectType",
    });

    if (current.depth >= effectiveDepth) continue;

    // Follow link types outward from this object type.
    const links = await query(
      `SELECT api_name, display_name, source_object_type, target_object_type
         FROM link_type
        WHERE ontology_id = $1
          AND (source_object_type = $2 OR target_object_type = $2)`,
      [ontologyId, row.rows[0].object_type_id]
    );
    for (const lt of links.rows) {
      const linkKey = `lt:${lt.api_name}`;
      if (!visited.has(linkKey)) {
        nodes.push({ id: linkKey, label: lt.display_name, kind: "linkType" });
        visited.add(linkKey);
      }
      edges.push({ from: key, to: linkKey, kind: "link" });

      const otherId =
        lt.source_object_type === row.rows[0].object_type_id
          ? lt.target_object_type
          : lt.source_object_type;
      const other = await query(
        "SELECT api_name FROM object_type WHERE object_type_id = $1",
        [otherId]
      );
      if (other.rowCount === 0) continue;
      const otherKey = `ot:${other.rows[0].api_name}`;
      if (!visited.has(otherKey)) {
        queue.push({ apiName: other.rows[0].api_name, depth: current.depth + 1 });
      }
      edges.push({ from: linkKey, to: otherKey, kind: "link" });
    }

    // Action types whose rules touch this object type. Action rules are
    // stored as a JSONB array of {operation, objectTypeApiName, …} entries
    // — we look for any rule that references the current api_name.
    try {
      const actions = await query(
        `SELECT api_name, display_name
           FROM action_type
          WHERE ontology_id = $1
            AND rules::text LIKE $2`,
        [ontologyId, `%"${current.apiName}"%`]
      );
      for (const a of actions.rows) {
        const actionKey = `at:${a.api_name}`;
        if (!visited.has(actionKey)) {
          nodes.push({ id: actionKey, label: a.display_name, kind: "actionType" });
          visited.add(actionKey);
        }
        edges.push({ from: actionKey, to: key, kind: "action_modifies" });
      }
    } catch {
      // action_type table may not exist on a partial install — skip.
    }

    // Functions that read from this object type. We approximate the
    // dependency by matching the api_name in the function source code,
    // which is good enough for governance dashboards without a full
    // static analyser.
    try {
      const functions = await query(
        `SELECT f.api_name, f.display_name
           FROM ontology_function f
           JOIN ontology_function_version v ON v.function_id = f.function_id AND v.is_latest = true
          WHERE f.ontology_id = $1
            AND v.source_code LIKE $2`,
        [ontologyId, `%${current.apiName}%`]
      );
      for (const fn of functions.rows) {
        const fnKey = `fn:${fn.api_name}`;
        if (!visited.has(fnKey)) {
          nodes.push({ id: fnKey, label: fn.display_name, kind: "function" });
          visited.add(fnKey);
        }
        edges.push({ from: fnKey, to: key, kind: "function_reads" });
      }
    } catch {
      // ontology_function tables not yet migrated — skip.
    }
  }

  return { nodes, edges, truncated: queue.length > 0 };
}
