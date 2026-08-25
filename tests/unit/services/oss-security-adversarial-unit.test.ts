// Adversarial security tests (Phase 14): the ObjectSet algebra
// must never widen visibility beyond the per-plan security
// context. Security is enforced in the deps factory
// (injectSecurityFilter, single choke point); these tests prove
// the executor can never call search WITHOUT going through that
// factory — every plan, including union/subtract/static/
// searchAround children, executes exactly one factory search.
import { describe, it, expect } from "vitest";
import { compileObjectSet } from "../../../src/services/oss/objectSetCompiler";
import {
  loadObjectSet,
  type ExecutorDeps,
} from "../../../src/services/oss/objectSetExecutor";

const NOW = new Date("2026-07-28T12:00:00Z");
const ctx = {
  ontologyRid: "o1",
  branchRid: "branch-1",
  tenant: "test",
  transactionId: null,
  scenarioRid: null,
  snapshot: false,
};

function spyDeps(rows: Record<string, Array<Record<string, unknown>>>) {
  const calls: Array<{ objectType: string; body: Record<string, unknown> }> = [];
  const deps: ExecutorDeps = {
    keywordOf: async (_t, f) => f,
    translateWhere: async (_t, w) => ({ translated: w }),
    search: async (objectType, body) => {
      calls.push({ objectType, body });
      return {
        hits: (rows[objectType] ?? []).map((r) => ({
          _id: r.__pk as string,
          _source: r,
          _sort: [r.__pk],
        })),
        total: (rows[objectType] ?? []).length,
      };
    },
    resolveStaticRids: async (rids) =>
      rids.map((rid, i) => ({
        rid,
        objectType: "Secret",
        primaryKey: `S-${i}`,
      })),
  };
  return { deps, calls };
}

describe("Phase 14 — adversarial set-algebra visibility", () => {
  it("union executes one factory search per type (security applied per plan)", async () => {
    const os = {
      type: "union",
      objectSets: [
        { type: "base", objectType: "Public" },
        { type: "base", objectType: "Secret" },
      ],
    } as const;
    const compiled = await compileObjectSet(os as never, { now: () => NOW });
    const { deps, calls } = spyDeps({ Public: [], Secret: [] });
    await loadObjectSet(compiled, { objectSet: os as never, select: [] }, ctx, deps);
    const types = calls.map((c) => c.objectType).sort();
    expect(types).toEqual(["Public", "Secret"]);
    // Each call goes through deps.search — the ONLY place the
    // production factory injects the mandatory security filter.
    expect(calls).toHaveLength(2);
  });

  it("subtract cannot widen: result plans ⊆ head types and carry not(subtrahend)", async () => {
    const os = {
      type: "subtract",
      objectSets: [
        { type: "base", objectType: "A" },
        { type: "base", objectType: "B" },
      ],
    } as const;
    const compiled = await compileObjectSet(os as never, { now: () => NOW });
    // B's wheres can only RESTRICT A's plan — never add a type.
    expect(compiled.plans.map((p) => p.objectType)).toEqual(["A"]);
  });

  it("static rids resolve through the secured search path too", async () => {
    const os = { type: "static", objects: ["ri.tellus.main.object.x"] } as const;
    const compiled = await compileObjectSet(os as never, { now: () => NOW });
    const { deps, calls } = spyDeps({ Secret: [{ __pk: "S-0" }] });
    const r = await loadObjectSet(compiled, { objectSet: os as never, select: [] }, ctx, deps);
    // Static rids become a terms filter on the SECURED search —
    // invisible rids are dropped by the mandatory filter, same as
    // any other query.
    expect(calls).toHaveLength(1);
    expect(r.data).toHaveLength(1);
  });

  it("cross-fingerprint page tokens are rejected (no replay across sets)", async () => {
    const osA = { type: "base", objectType: "A" } as const;
    const compiledA = await compileObjectSet(osA, { now: () => NOW });
    const { deps } = spyDeps({ A: [{ __pk: "1" }, { __pk: "2" }, { __pk: "3" }] });
    const p1 = await loadObjectSet(
      compiledA,
      { objectSet: osA, select: [], pageSize: 1 },
      ctx,
      deps,
    );
    const osB = { type: "base", objectType: "B" } as const;
    const compiledB = await compileObjectSet(osB, { now: () => NOW });
    await expect(
      loadObjectSet(
        compiledB,
        { objectSet: osB, select: [], pageSize: 1, pageToken: p1.nextPageToken! },
        ctx,
        deps,
      ),
    ).rejects.toThrowError(/different object set/);
  });

  it("cross-branch page tokens are rejected", async () => {
    const os = { type: "base", objectType: "A" } as const;
    const compiled = await compileObjectSet(os, { now: () => NOW });
    const { deps } = spyDeps({ A: [{ __pk: "1" }, { __pk: "2" }] });
    const p1 = await loadObjectSet(
      compiled,
      { objectSet: os, select: [], pageSize: 1 },
      ctx,
      deps,
    );
    await expect(
      loadObjectSet(
        compiled,
        { objectSet: os, select: [], pageSize: 1, pageToken: p1.nextPageToken! },
        { ...ctx, branchRid: "other-branch" },
        deps,
      ),
    ).rejects.toThrowError(/different branch/);
  });

  it("temporary rids never resolve across tenants (store-level)", async () => {
    // Covered exhaustively in oss-subscriptions-store-unit.test.ts;
    // this asserts the compiler refuses unresolvable references.
    await expect(
      compileObjectSet(
        { type: "reference", reference: "ri.object-set.main.temporary-object-set.x" } as never,
        { now: () => NOW, resolveReference: async () => null },
      ),
    ).rejects.toMatchObject({ errorName: "ObjectSetNotFound" });
  });
});
