// ---------------------------------------------------------------------------
// Shadow-diff query hook — wires B9 shadow diffing into the query path.
//
// Called from `src/routes/objects.ts` after every successful search. If
// the object type is currently in REPLACEMENT_SOAK, we (lazily) run the
// same query against the candidate Quickwit index and persist the diff
// in `replacement_diff_log`. Done out-of-band — the caller does not
// block on the shadow result.
//
// Best-effort: an unreachable Quickwit, unknown index, or malformed
// query is logged and ignored. The cutover gate computed from the
// diff log returns "insufficient samples" when the log is empty.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { logDiffObservation } from "../quickwit/replacement/shadowDiff";
import { getQuickwitClient } from "../quickwit/client";

interface SoakState {
  active_version: number;
  pending_version: number;
  state: string;
  checked_at: number;
}

const stateCache = new Map<string, SoakState>();
const STATE_TTL_MS = 5_000;

async function getSoakState(objectType: string): Promise<SoakState | null> {
  const hit = stateCache.get(objectType);
  if (hit && Date.now() - hit.checked_at < STATE_TTL_MS) {
    return hit.state === "REPLACEMENT_SOAK" ? hit : null;
  }
  try {
    const res = await query(
      `SELECT active_version, pending_version, state
         FROM object_type_active_index_version
        WHERE object_type_api_name = $1`,
      [objectType]
    );
    const row = res.rows[0];
    if (!row || row.state !== "REPLACEMENT_SOAK" || row.pending_version == null) {
      const stub: SoakState = {
        active_version: 0,
        pending_version: 0,
        state: row?.state ?? "LIVE",
        checked_at: Date.now(),
      };
      stateCache.set(objectType, stub);
      return null;
    }
    const state: SoakState = {
      active_version: row.active_version,
      pending_version: row.pending_version,
      state: row.state,
      checked_at: Date.now(),
    };
    stateCache.set(objectType, state);
    return state;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget: if the object type is in SOAK, shadow-execute the
 * query against the pending version and diff the results. Never throws;
 * logs and returns on any error path.
 */
export function recordShadowDiff(
  objectType: string,
  queryBody: Record<string, unknown>,
  liveHits: Array<Record<string, unknown>>
): void {
  void (async () => {
    try {
      const soak = await getSoakState(objectType);
      if (!soak) return;
      const candidateIndex = `ot_${objectType.toLowerCase()}__v${soak.pending_version}`;
      const candidateHits = await runShadowQuery(candidateIndex, queryBody);
      if (candidateHits === null) return;
      await logDiffObservation({
        objectTypeApiName: objectType,
        oldVersion: soak.active_version,
        newVersion: soak.pending_version,
        queryBody,
        oldHits: liveHits,
        newHits: candidateHits,
      });
    } catch (err) {
      // Swallow — shadow diff is observability, not correctness.
      const msg = err instanceof Error ? err.message : String(err);
      if (process.env.FUNNEL_SHADOW_DIFF_DEBUG === "true") {
        console.warn(`[shadow-diff] ${objectType}: ${msg}`);
      }
    }
  })();
}

async function runShadowQuery(
  indexId: string,
  body: Record<string, unknown>
): Promise<Array<Record<string, unknown>> | null> {
  try {
    const client = getQuickwitClient();
    const qString = toQuickwitQuery(body);
    const result = await client.search(indexId, { query: qString, max_hits: 100 });
    return result.hits;
  } catch {
    return null;
  }
}

// Projection of our validated search body onto Quickwit's `query` string.
// Handles the full compare/range/in/and/or/not grammar that the Object
// Explorer emits so the shadow diff stays representative across schema
// changes — the spec explicitly states the soak monitor must detect
// "a deliberately-induced diff" within the soak period, so anything
// narrower than `*` is worth evaluating.
export function toQuickwitQuery(body: Record<string, unknown>): string {
  const where = body.where as Record<string, unknown> | undefined;
  if (!where) {
    const q = body.query;
    return typeof q === "string" && q.length > 0 ? q : "*";
  }
  const compiled = compileWhere(where);
  return compiled.length > 0 ? compiled : "*";
}

function compileWhere(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as Record<string, unknown>;
  const type = String(n.type ?? "").toLowerCase();
  switch (type) {
    case "eq":
      return fieldValue(n.field, n.value, ":");
    case "neq":
      return `NOT ${fieldValue(n.field, n.value, ":")}`;
    case "in": {
      const values = Array.isArray(n.values) ? n.values : [];
      if (values.length === 0 || !n.field) return "";
      const parts = values.map((v) => fieldValue(n.field, v, ":"));
      return `(${parts.join(" OR ")})`;
    }
    case "notin": {
      const values = Array.isArray(n.values) ? n.values : [];
      if (values.length === 0 || !n.field) return "";
      const parts = values.map((v) => fieldValue(n.field, v, ":"));
      return `NOT (${parts.join(" OR ")})`;
    }
    case "gt":
      return fieldRange(n.field, n.value, "{", "*", "]");
    case "gte":
      return fieldRange(n.field, n.value, "[", "*", "]");
    case "lt":
      return fieldRange(n.field, "*", "[", n.value, "}");
    case "lte":
      return fieldRange(n.field, "*", "[", n.value, "]");
    case "between":
      return fieldRange(n.field, n.from, "[", n.to, "]");
    case "prefix":
      if (n.field && n.value != null) {
        return `${String(n.field)}:${String(n.value)}*`;
      }
      return "";
    case "contains":
    case "match":
      if (n.field && n.value != null) {
        return `${String(n.field)}:${String(n.value)}`;
      }
      return "";
    case "exists":
      return n.field ? `${String(n.field)}:*` : "";
    case "and":
    case "or": {
      const clauses = Array.isArray(n.clauses) ? n.clauses : [];
      const compiled = clauses
        .map(compileWhere)
        .filter((s): s is string => typeof s === "string" && s.length > 0);
      if (compiled.length === 0) return "";
      const join = type === "and" ? " AND " : " OR ";
      return compiled.length === 1 ? compiled[0] : `(${compiled.join(join)})`;
    }
    case "not": {
      const inner = compileWhere(n.clause);
      return inner ? `NOT (${inner})` : "";
    }
    default:
      return "";
  }
}

function fieldValue(field: unknown, value: unknown, sep: string): string {
  if (field == null || value == null) return "";
  const f = String(field);
  if (typeof value === "number" || typeof value === "boolean") {
    return `${f}${sep}${String(value)}`;
  }
  return `${f}${sep}"${String(value).replace(/"/g, '\\"')}"`;
}

function fieldRange(
  field: unknown,
  from: unknown,
  fromBracket: string,
  to: unknown,
  toBracket: string
): string {
  if (field == null || (from == null && to == null)) return "";
  const f = String(field);
  const lo = from == null ? "*" : formatRangeBound(from);
  const hi = to == null ? "*" : formatRangeBound(to);
  return `${f}:${fromBracket}${lo} TO ${hi}${toBracket}`;
}

function formatRangeBound(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === "*") return "*";
  return `"${String(v).replace(/"/g, '\\"')}"`;
}
