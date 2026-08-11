process.env.DUCKDB_MEMORY_LIMIT="1GB"; process.env.DUCKDB_TEMP_DIR="/tmp/duckdb_cols_probe";
import { acquireConnection, queryAll, runAll, __resetPoolForTests } from "../src/services/duckdb/pool";
async function main(){
  const c = await acquireConnection({skipHttpfs:true});
  await runAll(c,"CREATE TEMP TABLE leak_a AS SELECT range AS pk FROM range(10)");
  const cols = await queryAll<any>(c,"SELECT column_name FROM information_schema.columns WHERE table_name='duckdb_tables'");
  console.log("duckdb_tables() columns:", cols.map(x=>x.column_name).join(", "));
  const rows = await queryAll<any>(c,"SELECT * FROM duckdb_tables()");
  for (const r of rows) console.log("  row:", JSON.stringify(r));
  __resetPoolForTests();
}
main().catch(e=>{console.error(e.message);process.exit(1)});
