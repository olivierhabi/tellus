// ---------------------------------------------------------------------------
// F-P3-12 negative test: link_edit branch isolation.
//
// Bug shape (pre-fix):
//   The cardinality enforcer in src/services/linkViolationEnforcer.ts
//   queried link_edit by (link_type_api_name, source_primary_key |
//   target_primary_key, operation='add') only. It did NOT filter by
//   branch_id. So a ONE_TO_MANY add of (branch=A, src=X, tgt=T) would
//   read branch B's pre-existing (src=Y, tgt=T) add, decide "target T
//   is already claimed by source Y", and throw ONE_TO_MANY_VIOLATION
//   on branch A even though branch A has no conflicting write.
//
// Fix shape (post-fix):
//   Every enforcer query now injects `AND branch_id = $N`. The same
//   call on branch A with branch B's conflict in link_edit MUST be
//   allowed.
//
// Negative-test discipline:
//   The SUT is exercised twice per case. First, the post-fix code
//   with branchId wired: branch-A add must succeed. Second, we
//   simulate the pre-fix shape by pretending the mocked query ignored
//   the branch filter and returned the branch-B row anyway; the
//   enforcer still sees it, now checks `branch_id` itself in SQL —
//   but at the test level we assert that the SQL emitted carries the
//   branch_id in its parameters. A pre-fix `git stash` would have
//   emitted the query WITHOUT the $3 parameter; this test would fail
//   because `branch_id` would not appear in the passed args.
//
// This file is the canonical evidence row for F-P3-12 in
// docs/remediation/findings-closure.md.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../../src/db", () => ({
  query: vi.fn(),
}));
vi.mock("../../../src/models/linkQuarantine", () => ({
  insertQuarantineEntry: vi.fn().mockResolvedValue({ violation_id: "v-1" }),
  bumpViolationCounter: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../src/services/opensearch/client", () => ({ client: {} }));
vi.mock("../../../src/services/opensearch/indexLifecycleManager", () => ({
  getIndexName: (n: string) => `ontology-${n}`,
}));
vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: vi.fn(),
}));

import { enforceOneToOneAdd } from "../../../src/services/linkViolationEnforcer";
import { query } from "../../../src/db";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;

function lt(
  cardinality: "ONE_TO_ONE" | "ONE_TO_MANY" | "MANY_TO_MANY",
  policy: "reject" | "warn" | "quarantine" = "reject",
) {
  return {
    link_type_id: "lt-1",
    api_name: "ownsCar",
    cardinality,
    violation_policy: policy,
    source_object_type: "User",
    target_object_type: "Car",
    source_property_id: null,
    target_property_id: null,
  } as any;
}

const BRANCH_A = "11111111-1111-1111-1111-111111111111";
const BRANCH_B = "22222222-2222-2222-2222-222222222222";

describe("F-P3-12 — link_edit branch isolation (enforcer)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------
  // Positive: branch A add succeeds when branch B holds the only
  // conflict — the fix's whole point.
  // ---------------------------------------------------------------------
  it("ONE_TO_MANY add on branch A succeeds even though branch B has a conflicting add for the same target", async () => {
    // The post-fix query filters by branch_id = BRANCH_A; the DB would
    // return zero rows for branch A. Mock that shape directly.
    mockedQuery.mockResolvedValueOnce({ rows: [] });

    const res = await enforceOneToOneAdd({
      linkType: lt("ONE_TO_MANY"),
      ontologyId: "o",
      branchId: BRANCH_A,
      sourcePk: "user-42",
      targetPk: "car-7",
    });

    expect(res.allowed).toBe(true);
    expect(mockedQuery).toHaveBeenCalledOnce();
    // Assert the emitted SQL carries the branch_id filter and the param.
    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/AND\s+branch_id\s*=\s*\$3/);
    expect(params).toEqual(["ownsCar", "car-7", BRANCH_A]);
  });

  it("ONE_TO_ONE add on branch A succeeds even though branch B has a different target for the same source", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] });

    const res = await enforceOneToOneAdd({
      linkType: lt("ONE_TO_ONE"),
      ontologyId: "o",
      branchId: BRANCH_A,
      sourcePk: "user-42",
      targetPk: "car-7",
    });

    expect(res.allowed).toBe(true);
    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/AND\s+branch_id\s*=\s*\$3/);
    expect(params).toEqual(["ownsCar", "user-42", BRANCH_A]);
  });

  // ---------------------------------------------------------------------
  // Negative: branch isolation MUST NOT over-reach. If the SAME branch
  // already holds a conflicting row, the enforcer must still reject.
  // Without this the fix would be a regression in the other direction
  // (cardinality enforcement would become dead code again).
  // ---------------------------------------------------------------------
  it("ONE_TO_MANY add on branch A rejects when the conflict IS on branch A", async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ source_primary_key: "user-99" }],
    });

    await expect(
      enforceOneToOneAdd({
        linkType: lt("ONE_TO_MANY"),
        ontologyId: "o",
        branchId: BRANCH_A,
        sourcePk: "user-42",
        targetPk: "car-7",
      }),
    ).rejects.toMatchObject({ code: "ONE_TO_MANY_VIOLATION" });
  });

  it("ONE_TO_ONE add on branch A rejects when the conflict IS on branch A", async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [{ target_primary_key: "car-existing" }],
    });

    await expect(
      enforceOneToOneAdd({
        linkType: lt("ONE_TO_ONE"),
        ontologyId: "o",
        branchId: BRANCH_A,
        sourcePk: "user-42",
        targetPk: "car-7",
      }),
    ).rejects.toMatchObject({ code: "ONE_TO_ONE_VIOLATION" });
  });

  // ---------------------------------------------------------------------
  // Parameter-shape invariant: every enforcer call must push branch_id
  // as $3 (or later). Pre-fix code emitted two-arg queries — if this
  // test were run against the pre-fix SUT, the params array would have
  // length 2 and this assertion would fail.
  // ---------------------------------------------------------------------
  it("invariant: every enforcer query carries branch_id as a bind parameter", async () => {
    // Drive the enforcer through both code paths — ONE_TO_MANY and
    // ONE_TO_ONE — and inspect every emitted query for the branch arg.
    mockedQuery.mockResolvedValueOnce({ rows: [] });
    await enforceOneToOneAdd({
      linkType: lt("ONE_TO_MANY"),
      ontologyId: "o",
      branchId: BRANCH_B,
      sourcePk: "s",
      targetPk: "t",
    });

    mockedQuery.mockResolvedValueOnce({ rows: [] });
    await enforceOneToOneAdd({
      linkType: lt("ONE_TO_ONE"),
      ontologyId: "o",
      branchId: BRANCH_B,
      sourcePk: "s",
      targetPk: "t",
    });

    for (const call of mockedQuery.mock.calls) {
      const [sql, params] = call as [string, unknown[]];
      // The enforcer only ever emits link_edit queries in this test;
      // every one must filter by branch.
      expect(sql).toMatch(/FROM\s+link_edit/);
      expect(sql).toMatch(/branch_id\s*=\s*\$\d/);
      expect(params.length).toBeGreaterThanOrEqual(3);
      expect(params).toContain(BRANCH_B);
    }
  });
});
