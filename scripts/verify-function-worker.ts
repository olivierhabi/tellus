// ---------------------------------------------------------------------------
// verify-function-worker.ts — definitive proof that the function sandbox runs
// OFF the main event loop.
//
// Run with:  npx tsx scripts/verify-function-worker.ts
//
// It exercises the REAL worker pool (loaded under tsx, exactly as the dev
// backend runs it) and asserts:
//   1. A function's output + side-channel edits come back correctly.
//   2. A ~1.5s CPU-bound function running in the worker does NOT block a
//      main-thread setTimeout(100) — it fires near 100ms, not ~1500ms. This
//      is the exact regression that caused object-search 504s: previously the
//      sandbox blocked the event loop synchronously.
//   3. A runaway function (infinite loop) is killed by the vm cap and the pool
//      stays usable for subsequent calls.
//
// Exit code 0 = all checks passed; non-zero = failure (printed).
// ---------------------------------------------------------------------------
import {
  runSandboxedWithSdkAsync,
  __resetPoolForTests,
} from "../src/services/functionWorkerPool";
import type { OntologySnapshot } from "../src/services/functions/ontologyRuntime";

const EMPTY: OntologySnapshot = {
  byType: new Map(),
  ontologyId: "verify-ont",
  objectCount: 0,
  objectTypes: [],
};

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

async function main(): Promise<void> {
  __resetPoolForTests();

  // 1. Correctness — simple output.
  const r1 = await runSandboxedWithSdkAsync(
    `module.exports = function(input){ return input.x + 1; };`,
    { x: 41 },
    EMPTY,
  );
  assert(r1.status === "ok", `simple function status=ok (got ${r1.status})`);
  assert(r1.output === 42, `simple function output=42 (got ${JSON.stringify(r1.output)})`);

  // 2. Edits survive the structured-clone round trip across the worker.
  const r2 = await runSandboxedWithSdkAsync(
    `module.exports = function(){ Edits.update("Order","o1",{status:"closed"}); return 7; };`,
    {},
    EMPTY,
  );
  assert(r2.status === "ok", `edit fn status=ok (got ${r2.status})`);
  assert(r2.output === 7, `edit fn output=7 (got ${JSON.stringify(r2.output)})`);
  assert(r2.edits.length === 1, `edit fn collected 1 edit (got ${r2.edits.length})`);
  assert(
    r2.edits[0]?.op === "update" && r2.edits[0]?.primaryKey === "o1",
    `edit shape preserved`,
  );

  // 3. THE CORE FIX — no main-thread blocking while a worker runs a long fn.
  //    A 1500ms busy-loop function runs in the worker; a main-thread
  //    setTimeout(100) must fire near 100ms. If the sandbox were inline
  //    (sync), this would fire at ~1500ms.
  const slowP = runSandboxedWithSdkAsync(
    `module.exports = function(){ var t=Date.now(); while(Date.now()-t<1500){} return "slow-done"; };`,
    {},
    EMPTY,
  );
  const t0 = Date.now();
  let firedAt = -1;
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      firedAt = Date.now() - t0;
      resolve();
    }, 100),
  );
  if (firedAt >= 500) {
    console.error(
      `✗ FAIL: BLOCKED — main-thread setTimeout(100) fired at ${firedAt}ms while a 1500ms function ran. The sandbox is still on the main event loop.`,
    );
    process.exit(1);
  }
  console.log(
    `✓ no blocking — setTimeout(100) fired at ${firedAt}ms while a 1500ms function ran in a worker`,
  );
  const r3 = await slowP;
  assert(r3.status === "ok", `slow fn status=ok (got ${r3.status})`);
  assert(r3.output === "slow-done", `slow fn output (got ${JSON.stringify(r3.output)})`);

  // 4. Runaway function is killed by the vm cap; pool stays usable.
  const r4 = await runSandboxedWithSdkAsync(
    `module.exports = function(){ while(true){} };`,
    {},
    EMPTY,
  );
  assert(r4.status === "timeout", `runaway fn killed by vm cap (got ${r4.status})`);

  // Pool still works after the timeout.
  const r5 = await runSandboxedWithSdkAsync(
    `module.exports = function(){ return "recovered"; };`,
    {},
    EMPTY,
  );
  assert(r5.status === "ok" && r5.output === "recovered", `pool recovered after timeout`);

  console.log("\nALL CHECKS PASSED — sandbox execution is off the main event loop.");
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
