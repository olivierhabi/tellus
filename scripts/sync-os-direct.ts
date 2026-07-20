// Direct OS sync: index an Object Type's object_instances into OpenSearch,
// bypassing the Temporal funnel workflow (which re-runs changelog+merge and
// enforces a per-activity startToCloseTimeout). Used to COMPLETE indexing
// when object_instances is already correct (merge done) but the OS index is
// incomplete — e.g. OlivierOrder2 (test04.csv, 4.66M instances) where the
// merge succeeded but the OS sync crashed mid-way (OS heap OOM).
//
// Usage: OS_INDEX_SHARDS=4 npx tsx scripts/sync-os-direct.ts OlivierOrder2
import "dotenv/config";
import { syncObjectInstancesToOpenSearch } from "../src/services/opensearch/syncFromInstances";

async function main(): Promise<void> {
  const apiName = process.argv[2] ?? "OlivierOrder2";
  console.log(
    `[os-sync-direct] start ${apiName} shards=${process.env.OS_INDEX_SHARDS ?? "1"} ${new Date().toISOString()}`,
  );
  const res = await syncObjectInstancesToOpenSearch(apiName);
  console.log(`[os-sync-direct] DONE ${apiName}:`, JSON.stringify(res));
}

main().catch((e) => {
  console.error("[os-sync-direct] FAIL:", (e as Error).message);
  console.error((e as Error).stack);
  process.exit(1);
});
