// Probe: find the DuckDB SQL to list + drop ALL temp tables on a connection,
// so releaseConnection can clean up residual temp tables (the leak that
// pushed the 5.6M merge into DuckDB-OOM after the changelog's 5.6M dedup).
process.env.DUCKDB_MEMORY_LIMIT = "1GB";
process.env.DUCKDB_TEMP_DIR = "/tmp/duckdb_drop_probe";

import {
  acquireConnection,
  runAll,
  queryAll,
  releaseConnection,
  __resetPoolForTests,
} from "../src/services/duckdb/pool";

async function main() {
  const c = await acquireConnection({ skipHttpfs: true });
  await runAll(c, "CREATE TEMP TABLE leak_a AS SELECT range AS pk FROM range(100)");
  await runAll(c, "CREATE TEMP TABLE leak_b AS SELECT range AS pk FROM range(50)");
  console.log("created leak_a, leak_b");

  // Try several listing approaches + report which works.
  const tries = [
    "SELECT table_name FROM information_schema.tables WHERE table_schema='temp'",
    "SELECT table_name FROM duckdb_tables() WHERE schema_name='temp'",
    "SELECT name FROM duckdb_tables()",
    "SELECT table_name, table_schema FROM information_schema.tables WHERE table_name LIKE 'leak_%'",
  ];
  for (const sql of tries) {
    try {
      const r = await queryAll<any>(c, sql);
      console.log(`OK  [${sql}] => ${JSON.stringify(r)}`);
    } catch (e) {
      console.log(`ERR [${sql}] => ${(e as Error).message.slice(0, 70)}`);
    }
  }

  // Try DROP SCHEMA temp CASCADE
  try {
    await runAll(c, "DROP SCHEMA IF EXISTS temp CASCADE");
    console.log("DROP SCHEMA temp CASCADE: OK");
  } catch (e) {
    console.log("DROP SCHEMA temp CASCADE: ERR", (e as Error).message.slice(0, 70));
  }

  // Try dynamic DROP per temp table
  const list = await queryAll<{ table_name: string }>(
    c,
    "SELECT table_name FROM information_schema.tables WHERE table_schema='temp'",
  ).catch(() => [] as { table_name: string }[]);
  for (const { table_name } of list) {
    try {
      await runAll(c, `DROP TABLE IF EXISTS temp.${table_name}`);
      console.log(`  dropped temp.${table_name}`);
    } catch (e) {
      console.log(`  drop temp.${table_name} ERR:`, (e as Error).message.slice(0, 60));
    }
  }
  const after = await queryAll<{ table_name: string }>(
    c,
    "SELECT table_name FROM information_schema.tables WHERE table_schema='temp'",
  ).catch(() => [] as { table_name: string }[]);
  console.log("temp tables after cleanup:", after.map((r) => r.table_name));

  releaseConnection(c);
  await __resetPoolForTests();
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
