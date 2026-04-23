// ---------------------------------------------------------------------------
// F-P3-07 — withTransaction ROLLBACK-failure must NOT return a poisoned
// connection to the pool.
//
// Pre-fix (before F-P3-07):
//   catch (err) { await client.query("ROLLBACK"); throw err; }
//   finally { client.release(); }
// If ROLLBACK itself threw, client.release() was called with no argument
// and node-pg happily recycled the connection to the pool. The next
// borrower inherited the still-open transaction on the server.
//
// Post-fix:
//   try { await client.query("ROLLBACK"); }
//   catch (rollbackErr) { poisoned = rollbackErr; ...; }
//   finally { poisoned ? client.release(poisoned) : client.release(); }
//
// We exercise the helper by mocking the `pg` Pool so pool.connect()
// returns a fake PoolClient whose query() we can programme. The
// assertion surface is the single argument passed to `release()` —
// that is the only wire the poisoning behaviour travels on.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

interface RecordedCall {
  type: "query" | "release";
  sql?: string;
  err?: unknown;
}

const recorder = {
  calls: [] as RecordedCall[],
  queryImpl: null as null | ((sql: string) => Promise<unknown>),
};

// Mock pg BEFORE importing db.ts — the module-level `new Pool()` call
// needs the mock in place.
vi.mock("pg", () => {
  class MockPool {
    connect() {
      return Promise.resolve({
        query: (sql: string) => {
          recorder.calls.push({ type: "query", sql });
          if (recorder.queryImpl) return recorder.queryImpl(sql);
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release: (err?: unknown) => {
          recorder.calls.push({ type: "release", err });
        },
      });
    }
    on() {}
    end() {
      return Promise.resolve();
    }
    get totalCount() {
      return 0;
    }
    get idleCount() {
      return 0;
    }
    get waitingCount() {
      return 0;
    }
    query(sql: string) {
      return this.connect().then((c: { query: (s: string) => unknown }) => c.query(sql));
    }
  }
  const types = { setTypeParser: () => {} };
  return { Pool: MockPool, types };
});

import { withTransaction } from "../../../src/db";

beforeEach(() => {
  recorder.calls.length = 0;
  recorder.queryImpl = null;
});

describe("withTransaction ROLLBACK-failure isolation (F-P3-07)", () => {
  it("happy path: COMMIT + release() with no arg (connection recycled)", async () => {
    const result = await withTransaction(async (client) => {
      await client.query("INSERT INTO t VALUES (1)");
      return 42;
    });
    expect(result).toBe(42);
    const queries = recorder.calls.filter((c) => c.type === "query").map((c) => c.sql);
    expect(queries).toEqual(["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"]);
    const releases = recorder.calls.filter((c) => c.type === "release");
    expect(releases).toHaveLength(1);
    expect(releases[0].err).toBeUndefined();
  });

  it("callback throws, ROLLBACK succeeds: release() with no arg (connection recycled)", async () => {
    await expect(
      withTransaction(async () => {
        throw new Error("boom from callback");
      }),
    ).rejects.toThrow("boom from callback");

    const queries = recorder.calls.filter((c) => c.type === "query").map((c) => c.sql);
    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
    const releases = recorder.calls.filter((c) => c.type === "release");
    expect(releases).toHaveLength(1);
    expect(releases[0].err).toBeUndefined();
  });

  it("callback throws, ROLLBACK ALSO throws: release(err) is called so the pool discards the connection", async () => {
    recorder.queryImpl = async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback network error");
      return { rows: [], rowCount: 0 };
    };
    await expect(
      withTransaction(async () => {
        throw new Error("boom from callback");
      }),
    ).rejects.toThrow("boom from callback");

    const releases = recorder.calls.filter((c) => c.type === "release");
    expect(releases).toHaveLength(1);
    // Pre-F-P3-07: release() was called with NO argument here, so the
    // broken connection was recycled and poisoned the pool.
    expect(releases[0].err).toBeInstanceOf(Error);
    expect((releases[0].err as Error).message).toBe("rollback network error");
  });

  it("COMMIT throws: helper attempts ROLLBACK; clean ROLLBACK means the connection is recycled", async () => {
    let commitAttempted = false;
    recorder.queryImpl = async (sql: string) => {
      if (sql === "COMMIT" && !commitAttempted) {
        commitAttempted = true;
        throw new Error("commit failed");
      }
      return { rows: [], rowCount: 0 };
    };
    await expect(
      withTransaction(async (client) => {
        await client.query("INSERT ...");
      }),
    ).rejects.toThrow("commit failed");
    const releases = recorder.calls.filter((c) => c.type === "release");
    expect(releases).toHaveLength(1);
    expect(releases[0].err).toBeUndefined();
    const queries = recorder.calls.filter((c) => c.type === "query").map((c) => c.sql);
    expect(queries).toEqual(["BEGIN", "INSERT ...", "COMMIT", "ROLLBACK"]);
  });
});
