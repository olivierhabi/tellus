// Step 3a test: attempt a sync against a deliberately shard-mismatched index
// and confirm it FAILS FAST with the right error (does not proceed to bulk
// index into the wrong shape). Uses OlivierOrder1's live index (currently 1
// shard) against OS_INDEX_SHARDS=4. Run BEFORE backfilling OO1 to 4 shards:
//   OS_INDEX_SHARDS=4 npx tsx scripts/verify-shard-mismatch.ts
import "dotenv/config";
import { syncObjectInstancesToOpenSearch } from "../src/services/opensearch/syncFromInstances";

async function main(): Promise<void> {
  console.log("OS_INDEX_SHARDS env =", process.env.OS_INDEX_SHARDS ?? "(unset)");
  console.log("attempting sync of OlivierOrder1 (its index has 1 shard)...");
  const t0 = Date.now();
  try {
    await syncObjectInstancesToOpenSearch("OlivierOrder1");
    throw new Error("FAIL: sync did NOT throw on shard mismatch");
  } catch (e) {
    const dt = Date.now() - t0;
    const msg = (e as Error).message;
    if (!/shard-mismatched index/.test(msg)) {
      throw new Error(`FAIL: wrong error message: ${msg}`);
    }
    if (dt > 30000) {
      throw new Error(`FAIL: did not fail fast (took ${dt}ms — proceeded into bulk indexing?)`);
    }
    console.log(`PASS (sync failed fast in ${dt}ms): ${msg.slice(0, 160)}`);
  }
}

main().catch((e) => { console.error("FAIL:", (e as Error).message); process.exit(1); });
