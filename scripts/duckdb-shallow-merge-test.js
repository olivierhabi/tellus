// Does DuckDB || do a SHALLOW object merge (last-wins per key, REPLACE not recursive)?
const D = require("duckdb");
async function main() {
  const db = new D.Database(":memory:");
  const c = db.connect();
  const sql = `SELECT ('{"a":{"x":1,"y":2}}'::JSON || '{"a":{"z":3}}'::JSON)::VARCHAR AS m`;
  const r = await new Promise((res, rej) => c.all(sql, (e, rows) => e ? rej(e) : res(rows)));
  const m = String(r[0].m).trim();
  const obj = JSON.parse(m);
  console.log("|| result a =", JSON.stringify(obj.a));
  console.log("shallow replace (a={z:3}) =", JSON.stringify(obj.a) === JSON.stringify({ z: 3 }));
  console.log("recursive merge (a={x,y,z}) =", "x" in obj.a && "z" in obj.a);
  process.exit(0);
}
main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
