// ---------------------------------------------------------------------------
// F-P3-13 — branch-isolation invariant on the read path.
//
// Closure discipline mirror of F-P3-12 (write-path isolation):
//   1. Positive: `injectSecurityFilter(body, secFilter, "branch-a")`
//      produces a must-clause that restricts documents to
//      `__branch === "branch-a"` OR legacy docs without `__branch`.
//   2. Negative (git-stash proof): reverting the branchId term-injection
//      at `src/services/opensearch/client.ts:injectSecurityFilter` makes
//      assertion (1) fail — the test file is unchanged; only the SUT
//      regresses. Verified manually by commenting the `branchId` block
//      and re-running; both "restricts by branch" assertions fail.
//   3. Cross-branch sanity: `branchId = null` yields no branch clause
//      (intentional for exempted callers).
//   4. Handler-layer sanity: readBranchHeader pulls `x-branch-id` from
//      both the Express-style `req.get` path and the headers-object path.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { injectSecurityFilter } from "../../../src/services/opensearch/client";
import { readBranchHeader } from "../../../src/middleware/branchHeader";

describe("F-P3-13 — read-path branch isolation", () => {
  it("injects __branch term + missing-field fallback when branchId is a UUID", () => {
    const out = injectSecurityFilter(
      { query: { match_all: {} } },
      null,
      "branch-a",
    );
    const musts = ((out.query as any)?.bool?.must ?? []) as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(musts)).toBe(true);
    // Find the branch-isolation clause.
    const branchClause = musts.find((m) => {
      const should = ((m as any)?.bool?.should ?? []) as Array<
        Record<string, unknown>
      >;
      return should.some(
        (s) => (s as any)?.term?.__branch !== undefined,
      );
    });
    expect(branchClause).toBeDefined();
    const should = (branchClause as any).bool.should as Array<
      Record<string, unknown>
    >;
    expect(should).toHaveLength(2);
    expect((should[0] as any).term.__branch).toBe("branch-a");
    // Fallback: docs without __branch remain visible (transitional).
    expect((should[1] as any).bool.must_not).toEqual([
      { exists: { field: "__branch" } },
    ]);
    expect((branchClause as any).bool.minimum_should_match).toBe(1);
  });

  it("restricts a non-trivial query body to the requested branch", () => {
    const out = injectSecurityFilter(
      { query: { term: { status: "active" } }, size: 50 },
      null,
      "branch-b",
    );
    const musts = ((out.query as any)?.bool?.must ?? []) as Array<
      Record<string, unknown>
    >;
    // The original query must survive, and the branch clause must be
    // ANDed alongside it — never replacing the caller's intent.
    const originalSurvived = musts.some(
      (m) => (m as any)?.term?.status === "active",
    );
    const branchApplied = musts.some((m) => {
      const s = ((m as any)?.bool?.should ?? []) as Array<
        Record<string, unknown>
      >;
      return s.some((c) => (c as any)?.term?.__branch === "branch-b");
    });
    expect(originalSurvived).toBe(true);
    expect(branchApplied).toBe(true);
    expect(out.size).toBe(50);
  });

  it("does not add a branch clause when branchId is null (cross-branch read)", () => {
    const out = injectSecurityFilter(
      { query: { match_all: {} } },
      null,
      null,
    );
    // With no security filter and branchId=null, the body is returned as-is.
    expect(out).toEqual({ query: { match_all: {} } });
  });

  it("ANDs security filter AND branch clause when both present", () => {
    const secFilter = { term: { org_id: "org-1" } };
    const out = injectSecurityFilter(
      { query: { match_all: {} } },
      secFilter,
      "branch-c",
    );
    const musts = ((out.query as any)?.bool?.must ?? []) as Array<
      Record<string, unknown>
    >;
    expect(
      musts.some((m) => (m as any)?.term?.org_id === "org-1"),
    ).toBe(true);
    expect(
      musts.some((m) => {
        const s = ((m as any)?.bool?.should ?? []) as Array<
          Record<string, unknown>
        >;
        return s.some((c) => (c as any)?.term?.__branch === "branch-c");
      }),
    ).toBe(true);
  });

  it("readBranchHeader resolves from Express-style req.get()", () => {
    const req = { get: (name: string) => (name === "x-branch-id" ? "branch-x" : undefined) };
    expect(readBranchHeader(req)).toBe("branch-x");
  });

  it("readBranchHeader resolves from headers object fallback", () => {
    const req = { headers: { "x-branch-id": "branch-y" } };
    expect(readBranchHeader(req)).toBe("branch-y");
  });

  it("readBranchHeader returns null when header is absent", () => {
    expect(readBranchHeader({ headers: {} })).toBeNull();
    expect(readBranchHeader({})).toBeNull();
  });

  it("readBranchHeader normalises empty/whitespace to null", () => {
    expect(readBranchHeader({ headers: { "x-branch-id": "" } })).toBeNull();
    expect(readBranchHeader({ headers: { "x-branch-id": "   " } })).toBeNull();
  });
});
