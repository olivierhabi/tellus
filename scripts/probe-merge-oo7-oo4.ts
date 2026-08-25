// In-process verification of the Phase-1 DuckDB SQL merge path
// (mergeChangesFromSnapshots → mergeChangesSQL) on the LIVE data.
//
// Why in-process (not the funnel signal): the live backend HAS the Phase-1
// code (mergeStage.ts uncommitted on the main checkout), BUT the object_type
// record for OlivierOrder7 was deleted/reset (object_types has 0 rows), so
// POST /api/v1/funnel/signals returns 404 "Object type not found". This script
// calls the SAME code path the Temporal runMergeActivity would, bypassing the
// object_type lookup, directly on the changelog parquet_ref.
//
// OO7: changelog snapshot a4779aa9 (4,657,493 rows, all INSERTs, 0 edits, 0 existing).
// OO4: changelog snapshot d5b958bf (848,195 rows — previously "socket hang up").
//
// Run: npx tsx scripts/probe-merge-oo7-oo4.ts [OlivierOrder7|OlivierOrder4|both]
import "dotenv/config";
import { mergeChangesFromSnapshots } from "../src/services/funnel/mergeStage";
import { query } from "../src/db";

interface MergeTarget {
  ot: string;
  snapshotId: string;
  mergedTableId: string;
  mergedLocation: string;
  expectedRows: number;
}

const TARGETS: Record<string, MergeTarget> = {
  OlivierOrder7: {
    ot: "OlivierOrder7",
    snapshotId: "a4779aa9-058c-4b44-a272-3d5b67f14f2b",
    mergedTableId: "602ec9a6-2faa-4110-8e6c-7779975b3ac2",
    mergedLocation: "s3://_funnel/OlivierOrder7/merged/state",
    expectedRows: 4657493,
  },
  OlivierOrder4: {
    ot: "OlivierOrder4",
    snapshotId: "d5b958bf-958c-4bd4-be29-c0f6ea5e7e30",
    mergedTableId: "df76a40e-4c45-4ff9-84b3-e83d645fd7bd",
    mergedLocation: "s3://_funnel/OlivierOrder4/merged/state",
    expectedRows: 848195,
  },
};

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";

async function osCount(ot: string): Promise<string> {
  try {
    const r = await fetch(
      `http://localhost:9200/ontology-${ot.toLowerCase()}/_count`,
    );
    if (!r.ok) return `N/A (HTTP ${r.status})`;
    const j = (await r.json()) as { count?: number };
    return String(j.count ?? "?");
  } catch (e) {
    return `err: ${(e as Error).message}`;
  }
}

async function pgCount(ot: string): Promise<number> {
  const res = await query(
    `SELECT count(*) AS cnt FROM object_instances WHERE object_type_api_name = $1`,
    [ot],
  );
  return Number(res.rows[0].cnt);
}

async function runOne(target: MergeTarget): Promise<void> {
  const { ot, snapshotId, mergedTableId, mergedLocation, expectedRows } = target;
  const runKey = `verify-merge-${ot.toLowerCase()}-${Date.now()}`;
  const t0 = Date.now();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`[merge] ${ot} start @ ${new Date().toISOString()}`);
  console.log(
    `[merge] snapshot=${snapshotId} mergedTableId=${mergedTableId} runKey=${runKey}`,
  );

  const preCount = await pgCount(ot);
  const preOs = await osCount(ot);
  console.log(
    `[merge] PRE: object_instances=${preCount} os_count=${preOs} (expected after=${expectedRows})`,
  );

  // Peak RSS monitoring (process.memoryUsage is the authoritative in-process
  // metric; ps -o rss is polled below for cross-check).
  let peakRss = process.memoryUsage().rss;
  let peakHeap = process.memoryUsage().heapUsed;
  const rssInterval = setInterval(() => {
    const mem = process.memoryUsage();
    if (mem.rss > peakRss) peakRss = mem.rss;
    if (mem.heapUsed > peakHeap) peakHeap = mem.heapUsed;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(
      `[merge] t=${elapsed}s rss=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB peak_rss=${Math.round(peakRss / 1024 / 1024)}MB`,
    );
  }, 15000);

  try {
    const result = await mergeChangesFromSnapshots({
      ontologyId: ONTOLOGY_ID,
      objectTypeApiName: ot,
      changelogSnapshots: [
        {
          datasource_id: ZERO_UUID,
          snapshot_id: snapshotId,
          owned_properties: [],
          markings: [],
        },
      ],
      editsBatch: [],
      editStrategy: "user_edit_wins",
      mergedTableId,
      mergedOutputFileLocation: `${mergedLocation}/data/${new Date().toISOString()}.parquet`,
      runKey,
    });

    clearInterval(rssInterval);
    const wall = Date.now() - t0;

    console.log(`[merge] ${ot} DONE wall=${wall}ms (${(wall / 1000).toFixed(1)}s)`);
    console.log(
      `[merge] result: snapshotId=${result.snapshotId} upserts=${result.upserts} deletes=${result.deletes} editsConsumed=${result.editsConsumed}`,
    );
    console.log(`[merge] parquetRef=${JSON.stringify(result.parquetRef)}`);
    console.log(
      `[merge] peak RSS=${Math.round(peakRss / 1024 / 1024)}MB peak heap=${Math.round(peakHeap / 1024 / 1024)}MB`,
    );

    const postCount = await pgCount(ot);
    const postOs = await osCount(ot);
    const match = postCount === expectedRows ? "MATCH" : "MISMATCH";
    console.log(
      `[merge] POST: object_instances=${postCount} (expected=${expectedRows}) → ${match}`,
    );
    console.log(`[merge] POST: os_count=${postOs}`);
    if (postCount !== expectedRows) {
      console.error(`[merge] *** COUNT MISMATCH for ${ot} ***`);
    }
  } catch (e) {
    clearInterval(rssInterval);
    const wall = Date.now() - t0;
    console.error(
      `[merge] ${ot} FAILED @ t=${Math.round(wall / 1000)}s: ${(e as Error).message}`,
    );
    console.error((e as Error).stack);
    throw e;
  }
}

async function main() {
  const which = process.argv[2] || "both";
  console.log(`[merge] Phase-1 in-process merge verification — target=${which}`);
  console.log(
    `[merge] node pid=${process.pid} initial RSS=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
  );

  if (which === "both") {
    await runOne(TARGETS.OlivierOrder7);
    console.log(`\n[merge] OO7 done. Starting OO4 in 3s...`);
    await new Promise((r) => setTimeout(r, 3000));
    await runOne(TARGETS.OlivierOrder4);
  } else {
    const target = TARGETS[which];
    if (!target) {
      console.error(`Unknown target: ${which}. Use OlivierOrder7|OlivierOrder4|both`);
      process.exit(1);
    }
    await runOne(target);
  }

  console.log(`\n[merge] ALL DONE @ ${new Date().toISOString()}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`[merge] FATAL: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
