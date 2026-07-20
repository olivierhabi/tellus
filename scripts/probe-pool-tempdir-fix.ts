// Probe: confirm the pool.ts instance-level temp_directory guard.
//
// The OlivierOrder2 failure ("Cannot switch temporary directory after the
// current one has been used") proved the error class is real at 5.6M scale.
// This probe proves the FIX at the pool layer:
//   (a) after the first acquireConnection "uses" the instance temp_directory,
//       re-running `PRAGMA temp_directory` on a fresh connection THROWS
//       (reproduces the error class — proves the guard is necessary);
//   (b) acquireConnection() called a second time does NOT re-run that PRAGMA
//       (instance-level guard) → no throw (proves the guard is sufficient).
process.env.DUCKDB_MEMORY_LIMIT = "1GB";
process.env.DUCKDB_TEMP_DIR = "/tmp/duckdb_spill_probe2";

import {
  acquireConnection,
  runAll,
  queryAll,
  releaseConnection,
  __resetPoolForTests,
} from "../src/services/duckdb/pool";

async function main() {
  // c1: changelog-like. First acquire sets the instance temp_directory +
  // creates a temp table → instance temp_directory is now "used".
  const c1 = await acquireConnection({ skipHttpfs: true });
  await runAll(
    c1,
    "CREATE TEMP TABLE cl_t AS SELECT range AS pk, range*7 AS v FROM range(100000)",
  );
  await runAll(c1, "CREATE TEMP TABLE cl_sorted AS SELECT * FROM cl_t ORDER BY v");
  const n = await queryAll<{ c: number }>(c1, "SELECT count(*) AS c FROM cl_sorted");
  console.log(`[probe] changelog-like acquire + temp table done; rows=${n[0].c}`);
  releaseConnection(c1);

  // (a) Prove the error class: a fresh connection re-running PRAGMA
  // temp_directory on a "used" instance MUST throw.
  const c1b = await acquireConnection({ skipHttpfs: true });
  let threw = false;
  try {
    await runAll(c1b, `PRAGMA temp_directory='${process.env.DUCKDB_TEMP_DIR}'`);
  } catch (e) {
    threw = true;
    console.log(
      `  [expected] re-PRAGMA throws: ${(e as Error).message.slice(0, 90)}`,
    );
  }
  releaseConnection(c1b);
  if (!threw) {
    console.log(
      "  [note] re-PRAGMA did NOT throw — temp dir not yet 'used' by a temp table; forcing a spill...",
    );
    // Force an actual spill (small memory limit + a sort that exceeds it).
    const c1c = await acquireConnection({ skipHttpfs: true });
    await runAll(c1c, "SET memory_limit='64MB'");
    await runAll(c1c, "SET preserve_insertion_order=false");
    try {
      await runAll(
        c1c,
        "CREATE TEMP TABLE spill AS SELECT mod(range,5000000) AS k FROM range(20000000) ORDER BY k",
      );
    } catch {
      /* spill path exercised even if it ultimately OOMs */
    }
    releaseConnection(c1c);
    const c1d = await acquireConnection({ skipHttpfs: true });
    let threw2 = false;
    try {
      await runAll(c1d, `PRAGMA temp_directory='${process.env.DUCKDB_TEMP_DIR}'`);
    } catch (e) {
      threw2 = true;
      console.log(
        `  [expected post-spill] re-PRAGMA throws: ${(e as Error).message.slice(0, 90)}`,
      );
    }
    releaseConnection(c1d);
    if (!threw2) throw new Error("FAIL: could not reproduce 'Cannot switch temporary directory'");
  }

  // (b) The fix: acquireConnection() again (merge-like) must NOT throw —
  // the instance-level guard skips the PRAGMA entirely.
  const c2 = await acquireConnection({ skipHttpfs: true });
  await runAll(c2, "CREATE TEMP TABLE merge_t AS SELECT 42 AS answer");
  const r = await queryAll<{ answer: number }>(c2, "SELECT * FROM merge_t");
  if (r[0].answer !== 42) throw new Error("unexpected merge_t value");
  console.log("[probe] merge-like acquire OK — no temp_directory throw (FIX WORKS)");
  releaseConnection(c2);

  await __resetPoolForTests();
  console.log("[probe] PASS");
}

main().catch((e) => {
  console.error("[probe] FAIL:", e.message);
  process.exit(1);
});
