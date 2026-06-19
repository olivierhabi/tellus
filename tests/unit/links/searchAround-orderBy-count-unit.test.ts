// ---------------------------------------------------------------------------
// searchAround — server-side $orderBy + accurate totalCount.
//
// Proves that `linkResolverService.searchAround`:
//   1. translates `options.orderBy` into an OpenSearch `sort` clause
//      (via buildSortClause) on the FK-resolve query, and
//   2. sets `track_total_hits: true` so the returned `totalCount` is the
//      real hit total rather than the 10k-capped default.
//
// Mocks the OpenSearch client + the PG layer + resolveProperty so it runs
// under vitest.unit.config.ts without Docker.
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

// PG: getObjectTypeApiName / getPropertyApiName both read `api_name`.
vi.mock("../../../src/db", () => ({
  query: vi.fn(async () => ({ rows: [{ api_name: "Flight" }] })),
  withTransaction: vi.fn(),
}));

// resolveProperty: string-typed meta → buildSortClause sorts on `.keyword`.
vi.mock("../../../src/services/propertyResolver", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/services/propertyResolver")
  >("../../../src/services/propertyResolver");
  return {
    ...actual,
    resolveProperty: vi.fn(async (_ot: string, field: string) => ({
      baseType: "string",
      opensearchField: field,
      opensearchKeywordField: `${field}.keyword`,
    })),
  };
});

import { searchAround } from "../../../src/services/linkResolverService";

const linkType = {
  link_type_id: "lt-1",
  api_name: "flights",
  display_name: "Flight",
  source_object_type: "ot-src",
  target_object_type: "ot-tgt",
  source_property_id: null,
  target_property_id: "prop-1",
  cardinality: "ONE_TO_MANY",
  join_table_file_path: null,
  ontology_id: "ont-1",
} as any;

// searchAround issues two `client.search` calls on the FK path:
//   [0] source-side PK lookup, [1] FK-resolve of target objects.
function primeSourceAndTarget(targetTotal: number) {
  searchSpy.mockResolvedValueOnce({
    statusCode: 200,
    body: { hits: { total: { value: 1 }, hits: [{ _source: { __pk: "BWI" } }] } },
  });
  searchSpy.mockResolvedValueOnce({
    statusCode: 200,
    body: {
      hits: {
        total: { value: targetTotal },
        hits: [{ _source: { __pk: "F1", route: "BWI-LAS" } }],
      },
    },
  });
}

describe("searchAround — $orderBy + totalCount", () => {
  beforeEach(() => {
    searchSpy.mockReset();
  });

  it("translates orderBy → OpenSearch sort + sets track_total_hits + returns the real totalCount", async () => {
    primeSourceAndTarget(42);

    const result = await searchAround(
      linkType,
      "forward",
      {
        sourceFilter: { __pk: "BWI" },
        orderBy: [{ field: "route", direction: "asc" }],
        pageSize: 10,
      },
      null,
      null,
    );

    expect(searchSpy).toHaveBeenCalledTimes(2);
    const fkBody = searchSpy.mock.calls[1][0].body as Record<string, unknown>;
    expect(fkBody.track_total_hits).toBe(true);
    expect(fkBody.sort).toEqual([
      { "route.keyword": { order: "asc" } },
      { __pk: { order: "asc" } },
    ]);
    expect(result.totalCount).toBe(42);
    expect(result.linkedObjects).toHaveLength(1);
  });

  it("omits sort when no orderBy is given but still sets track_total_hits", async () => {
    primeSourceAndTarget(7);

    const result = await searchAround(
      linkType,
      "forward",
      { sourceFilter: { __pk: "BWI" } },
      null,
      null,
    );

    const fkBody = searchSpy.mock.calls[1][0].body as Record<string, unknown>;
    expect(fkBody.track_total_hits).toBe(true);
    expect(fkBody.sort).toBeUndefined();
    expect(result.totalCount).toBe(7);
  });
});
