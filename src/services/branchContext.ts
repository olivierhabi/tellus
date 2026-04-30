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

import { v5 as uuidv5 } from "uuid";
import { query } from "../db";

// UUID v5 DNS namespace, matching the literal in
// `src/migrations/040_branch_id_on_edits.sql` — if either value changes,
// both must change in lockstep or backfilled rows and freshly-resolved
// rows will diverge.
const DNS_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Compute the deterministic `main` branch UUID for a given ontology.
 * Kept in Node (rather than calling `uuid_generate_v5` in PG) so the
 * code path does not depend on the `uuid-ossp` extension being in the
 * connection's search_path — migration 040 installs it, but standalone
 * deployments and some managed databases put it in a non-default
 * schema.
 *
 * The output is byte-identical to Postgres'
 * `uuid_generate_v5(dns_ns, ontology_id || ':main')` that the migration
 * 040 backfill used.
 */
export function deriveMainBranchId(ontologyId: string): string {
  return uuidv5(`${ontologyId}:main`, DNS_NS);
}

// In-memory cache: ontologyId → mainBranchId. Branch rows never change
// their UUID once created, so this is safe to cache for process lifetime.
// Cleared by `clearBranchContextCache()` for tests.
const mainBranchCache = new Map<string, string>();

/**
 * Resolve the UUID of the ontology's `main` branch. Looks up
 * `ontology_branch(ontology_id, name='main')`. Returns null when the
 * ontology has no `main` branch yet.
 *
 * Note: this is a pure read. Callers that want the lazy-create
 * backstop should go through `resolveBranchIdOrMain` instead.
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
 * Ensure the ontology has a `main` branch, creating it if missing.
 * Uses the same deterministic UUID recipe as migration 040
 * (uuid_generate_v5 of DNS namespace + `<ontology_id>:main`) so the
 * generated UUID is byte-identical to what the backfill would have
 * produced. The INSERT is guarded by ON CONFLICT DO NOTHING so
 * concurrent callers converge on the same row.
 *
 * Returns the branch_id. Throws only if the ontology itself doesn't
 * exist (FK violation) or the database is unreachable.
 */
export async function ensureMainBranchId(
  ontologyId: string,
): Promise<string> {
  const existing = await resolveMainBranchId(ontologyId);
  if (existing) return existing;

  // Lazy create. Uses the deterministic UUID recipe from migration
  // 040.1 (now computed in Node — see deriveMainBranchId) and the
  // status value that satisfies the `ontology_branch_status_check`
  // constraint from the table's creating migration
  // (OPEN | MERGED | CLOSED). Migration 040's SQL backfill uses
  // 'active' which would actually violate the check; it only happens
  // to succeed in CI because fresh DBs have no ontologies at migration
  // time so the backfill INSERT inserts 0 rows. 'OPEN' is the correct
  // in-constraint equivalent for a live branch.
  // Only the columns that exist in ALL historical schemas of
  // ontology_branch — `fork_point_edit_id` is added by migration 035
  // via ALTER TABLE, and `parent_branch_id` is nullable by default.
  // Keeping the column list minimal lets this INSERT succeed regardless
  // of whether later migrations have finished populating the table.
  const branchId = deriveMainBranchId(ontologyId);
  const insert = await query(
    `INSERT INTO ontology_branch
       (branch_id, ontology_id, name, status, created_by)
     VALUES ($1::uuid, $2::uuid, 'main', 'OPEN', 'ontologyService.create')
     ON CONFLICT DO NOTHING
     RETURNING branch_id`,
    [branchId, ontologyId],
  );

  if (insert.rows.length > 0) {
    const id = String(insert.rows[0].branch_id);
    mainBranchCache.set(ontologyId, id);
    return id;
  }

  // Concurrent caller won the race — re-read.
  const afterRace = await resolveMainBranchId(ontologyId);
  if (afterRace) return afterRace;

  throw new Error(
    `Failed to ensure 'main' branch for ontology '${ontologyId}' — ` +
      `INSERT returned no row and follow-up SELECT found none.`,
  );
}

/**
 * Resolve branchId, falling back to the ontology's `main` branch.
 * If `main` is missing (ontology was created without going through
 * the migration 040 backfill, e.g. via direct seed INSERT), it is
 * lazily created with the deterministic UUID so this call always
 * succeeds for a valid ontology.
 *
 * This is the ONLY module permitted to perform this fallback. All
 * downstream code must accept branchId as a required parameter.
 */
export async function resolveBranchIdOrMain(
  ontologyId: string,
  branchId: string | null | undefined,
): Promise<string> {
  if (branchId) return branchId;
  return ensureMainBranchId(ontologyId);
}

/** Test-only — reset the ontology → main-branch cache. */
export function clearBranchContextCache(): void {
  mainBranchCache.clear();
}
