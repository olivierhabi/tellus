// ---------------------------------------------------------------------------
// Leader election for connectivity background workers.
//
// The outbox poller coordinates itself via `FOR UPDATE SKIP LOCKED` on the row
// it claims, so it is safe to run on every replica. The health prober and the
// credential rotation worker are NOT: they select a batch and then act on it,
// so N replicas do N× the probes (and N× the rewraps, which burn credential
// versions and write N audit rows per rotation).
//
// This wraps each sweep in a Postgres advisory lock so exactly one replica runs
// it per tick. Two properties matter:
//
//   - `pg_try_advisory_lock` is TRY, not blocking: a replica that loses the
//     race skips this tick entirely rather than queueing behind the winner and
//     running a redundant sweep late.
//   - The lock is SESSION-scoped, so it must be taken and released on the SAME
//     client. We check out a dedicated client and release it in `finally`;
//     returning the client to the pool without unlocking would leak the lock
//     until that backend died, silently wedging the worker fleet.
//
// A dropped connection releases the lock automatically, so a replica that dies
// mid-sweep does not block the next tick.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { getClient } from "../../db";
import { workerLease } from "./metrics";

/**
 * Run `fn` iff this replica wins the advisory lock for `worker`. Returns the
 * function's result, or `null` when the lease was not acquired.
 *
 * Set TELLUS_CONNECTIVITY_WORKER_LEASE=0 to bypass leader election (useful for
 * a known single-replica deployment or a test that must not depend on lock
 * state).
 */
export async function withWorkerLease<T>(
  worker: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (process.env.TELLUS_CONNECTIVITY_WORKER_LEASE === "0") {
    workerLease.labels(worker, "bypassed").inc();
    return fn();
  }

  const lockName = `tellus:connectivity:${worker}`;
  let client: PoolClient;
  try {
    client = (await getClient()) as PoolClient;
  } catch (err) {
    // Pool exhausted or shutting down. Not our tick; the next one retries.
    workerLease.labels(worker, "unavailable").inc();
    // eslint-disable-next-line no-console
    console.warn(
      `[connectivity.lease] could not acquire client for ${worker}`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  try {
    const res = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [lockName],
    );
    if (res.rows[0]?.acquired !== true) {
      workerLease.labels(worker, "contended").inc();
      return null;
    }
    workerLease.labels(worker, "acquired").inc();
    try {
      return await fn();
    } finally {
      // Same client, or the session lock outlives the sweep.
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [lockName])
        .catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
