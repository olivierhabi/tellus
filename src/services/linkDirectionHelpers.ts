// ---------------------------------------------------------------------------
// LT-B6 + LT-B7 — reverse-direction projection & mandatory control
// property filters. Small, side-effect-free helpers so the resolver and
// route layers can share logic.
// ---------------------------------------------------------------------------

import type { LinkTypeRow } from "../models/linkType";

export interface ReverseProjection {
  included?: string[];
  excluded?: string[];
}

function readProjection(lt: LinkTypeRow): ReverseProjection | null {
  const p = lt.reverse_property_projection;
  if (!p) return null;
  if (typeof p === "string") {
    try {
      return JSON.parse(p) as ReverseProjection;
    } catch {
      return null;
    }
  }
  return p as ReverseProjection;
}

/**
 * Filter a single object in-place according to the link type's reverse
 * property_projection. Returns the object (same ref) for chaining.
 *
 * Only applies when direction === 'reverse' AND the link type sets a
 * projection. System fields (`__pk`, `__rid`, `__ts`) are always kept.
 */
export function applyReverseProjection(
  hit: Record<string, unknown>,
  linkType: LinkTypeRow,
  direction: "forward" | "reverse"
): Record<string, unknown> {
  if (direction !== "reverse") return hit;
  const proj = readProjection(linkType);
  if (!proj) return hit;

  const keys = Object.keys(hit);
  const out: Record<string, unknown> = {};

  const isSystem = (k: string) => k.startsWith("__");

  if (proj.included && proj.included.length > 0) {
    const keep = new Set(proj.included);
    for (const k of keys) {
      if (isSystem(k) || keep.has(k)) {
        out[k] = hit[k];
      }
    }
    return out;
  }
  if (proj.excluded && proj.excluded.length > 0) {
    const drop = new Set(proj.excluded);
    for (const k of keys) {
      if (!drop.has(k) || isSystem(k)) {
        out[k] = hit[k];
      }
    }
    return out;
  }
  return hit;
}

export function applyReverseProjectionAll(
  hits: Array<Record<string, unknown>>,
  linkType: LinkTypeRow,
  direction: "forward" | "reverse"
): Array<Record<string, unknown>> {
  if (direction !== "reverse") return hits;
  const proj = readProjection(linkType);
  if (!proj) return hits;
  return hits.map((h) => applyReverseProjection(h, linkType, direction));
}

/**
 * Expose the cardinality as viewed from the reverse direction. Matches
 * Palantir's behavior: ONE_TO_MANY forward ⇔ MANY_TO_ONE reverse.
 */
export function reverseCardinality(c: string): string {
  switch (c) {
    case "ONE_TO_MANY":
      return "MANY_TO_ONE";
    case "MANY_TO_ONE":
      return "ONE_TO_MANY";
    case "ONE_TO_ONE":
      return "ONE_TO_ONE";
    case "MANY_TO_MANY":
      return "MANY_TO_MANY";
    default:
      return c;
  }
}

/**
 * LT-B7 — emit additional ES clauses enforcing Mandatory Control
 * Property markings. When the link type declares an MCP, only edges
 * whose `markings` array overlaps with the caller's markings are
 * returned. With zero caller markings + MCP configured, nothing
 * matches (fail-closed default).
 *
 * `mcp_required_count` is threaded through as `minimum_should_match`.
 */
export function mcpMarkingClauses(
  linkType: LinkTypeRow,
  userMarkings: string[] | undefined
): Array<Record<string, unknown>> {
  if (!linkType.mandatory_control_property_id) return [];
  const markings = userMarkings ?? [];
  const required = Math.max(1, linkType.mcp_required_count ?? 1);
  return [
    {
      terms_set: {
        markings: {
          terms: markings,
          minimum_should_match_script: { source: String(required) },
        },
      },
    },
  ];
}

/**
 * Plain-language marking filter for UI code paths that can't run an ES
 * query directly (Iceberg scan over DuckDB, ClickHouse lookups). The
 * caller should AND this predicate into their SQL WHERE clause.
 */
export function mcpPredicateForRow(
  linkType: LinkTypeRow,
  rowMarkings: string[],
  userMarkings: string[]
): boolean {
  if (!linkType.mandatory_control_property_id) return true;
  const required = Math.max(1, linkType.mcp_required_count ?? 1);
  const intersection = rowMarkings.filter((m) => userMarkings.includes(m));
  return intersection.length >= required;
}

/**
 * LT-B7 — given source & target row markings, compute the effective
 * markings for the edge per `mcp_propagation_mode`. Used at write time
 * when populating the Iceberg `markings` column, and at audit time via
 * the marking-trace endpoint.
 */
export function deriveEdgeMarkings(
  linkType: LinkTypeRow,
  sourceMarkings: string[],
  targetMarkings: string[]
): string[] {
  const mode = linkType.mcp_propagation_mode ?? "union";
  switch (mode) {
    case "source":
      return [...new Set(sourceMarkings)];
    case "target":
      return [...new Set(targetMarkings)];
    case "intersection":
      return [...new Set(sourceMarkings.filter((m) => targetMarkings.includes(m)))];
    case "union":
    default:
      return [...new Set([...sourceMarkings, ...targetMarkings])];
  }
}
