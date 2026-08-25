// De-risk test for the streaming foundry-bridged reader's DuckDB DISTINCT-ON
// dedup before the expensive OO7 run. Uploads a tiny CSV with duplicate PKs
// + a single-quote value, then asserts last-wins-by-file-order + escaping +
// JSON round-trip. Run: set -a && . ./.env && set +a && npx tsx scripts/test-foundry-dedup.ts
import "dotenv/config";
import { uploadObject, deleteObject } from "../src/services/storageService";
import { buildFoundryBridgedReader } from "../src/services/funnel/temporal/activities";

const KEY = "foundry-dedup-test.csv";
// PK = order_id. Dups: a (rows 1,3) → last-wins Alice2/3; b (rows 2,5) → Bob2/5;
// c (row 4) → O'Brien/4 (single-quote tests sqlStr escaping). Distinct = 3.
const CSV =
  "order_id,name,val\n" +
  "a,Alice,1\n" +
  "b,Bob,2\n" +
  "a,Alice2,3\n" +
  "c,O'Brien,4\n" +
  "b,Bob2,5\n";

async function main() {
  await uploadObject(KEY, Buffer.from(CSV, "utf-8"), "text/csv");
  const ds = { filePath: KEY, fileFormat: "csv" as const, primaryKeyColumn: "order_id" };
  const reader = await buildFoundryBridgedReader(ds);
  const rows: { primary_key: string; properties: Record<string, unknown> }[] = [];
  for await (const r of reader.read({ sourceTableId: "x", fromSnapshotId: null, toSnapshotId: "y" })) {
    rows.push({ primary_key: r.primary_key, properties: r.properties });
  }
  console.log(`[dedup-test] rows=${rows.length}`);
  const byPk = new Map(rows.map((r) => [r.primary_key, r.properties]));
  const a = byPk.get("a"); const b = byPk.get("b"); const c = byPk.get("c");
  console.log("  a:", JSON.stringify(a));
  console.log("  b:", JSON.stringify(b));
  console.log("  c:", JSON.stringify(c));
  let ok = true;
  const expect = (cond: boolean, msg: string) => { if (!cond) { ok = false; console.log("  FAIL:", msg); } else { console.log("  ok:", msg); } };
  expect(rows.length === 3, `3 distinct rows (got ${rows.length})`);
  expect(a?.name === "Alice2" && a?.val === "3", "a last-wins = Alice2/3");
  expect(b?.name === "Bob2" && b?.val === "5", "b last-wins = Bob2/5");
  expect(c?.name === "O'Brien" && c?.val === "4", "c single-quote preserved = O'Brien/4");
  try { await deleteObject(KEY); } catch { /* ignore */ }
  console.log(ok ? "[dedup-test] PASS" : "[dedup-test] FAIL");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("FAIL:", e.message, e.stack); process.exit(1); });
