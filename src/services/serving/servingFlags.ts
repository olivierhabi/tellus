// ---------------------------------------------------------------------------
// Serving-store rollout flags (migration 155 serving_rollout).
//
// Resolution is most-specific-first: capability → link_type → object_type →
// branch → ontology → tenant → global. Table rows override env; env
// overrides code default ('legacy'). Rows are cached briefly so reads
// never stall on a stale cache; failures default to 'legacy'
// (rollback-safe).
// ---------------------------------------------------------------------------

import { query } from "../../db";

export type ServingMode = "legacy" | "shadow" | "indexed";

export interface RolloutSubject {
  tenantId?: string;
  ontologyId?: string;
  branchId?: string;
  objectTypeApiName?: string;
  linkTypeApiName?: string;
  capability?: string; // e.g. "links.searchAround" | "objects.search"
}

const CACHE_TTL_MS = 15_000;
let cache: { at: number; rows: Array<{ scope_kind: string; scope_key: string; mode: ServingMode }> } | null =
  null;

async function loadRows(): Promise<Array<{ scope_kind: string; scope_key: string; mode: ServingMode }>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  try {
    const res = await query(
      `SELECT scope_kind, scope_key, mode FROM serving_rollout`,
    );
    cache = { at: Date.now(), rows: res.rows };
    return res.rows;
  } catch {
    // Table absent (migrations pending) or PG hiccup: stay legacy.
    return cache?.rows ?? [];
  }
}

/** Reset the flag cache — tests only. */
export function __resetServingRolloutCache(): void {
  cache = null;
}

/**
 * Resolve the serving mode for one request subject. Specific scope beats
 * general scope; within the same kind, an exact key match is required.
 */
export async function resolveServingMode(subject: RolloutSubject): Promise<ServingMode> {
  const rows = await loadRows();
  const order: Array<[string, string | undefined]> = [
    ["capability", subject.capability],
    ["link_type", subject.linkTypeApiName],
    ["object_type", subject.objectTypeApiName],
    ["branch", subject.branchId],
    ["ontology", subject.ontologyId],
    ["tenant", subject.tenantId],
    ["global", "*"],
  ];
  for (const [kind, key] of order) {
    if (!key) continue;
    const hit = rows.find((r) => r.scope_kind === kind && r.scope_key === key);
    if (hit) return hit.mode;
  }
  return envServingMode();
}

function envServingMode(): ServingMode {
  const v = (process.env.SERVING_STORE_MODE ?? "legacy").toLowerCase();
  return v === "indexed" || v === "shadow" ? (v as ServingMode) : "legacy";
}
