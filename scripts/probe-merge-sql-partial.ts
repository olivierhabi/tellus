// Probe: tombstone -> partial untombstone -> partial update (same contrib,
// different owned keys per row). Confirms whether the SQL "keep only last
// non-DELETE row per (PK, contrib)" + whole-properties json_merge_patch drops
// earlier partial contributions (DATA LOSS) vs the JS spec which accumulates.
import fs from "fs"; import path from "path"; import os from "os";
import { acquireConnection, runAll, streamQuery, releaseConnection, __resetPoolForTests } from "../src/services/duckdb/pool";
import type { ChangelogRow } from "../src/services/funnel/changelogStage";

function sqlStr(s: string): string { return `'${String(s).replace(/'/g, "''")}'`; }
function sqlVarcharArray(arr: string[]): string { return arr.length===0?"ARRAY[]::VARCHAR[]":`ARRAY[${arr.map(sqlStr).join(",")}]::VARCHAR[]`; }

async function writeCL(conn: any, rows: ChangelogRow[]): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-cl-"));
  const lp = path.join(dir, "c.parquet");
  const tbl = `probe_cl_${Math.random().toString(36).slice(2)}`;
  await runAll(conn, `CREATE TEMP TABLE ${tbl} (primary_key VARCHAR, operation VARCHAR, properties VARCHAR, source_transaction_id VARCHAR, source_commit_timestamp VARCHAR)`);
  if (rows.length>0){const vals=rows.map(r=>`(${sqlStr(r.primary_key)},${sqlStr(r.operation)},${sqlStr(JSON.stringify(r.properties))},${sqlStr(r.source_transaction_id)},${sqlStr(r.source_commit_timestamp)})`).join(",");await runAll(conn,`INSERT INTO ${tbl} VALUES ${vals}`);}
  await runAll(conn, `COPY (SELECT * FROM ${tbl}) TO '${lp.replace(/'/g,"''")}' (FORMAT PARQUET, CODEC 'ZSTD')`);
  await runAll(conn, `DROP TABLE ${tbl}`);
  return lp;
}

async function main() {
  const conn = await acquireConnection({ skipHttpFs: true });
  // 1 contribution: ds-a, owned=[a1,a2], markings=[].
  // PK k1: INSERT{a1:1,a2:1} -> DELETE{} -> INSERT{a1:3} (partial, no a2) -> UPDATE{a2:4} (partial, no a1)
  const rows: ChangelogRow[] = [
    { primary_key: "k1", operation: "INSERT", properties: { a1: 1, a2: 1 }, source_transaction_id: "t1", source_commit_timestamp: "2020-01-01T00:00:00Z" },
    { primary_key: "k1", operation: "DELETE", properties: {}, source_transaction_id: "t2", source_commit_timestamp: "2020-01-02T00:00:00Z" },
    { primary_key: "k1", operation: "INSERT", properties: { a1: 3 }, source_transaction_id: "t3", source_commit_timestamp: "2020-01-03T00:00:00Z" },
    { primary_key: "k1", operation: "UPDATE", properties: { a2: 4 }, source_transaction_id: "t4", source_commit_timestamp: "2020-01-04T00:00:00Z" },
  ];
  const lp = await writeCL(conn, rows);

  // ---- SQL chain (mirrors mergeChangesSQL steps 2-10, single-contrib fast path) ----
  await runAll(conn, `CREATE OR REPLACE TEMP TABLE contrib_meta (contrib_idx INTEGER, datasource_id VARCHAR, owned_properties VARCHAR[], contrib_markings VARCHAR[])`);
  await runAll(conn, `INSERT INTO contrib_meta VALUES (0,'ds-a',${sqlVarcharArray(["a1","a2"])},${sqlVarcharArray([])})`);
  await runAll(conn, `CREATE OR REPLACE TEMP TABLE changes AS SELECT 0::INTEGER AS contrib_idx, primary_key::VARCHAR AS primary_key, operation::VARCHAR AS operation, properties::VARCHAR AS properties, source_transaction_id::VARCHAR AS source_transaction_id, source_commit_timestamp::VARCHAR AS source_commit_timestamp FROM read_parquet('${lp.replace(/'/g,"''")}')`);
  await runAll(conn, `CREATE OR REPLACE TEMP TABLE changes_seq AS SELECT *, CAST(row_number() OVER (ORDER BY contrib_idx, source_commit_timestamp, source_transaction_id, primary_key) AS BIGINT) AS glob_seq FROM changes`);
  await runAll(conn, `CREATE OR REPLACE TEMP TABLE per_pk_last_delete AS SELECT primary_key, COALESCE(max(glob_seq) FILTER (WHERE operation='DELETE'), -1) AS last_del_seq FROM changes_seq GROUP BY primary_key`);
  await runAll(conn, `CREATE OR REPLACE TEMP TABLE effective_rows AS SELECT c.primary_key, c.contrib_idx, c.properties, c.source_transaction_id, c.source_commit_timestamp, c.glob_seq FROM changes_seq c JOIN per_pk_last_delete d ON d.primary_key=c.primary_key JOIN contrib_meta cm ON cm.contrib_idx=c.contrib_idx WHERE c.operation<>'DELETE' AND c.glob_seq>d.last_del_seq`);
  // FIXED: accumulate per (PK, contribution) — CASE count=1 THEN first ELSE fold
  await runAll(conn, `CREATE OR REPLACE TEMP TABLE source_state AS WITH src_info AS (SELECT c.primary_key, first(cm.datasource_id ORDER BY c.glob_seq DESC) AS source_datasource_id, first(c.source_transaction_id ORDER BY c.glob_seq DESC) AS source_transaction_id, first(c.source_commit_timestamp ORDER BY c.glob_seq DESC) AS source_timestamp FROM changes_seq c JOIN contrib_meta cm ON cm.contrib_idx=c.contrib_idx GROUP BY c.primary_key), eff_props AS (SELECT primary_key, CASE WHEN count(*)=1 THEN first(properties::JSON) ELSE list_reduce(list_prepend('{}'::JSON, list(properties::JSON ORDER BY glob_seq)), (acc,p)->json_merge_patch(acc,p)) END AS properties FROM effective_rows GROUP BY primary_key), eff_pks AS (SELECT DISTINCT primary_key FROM effective_rows), src_markings AS (SELECT c.primary_key, COALESCE(array_sort(array_agg(DISTINCT trim(m)) FILTER (WHERE m IS NOT NULL AND trim(m)<>'')), ARRAY[]::VARCHAR[]) AS markings FROM changes_seq c JOIN contrib_meta cm ON cm.contrib_idx=c.contrib_idx LEFT JOIN unnest(cm.contrib_markings) AS t(m) ON true GROUP BY c.primary_key) SELECT s.primary_key, s.source_datasource_id, s.source_transaction_id, s.source_timestamp, (ep.primary_key IS NULL) AS tombstoned, COALESCE(epp.properties,'{}'::JSON) AS properties, mk.markings FROM src_info s LEFT JOIN eff_pks ep ON ep.primary_key=s.primary_key LEFT JOIN eff_props epp ON epp.primary_key=s.primary_key LEFT JOIN src_markings mk ON mk.primary_key=s.primary_key`);
  await runAll(conn, `CREATE OR REPLACE TEMP TABLE merged_result AS SELECT s.primary_key, CASE WHEN s.tombstoned THEN 'delete' ELSE 'upsert' END AS operation, CASE WHEN s.tombstoned THEN '{}'::JSON ELSE s.properties END AS properties, s.markings FROM source_state s`);

  console.log("effective_rows (what survives the rn=1 filter):");
  for await (const r of streamQuery<any>(conn, `SELECT primary_key, properties, source_transaction_id, CAST(glob_seq AS VARCHAR) AS glob_seq FROM effective_rows`)) console.log("  ", JSON.stringify({ ...r, glob_seq: String(r.glob_seq) }));
  console.log("\nmerged_result (SQL output):");
  for await (const r of streamQuery<any>(conn, `SELECT primary_key, CAST(properties AS VARCHAR) AS properties, operation FROM merged_result`)) console.log("  ", JSON.stringify({pk:r.primary_key, props:JSON.parse(String(r.properties)), op:r.operation}));
  console.log("\nJS mergeChanges spec would produce: {a1:3, a2:4} (upsert) — accumulates both partial post-DELETE rows.");

  try { fs.rmSync(path.dirname(lp), { recursive: true, force: true }); } catch {}
  releaseConnection(conn); await __resetPoolForTests();
}
main().catch(e=>{console.error("ERR:",e.message,e.stack);process.exit(1);});
