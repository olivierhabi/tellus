// ---------------------------------------------------------------------------
// Overlay sweeper — Task B7
//
// Background loop that reconciles the overlay cache with Quickwit's indexed
// state. For every edit with `applied_to_index_at > overlay.created_at` (i.e.
// Quickwit has absorbed the edit after the overlay was written), the
// matching `overlay:*` key is deleted. Otherwise the overlay stays, TTL
// eventually evicts it, and the SLO alarm fires if lag exceeds 60s.
//
// The sweeper is a supervisor: it schedules itself on a fixed interval but
// never drops work — failures log and retry next tick. A single process
// running the sweeper is fine (the overlay SCAN is cheap, and each DEL is
// idempotent), but multiple replicas are safe too: DEL on a missing key is
// a no-op.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { OverlayStore, overlayKey } from "./overlayStore";
import { getOverlayStore } from "./getOverlayStore";
import { recordIndexApplied } from "./slis";

export interface SweeperRunResult {
  scannedObjectTypes: number;
  overlayKeysInspected: number;
  overlayKeysDeleted: number;
  editsCorrelated: number;
  durationMs: number;
}

export interface SweeperOptions {
  /** How often to run. Default 10s. */
  intervalMs?: number;
  /** Per-tick cap on keys inspected. Default 10_000. */
  maxKeysPerTick?: number;
  /** Inject a specific store. */
  store?: OverlayStore;
  /** Object types to sweep. If omitted, queries Postgres. */
  objectTypes?: string[];
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function sweepOnce(options: SweeperOptions = {}): Promise<SweeperRunResult> {
  const started = Date.now();
  const store = options.store ?? (await getOverlayStore());
  const objectTypes = options.objectTypes ?? (await listObjectTypeApiNames());
  const maxKeys = options.maxKeysPerTick ?? 10_000;

  let inspected = 0;
  let deleted = 0;
  let correlated = 0;

  for (const objectType of objectTypes) {
    if (inspected >= maxKeys) break;
    const overlays = await store.scan(objectType);
    if (overlays.length === 0) continue;

    // Batch-lookup applied_to_index_at for all overlays of this object
    // type in one Postgres round-trip.
    const editIds = overlays.map((o) => o.editId).filter(Boolean);
    const appliedByEditId = await loadAppliedIndexTimestamps(editIds);

    for (const rec of overlays) {
      if (inspected >= maxKeys) break;
      inspected++;
      const appliedAt = appliedByEditId.get(rec.editId);
      if (appliedAt === undefined) continue;
      // Correlate: record SLI regardless of whether we delete
      correlated++;
      recordIndexApplied(rec.editId, appliedAt);
      if (appliedAt > rec.createdAt) {
        await store.delete(overlayKey(rec.objectType, rec.primaryKey));
        deleted++;
      }
    }
  }

  return {
    scannedObjectTypes: objectTypes.length,
    overlayKeysInspected: inspected,
    overlayKeysDeleted: deleted,
    editsCorrelated: correlated,
    durationMs: Date.now() - started,
  };
}

/** Starts the periodic sweeper loop. Safe to call multiple times. */
export function startOverlaySweeper(options: SweeperOptions = {}): void {
  if (timer) return;
  const intervalMs = options.intervalMs ?? 10_000;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await sweepOnce(options);
      if (result.overlayKeysDeleted > 0 || result.editsCorrelated > 0) {
        console.debug(
          JSON.stringify({
            type: "overlay_sweep",
            ...result,
          })
        );
      }
    } catch (err) {
      console.warn(`[overlay/sweeper] tick failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  // Avoid keeping the event loop alive on graceful shutdown.
  timer.unref?.();
}

export function stopOverlaySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function listObjectTypeApiNames(): Promise<string[]> {
  try {
    const res = await query("SELECT api_name FROM object_type", []);
    return res.rows.map((r: { api_name: string }) => r.api_name);
  } catch {
    return [];
  }
}

async function loadAppliedIndexTimestamps(
  editIds: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (editIds.length === 0) return out;
  // Spec source: `object_edits.applied_to_index_at` (012). The editApplicator
  // writes to both `object_edits` (canonical B1/B7) and the legacy
  // `ontology_edit` table during the transition; we union both so the
  // sweeper correlates regardless of which table has been updated first
  // by B6's indexing stamp activity. The latest timestamp wins.
  const fold = (editId: string, ts: number) => {
    if (!Number.isFinite(ts)) return;
    const prior = out.get(editId);
    if (prior === undefined || ts > prior) out.set(editId, ts);
  };

  try {
    const res = await query(
      `SELECT edit_id, applied_to_index_at
         FROM object_edits
        WHERE edit_id = ANY($1::uuid[])
          AND applied_to_index_at IS NOT NULL`,
      [editIds]
    );
    for (const row of res.rows) {
      fold(row.edit_id, new Date(row.applied_to_index_at).getTime());
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/relation .*object_edits.* does not exist/i.test(msg)) {
      throw err;
    }
  }

  try {
    const res = await query(
      `SELECT edit_id, applied_to_index_at
         FROM ontology_edit
        WHERE edit_id = ANY($1::uuid[])
          AND applied_to_index_at IS NOT NULL`,
      [editIds]
    );
    for (const row of res.rows) {
      fold(row.edit_id, new Date(row.applied_to_index_at).getTime());
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/relation .*ontology_edit.* does not exist/i.test(msg)) {
      throw err;
    }
  }

  return out;
}
