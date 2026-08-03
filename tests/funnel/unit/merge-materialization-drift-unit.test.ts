import { describe, expect, it } from "vitest";

import { requiresFullPgTail } from "../../../src/services/funnel/mergeStage";

describe("merge materialization drift guard", () => {
  it("forces a full PG tail when an unchanged snapshot outlives an empty materialization", () => {
    expect(requiresFullPgTail(746, 0)).toBe(true);
  });

  it("keeps the delta path when snapshot and materialization cardinalities agree", () => {
    expect(requiresFullPgTail(746, 746)).toBe(false);
  });
});
