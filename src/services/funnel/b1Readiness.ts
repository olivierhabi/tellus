// ---------------------------------------------------------------------------
// B1/B7 readiness probe — Task B1 + production perf
//
// Savepoints around every edit's INSERT add 2 extra PG round-trips per
// edit for the transitional deployment case (B1 tables not migrated
// yet). That's measurable latency under bulk-action workloads. Instead
// we probe the required B1 tables ONCE at server boot, cache the
// verdict for the process lifetime, and expose `isB1Ready()` to the
// writeback hot path.
//
// The cache is re-checked after `RECHECK_INTERVAL_MS` so running the
// migrations post-boot automatically activates the B1 writeback without
// a server restart.
// ---------------------------------------------------------------------------

import { query } from "../../db";

const REQUIRED_TABLES = ["object_edits", "object_instances"] as const;
const RECHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let cachedReady: boolean | null = null;
let cachedAt = 0;
let inFlight: Promise<boolean> | null = null;

/** Returns true when both `object_edits` and `object_instances` exist
 *  in the public schema; false otherwise. Memoised for 5 minutes. */
export async function isB1Ready(): Promise<boolean> {
  const now = Date.now();
  if (cachedReady !== null && now - cachedAt < RECHECK_INTERVAL_MS) {
    return cachedReady;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await query(
        `SELECT tablename FROM pg_catalog.pg_tables
          WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
        [REQUIRED_TABLES]
      );
      const present = new Set(
        res.rows.map((r: { tablename: string }) => r.tablename)
      );
      const ready = REQUIRED_TABLES.every((t) => present.has(t));
      cachedReady = ready;
      cachedAt = Date.now();
      return ready;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Force a re-probe on the next call. Useful for tests. */
export function __resetB1ReadinessForTesting(): void {
  cachedReady = null;
  cachedAt = 0;
  inFlight = null;
}
