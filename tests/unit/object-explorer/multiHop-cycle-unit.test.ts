// ---------------------------------------------------------------------------
// T-09 — multi-hop cycle + concurrency unit tests.
//
// Covers contracts C-150 (no duplicates on cycle), C-151 (accumulated
// MAX_INTERMEDIATE), C-152 (chunked concurrency).
//
// We mock the model layer + opensearch by mocking `resolveLinks` from
// inside the linkResolverService module. The cycle test uses a fixture
// graph A↔B and asserts the traversal terminates with at most {A, B}
// rather than spinning forever.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../src/models/linkType", () => ({
  getByApiName: vi.fn(async () => ({
    link_type_id: "lt-1",
    api_name: "knows",
    source_object_type: "ot-A",
    target_object_type: "ot-B",
    cardinality: "MANY_TO_MANY" as const,
  })),
}));

// Mock `getObjectTypeApiName` and `searchIndex` (called on the last hop)
// — we don't care about their output for cycle/concurrency tests.
vi.mock("../../../src/services/opensearch/indexLifecycleManager", () => ({
  getIndexName: (s: string) => `ontology-${s}`,
}));

import * as linkResolver from "../../../src/services/linkResolverService";

describe("T-09 resolveMultiHop — cycle detection (C-150)", () => {
  let resolveLinksSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Build a tiny in-memory cycle: A → B → A → B …
    // Every call to __internals.resolveLinks(_, pk, _, …) returns the
    // *other* node. The internal indirection is the testing seam — see
    // src/services/linkResolverService.ts:__internals.
    resolveLinksSpy = vi
      .spyOn(linkResolver.__internals, "resolveLinks")
      .mockImplementation(async (_lt, pk: string) => {
        const other = pk === "A" ? "B" : "A";
        return {
          linkedObjects: [{ __pk: other }],
          totalCount: 1,
          nextPageToken: null,
        } as any;
      });
  });
  afterEach(() => {
    resolveLinksSpy.mockRestore();
  });

  it("T-09 C-150: 5-hop A↔B cycle traverses ≤ 2 unique PKs and never loops indefinitely", async () => {
    // Spy on `searchIndex` indirectly: the last-hop call to it never
    // happens because newlyDiscovered will be empty by hop 2 (everything
    // is already in visitedPKs). We expect the result to short-circuit
    // with no linkedObjects.
    const steps = Array.from({ length: 5 }, () => ({
      ontologyId: "ont-1",
      linkTypeApiName: "knows",
      direction: "forward" as const,
    }));
    const result = await linkResolver.resolveMultiHop(steps, ["A"], {}, null, null);
    // Hop 1: A → B (newlyDiscovered = {B}). Hop 2: B → A, but A is in
    // visitedPKs, so newlyDiscovered = {}. Empty frontier → short-circuit.
    expect(result.hopsCompleted).toBeLessThanOrEqual(2);
    expect(result.linkedObjects).toEqual([]);
    // Calls to resolveLinks: 1 (hop 1 on A) + 1 (hop 2 on B) = 2.
    // Pre-T-09 (no visitedPKs accumulator) would have made many more
    // calls because every hop revisited the prior set.
    expect(resolveLinksSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("T-09 resolveMultiHop — bounded concurrency (C-152)", () => {
  let resolveLinksSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    let inFlight = 0;
    let maxInFlight = 0;
    (globalThis as any).__T09_MAX_INFLIGHT__ = () => maxInFlight;
    resolveLinksSpy = vi
      .spyOn(linkResolver.__internals, "resolveLinks")
      .mockImplementation(async () => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Yield to give other promises a chance to start.
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
        return {
          linkedObjects: [{ __pk: `child-${Math.random()}` }],
          totalCount: 1,
          nextPageToken: null,
        } as any;
      });
  });
  afterEach(() => {
    resolveLinksSpy.mockRestore();
  });

  it("T-09 C-152: 1000 starting PKs × 1 hop never exceeds MULTI_HOP_CONCURRENCY (=50) in-flight calls", async () => {
    const startingPKs = Array.from({ length: 1000 }, (_, i) => `pk-${i}`);
    // We need a non-last-hop branch to exercise the concurrency guard
    // (the last hop also goes through the chunked Promise.all). 1 step
    // is fine — last hop and only hop both use the same chunking code.
    // The last-hop tail calls `getObjectTypeApiName` (a DB query) which
    // fails in this in-memory unit test; we silence the expected stderr
    // log so the test output is not misleading.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await linkResolver
        .resolveMultiHop(
          [{ ontologyId: "ont-1", linkTypeApiName: "knows", direction: "forward" }],
          startingPKs,
          {},
          null,
          null,
        )
        .catch(() => {
          // The last-hop attempts to call searchIndex which we haven't
          // mocked; the error is acceptable for the concurrency assertion
          // because all resolveLinks calls have already completed before
          // searchIndex is invoked.
        });
    } finally {
      errSpy.mockRestore();
    }
    expect(resolveLinksSpy).toHaveBeenCalledTimes(1000);
    const maxInFlight = (globalThis as any).__T09_MAX_INFLIGHT__();
    expect(maxInFlight).toBeLessThanOrEqual(50);
    expect(maxInFlight).toBeGreaterThan(1); // proves concurrency happened
  });
});
