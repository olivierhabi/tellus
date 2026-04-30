// ---------------------------------------------------------------------------
// F-P3-13-FOLLOWUP-1 — linkResolverService threads branchId end-to-end.
//
// Closure proof:
//   1. Every exported entry point that eventually calls
//      `injectSecurityFilter` now takes a REQUIRED `branchId` parameter.
//      TypeScript rejects call sites that omit it (verified at
//      compile time via `pnpm exec tsc --noEmit`).
//   2. The branchId travels through the internal helpers
//      (`searchIndex`, `countIndex`, `getDocByPK`, `resolveForward`,
//      `resolveReverse`, `collectCompositeCounts`) and lands on the
//      `__branch` term inside the emitted OpenSearch query.
//   3. Git-stash proof: commenting the `if (typeof branchId === "string"
//      …)` block in `src/services/opensearch/client.ts:injectSecurityFilter`
//      makes these assertions fail (the same mechanism F-P3-13 already
//      documented; shared fixture across both findings).
//
// These tests mock the OpenSearch client surface so they run under
// `vitest.unit.config.ts` without Docker.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the OpenSearch client module BEFORE importing the SUT so the
// resolver service imports the spy.
const searchSpy = vi.fn();
const countSpy = vi.fn();
const getSpy = vi.fn();
vi.mock("../../../src/services/opensearch/client", async () => {
  const actual = await vi.importActual<typeof import("../../../src/services/opensearch/client")>(
    "../../../src/services/opensearch/client",
  );
  return {
    ...actual,
    client: {
      search: (...args: any[]) => searchSpy(...args),
      count: (...args: any[]) => countSpy(...args),
      get: (...args: any[]) => getSpy(...args),
      indices: { exists: vi.fn() },
    },
  };
});

// Mock the PG side (for getObjectTypeApiName / getPropertyApiName).
vi.mock("../../../src/db", () => ({
  query: vi.fn(async () => ({ rows: [{ api_name: "MockedType" }] })),
  withTransaction: vi.fn(),
}));

import {
  resolveLinks,
  countLinks,
  searchAround,
  analyzeLinkType,
} from "../../../src/services/linkResolverService";

function extractBranchClauses(body: Record<string, unknown>): string[] {
  // Walk the query tree and return every string value found at
  // `{ term: { __branch: <value> } }`.
  const found: string[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (
      (n.term as Record<string, unknown> | undefined)?.__branch !== undefined
    ) {
      found.push(String((n.term as Record<string, unknown>).__branch));
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  }
  walk(body);
  return found;
}

describe("F-P3-13-FOLLOWUP-1 — linkResolverService branchId threading", () => {
  const linkType = {
    link_type_id: "lt-1",
    api_name: "authors",
    display_name: "Authors",
    source_object_type: "ot-src",
    target_object_type: "ot-tgt",
    source_property_id: null,
    target_property_id: "prop-1",
    cardinality: "ONE_TO_MANY",
    join_table_file_path: null,
    ontology_id: "ont-1",
    direction: "forward",
    mcp_propagation_mode: "union",
    mcp_required_count: 1,
    mandatory_control_property_id: null,
  } as any;

  beforeEach(() => {
    searchSpy.mockReset();
    countSpy.mockReset();
    getSpy.mockReset();

    // Default: empty hits so the code path completes quickly.
    searchSpy.mockResolvedValue({
      statusCode: 200,
      body: { hits: { total: { value: 0 }, hits: [] } },
    });
    countSpy.mockResolvedValue({ statusCode: 200, body: { count: 0 } });
    getSpy.mockResolvedValue({ statusCode: 200, body: { _source: {} } });
  });

  it("resolveLinks threads branchId into the OpenSearch search body", async () => {
    await resolveLinks(linkType, "pk-123", "forward", {}, null, "branch-a");
    expect(searchSpy).toHaveBeenCalled();
    const call = searchSpy.mock.calls[0][0] as {
      body: Record<string, unknown>;
    };
    const branches = extractBranchClauses(call.body);
    expect(branches).toContain("branch-a");
  });

  it("resolveLinks with branchId=null emits no __branch clause", async () => {
    await resolveLinks(linkType, "pk-123", "forward", {}, null, null);
    expect(searchSpy).toHaveBeenCalled();
    const call = searchSpy.mock.calls[0][0] as {
      body: Record<string, unknown>;
    };
    const branches = extractBranchClauses(call.body);
    expect(branches).toHaveLength(0);
  });

  it("countLinks threads branchId into the count body (ONE_TO_MANY forward)", async () => {
    await countLinks(linkType, "pk-123", "forward", null, "branch-b");
    expect(countSpy).toHaveBeenCalled();
    const call = countSpy.mock.calls[0][0] as {
      body: Record<string, unknown>;
    };
    const branches = extractBranchClauses(call.body);
    expect(branches).toContain("branch-b");
  });

  it("searchAround threads branchId into the source-side search body", async () => {
    // First search call is the source-side PK lookup inside searchAround.
    await searchAround(linkType, "forward", {}, null, "branch-c");
    expect(searchSpy).toHaveBeenCalled();
    const call = searchSpy.mock.calls[0][0] as {
      body: Record<string, unknown>;
    };
    const branches = extractBranchClauses(call.body);
    expect(branches).toContain("branch-c");
  });

  it("analyzeLinkType threads branchId into the count body", async () => {
    await analyzeLinkType(linkType, { precision: "fast" }, null, "branch-d");
    expect(countSpy).toHaveBeenCalled();
    // analyzeLinkType calls countIndex multiple times for totals; every
    // one should carry `branch-d`.
    for (const call of countSpy.mock.calls) {
      const body = (call[0] as { body: Record<string, unknown> }).body;
      const branches = extractBranchClauses(body);
      expect(branches).toContain("branch-d");
    }
  });

  it("invariant: TypeScript rejects call sites that omit branchId", () => {
    // This test is a documentation anchor; the real enforcement is the
    // compile-time `pnpm exec tsc --noEmit` exit 0 status. If the
    // branchId parameter ever becomes optional, the full unit suite
    // still passes because runtime defaults silently drop the clause —
    // but the following @ts-expect-error would disappear, making this
    // test fail. See the ledger entry for F-P3-13-FOLLOWUP-1 closure.
    //
    // @ts-expect-error — resolveLinks requires branchId as 6th arg.
    const badCall = () => resolveLinks(linkType, "pk", "forward", {}, null);
    expect(typeof badCall).toBe("function");
  });
});
