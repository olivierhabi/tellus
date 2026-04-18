// ---------------------------------------------------------------------------
// Shadow-query diff collection — Task B9
//
// During REPLACEMENT_SOAK, every production query runs against both the
// LIVE (active_version) and pending (pending_version) Quickwit indices.
// The two result sets are diffed, and the row-level diff count is appended
// to `replacement_diff_log`. The Soak monitor computes the rolling
// diff-rate from this log.
//
// Diff metric:
//   diff_rate = sum(diff_count) / sum(total_hits)
//
// Palantir's gate is <0.1%. A deliberately-induced diff (mutating a
// property in only one of the two indices) must be detectable within the
// soak window — this is straightforward because diffs never get cleaned
// up unless a cutover or rollback ensues.
// ---------------------------------------------------------------------------

import { createHash } from "crypto";
import { query } from "../../../db";

export interface DiffObservation {
  objectTypeApiName: string;
  oldVersion: number;
  newVersion: number;
  queryBody: Record<string, unknown>;
  oldHits: Array<{ __pk?: unknown } & Record<string, unknown>>;
  newHits: Array<{ __pk?: unknown } & Record<string, unknown>>;
}

export interface DiffSummary {
  diffCount: number;
  totalHits: number;
}

export function diffResultSets(obs: DiffObservation): DiffSummary {
  const oldMap = new Map<string, Record<string, unknown>>();
  for (const hit of obs.oldHits) {
    const pk = asString(hit.__pk);
    if (pk !== null) oldMap.set(pk, hit);
  }
  let diff = 0;
  const total = Math.max(obs.oldHits.length, obs.newHits.length);
  const seenNewPks = new Set<string>();

  for (const hit of obs.newHits) {
    const pk = asString(hit.__pk);
    if (pk === null) continue;
    seenNewPks.add(pk);
    const prev = oldMap.get(pk);
    if (!prev || !shallowEqualExceptSystem(prev, hit)) diff++;
  }
  // Rows only in the old index are also diffs.
  for (const pk of oldMap.keys()) if (!seenNewPks.has(pk)) diff++;
  return { diffCount: diff, totalHits: total };
}

function asString(v: unknown): string | null {
  return typeof v === "string"
    ? v
    : typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : null;
}

function shallowEqualExceptSystem(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const skip = new Set(["__pk", "__version", "__deleted", "__overlay_source"]);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (skip.has(k)) continue;
    const av = a[k];
    const bv = b[k];
    if (av !== bv) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Persist a diff observation. Graceful when the B9 table is missing.
// ---------------------------------------------------------------------------

export async function logDiffObservation(obs: DiffObservation): Promise<void> {
  const { diffCount, totalHits } = diffResultSets(obs);
  const queryHash = hashQuery(obs.queryBody);
  try {
    await query(
      `INSERT INTO replacement_diff_log
         (object_type_api_name, old_version, new_version, query_hash,
          query_body, diff_count, total_hits)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        obs.objectTypeApiName,
        obs.oldVersion,
        obs.newVersion,
        queryHash,
        JSON.stringify(obs.queryBody),
        diffCount,
        totalHits,
      ]
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/relation .*replacement_diff_log.* does not exist/i.test(msg)) throw err;
  }
}

function hashQuery(body: Record<string, unknown>): string {
  return createHash("sha1").update(JSON.stringify(body)).digest("hex");
}
