// ---------------------------------------------------------------------------
// indexingLease — unit tests for the three lock signals.
//
// `query` is mocked, so these are assertions about the SQL this module emits
// and its decision predicates — not about Postgres. What is pinned:
//   * heartbeat vs movement write the right columns, scoped to live locks;
//   * the watchdog ONLY fails instrumented-but-quiet locks (NULL
//     last_progress_at is never a stall — that would punish slow but
//     uninstrumented runs; the boot reconciler owns those);
//   * the boot reconciler ONLY releases locks with no live run (a lock whose
//     run is still 'running' may be resumed by Temporal after restart);
//   * every mutator is scoped AND idempotent (re-running changes nothing).
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/** Every SQL statement this module issued, with its bound parameters. */
const calls: Array<{ sql: string; params: unknown[] }> = [];
/** Per-test responder: given the SQL, return rows (and rowCount). */
let respond: (sql: string) => { rows: Record<string, unknown>[] } = () => ({
  rows: [],
});

vi.mock("../../../src/db", () => ({
  query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    const { rows } = respond(sql);
    return { rowCount: rows.length, rows };
  },
}));

import {
  indexingStallAfterMs,
  indexingBootStaleMs,
  indexingDeadAfterMs,
  isTimestampStale,
  shouldMarkStalled,
  touchIndexingLock,
  touchLeaseHeartbeat,
  reportIndexingProgress,
  sweepStalledIndexing,
  sweepDeadIndexingLocks,
  reconcileStaleIndexingLocks,
  describeIndexingLock,
  resolveLeaseObjectTypeId,
  INDEXING_STALL_AFTER_MS_DEFAULT,
  INDEXING_BOOT_STALE_MS_DEFAULT,
  INDEXING_DEAD_AFTER_MS_DEFAULT,
} from "../../../src/services/funnel/indexingLease";

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

beforeEach(() => {
  calls.length = 0;
  respond = () => ({ rows: [] });
});

afterEach(() => {
  delete process.env.TELLUS_ENVIRONMENT_ID;
  delete process.env.NODE_ENV;
});

describe("versioned config", () => {
  it("defaults: 10 min stall, 15 min boot grace, 15 min dead budget", () => {
    delete process.env.TELLUS_ENVIRONMENT_ID;
    delete process.env.NODE_ENV;
    expect(indexingStallAfterMs()).toBe(INDEXING_STALL_AFTER_MS_DEFAULT);
    expect(indexingBootStaleMs()).toBe(INDEXING_BOOT_STALE_MS_DEFAULT);
    expect(indexingDeadAfterMs()).toBe(INDEXING_DEAD_AFTER_MS_DEFAULT);
    expect(INDEXING_STALL_AFTER_MS_DEFAULT).toBe(600_000);
    expect(INDEXING_BOOT_STALE_MS_DEFAULT).toBe(900_000);
    expect(INDEXING_DEAD_AFTER_MS_DEFAULT).toBe(900_000);
  });
});

describe("predicates", () => {
  const NOW = 1_000_000;
  it("isTimestampStale: null is never stale; boundary is strict", () => {
    expect(isTimestampStale(null, NOW, 100)).toBe(false);
    expect(isTimestampStale(undefined, NOW, 100)).toBe(false);
    expect(isTimestampStale("garbage", NOW, 100)).toBe(false);
    expect(isTimestampStale(new Date(NOW - 50).toISOString(), NOW, 100)).toBe(
      false,
    );
    expect(isTimestampStale(new Date(NOW - 100).toISOString(), NOW, 100)).toBe(
      false,
    );
    expect(isTimestampStale(new Date(NOW - 101).toISOString(), NOW, 100)).toBe(
      true,
    );
  });

  it("shouldMarkStalled: NULL last_progress_at is never a stall", () => {
    // A lock that never reported movement predates instrumentation (or never
    // opted in). Failing it here would punish slow-but-uninstrumented runs;
    // the boot reconciler owns those rows.
    expect(shouldMarkStalled(null, NOW, 100)).toBe(false);
    expect(shouldMarkStalled(undefined, NOW, 100)).toBe(false);
    expect(
      shouldMarkStalled(new Date(NOW - 50).toISOString(), NOW, 100),
    ).toBe(false);
    expect(
      shouldMarkStalled(new Date(NOW - 10_000).toISOString(), NOW, 100),
    ).toBe(true);
  });
});

describe("touchIndexingLock / reportIndexingProgress", () => {
  it("heartbeat moves updated_at only, scoped to live locks", async () => {
    respond = () => ({
      rows: [{ object_type_id: "ot-1" }],
    });
    await expect(touchIndexingLock("ot-1")).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(flat(calls[0].sql)).toContain("SET updated_at = now()");
    expect(flat(calls[0].sql)).not.toContain("last_progress_at");
    expect(flat(calls[0].sql)).toContain("status = 'indexing'");
    expect(calls[0].params).toEqual(["ot-1"]);
  });

  it("heartbeat on a non-live lock touches nothing and reports false", async () => {
    respond = () => ({ rows: [] });
    await expect(touchIndexingLock("ot-1")).resolves.toBe(false);
  });

  it("movement moves last_progress_at with the heartbeat", async () => {
    respond = () => ({
      rows: [{ object_type_id: "ot-1" }],
    });
    await expect(reportIndexingProgress("ot-1")).resolves.toBe(true);
    expect(flat(calls[0].sql)).toContain(
      "SET last_progress_at = now(), updated_at = now()",
    );
    expect(flat(calls[0].sql)).toContain("status = 'indexing'");
  });

  it("holder timer moves lease_heartbeat_at and never last_progress_at", async () => {
    respond = () => ({
      rows: [{ object_type_id: "ot-1" }],
    });
    await expect(touchLeaseHeartbeat("ot-1")).resolves.toBe(true);
    expect(flat(calls[0].sql)).toContain("SET lease_heartbeat_at = now()");
    expect(flat(calls[0].sql)).not.toContain("last_progress_at");
    expect(flat(calls[0].sql)).toContain("status = 'indexing'");
  });
});

describe("sweepStalledIndexing", () => {
  it("fails only instrumented-but-quiet locks and marks their live runs", async () => {
    respond = (sql) => {
      if (sql.includes("UPDATE funnel_state")) {
        return {
          rows: [
            {
              object_type_id: "ot-stuck",
              active_run_id: "run-1",
              last_progress_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
            {
              object_type_id: "ot-norun",
              active_run_id: null,
              last_progress_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
        };
      }
      return { rows: [{ run_id: "run-1" }] };
    };
    const { swept } = await sweepStalledIndexing(600_000);
    expect(swept.map((r) => r.object_type_id).sort()).toEqual([
      "ot-norun",
      "ot-stuck",
    ]);
    const lockSql = flat(calls[0].sql);
    // The NULL guard is the whole safety property: uninstrumented rows are
    // never failed by the watchdog.
    expect(lockSql).toContain("last_progress_at IS NOT NULL");
    expect(lockSql).toContain("status = 'indexing'");
    expect(lockSql).toContain("SET status = 'failed'");
    expect(lockSql).toContain("STALLED");
    expect(calls[0].params).toEqual(["600000"]);
    // Only the row WITH a run gets a run UPDATE, scoped to still-running.
    const runUpdates = calls.filter((c) => flat(c.sql).includes("UPDATE funnel_run"));
    expect(runUpdates).toHaveLength(1);
    expect(flat(runUpdates[0].sql)).toContain("status = 'running'");
    expect(runUpdates[0].params).toEqual(["run-1"]);
  });

  it("empty sweep issues one UPDATE and touches no runs", async () => {
    respond = () => ({ rows: [] });
    const { swept } = await sweepStalledIndexing(600_000);
    expect(swept).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("sweepDeadIndexingLocks", () => {
  it("uses the lease heartbeat only and skips live runs", async () => {
    respond = (sql) => {
      if (sql.includes("UPDATE funnel_state")) {
        return {
          rows: [
            {
              object_type_id: "ot-dead",
              lease_heartbeat_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ],
        };
      }
      return { rows: [] };
    };
    const { swept } = await sweepDeadIndexingLocks(900_000);
    expect(swept.map((r) => r.object_type_id)).toEqual(["ot-dead"]);
    const sql = flat(calls[0].sql);
    expect(sql).toContain("lease_heartbeat_at IS NOT NULL");
    expect(sql).toContain("lease_heartbeat_at < now()");
    expect(sql).not.toContain("last_progress_at");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("fr.status = 'running'");
    expect(sql).toContain("DEAD");
    expect(calls[0].params).toEqual(["900000"]);
  });
});

describe("reconcileStaleIndexingLocks", () => {
  it("releases only old locks with no live run (NOT EXISTS running)", async () => {
    respond = () => ({ rows: [{ object_type_id: "ot-old" }] });
    const { released } = await reconcileStaleIndexingLocks(900_000);
    expect(released).toEqual(["ot-old"]);
    const sql = flat(calls[0].sql);
    expect(sql).toContain("fs.status = 'indexing'");
    expect(sql).toContain("fs.updated_at < now()");
    // The safety property: a lock whose run is still 'running' (Temporal may
    // resume it) is never released here.
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("fr.status = 'running'");
    expect(sql).toContain("boot-reconcile");
    expect(calls[0].params).toEqual(["900000"]);
  });
});

describe("describeIndexingLock / resolveLeaseObjectTypeId", () => {
  it("returns the lock, run stage and timestamps", async () => {
    respond = () => ({
      rows: [
        {
          status: "indexing",
          objects_indexed: 42,
          updated_at: "2026-01-01T00:00:00Z",
          lease_heartbeat_at: "2026-01-01T00:00:01Z",
          last_progress_at: "2026-01-01T00:00:02Z",
          active_run_id: "run-9",
          current_stage: "merge",
          started_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    await expect(describeIndexingLock("ot-1")).resolves.toEqual({
      status: "indexing",
      objectsIndexed: 42,
      updatedAt: "2026-01-01T00:00:00Z",
      leaseHeartbeatAt: "2026-01-01T00:00:01Z",
      lastProgressAt: "2026-01-01T00:00:02Z",
      activeRunId: "run-9",
      runStage: "merge",
      runStartedAt: "2026-01-01T00:00:00Z",
    });
    expect(calls[0].params).toEqual(["ot-1"]);
  });

  it("returns null when no lock row exists", async () => {
    respond = () => ({ rows: [] });
    await expect(describeIndexingLock("ot-1")).resolves.toBeNull();
  });

  it("resolves the OT id, or null when the type is gone", async () => {
    respond = () => ({ rows: [{ object_type_id: "uuid-1" }] });
    await expect(
      resolveLeaseObjectTypeId("ont-1", "Transaction"),
    ).resolves.toBe("uuid-1");
    respond = () => ({ rows: [] });
    await expect(
      resolveLeaseObjectTypeId("ont-1", "Deleted"),
    ).resolves.toBeNull();
  });
});
