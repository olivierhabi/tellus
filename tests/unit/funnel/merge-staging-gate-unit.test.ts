// ---------------------------------------------------------------------------
// Staging gate — unit tests (Blocker 3).
//
// assertStagedTail is the live-table guard: the staged set must equal the
// merged tail exactly (same cardinality, all-distinct PKs, no null/empty
// keys) or the promote never runs.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { assertStagedTail } from "../../../src/services/funnel/mergeStage";

const ok = {
  staged: 3,
  stagedUpserts: 2,
  stagedDeletes: 1,
  distinctPk: 3,
  nullPk: 0,
  emptyPk: 0,
};

describe("assertStagedTail", () => {
  it("passes on an exact staged set", () => {
    expect(() => assertStagedTail(ok, 3, "Account")).not.toThrow();
  });

  it("throws on cardinality drift", () => {
    expect(() => assertStagedTail({ ...ok, staged: 2 }, 3, "Account")).toThrow(
      /staged=2 expected tail=3/,
    );
  });

  it("throws on duplicate PKs", () => {
    expect(() => assertStagedTail({ ...ok, distinctPk: 2 }, 3, "Account")).toThrow(
      /duplicate PKs/,
    );
  });

  it("throws on null or empty PKs", () => {
    expect(() => assertStagedTail({ ...ok, nullPk: 1 }, 3, "Account")).toThrow(
      /nullPk=1/,
    );
    expect(() => assertStagedTail({ ...ok, emptyPk: 1 }, 3, "Account")).toThrow(
      /emptyPk=1/,
    );
  });
});
