// Throwaway: confirm conn.stream(sql) is async-iterable directly.
const D = require("duckdb");
async function main() {
  const db = new D.Database(":memory:");
  const c = db.connect();
  const s = c.stream("SELECT * FROM range(0,3)");
  console.log("typeof:", typeof s, "| asyncIter:", !!s[Symbol.asyncIterator]);
  const r = [];
  for await (const row of s) r.push(row);
  console.log("for-await rows=", JSON.stringify(r));
}
main().catch((e) => console.log("FAIL:", e.message));
