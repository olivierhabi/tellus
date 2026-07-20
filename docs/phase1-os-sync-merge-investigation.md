# Phase 1 Investigation — 5.6M OS sync + merge scaling

**Status:** investigation only. No code changes. `pool.ts` `instanceSettingsApplied`
guard and `mergeStage.ts` temp-table-drop logic were NOT touched (verified
root-cause fixes, per instruction).

All file:line refs are against the tellus backend at the time of writing
(working tree, uncommitted). All command output is real, captured this session.

---

## BONUS — Why OT-B shows "indexed" in status but the funnel says "stuck at merge changes"

**Verified (command output):**

```
funnel_state (c362497a): status=indexed, objects_indexed=4657493, updated_at=2026-07-13 10:33:54
funnel_run  (OlivierOrder2), latest rows:
  failed | merge | socket hang up | started 2026-07-13 09:05:06 | done 2026-07-13 09:30:37
  failed | merge | socket hang up | started 2026-07-13 08:35:03 | done 2026-07-13 08:55:58
  ... (more failed | merge rows)
```

**Explanation:** The two tables serve different purposes and were written by
different code paths:
- `funnel_state` is the OT badge (one row per OT). It was set to `indexed`
  **manually** at 10:33:54 by a direct `UPDATE funnel_state SET status='indexed'`
  after the out-of-band OS sync (`scripts/sync-os-direct.ts`).
- `funnel_run` is the per-run ledger (one row per Temporal workflow run). Its
  latest row is the Temporal run that **FAILED at merge** (`socket hang up`,
  09:05–09:30) — never updated because no successful Temporal run reached the
  terminal projection.

So the UI reads `funnel_state` ("indexed") AND `funnel_run` (latest = "failed /
merge") and shows both. The divergence is an **artifact of the bypass**: the
manual `funnel_state` update was not accompanied by a successful Temporal run,
so `funnel_run` still reflects the last failed merge. This is NOT a code bug in
either table — it is the expected consequence of routing around the Temporal
workflow.

---

## 1. OS_INDEX_SHARDS / createIndex idempotency + DELETE race

### 1a. createIndex does NOT verify an existing index's shard count

`src/services/opensearch/indexLifecycleManager.ts:122-138` — `createIndex()`:
```ts
const { body: exists } = await client.indices.exists({ index: indexName });   // :131
if (exists) {                                                                  // :133
  throw new Error(`Index '...' already exists ... Use recreateIndex() ...`);   // :134-136
}
```
So `createIndex` itself **throws** if the index exists (it does not silently
no-op).

But the **caller** `src/services/opensearch/syncFromInstances.ts:142-147`:
```ts
const existsRes = await indexExists(objectTypeApiName);   // :143
if (!existsRes.exists) {                                  // :144
  await createIndex(objectTypeApiName);                   // :145
  indexCreated = true;
}
```
→ If the index already exists, `createIndex` is **skipped** and the sync
upserts into the **existing** index with **no check that its shard count (or
any setting) matches `OS_INDEX_SHARDS` / the configured mapping.**

**Verified — shard-count drift is real:**
```
ontology-olivierorder2: number_of_shards=4, number_of_replicas=0   (created after OS_INDEX_SHARDS=4)
ontology-olivierorder1: number_of_shards=1, number_of_replicas=0   (created before the 4-shard change)
```
Two OTs in the same cluster, different shard counts, no warning.

**Grep for any shard-count verification:** only the *settings definitions*
(`templateRegistry.ts:62`, `indexMappingGenerator.ts:116`) read
`OS_INDEX_SHARDS`. No code path fetches an existing index's
`number_of_shards` and compares it to the configured value. → Confirmed:
silent drift.

### 1b. deleteIndex returns on `acknowledged`, no durability verification

`src/services/opensearch/indexLifecycleManager.ts:188-211` — `deleteIndex()`:
```ts
const { body: exists } = await client.indices.exists({ index: indexName });   // :194
if (!exists) { return { success: true, ... "nothing to delete" }; }
await client.indices.delete({ index: indexName });                            // :206
console.log(`Deleted index '...'`);                                            // :210
```
The function returns as soon as `indices.delete` resolves (i.e. OS
acknowledged the request). It does **not** re-`exists` to confirm the index is
gone, nor wait for cluster-state persistence.

**Observed (one data point, mechanism unverified):** During this session I ran
`curl -X DELETE .../ontology-olivierorder2` → got `{"acknowledged":true}` →
the OS container restarted ~1 min later → after restart the index was **back**
with 2,766,148 docs, and the next sync's `indexExists` returned true so it
upserted into the recovered (1-shard) index. This is consistent with a
DELETE-acknowledged-but-cluster-state-not-yet-persisted window overlapping the
restart, but I could not directly confirm the mechanism (no OS-level
cluster-state logging captured). Marking the *mechanism* as **unverified**;
the *absence of a post-delete verification* in `deleteIndex` is verified.

---

## 2. Re-merge PG statement-timeout (the bug bypassed by sync-os-direct.ts)

**The query** — `src/services/funnel/mergeStage.ts:914-918`:
```ts
const hasExisting = await query(
  `SELECT count(*)::text AS count FROM object_instances
     WHERE ontology_id = $1 AND object_type_api_name = $2`,
  [input.ontologyId, input.objectTypeApiName],
);
```
This is the `hasExisting` check that decides whether the RE-merge loads
existing instances. For OlivierOrder2 it counts the 4,657,493 existing rows.

**statement_timeout value + where set** — `src/db.ts:76`:
```ts
statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || "60000", 10),
```
- Default **60 s**, env-tunable via `PG_STATEMENT_TIMEOUT_MS`. Set as a libpq
  connection parameter on the pg `Pool`, so PG itself cancels the statement
  (server-side). `SHOW statement_timeout` on the dev DB returns `0` because
  that is the superuser/role default; the **app pool** sets 60s per connection.
- `idle_in_transaction_session_timeout` = 60s (`db.ts:82`, `PG_IDLE_TX_TIMEOUT_MS`).

**Verified failure output (this session):**
```
error: error: canceling statement due to statement timeout
    at async mergeChangesSQL (src/services/funnel/mergeStage.ts:914:27)
    at async runMergeActivityImpl (src/services/funnel/temporal/activities.ts:321:15)
activityType: 'runMergeActivity', attempt 1..4
```

**Still broken in the Temporal path?** **Yes — confirmed.** `mergeStage.ts:914`
is unchanged. The only thing that changed is that I routed the OS sync around
the workflow via `scripts/sync-os-direct.ts`; the merge `count(*)` path the
Temporal workflow will use in production is untouched and will time out at 60s
on any RE-merge whose existing rowcount makes `count(*)` exceed 60s on this PG.

---

## 3. Memory sizing (current, dev)

**Verified (docker inspect + OS node stats + OS logs):**
```
docker mem_limit        = 4294967296 (4 GiB)
docker memswap_limit    = -1  (unlimited swap)
docker memswappiness    = <nil> (unset)

OPENSEARCH_JAVA_OPTS    = -Xms512m -Xmx1536m
heap_max_in_bytes       = 1610612736 (1.5 GiB)   [live, from _nodes/stats/jvm]
-XX:MaxDirectMemorySize = 805306368 (768 MiB)    [from OS JVM args log]
```

**Ratios:**
- JVM committed ceiling ≈ heap (1.5 GiB) + direct (768 MiB) = **2.3 GiB**.
- Container = 4 GiB → JVM is **~57%** of the container, leaving ~1.7 GiB for
  the rest (JVM non-heap/native + Lucene mmap-allocated segment files + the
  container's own overhead).
- This 4 GiB / 2.3 GiB split was arrived at **empirically** (bumped from
  1 GiB → 2 GiB → 4 GiB until one run succeeded). It is not derived from a
  sizing rule.

**bootstrap.memory_lock — NOT enabled:**
```
opensearch.yml: (no memory_lock / bootstrap line — only a comment about bootstrap checks)
GET _nodes/settings?filter_path=nodes.*.settings.bootstrap  ->  {}   (empty)
```
So `bootstrap.memory_lock` is unset/false. Combined with `memswap_limit=-1`
(unlimited swap), Lucene's mmap segment pages are **not pinned** and **can be
swapped**. This is the combination flagged in the task: unlimited swap with no
mlock → under memory pressure the OS can page mmap segment files to swap,
causing the GC/IO thrash that produced the ECONNRESET / "Request timed out"
symptoms at ~2.1–2.5M docs.

**Whether mlock is available:** not verified. Enabling `bootstrap.memory_lock`
requires `ulimit -l unlimited` (or `--cap-add=IPC_LOCK`) on the container;
I did not check whether the dev docker setup grants that. → **unverified**.

---

## 4. Resume/heartbeat mechanism — has it ever been exercised?

**The code exists:**
- `src/services/opensearch/syncFromInstances.ts:95` `readResumeCursor()` —
  reads `Context.current().info.heartbeatDetails` (the last heartbeat cursor).
- `:108` `heartbeatCursor(key)` — calls `Context.current().heartbeat(key)`.
- `:243` `let lastSeenKey = readResumeCursor();` (start of paging).
- `:386` `heartbeatCursor(lastSeenKey);` (after each page).
- `src/services/funnel/temporal/workflows.ts:85` `syncOpenSearchActivity`
  proxy: `startToCloseTimeout: "60 minutes"`, `heartbeatTimeout: "120 seconds"`.

**Has an actual mid-sync worker death triggered the resume?**
**No — verified by absence.** After `heartbeatTimeout` was added (the
~09:03 backend restart with the new `workflows.ts`), the only Temporal run for
OlivierOrder2 is the 09:05 run, which **failed at the merge stage** (PG
statement-timeout, §2) and never reached `syncOpenSearchActivity`. The
**successful** 4.66M sync was `scripts/sync-os-direct.ts`, which calls
`syncObjectInstancesToOpenSearch` directly and **bypasses Temporal entirely**
(no `Context.current()`, no heartbeat — `readResumeCursor`/`heartbeatCursor`
are no-ops outside an activity).

→ The heartbeat-resume path is **assumed to work** (the code reads
`heartbeatDetails` + resumes the keyset cursor), but it has **never been
exercised by a real mid-sync worker kill**. The retry/resume loop in
`syncFromInstances.ts:289-388` (backpressure backoff + per-item-failed retry)
is likewise only assumed.

---

## 5. Registry drift — why `object_types` / `object_type_datasources` / `funnel_bindings` are empty

**Verified counts:**
```
object_types(plural)      | 0
object_type(singular)     | 9
object_type_datasources   | 0
backing_datasource        | 9
funnel_bindings           | 0
funnel_state              | 9
```

**Which tables production code reads FROM (grep `FROM`/`JOIN`):**
- `object_type` (singular): `src/indexer.ts`, `src/models/linkType.ts`,
  `src/actions/objectChecker.ts`, migrations, seeds. ← **the OT-indexing live registry**
- `backing_datasource`: `src/indexer.ts`, `src/routes/{datasets,edits,reindex,indexing,reindexStatus}.ts`,
  `src/services/{reindexService,autoIndexService}.ts`, seeds. ← **the live backing registry**
- `object_types` (plural): **only** `src/services/orchestration/datasource-compiler-consumer.ts`
- `object_type_datasources`: `src/services/objectTypeService.ts`, `src/services/orchestration/datasource-compiler-consumer.ts`
- `funnel_bindings`: **only** `src/services/funnel/bindings/repo.ts`

**Confirmed:** the funnel's own changelog/merge activities read `object_type`
(singular) + `backing_datasource` (e.g. `activities.ts:614,675`
`FROM backing_datasource bd JOIN object_type ot ...`), **not** the plural
tables. So OT indexing is unaffected by the empty plural tables.

**Why the plural tables are empty:** Correction to my earlier loose statement
("a prior seed reset"). `resetEnterpriseOntologyForSeed` in
`src/seeds/seedOntology.ts` deletes from `object_type` (singular) + `link_type`
— it does **not** touch the plural tables. The plural tables
(`object_types`, `object_type_datasources`, `funnel_bindings`) belong to a
**separate subsystem** (orchestration / datasource-compiler / funnel-bindings
management) and were **never populated in this dev env**. They are not
"drifted from" the singular tables; they are a different registry that simply
has no rows here.

**Assumption (not directly verified):** whether the orchestration /
datasource-compiler / funnel-bindings features are *expected* to have rows in
this dev env, or whether their emptiness is a separate seeding bug, was not
determined. I verified only: (a) they are empty, (b) the OT-indexing path does
not read them, (c) the singular/backing live registry is populated and is what
the funnel uses.

---

## 6. Replica / HA config for the OS index

**Verified:**
```
ontology-olivierorder2: number_of_shards=4, number_of_replicas=0
ontology-olivierorder1: number_of_shards=1, number_of_replicas=0
```
- `number_of_replicas: 0` is **hardcoded** in both:
  - `src/services/opensearch/templateRegistry.ts:59` (`DEFAULT_TEMPLATE_SETTINGS`)
  - `src/services/opensearch/indexMappingGenerator.ts:115` (`DEFAULT_INDEX_SETTINGS`)
- It is **not environment-aware** (no `process.env.OS_REPLICAS` or similar).
  Dev and prod would both get 0 replicas.
- The cluster is `discovery.type=single-node`, so 0 replicas is consistent for
  dev but the hardcoded value means a multi-node prod deployment would also
  get 0 replicas (no HA) unless overridden.

---

## Verified vs. Assuming (mandatory)

**Verified directly (command output this session):**
- BONUS: `funnel_state`=indexed (10:33:54) vs latest `funnel_run`=failed/merge (09:30:37) — divergence is the bypass artifact.
- §1a: `createIndex` throws if exists (`indexLifecycleManager.ts:131-136`); caller `syncFromInstances.ts:142-147` skips it on exists → upserts with no shard check. Drift confirmed: oo1=1 shard, oo2=4 shards.
- §1b: `deleteIndex` (`:188-211`) returns on acknowledged, no post-delete `exists` check.
- §2: timeout query = `mergeStage.ts:914-918` `count(*)`; `statement_timeout`=`db.ts:76` 60s (`PG_STATEMENT_TIMEOUT_MS`); failure stack confirmed; path unchanged (still broken in Temporal).
- §3: heap 1.5GiB, MaxDirectMemorySize 768MiB, mem_limit 4GiB, memswap=-1, bootstrap.memory_lock NOT set (`{}`).
- §4: resume code exists (`syncFromInstances.ts:95,108,243,386`); the only post-heartbeatTimeout Temporal run failed at merge (never reached OS sync); the successful sync bypassed Temporal.
- §5: counts (plural=0, singular=9, backing=9, bindings=0); grep of which files read which tables; funnel activities read singular+backing.
- §6: replicas=0 hardcoded (`templateRegistry.ts:59`, `indexMappingGenerator.ts:115`); not env-aware; confirmed on both live indices.

**Assuming / unverified:**
- §1b: the *mechanism* of the DELETE-vs-restart race (acknowledged-but-not-persisted) is inferred from one observation; not directly confirmed via OS cluster-state logs.
- §3: whether `bootstrap.memory_lock` can be enabled in this docker setup (needs `ulimit -l` / `IPC_LOCK`) — not checked.
- §4: that the heartbeat-resume actually works on a real mid-sync worker kill — never exercised; the code path is assumed correct.
- §5: whether the empty plural tables are a real bug for the orchestration/funnel-bindings features, or simply unused in this dev env — not determined.
- §2 (root cause of the 60s timeout being hit): whether the dev PG's `/dev/shm` constraint (Phase 1 prior work) is what makes `count(*)` on 4.66M rows exceed 60s, vs. a genuinely slow query — not isolated. The timeout value (60s) and the query (count(*)) are verified; the *reason* it exceeds 60s on this PG is inferred.
- General: the successful 4.66M sync is a **single data point**. Nothing above should be read as proof that the current config is correct or stable under repeat load — only that one run completed.
