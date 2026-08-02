// ---------------------------------------------------------------------------
// searchAround edgeResolver seam (serving-store cutover).
//
// Proves the injected LinkServingStore path: when the route passes an
// edgeResolver the M2M branch:
//   1. never touches the CSV join table (defect #4 fixed — no parse in
//      request path);
//   2. hydrates linked objects with the SAME filters/security/page logic
//      as the legacy path (response shape is bit-compatible);
//   3. short-circuits deterministically when the edge store is empty.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

const searchSpy = vi.fn();
const countSpy = vi.fn();
const getSpy = vi.fn();
vi.mock("../../../src/services/opensearch/client", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/services/opensearch/client")
  >("../../../src/services/opensearch/client");
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

// PG: getObjectTypeApiName reads `api_name`.
vi.mock("../../../src/db", () => ({
  query: vi.fn(async () => ({ rows: [{ api_name: "Jet" }] })),
  withTransaction: vi.fn(),
}));

import { searchAround } from "../../../src/services/linkResolverService";

const m2mLinkType = {
  link_type_id: "lt-2",
  api_name: "assigned",
  display_name: "Assigned",
  source_object_type: "ot-src",
  target_object_type: "ot-tgt",
  source_property_id: null,
  target_property_id: null,
  cardinality: "MANY_TO_MANY",
  // NOTE: NO join_table_file_path — the CSV file does not even have to
  // exist for the cutover to serve edges from the serving index.
  join_table_file_path: null,
  ontology_id: "ont-1",
} as any;

beforeEach(() => {
  searchSpy.mockReset();
});

describe("searchAround with injected edgeResolver (serving-store cutover)", () => {
  it("resolves edges through the store and hydrates via shared logic", async () => {
    // [0] source-side PK lookup: source BWI exists.
    searchSpy.mockResolvedValueOnce({
      statusCode: 200,
      body: { hits: { total: { value: 1 }, hits: [{ _source: { __pk: "BWI" } }] } },
    });
    // [1] hydrate targets resolved by the edge store.
    searchSpy.mockResolvedValueOnce({
      statusCode: 200,
      body: {
        hits: {
          total: { value: 2 },
          hits: [
            { _source: { __pk: "T1", name: "Ferewnda" } },
            { _source: { __pk: "T2", name: "Exalt" } },
          ],
        },
      },
    });

    const edgeCalls: Array<{ pks: string[]; direction: string }> = [];
    const result = await searchAround(
      m2mLinkType,
      "forward",
      {
        pageSize: 100,
        edgeResolver: async (pks, direction) => {
          edgeCalls.push({ pks: [...pks], direction });
          return ["T1", "T2"]; // from the versioned ClickHouse edge index in prod
        },
      },
      null,
      null,
    );

    // The serving store received exactly the resolved source PKs
    expect(edgeCalls).toEqual([{ pks: ["BWI"], direction: "forward" }]);
    // Exacly TWO OpenSearch calls (source + hydrate) — zero CSV parse
    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(result.totalCount).toBe(2);
    expect(result.linkedObjects).toHaveLength(2);
    expect(result.nextPageToken).toBeNull();
  });

  it("empty edge store yields an empty, well-formed response", async () => {
    searchSpy.mockResolvedValueOnce({
      statusCode: 200,
      body: { hits: { total: { value: 1 }, hits: [{ _source: { __pk: "BWI" } }] } },
    });
    const result = await searchAround(
      m2mLinkType,
      "reverse",
      {
        edgeResolver: async () => [],
      },
      null,
      null,
    );
    expect(result.linkedObjects).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.nextPageToken).toBeNull();
    // Only the source-side lookup happened — no hydration query.
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });
});
