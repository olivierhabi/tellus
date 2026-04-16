// ---------------------------------------------------------------------------
// multiDatasourceMerge.ts — per-property conflict resolution
// ---------------------------------------------------------------------------
// Spec §Task 11:
//   "Merge algorithm: left join all sources on PK, iterate per property
//    applying conflict strategy. If user_edits_win and user has edited
//    property via action, the action-log value takes precedence over all
//    datasources. Per-property source priority stored in
//    backing_datasources.conflict_config."
//
// Strategies:
//   - latest_wins    : pick the source with the highest updated_at
//   - source_priority: pick the source with the lowest priority integer
//   - user_edits_win : if a user edit exists in ontology_edit, use that;
//                      otherwise fall back to latest_wins
// ---------------------------------------------------------------------------

export type ConflictStrategy =
  | "latest_wins"
  | "source_priority"
  | "user_edits_win";

export interface DatasourceRow {
  sourceId: string;
  priority: number;
  updatedAt: string; // ISO timestamp
  values: Record<string, unknown>;
}

export interface UserEditRow {
  propertyApiName: string;
  value: unknown;
  updatedAt: string;
}

export interface MergeConfig {
  strategy: ConflictStrategy;
  /** Per-property overrides (e.g. { salary: "source_priority", name: "latest_wins" }) */
  perProperty?: Record<string, ConflictStrategy>;
}

export interface MergeDecision {
  propertyApiName: string;
  value: unknown;
  source: string;
  strategy: ConflictStrategy;
}

/**
 * Merge N datasource rows for a single PK into one record.
 * Returns both the merged values and the per-property decision log (so
 * the Funnel pipeline can persist it for audit).
 */
export function mergeDatasourceRows(
  rows: DatasourceRow[],
  userEdits: UserEditRow[],
  config: MergeConfig
): { merged: Record<string, unknown>; decisions: MergeDecision[] } {
  const merged: Record<string, unknown> = {};
  const decisions: MergeDecision[] = [];

  if (rows.length === 0) return { merged, decisions };

  // Gather all property names seen across all sources
  const props = new Set<string>();
  for (const r of rows) {
    for (const key of Object.keys(r.values)) props.add(key);
  }

  const editIndex = new Map<string, UserEditRow>();
  for (const e of userEdits) editIndex.set(e.propertyApiName, e);

  for (const prop of props) {
    const strategy = config.perProperty?.[prop] ?? config.strategy;

    if (strategy === "user_edits_win") {
      const edit = editIndex.get(prop);
      if (edit) {
        merged[prop] = edit.value;
        decisions.push({
          propertyApiName: prop,
          value: edit.value,
          source: "user_edit",
          strategy,
        });
        continue;
      }
      // Fall through to latest_wins if no user edit present
    }

    const candidates = rows.filter((r) => prop in r.values);
    if (candidates.length === 0) continue;

    let chosen: DatasourceRow;
    if (strategy === "source_priority") {
      chosen = candidates.reduce((a, b) => (a.priority <= b.priority ? a : b));
    } else {
      // latest_wins (also the fallback path for user_edits_win)
      chosen = candidates.reduce((a, b) =>
        new Date(a.updatedAt).getTime() >= new Date(b.updatedAt).getTime()
          ? a
          : b
      );
    }
    merged[prop] = chosen.values[prop];
    decisions.push({
      propertyApiName: prop,
      value: chosen.values[prop],
      source: chosen.sourceId,
      strategy,
    });
  }

  return { merged, decisions };
}
