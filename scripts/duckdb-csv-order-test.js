// Throwaway: does read_csv_auto(PARALLEL=false) + row_number() OVER () give
// deterministic FILE ORDER (needed for DISTINCT ON last-wins-by-file-order)?
const fs = require("fs");
const path = require("path");
const D = require("duckdb");
async function main() {
  const csvPath = path.join("/tmp", `fb-order-${process.pid}.csv`);
  fs.writeFileSync(csvPath,
    "order_id,name,val\n" +
    "a,Alice,1\nb,Bob,2\na,Alice2,3\nc,O'Brien,4\nb,Bob2,5\n");
  const db = new D.Database(":memory:");
  const c = db.connect();
  const sql = `SELECT DISTINCT ON ("order_id") "order_id", name, val FROM (
    SELECT *, row_number() OVER () AS rn FROM read_csv_auto('${csvPath}', PARALLEL=false)
  ) ORDER BY "order_id", rn DESC`;
  const r = await new Promise((res, rej) => c.all(sql, (err, rows) => err ? rej(err) : res(rows)));
  const s = (x) => Object.fromEntries(Object.entries(x).map(([k,v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  console.log("rows:", r.map(s));
  const a = r.find((x) => String(x.order_id) === "a");
  const b = r.find((x) => String(x.order_id) === "b");
  const cc = r.find((x) => String(x.order_id) === "c");
  const ok = r.length === 3 && a?.name === "Alice2" && b?.name === "Bob2" && cc?.name === "O'Brien";
  console.log(ok ? "PASS: read_csv_auto(PARALLEL=false) file-order last-wins deterministic" : "FAIL");
  fs.unlinkSync(csvPath);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
