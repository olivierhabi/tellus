// ---------------------------------------------------------------------------
// F-P3-12 — branch-id resolution helper.
//
// Every `link_edit` write must carry a non-null `branch_id` (migration 040
// promoted the column to NOT NULL + FK). The write-path writer
// (`src/actions/editApplicator.ts`) requires `branchId: string` on
// its `ApplyExecutionContext` interface so compile-time detection catches
// any caller that forgets to thread the branch through.
//
// The single runtime-fallback site is the executor boundary: when the
// HTTP request does not carry a branch (classic untagged write), the
// executor resolves the ontology's synthetic `main` branch and passes
// that UUID forward. Migration 040 guarantees every ontology has an
// `main` branch row, and the UUID is derived deterministically via
// `uuid_generate_v5` so the backfill path and the runtime resolution
// agree byte-for-byte.
//
// This helper is kept in its own module so the resolution rule is one
// place and not inlined into many call sites.
// ---------------------------------------------------------------------------

import { query } from "../db";

// UUID v5 DNS namespace, matching the literal in
// `src/migrations/040_branch_id_on_edits.sql` — if either value changes,
// both must change in lockstep or backfilled rows and freshly-resolved
// rows will diverge.
const DNS_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

// In-memory cache: ontologyId → mainBranchId. Branch rows never change
// their UUID once created, so this is safe to cache for process lifetime.
// Cleared by `clearBranchContextCache()` for tests.
const mainBranchCache = new Map<string, string>();

/**
 * Resolve the UUID of the ontology's `main` branch. Looks up
 * `ontology_branch(ontology_id, name='main')`. Returns null when the
 * ontology has no `main` branch yet — callers must treat null as a
 * hard error and refuse the write (the migration 040 backfill inserts
 * `main` for every ontology, so null can only happen if migration 040
 * hasn't run, which is itself a wiring bug).
 */
export async function resolveMainBranchId(
  ontologyId: string,
): Promise<string | null> {
  const cached = mainBranchCache.get(ontologyId);
  if (cached) return cached;

  try {
    const res = await query(
      `SELECT branch_id FROM ontology_branch
        WHERE ontology_id = $1 AND name = 'main'
        LIMIT 1`,
      [ontologyId],
    );
    if (res.rows.length > 0) {
      const id = String(res.rows[0].branch_id);
      mainBranchCache.set(ontologyId, id);
      return id;
    }
  } catch {
    // Table missing → transitional deployment; fall through to null.
  }
  return null;
}

/**
 * Resolve branchId, falling back to the ontology's `main` branch.
 * Throws if neither an explicit branchId nor a resolvable `main` is
 * available — this is the single runtime backstop and it fails loud.
 *
 * This is the ONLY module permitted to perform this fallback. All
 * downstream code must accept branchId as a required parameter.
 */
export async function resolveBranchIdOrMain(
  ontologyId: string,
  branchId: string | null | undefined,
): Promise<string> {
  if (branchId) return branchId;
  const main = await resolveMainBranchId(ontologyId);
  if (!main) {
    throw new Error(
      `No branch_id provided and no 'main' branch exists for ontology '${ontologyId}'. ` +
        `Run migration 040 or pass x-branch-id explicitly.`,
    );
  }
  return main;
}

/** Test-only — reset the ontology → main-branch cache. */
export function clearBranchContextCache(): void {
  mainBranchCache.clear();
}
