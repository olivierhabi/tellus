// Throwaway: read_csv_auto(PARALLEL=false, all_varchar=true) — does all_varchar
// force string types (avoiding BigInt that breaks JSON.stringify downstream) +
// preserve file-order last-wins via row_number()?
const fs = require("fs");
const path = require("path");
const D = require("duckdb");
async function main() {
  const csvPath = path.join("/tmp", `fb-av-${process.pid}.csv`);
  fs.writeFileSync(csvPath,
    "order_id,name,val\n" +
    "a,Alice,1\nb,Bob,2\na,Alice2,3\nc,O'Brien,4\nb,Bob2,5\n");
  const db = new D.Database(":memory:");
  const c = db.connect();
  const sql = `SELECT DISTINCT ON ("order_id") "order_id", name, val FROM (
    SELECT *, row_number() OVER () AS rn FROM read_csv_auto('${csvPath}', PARALLEL=false, all_varchar=true)
  ) ORDER BY "order_id", rn DESC`;
  const r = await new Promise((res, rej) => c.all(sql, (err, rows) => err ? rej(err) : res(rows)));
  const a = r.find((x) => String(x.order_id) === "a");
  const b = r.find((x) => String(x.order_id) === "b");
  const cc = r.find((x) => String(x.order_id) === "c");
  console.log("rows=", r.length, "| a.val=", JSON.stringify(a.val), "type=", typeof a.val, "| a.name=", a.name);
  console.log("b.name=", b.name, "| c.name=", cc.name);
  const ok = r.length === 3 && a.name === "Alice2" && String(a.val) === "3" && typeof a.val === "string" &&
             b.name === "Bob2" && cc.name === "O'Brien";
  console.log(ok ? "PASS: all_varchar → string types + file-order last-wins" : "FAIL");
  fs.unlinkSync(csvPath);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
