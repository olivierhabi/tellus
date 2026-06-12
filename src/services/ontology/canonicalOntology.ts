// ---------------------------------------------------------------------------
// canonicalOntology.ts — "One Enterprise, One Ontology"
// ---------------------------------------------------------------------------
// Palantir Foundry models the enterprise as a SINGLE ontology. This module is
// the one and only source of truth for that ontology's identity. Every place
// that historically tried to "pick the default ontology" (there were three,
// and they disagreed with each other — see git history / the migration plan)
// now delegates here so the answer is deterministic and consistent.
//
// The canonical UUID is fixed and environment-independent. It intentionally
// matches the value the frontend has always used as its fallback
// (`ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001`) so the
// two sides agree without any client-side data migration.
//
// The identity can be overridden via env for white-label / multi-deployment
// installs, but a deployment still has exactly ONE ontology.
// ---------------------------------------------------------------------------

import { query } from "../../db";

/** Permanent UUID of the single enterprise ontology. */
export const ENTERPRISE_ONTOLOGY_UUID: string =
  (process.env.ENTERPRISE_ONTOLOGY_UUID || "").trim() ||
  "00000000-0000-0000-0000-000000000001";

/** Human-facing name of the single enterprise ontology. */
export const ENTERPRISE_ONTOLOGY_DISPLAY_NAME: string =
  (process.env.ENTERPRISE_ONTOLOGY_DISPLAY_NAME || "").trim() ||
  "Enterprise Ontology";

/** Foundry-style resource identifier for the single enterprise ontology. */
export const ENTERPRISE_ONTOLOGY_RID: string = `ri.ontology.main.ontology.${ENTERPRISE_ONTOLOGY_UUID}`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolved-once cache. The canonical row is created by the consolidation
// migration and protected by a DB singleton guard, so once we confirm it
// exists the answer never changes for the lifetime of the process.
let resolvedId: string | null = null;

/** True when `id` is the canonical ontology UUID (case-insensitive). */
export function isCanonicalOntologyId(id: string | null | undefined): boolean {
  return (
    typeof id === "string" &&
    id.trim().toLowerCase() === ENTERPRISE_ONTOLOGY_UUID.toLowerCase()
  );
}

/**
 * Collapse ANY caller-supplied ontology identifier — a UUID, a symbolic alias
 * (`default` / `main` / `primary`), a full RID, or anything else — onto the one
 * enterprise ontology UUID. In a single-ontology world the input is advisory:
 * there is only one ontology to address.
 */
export function coerceToCanonicalOntologyId(_input?: string | null): string {
  return ENTERPRISE_ONTOLOGY_UUID;
}

/** Build the canonical RID for the single ontology. */
export function enterpriseOntologyRid(): string {
  return ENTERPRISE_ONTOLOGY_RID;
}

// Matches an ontology-scoped request path and captures (prefix, idSegment,
// rest). The negative lookahead excludes `/api/v1/ontology/import` — a
// lifecycle sub-route, not an ontology id. The bare `/api/v1/ontology`
// (list/create, no id) does not match.
const ONTOLOGY_SEG_RE =
  /^(\/api\/v1\/ontology)\/(?!import(?:\/|\?|$))([^/?]+)([/?].*)?$/;

/**
 * "One Enterprise, One Ontology" edge collapse. Given a request URL and the
 * canonical id, return the URL rewritten so its ontology-id segment is the
 * canonical id — or `null` when no rewrite is needed (not an ontology-scoped
 * path, the `import` sub-route, or the segment is already canonical).
 *
 * Pure + synchronous so it is unit-testable in isolation from Express.
 */
export function collapseOntologyUrl(
  url: string,
  canonicalId: string
): string | null {
  const m = url.match(ONTOLOGY_SEG_RE);
  if (!m) return null;
  if (isCanonicalOntologyId(m[2])) return null;
  return `${m[1]}/${canonicalId}${m[3] ?? ""}`;
}

/**
 * Resolve the single enterprise ontology UUID.
 *
 * Fast path: returns the fixed constant once we have confirmed the canonical
 * row exists. Transition path (canonical row not yet created by the
 * consolidation migration): falls back to the single existing ontology so the
 * app keeps serving during a rolling deploy. Both paths return the SAME value
 * post-migration, which is the whole point — no more divergent "default"s.
 */
export async function getOntologyId(): Promise<string | null> {
  if (resolvedId) return resolvedId;

  try {
    const canonical = await query(
      "SELECT ontology_id FROM ontology WHERE ontology_id = $1",
      [ENTERPRISE_ONTOLOGY_UUID]
    );
    if (canonical.rows.length > 0) {
      resolvedId = ENTERPRISE_ONTOLOGY_UUID;
      return resolvedId;
    }

    // Pre-migration fallback: deterministic single-ontology selection. Prefer a
    // row already named like the enterprise ontology, else the most-populated,
    // else the oldest. Not cached — so once the migration lands we switch to
    // the canonical id on the next call.
    const fallback = await query(
      `SELECT o.ontology_id
         FROM ontology o
        ORDER BY
          (o.display_name = $1) DESC,
          (SELECT COUNT(*) FROM object_type ot WHERE ot.ontology_id = o.ontology_id) DESC,
          o.created_at ASC
        LIMIT 1`,
      [ENTERPRISE_ONTOLOGY_DISPLAY_NAME]
    );
    return fallback.rows[0]?.ontology_id ?? null;
  } catch {
    // DB unreachable — let the caller surface its own error.
    return null;
  }
}

/**
 * Ensure the single enterprise ontology row (and its `main` branch) exists,
 * returning its UUID. Safe to call repeatedly — the DB singleton guard caps the
 * table at one row, and this upsert targets the canonical UUID specifically.
 * Used by seeds/bootstrap so they populate THE ontology instead of creating new
 * ones.
 */
export async function ensureEnterpriseOntology(): Promise<string> {
  await query(
    `INSERT INTO ontology (ontology_id, display_name, description, created_by)
     VALUES ($1, $2, $3, 'system')
     ON CONFLICT (ontology_id) DO NOTHING`,
    [
      ENTERPRISE_ONTOLOGY_UUID,
      ENTERPRISE_ONTOLOGY_DISPLAY_NAME,
      "The single enterprise ontology (One Enterprise, One Ontology).",
    ]
  );
  // Lazily import to avoid a load-order cycle (branchContext → db only).
  const { ensureMainBranchId } = await import("../branchContext");
  await ensureMainBranchId(ENTERPRISE_ONTOLOGY_UUID);
  resolvedId = ENTERPRISE_ONTOLOGY_UUID;
  return ENTERPRISE_ONTOLOGY_UUID;
}

/** Test/maintenance hook to drop the resolved-once cache. */
export function __resetCanonicalCache(): void {
  resolvedId = null;
}

export default {
  ENTERPRISE_ONTOLOGY_UUID,
  ENTERPRISE_ONTOLOGY_DISPLAY_NAME,
  ENTERPRISE_ONTOLOGY_RID,
  isCanonicalOntologyId,
  coerceToCanonicalOntologyId,
  enterpriseOntologyRid,
  getOntologyId,
};
