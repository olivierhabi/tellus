// ---------------------------------------------------------------------------
// Writeback overlay — Task B7
//
// Public surface for the three call sites:
//
//   writeOverlayForEdit()       — called inside the Action writeback txn
//   applyOverlayToResults()     — called by the Query API after Quickwit
//                                  returns its hits
//   collectFilterMatchingOverlays() — called by the Query API to inject
//                                     not-yet-indexed edits into the result
//                                     set
//
// These three together give the invariants that B7 demands:
//   (a) immediate edit visibility (<1s) regardless of Quickwit freshness
//   (b) no stale overlay — the sweeper drops keys once Quickwit has
//       absorbed the edit (applied_to_index_at > overlay.createdAt)
//   (c) deletes visible too — we emit a `deleted=true` overlay so query
//       merge drops the row from results until Quickwit's own delete cadence
//       catches up
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { OverlayRecord, OverlayStore, overlayKey } from "./overlayStore";
import { getOverlayStore } from "./getOverlayStore";
import { recordOverlayWrite } from "./slis";

export interface WriteOverlayInput {
  ontologyId: string;
  objectType: string;
  primaryKey: string;
  /** Full current object state (post-edit). Quickwit-ready shape. */
  doc: Record<string, unknown>;
  /** True when the edit is a delete (tombstone). */
  deleted: boolean;
  version: number;
  editId: string;
  actorUserId?: string | null;
  /** Optional — defaults to QUICKWIT_COMMIT_TIMEOUT_SECS * 3. */
  ttlSeconds?: number;
  /** Inject a specific store (tests). */
  store?: OverlayStore;
}

export interface WriteOverlayOutputs {
  editId: string;
  wroteOverlay: boolean;
  upsertedInstance: boolean;
}

const DEFAULT_COMMIT_TIMEOUT = 60;

function computeTtlSeconds(explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const env = Number(process.env.QUICKWIT_COMMIT_TIMEOUT_SECS);
  const commit = Number.isFinite(env) && env > 0 ? env : DEFAULT_COMMIT_TIMEOUT;
  return commit * 3;
}

// ---------------------------------------------------------------------------
// writeOverlayForEdit() — MUST be called in the same txn as object_edits
// insert so the visible state mirrors Postgres exactly. The PG transaction
// is owned by the caller; we receive a PoolClient so the overlay write can
// observe any in-flight rollback.
//
// Order:
//   1. insert object_edits row (caller)
//   2. UPSERT object_instances (here)
//   3. write Redis overlay (here)
//
// If step 3 throws, step 2 is already durable — Postgres remains the
// system of record. The caller is free to retry the overlay write from the
// sweeper on a best-effort basis.
// ---------------------------------------------------------------------------

export async function writeOverlayForEdit(
  client: PoolClient,
  input: WriteOverlayInput
): Promise<WriteOverlayOutputs> {
  const store = input.store ?? (await getOverlayStore());

  // Step 2 — UPSERT object_instances. Postgres is authoritative; Quickwit
  // and the overlay are downstream projections. `version` bumps on every
  // write so query paths can compare for "is the overlay strictly newer
  // than the indexed doc".
  //
  // Wrapped in a SAVEPOINT because a missing B1 `object_instances` table
  // in transitional deployments would otherwise abort the caller's PG
  // transaction (PG leaves any aborted txn unusable until ROLLBACK; a
  // plain try/catch here wouldn't rescue it). Rolling back to the
  // savepoint preserves the outer txn exactly.
  let upsertedInstance = false;
  await client.query("SAVEPOINT b1_object_instances");
  try {
    const res = await client.query(
      `INSERT INTO object_instances
         (ontology_id, object_type_api_name, primary_key, properties,
          markings, source_datasource_id, source_transaction_id,
          last_modified_at, version)
       VALUES ($1, $2, $3, $4::jsonb, ARRAY[]::text[], NULL, NULL, NOW(), $5)
       ON CONFLICT (ontology_id, object_type_api_name, primary_key)
         DO UPDATE SET properties        = EXCLUDED.properties,
                       last_modified_at  = NOW(),
                       version           = object_instances.version + 1
       RETURNING version`,
      [
        input.ontologyId,
        input.objectType,
        input.primaryKey,
        JSON.stringify(input.doc),
        input.version,
      ]
    );
    upsertedInstance = (res.rowCount ?? 0) > 0;
    await client.query("RELEASE SAVEPOINT b1_object_instances");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT b1_object_instances");
    const msg = err instanceof Error ? err.message : String(err);
    if (!/relation .*object_instances.* does not exist/i.test(msg)) {
      throw err;
    }
  }

  // Step 3 — Redis overlay. Must not throw out of the Action response path,
  // but we DO let caller-supplied errors propagate in tests (so retries and
  // SLI recording stay observable).
  const record: OverlayRecord = {
    objectType: input.objectType,
    primaryKey: input.primaryKey,
    doc: input.doc,
    deleted: input.deleted,
    version: input.version,
    createdAt: Date.now(),
    editId: input.editId,
    actorUserId: input.actorUserId ?? null,
  };
  let wrote = false;
  const ttl = computeTtlSeconds(input.ttlSeconds);
  try {
    await store.put(overlayKey(input.objectType, input.primaryKey), record, ttl);
    wrote = true;
    recordOverlayWrite(input.editId, record.createdAt);
  } catch (err) {
    console.warn(
      `[overlay] put failed for ${input.objectType}/${input.primaryKey}: ${(err as Error).message}`
    );
  }

  return { editId: input.editId, wroteOverlay: wrote, upsertedInstance };
}

// ---------------------------------------------------------------------------
// applyOverlayToResults()
//
// Post-processes a Quickwit search result:
//   • fetches overlays for every returned PK
//   • replaces the Quickwit doc with the overlay doc when present
//   • drops any hit whose overlay is a delete-tombstone
//
// Shape is intentionally loose: we receive `hits` as an array of shallow
// docs (each with `__pk`) and return the same shape, filtered and
// substituted. Callers keep total-count, pagination, aggregations etc.
// ---------------------------------------------------------------------------

export async function applyOverlayToResults(
  objectType: string,
  hits: Array<Record<string, unknown>>,
  storeOverride?: OverlayStore
): Promise<Array<Record<string, unknown>>> {
  if (hits.length === 0) return hits;
  const store = storeOverride ?? (await getOverlayStore());

  const pks = hits
    .map((h) => asString(h.__pk))
    .filter((pk): pk is string => pk !== null);
  if (pks.length === 0) return hits;

  const keys = pks.map((pk) => overlayKey(objectType, pk));
  const overlays = await store.mget(keys);
  const overlayByPk = new Map<string, OverlayRecord>();
  for (const rec of overlays) {
    if (rec) overlayByPk.set(rec.primaryKey, rec);
  }

  const out: Array<Record<string, unknown>> = [];
  for (const hit of hits) {
    const pk = asString(hit.__pk);
    if (pk === null) {
      out.push(hit);
      continue;
    }
    const overlay = overlayByPk.get(pk);
    if (!overlay) {
      out.push(hit);
      continue;
    }
    // Stale guard: if the indexed doc's version is strictly greater than
    // the overlay's, Quickwit has caught up — trust the index.
    const indexedVersion = numberOrNull(hit.__version);
    if (indexedVersion !== null && indexedVersion > overlay.version) {
      out.push(hit);
      continue;
    }
    if (overlay.deleted) continue;
    out.push({
      ...overlay.doc,
      __pk: overlay.primaryKey,
      __version: overlay.version,
      __overlay_source: "writeback",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// collectFilterMatchingOverlays()
//
// When a recent edit hasn't reached Quickwit yet, the overlay is the only
// place it lives. We SCAN the overlay namespace for this Object Type, apply
// the (optional) caller-supplied filter predicate, and return records that
// match. The caller merges them with the Quickwit hits (deduped by PK).
// ---------------------------------------------------------------------------

export async function collectFilterMatchingOverlays(
  objectType: string,
  filter: (doc: Record<string, unknown>) => boolean,
  storeOverride?: OverlayStore
): Promise<Array<Record<string, unknown>>> {
  const store = storeOverride ?? (await getOverlayStore());
  const records = await store.scan(objectType);
  const out: Array<Record<string, unknown>> = [];
  for (const r of records) {
    if (r.deleted) continue;
    if (!filter(r.doc)) continue;
    out.push({
      ...r.doc,
      __pk: r.primaryKey,
      __version: r.version,
      __overlay_source: "writeback",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

// ---------------------------------------------------------------------------
// Convenience for B7 acceptance: a helper the Query API uses to stitch the
// two steps (overlay replacement + scan-and-merge) into one call.
// ---------------------------------------------------------------------------

export interface MergeInput {
  objectType: string;
  hits: Array<Record<string, unknown>>;
  filter?: (doc: Record<string, unknown>) => boolean;
  store?: OverlayStore;
}

export async function mergeOverlayIntoSearch(
  input: MergeInput
): Promise<Array<Record<string, unknown>>> {
  const store = input.store ?? (await getOverlayStore());
  const replaced = await applyOverlayToResults(input.objectType, input.hits, store);
  if (!input.filter) return replaced;
  const extras = await collectFilterMatchingOverlays(input.objectType, input.filter, store);
  // Dedup by PK — a PK already in `replaced` must not appear again.
  const seen = new Set<string>();
  for (const h of replaced) {
    const pk = asString(h.__pk);
    if (pk) seen.add(pk);
  }
  for (const e of extras) {
    const pk = asString(e.__pk);
    if (pk && !seen.has(pk)) {
      replaced.push(e);
      seen.add(pk);
    }
  }
  return replaced;
}

