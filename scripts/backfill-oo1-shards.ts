// Step 3c: backfill ontology-olivierorder1 from 1 shard to OS_INDEX_SHARDS (4).
// Uses the new deleteIndex (polls until 404 — Step 3b) then re-syncs, which
// createIndex's with the configured shard count. Asserts no data loss
// (after count == before count) and after shards == OS_INDEX_SHARDS.
//   OS_INDEX_SHARDS=4 OPENSEARCH_REQUEST_TIMEOUT=120000 SYNC_OS_BATCH_DOCS=250 \
//     npx tsx scripts/backfill-oo1-shards.ts
import "dotenv/config";
import {
  deleteIndex,
  getIndexName,
} from "../src/services/opensearch/indexLifecycleManager";
import { syncObjectInstancesToOpenSearch } from "../src/services/opensearch/syncFromInstances";
import { client } from "../src/services/opensearch/client";

async function shardsOf(apiName: string): Promise<string> {
  const idx = getIndexName(apiName);
  const { body } = (await client.indices.getSettings({ index: idx })) as unknown as {
    body: Record<string, { settings: { index: { number_of_shards: string } } }>;
  };
  return body[idx].settings.index.number_of_shards;
}
async function countOf(apiName: string): Promise<number> {
  const idx = getIndexName(apiName);
  const { body } = (await client.count({ index: idx })) as unknown as { body: { count: number } };
  return body.count;
}

async function main(): Promise<void> {
  const api = "OlivierOrder1";
  console.log("OS_INDEX_SHARDS env =", process.env.OS_INDEX_SHARDS ?? "(unset)");
  const beforeShards = await shardsOf(api).catch(() => "absent");
  const beforeCount = await countOf(api).catch(() => -1);
  console.log("BEFORE: shards=", beforeShards, " docs=", beforeCount);

  console.log("deleteIndex(OlivierOrder1) [polls HEAD until 404]...");
  await deleteIndex(api);
  console.log("deleteIndex done (verified 404)");

  console.log("syncObjectInstancesToOpenSearch(OlivierOrder1) [recreate + reindex]...");
  const res = await syncObjectInstancesToOpenSearch(api);
  console.log("sync DONE:", JSON.stringify({ rowsRead: res.rowsRead, rowsIndexed: res.rowsIndexed, rowsFailed: res.rowsFailed, rowsOrphanDeleted: res.rowsOrphanDeleted, durationMs: res.durationMs }));

  const afterShards = await shardsOf(api);
  const afterCount = await countOf(api);
  console.log("AFTER:  shards=", afterShards, " docs=", afterCount);

  const expected = String(process.env.OS_INDEX_SHARDS ?? "1");
  if (afterShards !== expected) throw new Error(`FAIL: expected shards=${expected}, got ${afterShards}`);
  if (afterCount !== beforeCount) throw new Error(`FAIL: data loss — before=${beforeCount} after=${afterCount}`);
  console.log(`PASS: ${api} backfilled to ${afterShards} shards, no data loss (docs ${beforeCount} -> ${afterCount})`);
}

main().catch((e) => { console.error("FAIL:", (e as Error).message); process.exit(1); });
