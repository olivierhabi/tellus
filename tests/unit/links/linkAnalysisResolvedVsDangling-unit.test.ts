// ---------------------------------------------------------------------------
// Phase-1 regression — link analysis resolved-vs-dangling invariant.
//
// Root cause of the historical RSSB "links > 0 / targets = 0" contradiction:
// `analyzeLinkType` counted POPULATED foreign keys as `totalLinkCount`
// without confirming the FK value resolves to an indexed target object.
// When the target index was stale/empty, every populated FK was dangling
// yet `totalLinkCount` reported them as links — contradicting
// `totalTargetObjects === 0`.
//
// Foundry semantics (the fix): link analysis counts RESOLVED edges against
// indexed target objects; populated-but-unresolved FKs are reported
// separately as `danglingEdges`. Invariant enforced + asserted here:
//   `totalLinkCount > 0  ⇒  totalTargetObjects > 0`
//
// These tests mock the OpenSearch client surface so they run under
// `vitest.unit.config.ts` without Docker.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

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

// PG mock: resolve object-type + property api names by the id param so
// source vs target get distinct index names.
vi.mock("../../../src/db", () => ({
  query: vi.fn(async (_sql: string, params: any[]) => {
    const id = params?.[0];
    if (id === "ot-source") return { rows: [{ api_name: "SrcType" }] };
    if (id === "ot-target") return { rows: [{ api_name: "TgtType" }] };
    if (id === "prop-fk") return { rows: [{ api_name: "fkProp" }] };
    return { rows: [{ api_name: "Unknown" }] };
  }),
  withTransaction: vi.fn(),
}));

import { analyzeLinkType } from "../../../src/services/linkResolverService";

// A MANY_TO_ONE link (FK on source side, joins to target __pk).
const linkType = {
  link_type_id: "lt-m21",
  api_name: "srcToTgt",
  display_name: "Src to Tgt",
  source_object_type: "ot-source",
  target_object_type: "ot-target",
  source_property_id: "prop-fk",
  target_property_id: null,
  cardinality: "MANY_TO_ONE",
  join_table_file_path: null,
  ontology_id: "ont-1",
  direction: "forward",
  mcp_propagation_mode: "union",
  mcp_required_count: 1,
  mandatory_control_property_id: null,
} as any;

function compositeBuckets(values: string[], perCount: number) {
  return {
    buckets: values.map((v) => ({ key: { fk: v }, doc_count: perCount })),
  };
}

function emptyBuckets() {
  return { buckets: [] };
}

function onRequest(
  countImpl: (index: string, query: any) => number,
  searchImpl: (index: string, body: any) => any,
) {
  countSpy.mockImplementation(async (args: any) => {
    const index: string = args.index;
    const query = args.body?.query;
    return { statusCode: 200, body: { count: countImpl(index, query) } };
  });
  searchSpy.mockImplementation(async (args: any) => {
    const index: string = args.index;
    return { statusCode: 200, body: searchImpl(index, args.body) };
  });
  getSpy.mockResolvedValue({ statusCode: 200, body: { _source: {} } });
}

describe("Phase-1 — analyzeLinkType resolved vs dangling invariant", () => {
  beforeEach(() => {
    searchSpy.mockReset();
    countSpy.mockReset();
    getSpy.mockReset();
  });

  it("stale/empty target index: populated FKs are ALL dangling, links=0, invariant holds", async () => {
    // 10 source objects, every one has a populated FK, but the target
    // index is EMPTY (0 objects) — the historical contradiction scenario.
    onRequest(
      (index, query) => {
        if (query?.match_all !== undefined) return index.endsWith("tgttype") ? 0 : 10;
        if (query?.exists) return 10; // populated FK count on source
        return 0;
      },
      (_index, body) => {
        const src = body?.aggs?.fk_buckets?.composite?.sources?.[0]?.fk?.terms?.field;
        if (src && src.startsWith("fkProp")) {
          // distinct FK values in the source index: 5 values x 2 docs = 10
          return { aggregations: { fk_buckets: compositeBuckets(["T1", "T2", "T3", "T4", "T5"], 2) } };
        }
        if (src === "__pk") {
          // target index has NO primary keys (stale/empty)
          return { aggregations: { fk_buckets: emptyBuckets() } };
        }
        return { aggregations: { fk_buckets: emptyBuckets() } };
      },
    );

    const a = await analyzeLinkType(linkType, { precision: "exact" }, null, null);

    expect(a.totalTargetObjects).toBe(0);
    // The contradiction is impossible: populated FKs (10) do NOT count as links.
    expect(a.totalLinkCount).toBe(0);
    expect(a.danglingEdges).toBe(10);
    // Invariant: links > 0 ⇒ targets > 0. Here links=0 so vacuously ok,
    // but explicitly: there is NO "links=10 / targets=0" any more.
    expect(a.totalLinkCount > 0 ? a.totalTargetObjects > 0 : true).toBe(true);
  });

  it("healthy target: resolved edges counted, zero dangling, invariant holds", async () => {
    onRequest(
      (index, query) => {
        if (query?.match_all !== undefined) return index.endsWith("tgttype") ? 5 : 10;
        if (query?.exists) return 10;
        return 0;
      },
      (_index, body) => {
        const src = body?.aggs?.fk_buckets?.composite?.sources?.[0]?.fk?.terms?.field;
        if (src && src.startsWith("fkProp")) {
          return { aggregations: { fk_buckets: compositeBuckets(["T1", "T2", "T3", "T4", "T5"], 2) } };
        }
        if (src === "__pk") {
          // target index has the 5 matching PKs
          return { aggregations: { fk_buckets: compositeBuckets(["T1", "T2", "T3", "T4", "T5"], 1) } };
        }
        return { aggregations: { fk_buckets: emptyBuckets() } };
      },
    );

    const a = await analyzeLinkType(linkType, { precision: "exact" }, null, null);

    expect(a.totalTargetObjects).toBe(5);
    expect(a.totalLinkCount).toBe(10); // all 5 FK values resolve x 2 docs
    expect(a.danglingEdges).toBe(0);
    // Invariant: links > 0 ⇒ targets > 0
    expect(a.totalLinkCount > 0).toBe(true);
    expect(a.totalTargetObjects > 0).toBe(true);
  });

  it("partial dangling: only resolving FK values count as links; rest are dangling", async () => {
    onRequest(
      (index, query) => {
        if (query?.match_all !== undefined) return index.endsWith("tgttype") ? 5 : 10;
        if (query?.exists) return 10;
        return 0;
      },
      (_index, body) => {
        const src = body?.aggs?.fk_buckets?.composite?.sources?.[0]?.fk?.terms?.field;
        if (src && src.startsWith("fkProp")) {
          // 3 values resolve (T1,T2,T3), 2 values point at missing targets
          return { aggregations: { fk_buckets: compositeBuckets(["T1", "T2", "T3", "GHOST1", "GHOST2"], 2) } };
        }
        if (src === "__pk") {
          return { aggregations: { fk_buckets: compositeBuckets(["T1", "T2", "T3", "T4", "T5"], 1) } };
        }
        return { aggregations: { fk_buckets: emptyBuckets() } };
      },
    );

    const a = await analyzeLinkType(linkType, { precision: "exact" }, null, null);

    expect(a.totalTargetObjects).toBe(5);
    expect(a.totalLinkCount).toBe(6); // T1,T2,T3 x 2 docs each
    expect(a.danglingEdges).toBe(4); // GHOST1,GHOST2 x 2 docs each
    // Invariant holds: links > 0 ⇒ targets > 0
    expect(a.totalLinkCount > 0 ? a.totalTargetObjects > 0 : true).toBe(true);
    // Sanity: links + dangling == populated FKs
    expect(a.totalLinkCount + a.danglingEdges).toBe(10);
  });
});
