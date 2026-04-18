// ---------------------------------------------------------------------------
// Overlay store abstraction — Task B7
//
// The Writeback Overlay is a short-lived cache that sits between every
// Action writeback and the Quickwit query path. Its job is to make an edit
// visible *immediately* even though Quickwit's commit cadence (B6) and
// delete-by-query cadence are measured in seconds-to-hours.
//
// The physical store is Redis in production. For dev/test we expose the
// same surface via an in-memory store, so the rest of the system (edit
// applicator, query merger, sweeper) never sees the difference.
//
// Key format: `overlay:<object_type_api_name>:<primary_key>`
// Value:      full current object JSON (see OverlayRecord)
// TTL:        quickwit_commit_timeout_secs * 3 (default 180s)
// ---------------------------------------------------------------------------

export interface OverlayRecord {
  objectType: string;
  primaryKey: string;
  /** Full current object state — replaces the Quickwit doc at query time. */
  doc: Record<string, unknown>;
  /** True when the edit was a delete — query-time filter drops the row. */
  deleted: boolean;
  /** Monotonic version of this object's edit history (from object_edits). */
  version: number;
  /** When the overlay was first written (for staleness checks). */
  createdAt: number;
  /** Which edit produced this overlay (for sweeper correlation). */
  editId: string;
  /** Who made the edit. */
  actorUserId?: string | null;
}

export interface OverlayStore {
  put(key: string, record: OverlayRecord, ttlSeconds: number): Promise<void>;
  mget(keys: string[]): Promise<Array<OverlayRecord | null>>;
  scan(objectType: string): Promise<OverlayRecord[]>;
  delete(key: string): Promise<void>;
  size(): Promise<number>;
  /** Optional — used by tests for reset between cases. */
  clear?(): Promise<void>;
}

export function overlayKey(objectType: string, primaryKey: string): string {
  return `overlay:${objectType}:${primaryKey}`;
}

export function parseOverlayKey(
  key: string
): { objectType: string; primaryKey: string } | null {
  const m = /^overlay:([^:]+):(.+)$/.exec(key);
  if (!m) return null;
  return { objectType: m[1], primaryKey: m[2] };
}
