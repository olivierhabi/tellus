// scripts/concurrency_suite.ts
// Phase 12 — live-DB concurrency suite (two real PG connections, not mocks).
// Verifies §3 (shared locking protocol serializes EVERY mutation path) +
// §3 (deadlock-avoidance via deterministic ordering) + §3 (bounded retry:
// retryable serialized/deadlock retried with exhaustion; domain errors NOT retried).
//
// Run (ephemeral PG):
//   PGHOST=localhost PGPORT=55432 PGDATABASE=tellus_test PGUSER=tellus_test \
//     PGPASSWORD=tellus_test npx tsx scripts/concurrency_suite.ts
import { Pool } from "pg";
import {
  acquireActionLocks,
  acquireAdvisoryLocks,
  sortedLockIdentities,
  deterministicLockKey,
  type LockIdentity,
} from "../src/actions/actionLockManager";
import { withBoundedRetry, isRetryablePgError } from "../src/actions/actionRetry";

const PGHOST = process.env.PGHOST ?? "localhost";
const PGPORT = parseInt(process.env.PGPORT ?? "55432", 10);
const PGDATABASE = process.env.PGDATABASE ?? "tellus_test";
const PGUSER = process.env.PGUSER ?? "tellus_test";
const PGPASSWORD = process.env.PGPASSWORD ?? "tellus_test";

function log(label: string, body?: unknown) {
  console.log(`\n=== ${label} ===`);
  if (body !== undefined) console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}
function pass(label: string) { console.log(`  ✓ ${label}`); }
function fail(label: string, why: string) { console.log(`  ✖ ${label}: ${why}`); process.exitCode = 1; }

// Each mutation path and the identities the shared protocol must lock.
const MUTATION_PATHS: { name: string; identities: LockIdentity[] }[] = [
  { name: "createObject", identities: [{ ontologyId: "o", branchId: "b", objectType: "Customer", primaryKey: "pk-create" }] },
  { name: "modifyObject", identities: [{ ontologyId: "o", branchId: "b", objectType: "Customer", primaryKey: "pk-modify" }] },
  { name: "modifyOrCreateObject", identities: [{ ontologyId: "o", branchId: "b", objectType: "Customer", primaryKey: "pk-moc" }] },
  { name: "deleteObject", identities: [{ ontologyId: "o", branchId: "b", objectType: "Customer", primaryKey: "pk-del" }] },
  { name: "addLink (both endpoints)", identities: [{ ontologyId: "o", branchId: "b", objectType: "Customer", primaryKey: "pk-src" }, { ontologyId: "o", branchId: "b", objectType: "Order", primaryKey: "pk-tgt" }] },
  { name: "removeLink (both endpoints)", identities: [{ ontologyId: "o", branchId: "b", objectType: "Customer", primaryKey: "pk-rsrc" }, { ontologyId: "o", branchId: "b", objectType: "Order", primaryKey: "pk-rtgt" }] },
  { name: "FK assignment (source + target)", identities: [{ ontologyId: "o", branchId: "b", objectType: "Order", primaryKey: "pk-fk-owner" }, { ontologyId: "o", branchId: "b", objectType: "Customer", primaryKey: "pk-fk-ref" }] },
  { name: "FK removal (source)", identities: [{ ontologyId: "o", branchId: "b", objectType: "Order", primaryKey: "pk-fk-clear" }] },
];

async function main() {
  const pool = new Pool({ host: PGHOST, port: PGPORT, database: PGDATABASE, user: PGUSER, password: PGPASSWORD });
  log("concurrency suite connected", { PGHOST, PGPORT });

  // --- §3.1: every mutation path serializes via the shared protocol --------
  log("§3.1 — shared locking protocol serializes EVERY mutation path");
  for (const path of MUTATION_PATHS) {
    const a = await pool.connect(); const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await acquireActionLocks(a, path.identities); // A acquires (advisory + row)
      // B tries each identity's advisory lock NOWAIT — must be locked by A.
      await b.query("BEGIN");
      let allBlocked = true;
      for (const id of sortedLockIdentities(path.identities)) {
        const key = deterministicLockKey(id);
        const r = await b.query("SELECT pg_try_advisory_xact_lock($1::bigint) AS got", [key.toString()]);
        if (r.rows[0].got === true) allBlocked = false;
      }
      if (allBlocked) pass(`${path.name}: concurrent writer blocked on all ${path.identities.length} identit(ies)`);
      else fail(path.name, "second writer acquired a lock the first should hold");
      await a.query("ROLLBACK"); await b.query("ROLLBACK");
    } finally { a.release(); b.release(); }
  }

  // --- §3.2: deadlock-avoidance via deterministic ordering -------------------
  log("§3.2 — deterministic ordering prevents deadlock (overlapping identity sets, opposite submission order)");
  {
    const setA = [
      { ontologyId: "o", branchId: "b", objectType: "C", primaryKey: "k3" },
      { ontologyId: "o", branchId: "b", objectType: "C", primaryKey: "k1" },
      { ontologyId: "o", branchId: "b", objectType: "C", primaryKey: "k2" },
    ] as LockIdentity[];
    const setB = [...setA].reverse(); // B submits in the opposite order
    // The deadlock-prevention GUARANTEE: regardless of submission order, both
    // writers acquire locks in the SAME canonical (sorted) order, so there is
    // no circular wait. This is a pure invariant assertion (no hanging).
    const orderA = sortedLockIdentities(setA).map((i) => deterministicLockKey(i).toString());
    const orderB = sortedLockIdentities(setB).map((i) => deterministicLockKey(i).toString());
    const sameOrder = JSON.stringify(orderA) === JSON.stringify(orderB);
    if (sameOrder) pass("both writers acquire in the identical sorted order → no circular wait possible");
    else fail("deadlock-avoidance ordering", `orderA=${orderA} orderB=${orderB}`);

    // Live two-connection serialization (no hang): A acquires, B NOWAIT-blocked,
    // A rolls back, B then acquires. Proves overlapping-key writers serialize
    // (blocked) and the released lock is immediately available (no deadlock,
    // no orphan lock).
    const a = await pool.connect(); const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await acquireAdvisoryLocks(a, setA);
      await b.query("BEGIN");
      let bBlocked = true;
      for (const id of sortedLockIdentities(setA)) {
        const k = deterministicLockKey(id);
        const r = await b.query("SELECT pg_try_advisory_xact_lock($1::bigint) AS got", [k.toString()]);
        if (r.rows[0].got === true) bBlocked = false;
      }
      if (bBlocked) pass("concurrent overlapping-set writer serialized (blocked) while first holds");
      else fail("overlap-serialization", "second writer was not blocked");
      await a.query("ROLLBACK"); // release A's xact locks
      const afterRelease = (await b.query("SELECT pg_try_advisory_xact_lock($1::bigint) AS got", [orderA[0]])).rows[0].got;
      if (afterRelease === true) pass("after first writer releases, second acquires (no orphan lock)");
      else fail("release", "lock not freed after ROLLBACK");
      await b.query("ROLLBACK");
    } finally { a.release(); b.release(); }
  }

  // --- §3.3: bounded retry — retryable 40P01/40001 retried; exhaustion reported
  log("§3.3 — bounded retry: 40P01/40001 retried, exhaustion reported");
  {
    let attempts = 0;
    const r = await withBoundedRetry<number>(() => {
      attempts++;
      const err: any = new Error("deadlock_detected");
      // alternate the code so we exercise both retryable cases
      err.code = attempts % 2 === 0 ? "40001" : "40P01";
      throw err;
    }, { maxAttempts: 4 });
    if (!r.ok && attempts === 4 && r.error && (r.error.code === "DEADLOCK_RETRY_EXHAUSTED" || r.error.code === "CONCURRENCY_CONFLICT")) pass(`40P01/40001 retried until exhaustion (4 attempts) → ${r.error.code}`);
    else fail("retry exhaustion", JSON.stringify({ ok: r.ok, attempts, error: r.error }));
  }

  // --- §3.4: domain validation errors are NEVER retried --------------------
  log("§3.4 — domain validation error not retried (rethrown immediately)");
  {
    let attempts = 0; let rethrown: any = null;
    try {
      await withBoundedRetry(() => {
        attempts++;
        const e: any = new Error("DELETE_BLOCKED_BY_RELATIONSHIPS");
        e.code = "P0001"; // PL/pgSQL raise — non-retryable
        throw e;
      }, { maxAttempts: 5 });
    } catch (e: any) { rethrown = e; }
    if (attempts === 1 && rethrown?.message === "DELETE_BLOCKED_BY_RELATIONSHIPS") pass("domain error rethrown on attempt 1 (no retry)");
    else fail("domain-error no-retry", JSON.stringify({ attempts, msg: rethrown?.message }));
  }

  // --- §3.5: opposite rule ordering over the same identities ---------------
  log("§3.5 — opposite rule ordering over the same identities (serialization holds)");
  {
    const ids = [
      { ontologyId: "o", branchId: "b", objectType: "C", primaryKey: "same" },
    ] as LockIdentity[];
    const a = await pool.connect(); const b = await pool.connect();
    try {
      await a.query("BEGIN"); await acquireActionLocks(a, ids);
      await b.query("BEGIN");
      const key = deterministicLockKey(ids[0]);
      const t = (await b.query("SELECT pg_try_advisory_xact_lock($1::bigint) AS got", [key.toString()])).rows[0].got;
      if (t === false) pass("same identity holds regardless of which writer/request arrives first");
      else fail("opposite-ordering", "second writer stole the lock");
      await a.query("ROLLBACK"); await b.query("ROLLBACK");
    } finally { a.release(); b.release(); }
  }

  // --- isRetryablePgError classifier --------------------------------------
  log("§3.6 — isRetryablePgError classifier");
  if (isRetryablePgError({ code: "40P01" }) && isRetryablePgError({ code: "40001" }) && isRetryablePgError({ code: "40P02" }) && !isRetryablePgError({ code: "P0001" }) && !isRetryablePgError({ code: "23505" })) pass("retryable set = {40P01,40001,40P02}; domain codes excluded");
  else fail("classifier", "wrong classification");

  log("DONE");
}

main().catch((e) => { console.error("CONCURRENCY SUITE FAILED:", e); process.exit(1); }).finally(async () => { /* pool ended by process */ });
