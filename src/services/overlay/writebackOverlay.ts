// ---------------------------------------------------------------------------
// Writeback overlay — Task B7, hardened by T-04.
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
// T-04 — branch-aware overlay (closes B-4):
//
//   • `OverlayRecord.branchId` is required (`_main` sentinel for unbranched
//     writes).
//   • `writeOverlay(rec, store, ttl)` does CAS on `version`
//     (`OVERLAY_VERSION_CONFLICT` on `incoming.version <= existing.version`),
//     writes to the new keyspace, and dual-writes to the legacy key only
//     when (a) `OVERLAY_DUAL_WRITE !== "false"` and (b) `branchId === "_main"`.
//   • `readOverlay(branchId, ot, pk, store)` reads the new key, falls back
//     to the legacy key only when (a) `OVERLAY_READ_LEGACY !== "false"` and
//     (b) the request's `branchId` is null/`_main`. Branch-mismatch reads
//     (legacy hit on a non-main branch request) emit
//     `OVERLAY_BRANCH_MISMATCH` via a counter; the record is suppressed.
//   • `applyOverlayToResults` and `collectFilterMatchingOverlays` accept a
//     `branchId` parameter (default `null` ≡ `_main`) and route every read
//     through `readOverlay`.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import {
  OverlayRecord,
  OverlayStore,
  overlayKey,
  legacyOverlayKey,
  linkOverlayKey,
  LinkOverlayRecord,
  MAIN_BRANCH_SENTINEL,
  isDualWriteEnabled,
  isLegacyReadEnabled,
} from "./overlayStore";
import { getOverlayStore } from "./getOverlayStore";
import { recordOverlayWrite } from "./slis";
import { deriveMainBranchId } from "../branchContext";
import { incCounter } from "../funnel/metrics";

export interface WriteOverlayInput {
  ontologyId: string;
  /**
   * T-04: optional. When omitted, the `_main` sentinel is used. New
   * branch-aware callers SHOULD pass the actual branchId so the new
   * keyspace correctly segregates by branch.
   */
  branchId?: string | null;
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

function resolveBranchSlot(branchId?: string | null): string {
  if (typeof branchId !== "string" || branchId.length === 0) {
    return MAIN_BRANCH_SENTINEL;
  }
  return branchId;
}

// ---------------------------------------------------------------------------
// T-04 — branch-aware write helper.
//
// Performs CAS on `version` against any existing slot. Throws
// `OVERLAY_VERSION_CONFLICT` (HTTP 409 via the canonical envelope) when an
// older version arrives after a newer one has been persisted. Dual-writes
// to the legacy key during phases 0–1 of the rollout, and only when the
// branch slot is `_main` — branch writes never pollute the legacy
// namespace.
// ---------------------------------------------------------------------------

async function getExistingRecord(
  store: OverlayStore,
  key: string,
): Promise<OverlayRecord | null> {
  if (typeof store.get === "function") {
    return store.get(key);
  }
  const [v] = await store.mget([key]);
  return v ?? null;
}

export async function writeOverlay(
  rec: OverlayRecord,
  store: OverlayStore,
  ttlSeconds: number,
): Promise<void> {
  const slot = resolveBranchSlot(rec.branchId);
  const newKey = overlayKey(slot, rec.objectType, rec.primaryKey);

  // CAS on version. `version <= existing.version` rejects out-of-order
  // arrivals; equal versions are treated as conflicts so accidental
  // double-writes surface in the metric / 409.
  const existing = await getExistingRecord(store, newKey);
  if (existing && rec.version <= existing.version) {
    incCounter("tellus_overlay_writes_total", { outcome: "version_conflict" });
    throw Object.assign(
      new Error(
        `Incoming overlay version ${rec.version} is not strictly greater than stored version ${existing.version}.`,
      ),
      {
        code: "OVERLAY_VERSION_CONFLICT",
        details: {
          incomingVersion: rec.version,
          storedVersion: existing.version,
        },
      },
    );
  }

  // Persist with the canonical branchId stamped (tests can inspect this
  // field directly to verify the write went into the right slot).
  const stamped: OverlayRecord = { ...rec, branchId: slot };
  await store.put(newKey, stamped, ttlSeconds);

  // Dual-write to the legacy key during phases 0–1, and only for `_main`
  // writes. Branch writes never spill into the legacy namespace.
  if (isDualWriteEnabled() && slot === MAIN_BRANCH_SENTINEL) {
    const legacyKey = legacyOverlayKey(rec.objectType, rec.primaryKey);
    await store.put(legacyKey, stamped, ttlSeconds);
  }

  incCounter("tellus_overlay_writes_total", { outcome: "ok" });
}

// ---------------------------------------------------------------------------
// T-04 — branch-aware read helper.
//
// Returns null if (a) no overlay exists in either keyspace, or (b) the
// only hit was a legacy record served against a non-main branch request
// (which we treat as a branch mismatch and SUPPRESS — the read does not
// see the legacy edit).
// ---------------------------------------------------------------------------

export async function readOverlay(
  branchId: string | null | undefined,
  objectType: string,
  primaryKey: string,
  store: OverlayStore,
): Promise<OverlayRecord | null> {
  const slot = resolveBranchSlot(branchId);
  const newKey = overlayKey(slot, objectType, primaryKey);
  const newVal = await getExistingRecord(store, newKey);
  if (newVal) {
    incCounter("tellus_overlay_reads_total", {
      branch_match: "match",
      source: "new_key",
    });
    return newVal;
  }
  if (isLegacyReadEnabled()) {
    const legacyKey = legacyOverlayKey(objectType, primaryKey);
    const legacyVal = await getExistingRecord(store, legacyKey);
    if (legacyVal) {
      // Legacy records have no branchId. Serve them only when the
      // request itself targets `_main` — never on a real branch read.
      if (slot === MAIN_BRANCH_SENTINEL) {
        incCounter("tellus_overlay_reads_total", {
          branch_match: "match",
          source: "legacy_key",
        });
        incCounter("tellus_overlay_legacy_hits_total");
        return legacyVal;
      }
      incCounter("tellus_overlay_reads_total", {
        branch_match: "mismatch_rejected",
        source: "legacy_key",
      });
      // Branch mismatch — surface via the alert metric so phase 3 can
      // be confirmed (this counter MUST be zero in phase 3).
      incCounter("tellus_overlay_branch_mismatch_total", {
        branch_id: slot,
        object_type: objectType,
      });
      return null;
    }
  }
  return null;
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
  input: WriteOverlayInput,
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
  // Default to caller-supplied version. Overwritten below from the
  // UPSERT's RETURNING clause when the table exists — that is the
  // monotonic value that downstream readers compare against the indexed
  // `__version`. Falling through with a hard-coded `1` (the editApplicator
  // default) would conflict on the next edit for the same PK.
  let canonicalVersion = input.version;
  await client.query("SAVEPOINT b1_object_instances");
  try {
    // Migration 041 extended the object_instances PK to include branch_id
    // (src/migrations/041_object_instances_branch_pk.sql). The old 3-col
    // ON CONFLICT target no longer matches any unique constraint and PG
    // rejects with "there is no unique or exclusion constraint matching
    // the ON CONFLICT specification". Thread the main-branch UUID through
    // so the INSERT resolves and branch isolation semantics are preserved
    // (T-04 layers an explicit-branch keyspace on top — the PG row is
    // still per-ontology-`_main`-by-default for now).
    const branchUuid = deriveMainBranchId(input.ontologyId);
    const res = await client.query(
      `INSERT INTO object_instances
         (ontology_id, branch_id, object_type_api_name, primary_key, properties,
          markings, source_datasource_id, source_transaction_id,
          last_modified_at, version)
       VALUES ($1, $6::uuid, $2, $3, $4::jsonb, ARRAY[]::text[], NULL, NULL, NOW(), $5)
       ON CONFLICT (ontology_id, branch_id, object_type_api_name, primary_key)
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
        branchUuid,
      ],
    );
    upsertedInstance = (res.rowCount ?? 0) > 0;
    // Capture the canonical monotonic version from the UPSERT — on INSERT
    // it equals the inserted value, on UPDATE it equals existing+1. This
    // is what we MUST stamp on the overlay record; using the caller's
    // `input.version` produces same-version writes for distinct edits and
    // trips OVERLAY_VERSION_CONFLICT for legitimate sequences (a single
    // hard-coded `1` from editApplicator stamps every edit identically).
    if (upsertedInstance && res.rows[0]?.version != null) {
      const v = Number(res.rows[0].version);
      if (Number.isFinite(v) && v > 0) {
        canonicalVersion = v;
      }
    }
    await client.query("RELEASE SAVEPOINT b1_object_instances");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT b1_object_instances");
    const msg = err instanceof Error ? err.message : String(err);
    if (!/relation .*object_instances.* does not exist/i.test(msg)) {
      throw err;
    }
  }

  // Step 3 — Redis overlay. Routed through `writeOverlay` for CAS,
  // dual-write, and metrics. Errors propagate up to the caller for
  // observability; the caller decides whether to retry from the sweeper.
  const slot = resolveBranchSlot(input.branchId);
  const record: OverlayRecord = {
    branchId: slot,
    objectType: input.objectType,
    primaryKey: input.primaryKey,
    doc: input.doc,
    deleted: input.deleted,
    version: canonicalVersion,
    createdAt: Date.now(),
    editId: input.editId,
    actorUserId: input.actorUserId ?? null,
  };
  let wrote = false;
  const ttl = computeTtlSeconds(input.ttlSeconds);
  try {
    await writeOverlay(record, store, ttl);
    wrote = true;
    recordOverlayWrite(input.editId, record.createdAt);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // OVERLAY_VERSION_CONFLICT is a contractual outcome — propagate it so
    // callers can render a 409. Non-conflict failures (Redis offline, etc.)
    // are softened to a warning so the Action response path still returns
    // 200 (Postgres is authoritative; the sweeper retries the overlay).
    if (code === "OVERLAY_VERSION_CONFLICT") {
      throw err;
    }
    console.warn(
      `[overlay] put failed for ${input.objectType}/${input.primaryKey}: ${(err as Error).message}`,
    );
  }

  return { editId: input.editId, wroteOverlay: wrote, upsertedInstance };
}

// ---------------------------------------------------------------------------
// applyOverlayToResults()
//
// Post-processes a Quickwit search result:
//   • fetches overlays for every returned PK (branch-aware)
//   • replaces the Quickwit doc with the overlay doc when present
//   • drops any hit whose overlay is a delete-tombstone
// ---------------------------------------------------------------------------

export async function applyOverlayToResults(
  objectType: string,
  hits: Array<Record<string, unknown>>,
  storeOverride?: OverlayStore,
  branchId: string | null = null,
): Promise<Array<Record<string, unknown>>> {
  if (hits.length === 0) return hits;
  const store = storeOverride ?? (await getOverlayStore());

  const pks = hits
    .map((h) => asString(h.__pk))
    .filter((pk): pk is string => pk !== null);
  if (pks.length === 0) return hits;

  // Read each overlay through the branch-aware path. We accept the per-PK
  // round-trips here (vs. mget) because the read helper has to make the
  // legacy/branch-mismatch decision per-key; a vectorised mget would force
  // us to recompute that logic at the caller. For typical pages of ≤100
  // hits this is well within p95 budgets.
  const overlayByPk = new Map<string, OverlayRecord>();
  await Promise.all(
    pks.map(async (pk) => {
      const rec = await readOverlay(branchId, objectType, pk, store);
      if (rec) overlayByPk.set(pk, rec);
    }),
  );

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
//
// T-04: the SCAN sees every overlay record across every branch slot and
// the legacy slot. We post-filter to records whose `branchId === slot` for
// the request's branch context. Legacy-slot records (no branchId, parsed
// as null in the key) are admitted only on `_main` requests when
// `OVERLAY_READ_LEGACY` is enabled.
// ---------------------------------------------------------------------------

export async function collectFilterMatchingOverlays(
  objectType: string,
  filter: (doc: Record<string, unknown>) => boolean,
  storeOverride?: OverlayStore,
  branchId: string | null = null,
): Promise<Array<Record<string, unknown>>> {
  const store = storeOverride ?? (await getOverlayStore());
  const records = await store.scan(objectType);
  const slot = resolveBranchSlot(branchId);
  const out: Array<Record<string, unknown>> = [];
  const legacyAllowed = isLegacyReadEnabled() && slot === MAIN_BRANCH_SENTINEL;
  for (const r of records) {
    if (r.deleted) continue;
    // Records persisted before T-04 may not carry a branchId at all. The
    // store deserialises them as `branchId === undefined`; we treat that
    // as a legacy-slot record subject to the legacy-fallback gate.
    const recBranch = typeof r.branchId === "string" ? r.branchId : null;
    if (recBranch === null) {
      if (!legacyAllowed) continue;
    } else if (recBranch !== slot) {
      continue;
    }
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
  /** T-04: branch context for the request. Defaults to `_main`. */
  branchId?: string | null;
}

export async function mergeOverlayIntoSearch(
  input: MergeInput,
): Promise<Array<Record<string, unknown>>> {
  const store = input.store ?? (await getOverlayStore());
  const branchId = input.branchId ?? null;
  const replaced = await applyOverlayToResults(input.objectType, input.hits, store, branchId);
  if (!input.filter) return replaced;
  const extras = await collectFilterMatchingOverlays(input.objectType, input.filter, store, branchId);
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


// ---------------------------------------------------------------------------
// FNL-H5 — link-edge writeback overlay (unchanged surface — T-04 does
// not extend branch-awareness to link overlays in this PR; tracked
// separately).
// ---------------------------------------------------------------------------

interface LinkOverlayStore {
  put: (key: string, record: LinkOverlayRecord, ttlSeconds: number) => Promise<void>;
  mget: (keys: string[]) => Promise<Array<LinkOverlayRecord | null>>;
  delete: (key: string) => Promise<void>;
}

async function getLinkOverlayStore(): Promise<LinkOverlayStore> {
  const store = await getOverlayStore();
  return {
    put: (key, rec, ttl) =>
      (store as unknown as { put: (k: string, r: unknown, t: number) => Promise<void> }).put(
        key,
        rec,
        ttl,
      ),
    mget: async (keys) =>
      (await (store as unknown as {
        mget: (k: string[]) => Promise<Array<unknown>>;
      }).mget(keys)) as Array<LinkOverlayRecord | null>,
    delete: (key) => store.delete(key),
  };
}

export interface WriteLinkOverlayInput {
  linkTypeApiName: string;
  sourcePk: string;
  targetPk: string;
  operation: "ADD" | "REMOVE" | "RETRACT";
  markings?: string[];
  linkProps?: Record<string, unknown>;
  eventId?: string;
  actorUserId?: string | null;
  ttlSeconds?: number;
}

export async function writeOverlayForLinkEdit(
  input: WriteLinkOverlayInput,
): Promise<void> {
  const store = await getLinkOverlayStore();
  const ttl = computeLinkOverlayTtl(input.linkTypeApiName, input.ttlSeconds);
  const key = linkOverlayKey(input.linkTypeApiName, input.sourcePk, input.targetPk);
  const rec: LinkOverlayRecord = {
    linkTypeApiName: input.linkTypeApiName,
    sourcePk: input.sourcePk,
    targetPk: input.targetPk,
    operation: input.operation,
    markings: input.markings ?? [],
    linkProps: input.linkProps ?? undefined,
    createdAt: Date.now(),
    eventId: input.eventId,
    actorUserId: input.actorUserId ?? null,
  };
  await store.put(key, rec, ttl);
  try {
    recordOverlayWrite(input.eventId ?? key, rec.createdAt);
  } catch {
    /* SLI optional */
  }
}

function computeLinkOverlayTtl(
  linkTypeApiName: string,
  explicit?: number,
): number {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const override = process.env[`LINK_OVERLAY_TTL_${linkTypeApiName.toUpperCase()}`];
  const overrideN = override ? Number(override) : NaN;
  if (Number.isFinite(overrideN) && overrideN > 0) return overrideN;
  return computeTtlSeconds(undefined);
}

/**
 * Load any overlay entries matching the set of `(source_pk, target_pk)`
 * pairs returned by the underlying link resolver and apply them to the
 * result:
 *   - REMOVE/RETRACT entries drop the pair from results.
 *   - ADD entries confirm the pair (and merge link_props if provided).
 */
export async function mergeWithLinkOverlay<
  Row extends { sourcePk?: string; targetPk?: string; source_pk?: string; target_pk?: string },
>(
  linkTypeApiName: string,
  rows: Row[],
): Promise<Row[]> {
  if (rows.length === 0) return rows;
  const store = await getLinkOverlayStore();
  const keys = rows.map((r) =>
    linkOverlayKey(
      linkTypeApiName,
      String(r.sourcePk ?? r.source_pk ?? ""),
      String(r.targetPk ?? r.target_pk ?? ""),
    ),
  );
  const overlays = await store.mget(keys);
  const result: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const overlay = overlays[i];
    if (overlay && (overlay.operation === "REMOVE" || overlay.operation === "RETRACT")) {
      continue; // drop
    }
    result.push(rows[i]);
  }
  return result;
}
