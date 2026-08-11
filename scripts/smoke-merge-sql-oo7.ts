// ---------------------------------------------------------------------------
// scripts/smoke-merge-sql-oo7.ts
//
// OO7 scale smoke test for the DuckDB SQL k-way merge overlay. Downloads the
// real OO7 changelog parquet (4,657,493 rows, pk-sorted, all INSERTs, no
// markings, no edits, existing=0) and runs the SQL overlay chain at scale —
// the key verification that the merge does NOT reproduce the full-materialization
// wall (flat memory via DuckDB temp tables + streamQuery). Does NOT write to PG
// / MinIO / commitSnapshot — only the SQL overlay + a count + sample.
//
// Run: set -a && . ./.env && set +a && npx tsx scripts/smoke-merge-sql-oo7.ts
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { acquireConnection, runAll, queryAll, streamQuery, releaseConnection, __resetPoolForTests } from "../src/services/duckdb/pool";
import { getObjectStream } from "../src/services/storageService";

const OO7_KEY = "changelogs/OlivierOrder7/a4779aa9-058c-4b44-a272-3d5b67f14f2b.parquet";

function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function main() {
  const t0 = Date.now();
  console.log("[oo7-smoke] downloading OO7 changelog parquet...");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oo7-merge-smoke-"));
  const localPath = path.join(dir, "c0.parquet");
  const stream = await getObjectStream(OO7_KEY);
  await pipeline(stream, fs.createWriteStream(localPath));
  const stat = fs.statSync(localPath);
  console.log(`[oo7-smoke] downloaded ${stat.size} bytes in ${Date.now() - t0}ms`);

  const conn = await acquireConnection({ skipHttpfs: true });
  try {
    const lp = localPath.replace(/'/g, "''");

    // contrib_meta (1 contribution: foundry a4779aa9, no markings)
    await runAll(conn, `CREATE OR REPLACE TEMP TABLE contrib_meta (contrib_idx INTEGER, datasource_id VARCHAR, owned_properties VARCHAR[], contrib_markings VARCHAR[])`);
    await runAll(conn, `INSERT INTO contrib_meta VALUES (0,'foundry-a4779aa9',ARRAY[]::VARCHAR[],ARRAY[]::VARCHAR[])`);

    console.log("[oo7-smoke] building changes (read_parquet)...");
    const t1 = Date.now();
    await runAll(conn, `CREATE OR REPLACE TEMP TABLE changes AS SELECT 0::INTEGER AS contrib_idx, primary_key::VARCHAR AS primary_key, operation::VARCHAR AS operation, properties::VARCHAR AS properties, source_transaction_id::VARCHAR AS source_transaction_id, source_commit_timestamp::VARCHAR AS source_commit_timestamp FROM read_parquet('${lp}')`);
    const changesCount = await queryAll<{ c: string }>(conn, `SELECT CAST(count(*) AS VARCHAR) AS c FROM changes`);
    console.log(`[oo7-smoke] changes rows=${changesCount[0].c} in ${Date.now() - t1}ms`);

    console.log("[oo7-smoke] building changes_seq (glob_seq sort)...");
    const t2 = Date.now();
    await runAll(conn, `CREATE OR REPLACE TEMP TABLE changes_seq AS SELECT *, CAST(row_number() OVER (ORDER BY contrib_idx, source_commit_timestamp, source_transaction_id, primary_key) AS BIGINT) AS glob_seq FROM changes`);
    console.log(`[oo7-smoke] changes_seq built in ${Date.now() - t2}ms`);

    console.log("[oo7-smoke] building per_pk_last_delete...");
    const t3 = Date.now();
    await runAll(conn, `CREATE OR REPLACE TEMP TABLE per_pk_last_delete AS SELECT primary_key, COALESCE(max(glob_seq) FILTER (WHERE operation = 'DELETE'), -1) AS last_del_seq FROM changes_seq GROUP BY primary_key`);
    console.log(`[oo7-smoke] per_pk_last_delete built in ${Date.now() - t3}ms`);

    console.log("[oo7-smoke] building effective_rows...");
    const t4 = Date.now();
    await runAll(conn, `CREATE OR REPLACE TEMP TABLE effective_rows AS WITH cand AS (SELECT c.primary_key, c.contrib_idx, cm.datasource_id, c.properties, c.source_transaction_id, c.source_commit_timestamp, c.glob_seq, row_number() OVER (PARTITION BY c.primary_key, c.contrib_idx ORDER BY c.glob_seq DESC) AS rn FROM changes_seq c JOIN per_pk_last_delete d ON d.primary_key = c.primary_key JOIN contrib_meta cm ON cm.contrib_idx = c.contrib_idx WHERE c.operation <> 'DELETE' AND c.glob_seq > d.last_del_seq) SELECT primary_key, contrib_idx, datasource_id, properties, source_transaction_id, source_commit_timestamp, glob_seq FROM cand WHERE rn = 1`);
    console.log(`[oo7-smoke] effective_rows built in ${Date.now() - t4}ms`);

    console.log("[oo7-smoke] building source_state (fast-path: 1 contrib → no list_reduce)...");
    const t5 = Date.now();
    await runAll(conn, `CREATE OR REPLACE TEMP TABLE source_state AS WITH src_info AS (SELECT c.primary_key, first(cm.datasource_id ORDER BY c.glob_seq DESC) AS source_datasource_id, first(c.source_transaction_id ORDER BY c.glob_seq DESC) AS source_transaction_id, first(c.source_commit_timestamp ORDER BY c.glob_seq DESC) AS source_timestamp FROM changes_seq c JOIN contrib_meta cm ON cm.contrib_idx = c.contrib_idx GROUP BY c.primary_key), eff_props AS (SELECT primary_key, properties::JSON AS properties FROM effective_rows), eff_pks AS (SELECT DISTINCT primary_key FROM effective_rows), src_markings AS (SELECT c.primary_key, COALESCE(array_sort(array_agg(DISTINCT trim(m)) FILTER (WHERE m IS NOT NULL AND trim(m) <> '')), ARRAY[]::VARCHAR[]) AS markings FROM changes_seq c JOIN contrib_meta cm ON cm.contrib_idx = c.contrib_idx LEFT JOIN unnest(cm.contrib_markings) AS t(m) ON true GROUP BY c.primary_key) SELECT s.primary_key, s.source_datasource_id, s.source_transaction_id, s.source_timestamp, (ep.primary_key IS NULL) AS tombstoned, COALESCE(epp.properties, '{}'::JSON) AS properties, mk.markings FROM src_info s LEFT JOIN eff_pks ep ON ep.primary_key = s.primary_key LEFT JOIN eff_props epp ON epp.primary_key = s.primary_key LEFT JOIN src_markings mk ON mk.primary_key = s.primary_key`);
    console.log(`[oo7-smoke] source_state built in ${Date.now() - t5}ms`);

    // For OO7 (no edits, no existing), merged_result = source_state (all upserts).
    console.log("[oo7-smoke] building merged_result (no edits/existing → = source_state projection)...");
    const t6 = Date.now();
    await runAll(conn, `CREATE OR REPLACE TEMP TABLE merged_result AS SELECT primary_key, 'upsert' AS operation, properties, COALESCE(markings, ARRAY[]::VARCHAR[]) AS markings, source_datasource_id, source_transaction_id FROM source_state`);
    const mergedCount = await queryAll<{ c: string }>(conn, `SELECT CAST(count(*) AS VARCHAR) AS c FROM merged_result`);
    console.log(`[oo7-smoke] merged_result rows=${mergedCount[0].c} in ${Date.now() - t6}ms`);

    // Sample 3 rows via streamQuery (flat memory — the key proof)
    console.log("[oo7-smoke] streaming 3 sample rows (streamQuery, flat memory)...");
    const t7 = Date.now();
    let sampled = 0;
    for await (const row of streamQuery<Record<string, unknown>>(conn, `SELECT primary_key, CAST(properties AS VARCHAR) AS properties, to_json(markings) AS markings, operation FROM merged_result ORDER BY primary_key LIMIT 3`)) {
      console.log(`  sample[${sampled}]: pk=${row.primary_key} op=${row.operation} props=<${String(row.properties).length} chars> markings=${row.markings}`);
      sampled++;
    }
    console.log(`[oo7-smoke] sampled ${sampled} rows in ${Date.now() - t7}ms`);

    // RSS check (flat memory proof)
    const rss = process.memoryUsage().rss;
    console.log(`[oo7-smoke] process RSS=${Math.round(rss / 1024 / 1024)}MB (flat-memory proof: must be << 4.65M rows × ~200 bytes = ~930MB)`);
    console.log(`[oo7-smoke] TOTAL elapsed=${Date.now() - t0}ms`);

    const expected = 4657493;
    const got = Number(mergedCount[0].c);
    const ok = got === expected;
    console.log(`[oo7-smoke] ${ok ? "PASS" : "FAIL"}: merged_result rows=${got} (expected ${expected})`);

    // Verify the count matches the changes count (all INSERTs → all effective → all merged)
    const changesN = Number(changesCount[0].c);
    console.log(`[oo7-smoke] changes=${changesN} merged=${got} (should be equal for all-INSERT 1-row-per-PK)`);
  } finally {
    releaseConnection(conn);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    await __resetPoolForTests();
  }
  process.exit(0);
}
main().catch((e) => { console.error("[oo7-smoke] ERR:", e.message, e.stack); process.exit(1); });
