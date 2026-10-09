// ---------------------------------------------------------------------------
// Serving edit projector — closes the action-commits → OpenSearch gap.
//
// Consistency model (local/single-node topology): the action writeback txn
// commits to `object_instances` + `ontology_edit` (WAL) + the writeback
// overlay (read-your-writes, ~3×commit-timeout TTL). Nothing else in this
// topology consumes the edit WAL into the OpenSearch serving indexes: the
// Temporal funnel indexing activity targets Quickwit (absent locally), and
// `reindexObjectType` is operator-triggered. The observable result was that
// an Action-created object was durably committed and audited but NEVER
// appeared in object serving (object lists / object tables / criteria
// live-reads) — the "projection gap".
//
// This projector is the bounded, functioning projection path: it drains
// `ontology_edit` rows where `applied_to_index_at IS NULL`, re-reads the
// CURRENT row from `object_instances` (user_edit_wins — the WAL row only
// carries the delta), upserts the serving document into the per-Object-Type
// OpenSearch index (creating the index on cold start), and only then stamps
// `applied_to_index_at` — the same truthful-acknowledgement invariant the
// funnel indexing activity documents: an edit is "indexed" only after the
// serving store confirms it.
//
// Failure semantics: any per-type failure leaves the edits pending and is
// retried on the next tick — the projector never drops work. The overlay
// covers the lag window for reads; the sweeper retires overlay keys once
// `applied_to_index_at` passes their creation time.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import {
  getPendingIndexEdits,
  markEditsAppliedToIndex,
} from "../../models/ontologyEdit";
import { client } from "../opensearch/client";
import {
  createIndex,
  getIndexName,
  indexExists,
} from "../opensearch/indexLifecycleManager";
import { ensureDocumentSecurity } from "../security/documentSecurity";
import {
  buildPropertyAliasMap,
  toCanonicalProperties,
  buildPropertyTypeMap,
  toIndexableProperties,
} from "../opensearch/syncFromInstances";
import { collectBulkFailures, formatBulkFailures } from "./bulkResult";
import { incCounter } from "../funnel/metrics";

export interface ProjectorTickResult {
  objectTypesDrained: number;
  editsProjected: number;
  docsDeleted: number;
  durationMs: number;
}

export interface ServingProjectorOptions {
  /** How often to drain. Default 2000 ms (edit → serving inside seconds). */
  intervalMs?: number;
  /** Cap on object types drained per tick. Default 10. */
  maxObjectTypesPerTick?: number;
  /** Cap on edits projected per object type per tick. Default 5_000. */
  maxEditsPerType?: number;
}

interface PendingTypeRow {
  ontology_id: string;
  object_type_api_name: string;
}

async function listPendingObjectTypes(
  limit: number,
): Promise<PendingTypeRow[]> {
  const res = await query(
    `SELECT DISTINCT ontology_id, object_type_api_name
       FROM ontology_edit
      WHERE applied_to_index_at IS NULL
      ORDER BY ontology_id, object_type_api_name
      LIMIT $1`,
    [limit],
  );
  return res.rows as PendingTypeRow[];
}

async function ensureServingIndex(
  ontologyId: string,
  objectTypeApiName: string,
): Promise<string> {
  const indexName = getIndexName(objectTypeApiName);
  const exists = await indexExists(objectTypeApiName);
  if (!exists.exists) {
    await createIndex(objectTypeApiName, ontologyId);
  }
  return indexName;
}

/**
 * Project one object type's pending edit WAL into its serving index.
 * Returns the number of edits acknowledged + docs deleted.
 */
async function projectObjectType(
  ontologyId: string,
  objectTypeApiName: string,
  maxEdits: number,
): Promise<{ edits: number; deleted: number }> {
  const pending = (await getPendingIndexEdits(objectTypeApiName)).slice(
    0,
    maxEdits,
  );
  if (pending.length === 0) return { edits: 0, deleted: 0 };

  const indexName = await ensureServingIndex(ontologyId, objectTypeApiName);

  // Latest-state-wins: collapse the WAL to the newest operation per PK,
  // then re-read the CURRENT committed row (a later edit in the same WAL
  // batch may already have overwritten an earlier one's delta).
  const latestOpByPk = new Map<string, "create" | "update" | "delete">();
  for (const e of pending) {
    if (!e.primary_key || !String(e.primary_key).trim()) continue; // nothing addressable
    latestOpByPk.set(e.primary_key, e.operation);
  }

  // Same document shape as the full sync: canonical property keys,
  // ISO __lastModified, PUBLIC default markings.
  const aliases = await buildPropertyAliasMap(objectTypeApiName, ontologyId);
  const types = await buildPropertyTypeMap(objectTypeApiName, ontologyId);

  // Date coercion parity with the funnel index path is handled by the
  // shared toIndexableProperties helper (see syncFromInstances).

  const bulkBody: Array<Record<string, unknown>> = [];
  let deletes = 0;
  for (const [pk, op] of latestOpByPk) {
    if (op === "delete") {
      bulkBody.push({ delete: { _index: indexName, _id: pk } });
      deletes += 1;
      continue;
    }
    const row = await query(
      `SELECT primary_key, properties, markings, last_modified_at, version, branch_id, rid
         FROM object_instances
        WHERE ontology_id = $1 AND object_type_api_name = $2 AND primary_key = $3
        LIMIT 1`,
      [ontologyId, objectTypeApiName, pk],
    );
    const r = row.rows[0];
    if (!r) {
      // Row vanished (hard delete outside the edit WAL) — drop the doc.
      bulkBody.push({ delete: { _index: indexName, _id: pk } });
      deletes += 1;
      continue;
    }
    const doc = {
      __pk: r.primary_key,
      __objectType: objectTypeApiName,
      __ontology: ontologyId,
      __rid: r.rid,
      __version: Number(r.version),
      __lastModified: new Date(r.last_modified_at).toISOString(),
      __branch: r.branch_id,
      ...toIndexableProperties(
        toCanonicalProperties(
          r.properties as Record<string, unknown>,
          aliases,
        ),
        types,
      ),
      _security: {
        markings:
          Array.isArray(r.markings) && r.markings.length > 0
            ? r.markings
            : ["PUBLIC"],
      },
    };
    bulkBody.push({ index: { _index: indexName, _id: pk } });
    bulkBody.push(ensureDocumentSecurity(doc));
  }

  if (bulkBody.length > 0) {
    const { body } = await client.bulk({ body: bulkBody, refresh: true });
    const res = body as unknown as {
      errors: boolean;
      items?: Array<Record<string, { status: number; result?: string; error?: { type?: string; reason?: string } }>>;
    };
    if (res.errors) {
      // Poison-pill isolation: acknowledge every document the serving store
      // accepted and retry ONLY the rejected ones next tick. Without this,
      // one unindexable document (e.g. an over-long _id minted by a bad
      // generatedSequence config) wedges the whole object type forever.
      const failures = collectBulkFailures(res.items);
      const failedIds = new Set(failures.map((f) => f.id));
      const acceptedEditIds = pending
        .filter((e) => e.primary_key && !failedIds.has(e.primary_key))
        .map((e) => e.edit_id);
      const acknowledged = await markEditsAppliedToIndex(acceptedEditIds);
      incCounter("serving_projector_projection_failed_total", {
        object_type: objectTypeApiName,
      }, failures.length);
      throw new Error(
        `bulk project failed for ${objectTypeApiName}: ${failures.length} document(s) rejected ` +
          `(${formatBulkFailures(failures)}); ${acknowledged} accepted document(s) acknowledged`,
      );
    }
  }

  // Truthful acknowledgement: only after the serving store accepted the docs.
  const acknowledged = await markEditsAppliedToIndex(
    pending.map((e) => e.edit_id),
  );
  incCounter("serving_projector_edits_projected_total", {
    objectType: objectTypeApiName,
  });
  return { edits: acknowledged, deleted: deletes };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function projectServingEditsOnce(
  options: ServingProjectorOptions = {},
): Promise<ProjectorTickResult> {
  const started = Date.now();
  const maxTypes = options.maxObjectTypesPerTick ?? 10;
  const maxEdits = options.maxEditsPerType ?? 5_000;
  let edits = 0;
  let deleted = 0;
  let drained = 0;
  const pendingTypes = await listPendingObjectTypes(maxTypes);
  for (const t of pendingTypes) {
    try {
      const out = await projectObjectType(
        t.ontology_id,
        t.object_type_api_name,
        maxEdits,
      );
      edits += out.edits;
      deleted += out.deleted;
      drained += 1;
    } catch (err) {
      // A WAL batch for a dropped Object Type can never be projected —
      // acknowledge it so it doesn't poison the queue forever; everything
      // else stays pending and is retried next tick.
      const msg = (err as Error).message;
      if (/not found in metadata store/i.test(msg)) {
        console.warn(
          `[serving-projector] ${t.object_type_api_name}: object type gone — acknowledging ${"pending"} edits as unprojectable`,
        );
        try {
          const stale = await getPendingIndexEdits(t.object_type_api_name);
          await markEditsAppliedToIndex(stale.map((e) => e.edit_id));
        } catch (ackErr) {
          console.warn(
            `[serving-projector] failed to acknowledge dropped type ${t.object_type_api_name}: ${(ackErr as Error).message}`,
          );
        }
        continue;
      }
      // Leave the WAL pending — next tick retries.
      console.warn(`[serving-projector] ${t.object_type_api_name}: ${msg}`);
    }
  }
  return {
    objectTypesDrained: drained,
    editsProjected: edits,
    docsDeleted: deleted,
    durationMs: Date.now() - started,
  };
}

export function startServingProjector(
  options: ServingProjectorOptions = {},
): void {
  if (timer) return;
  const intervalMs = options.intervalMs ?? 2_000;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await projectServingEditsOnce(options);
    } catch (err) {
      console.warn(`[serving-projector] tick failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  console.log(`[serving-projector] started (interval ${intervalMs}ms)`);
}

export function stopServingProjector(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
