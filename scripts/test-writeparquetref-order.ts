// #1: does writeParquetRef preserve row order on disk? Write rows in a known
// non-sorted order, read back, check. (Phase 0's dedup yields pk-sorted; this
// tests whether writeParquetRef preserves that order on disk.)
// Run: set -a && . ./.env && set +a && npx tsx scripts/test-writeparquetref-order.ts
import "dotenv/config";
import { writeParquetRef, readParquetRows, deleteOrphanParquetRef, type ParquetColumn } from "../src/services/funnel/funnelParquetStore";

const COLUMNS: ParquetColumn[] = [
  { name: "primary_key", type: "string" },
  { name: "v", type: "string" },
];

async function main() {
  // Write in NON-pk-sorted order: c, a, b, a2 (dup pk 'a' — last-wins would be a2)
  const rowsIn = [
    { primary_key: "c", v: "3" },
    { primary_key: "a", v: "1" },
    { primary_key: "b", v: "2" },
    { primary_key: "a", v: "1b" },
  ];
  const ref = await writeParquetRef({ columns: COLUMNS, rows: (async function* () { for (const r of rowsIn) yield r; })(), key: "order-test.parquet", objectTypeApiName: "OrderTest", stage: "changelog" });
  console.log("[order-test] wrote", ref?.rowCount, "rows");
  const out = await readParquetRows(ref!, (r) => ({ primary_key: String(r.primary_key), v: String(r.v) }));
  console.log("[order-test] read back order:", out.map((r) => r.primary_key + "=" + r.v).join(", "));
  const pks = out.map((r) => r.primary_key);
  const isPkSorted = JSON.stringify(pks) === JSON.stringify([...pks].sort());
  console.log("[order-test] pk-sorted on disk?", isPkSorted, "| insertion order preserved?", JSON.stringify(pks) === JSON.stringify(rowsIn.map((r) => r.primary_key)));
  try { await deleteOrphanParquetRef(ref); } catch { /* ignore */ }
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e.message, e.stack); process.exit(1); });
