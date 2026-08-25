// Hermetic unit coverage for connectivity worker leader election.
//
// The dangerous failure modes here are silent: a lost lease that still runs the
// sweep (duplicate rewraps), or a won lease that never unlocks (advisory locks
// are session-scoped, so leaking one wedges the worker until that backend dies).
// Both are asserted against a fake client that records the exact SQL sequence.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  sql: string[];
}

let acquired = true;
let client: FakeClient;
let getClientFails = false;

function makeClient(): FakeClient {
  const sql: string[] = [];
  const c: FakeClient = {
    sql,
    release: vi.fn(),
    query: vi.fn(async (text: string) => {
      sql.push(text);
      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired }] };
      }
      return { rows: [] };
    }),
  };
  return c;
}

vi.mock("../../../src/db", () => ({
  getClient: async () => {
    if (getClientFails) throw new Error("pool exhausted");
    return client;
  },
  pool: { connect: async () => client },
}));

const { withWorkerLease } = await import(
  "../../../src/services/connectivity/workerLease"
);

describe("withWorkerLease", () => {
  beforeEach(() => {
    acquired = true;
    getClientFails = false;
    client = makeClient();
    delete process.env.TELLUS_CONNECTIVITY_WORKER_LEASE;
  });

  it("runs the sweep and unlocks on the same client when the lease is won", async () => {
    const fn = vi.fn(async () => ({ healthy: 3, unhealthy: 0 }));
    const out = await withWorkerLease("health-prober", fn);

    expect(out).toEqual({ healthy: 3, unhealthy: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.sql[0]).toContain("pg_try_advisory_lock");
    expect(client.sql[1]).toContain("pg_advisory_unlock");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("skips the sweep and returns null when another replica holds the lease", async () => {
    acquired = false;
    const fn = vi.fn(async () => "ran");

    expect(await withWorkerLease("credential-rotation", fn)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    // No unlock: we never held it, and unlocking a lock we don't own logs a
    // Postgres warning on every tick.
    expect(client.sql.some((s) => s.includes("pg_advisory_unlock"))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("unlocks and releases even when the sweep throws", async () => {
    const boom = new Error("probe sweep exploded");
    await expect(
      withWorkerLease("health-prober", async () => {
        throw boom;
      }),
    ).rejects.toThrow(boom);

    expect(client.sql[1]).toContain("pg_advisory_unlock");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns null without throwing when no client is available", async () => {
    getClientFails = true;
    const fn = vi.fn(async () => "ran");
    expect(await withWorkerLease("health-prober", fn)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("bypasses locking entirely when the lease is disabled", async () => {
    process.env.TELLUS_CONNECTIVITY_WORKER_LEASE = "0";
    const fn = vi.fn(async () => "ran");

    expect(await withWorkerLease("health-prober", fn)).toBe("ran");
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
  });

  it("namespaces the lock per worker so the two workers never contend", async () => {
    await withWorkerLease("health-prober", async () => null);
    const proberArgs = client.query.mock.calls[0][1];
    client = makeClient();
    await withWorkerLease("credential-rotation", async () => null);
    const rotationArgs = client.query.mock.calls[0][1];

    expect(proberArgs).toEqual(["tellus:connectivity:health-prober"]);
    expect(rotationArgs).toEqual(["tellus:connectivity:credential-rotation"]);
  });
});
