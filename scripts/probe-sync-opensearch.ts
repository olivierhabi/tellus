// Direct, in-process run of syncObjectInstancesToOpenSearch — NO Temporal
// 10-min startToCloseTimeout. If this COMPLETES (slowly), the workflow's
// failure was the Temporal timeout (sync too slow). If it ERRORS, we capture
// the actual OS rejection. Run: `npx tsx scripts/probe-sync-opensearch.ts OlivierOrder4`
import "dotenv/config";
import { syncObjectInstancesToOpenSearch } from "../src/services/opensearch/syncFromInstances";

const ot = process.argv[2] || "OlivierOrder4";
const t0 = Date.now();
console.log(`[probe] syncObjectInstancesToOpenSearch("${ot}") start @ ${new Date().toISOString()}`);
// Progress heartbeat: poll the OS _count every 15s so we see the rate even
// though the sync itself blocks.
let beating = true;
const beat = async () => {
  while (beating) {
    await new Promise((r) => setTimeout(r, 15000));
    try {
      const r = await fetch(`http://localhost:9200/ontology-${ot.toLowerCase()}/_count`);
      const j = await r.json();
      console.log(`[probe] t=${Math.round((Date.now() - t0) / 1000)}s os_count=${j.count}`);
    } catch (e) {
      console.log(`[probe] t=${Math.round((Date.now() - t0) / 1000)}s os_count fetch err: ${(e as Error).message}`);
    }
  }
};
void beat();
syncObjectInstancesToOpenSearch(ot)
  .then((r) => {
    beating = false;
    console.log(`[probe] SYNC DONE rowsRead=${r.rowsRead} rowsIndexed=${r.rowsIndexed} rowsOrphanDeleted=${r.rowsOrphanDeleted} indexCreated=${r.indexCreated} durationMs=${r.durationMs} (wall=${Date.now() - t0})`);
  })
  .catch((e) => {
    beating = false;
    console.error(`[probe] SYNC FAILED @ t=${Math.round((Date.now() - t0) / 1000)}s: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  });
