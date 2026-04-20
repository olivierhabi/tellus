// ---------------------------------------------------------------------------
// LT-B2 — link_resolver_config model
//
// Per-ontology knobs for resolver PK caps and cardinality-estimate
// escalation. Defaults match the pre-LT-B2 hard-coded 100k caps so
// existing clients see no behavior change.
// ---------------------------------------------------------------------------

import { query } from "../db";

export type EscalationBackend = "none" | "clickhouse" | "furnace";

export interface ResolverConfigRow {
  ontology_id: string;
  max_intermediate_pks: number;
  max_search_around_source: number;
  max_multihop_intermediate: number;
  escalation_backend: EscalationBackend;
  escalation_threshold_pks: number;
  global_hard_cap: number;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_RESOLVER_CONFIG: Omit<ResolverConfigRow, "ontology_id" | "created_at" | "updated_at"> = {
  max_intermediate_pks: 100_000,
  max_search_around_source: 100_000,
  max_multihop_intermediate: 100_000,
  escalation_backend: "clickhouse",
  escalation_threshold_pks: 100_000,
  global_hard_cap: 1_000_000,
};

export async function getResolverConfig(ontologyId: string): Promise<ResolverConfigRow> {
  const result = await query(
    "SELECT * FROM link_resolver_config WHERE ontology_id = $1",
    [ontologyId]
  );
  if (result.rows.length > 0) {
    return result.rows[0] as ResolverConfigRow;
  }
  return {
    ontology_id: ontologyId,
    ...DEFAULT_RESOLVER_CONFIG,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export interface UpdateResolverConfigInput {
  maxIntermediatePks?: number;
  maxSearchAroundSource?: number;
  maxMultihopIntermediate?: number;
  escalationBackend?: EscalationBackend;
  escalationThresholdPks?: number;
  globalHardCap?: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export async function upsertResolverConfig(
  ontologyId: string,
  input: UpdateResolverConfigInput
): Promise<ResolverConfigRow> {
  const current = await getResolverConfig(ontologyId);

  const next = {
    max_intermediate_pks: clamp(
      input.maxIntermediatePks ?? current.max_intermediate_pks,
      1,
      1_000_000
    ),
    max_search_around_source: clamp(
      input.maxSearchAroundSource ?? current.max_search_around_source,
      1,
      1_000_000
    ),
    max_multihop_intermediate: clamp(
      input.maxMultihopIntermediate ?? current.max_multihop_intermediate,
      1,
      1_000_000
    ),
    escalation_backend: input.escalationBackend ?? current.escalation_backend,
    escalation_threshold_pks: clamp(
      input.escalationThresholdPks ?? current.escalation_threshold_pks,
      100,
      1_000_000
    ),
    global_hard_cap: clamp(
      input.globalHardCap ?? current.global_hard_cap,
      1_000,
      1_000_000
    ),
  };

  const result = await query(
    `INSERT INTO link_resolver_config
       (ontology_id, max_intermediate_pks, max_search_around_source,
        max_multihop_intermediate, escalation_backend, escalation_threshold_pks,
        global_hard_cap)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (ontology_id) DO UPDATE SET
       max_intermediate_pks     = EXCLUDED.max_intermediate_pks,
       max_search_around_source = EXCLUDED.max_search_around_source,
       max_multihop_intermediate = EXCLUDED.max_multihop_intermediate,
       escalation_backend       = EXCLUDED.escalation_backend,
       escalation_threshold_pks = EXCLUDED.escalation_threshold_pks,
       global_hard_cap          = EXCLUDED.global_hard_cap,
       updated_at = now()
     RETURNING *`,
    [
      ontologyId,
      next.max_intermediate_pks,
      next.max_search_around_source,
      next.max_multihop_intermediate,
      next.escalation_backend,
      next.escalation_threshold_pks,
      next.global_hard_cap,
    ]
  );
  return result.rows[0] as ResolverConfigRow;
}

/**
 * Resolve the effective cap for a request, applying:
 *   1. tenant config (per-ontology row).
 *   2. optional client override (`?maxResultPks`), clamped to the tenant max.
 *   3. the global 1M hard cap.
 */
export function effectiveMaxPks(
  tenantCap: number,
  override?: number,
  hardCap = 1_000_000
): { effective: number; clamped: boolean } {
  const target = override ?? tenantCap;
  const clamped = Math.max(1, Math.min(target, tenantCap, hardCap));
  return { effective: clamped, clamped: clamped !== target };
}
