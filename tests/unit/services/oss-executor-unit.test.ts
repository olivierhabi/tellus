// Unit tests: ObjectSet executor with fake deps (no OS/PG/Redis).
import { describe, it, expect } from "vitest";
import { compileObjectSet } from "../../../src/services/oss/objectSetCompiler";
import {
  loadObjectSet,
  aggregateObjectSet,
  ObjectSetExecutionError,
  type ExecutorDeps,
} from "../../../src/services/oss/objectSetExecutor";
import {
  createPageTokenV2,
} from "../../../src/services/oss/pageTokenV2";
import { objectSetFingerprint } from "../../../src/services/oss/objectSetDefinition";

const NOW = new Date("2026-07-28T12:00:00Z");
const ctx = {
  ontologyRid: "o1",
  branchRid: null,
  tenant: "test",
  transactionId: null,
  scenarioRid: null,
  snapshot: false,
};

function fakeSearch(
  data: Record<string, Array<Record<string, unknown>>>,
): ExecutorDeps["search"] {
  return async (objectType, body) => {
    const rows = data[objectType] ?? [];
    const size = (body.size as number) ?? 10;
    const after = body.search_after as unknown[] | undefined;
    let start = 0;
    if (after) {
      const lastPk = after[after.length - 1];
      start = rows.findIndex((r) => r.__pk === lastPk) + 1;
    }
    const slice = rows.slice(start, start + size);
    return {
      hits: slice.map((r) => ({
        _id: r.__pk as string,
        _source: r,
        _sort: [r.__pk],
      })),
      total: rows.length,
    };
  };
}

const baseDeps = (data: Record<string, Array<Record<string, unknown>>>): ExecutorDeps => ({
  keywordOf: async (_t, f) => `${f}.keyword`,
  translateWhere: async (_t, where) => ({ translated: where }),
  search: fakeSearch(data),
});

describe("loadObjectSet", () => {
  it("loads a base set with system props + rid", async () => {
    const compiled = await compileObjectSet(
      { type: "base", objectType: "Employee" },
      { now: () => NOW },
    );
    const r = await loadObjectSet(
      compiled,
      { objectSet: { type: "base", objectType: "Employee" }, select: [] },
      ctx,
      baseDeps({
        Employee: [
          { __pk: "E-1", __rid: "ri.tellus.main.object.1", name: "A" },
        ],
      }),
    );
    expect(r.data).toHaveLength(1);
    expect(r.data[0].__primaryKey).toBe("E-1");
    expect(r.data[0].__apiName).toBe("Employee");
    expect(r.data[0].__rid).toBe("ri.tellus.main.object.1");
    expect(r.data[0].name).toBe("A");
    expect(r.data[0].__pk).toBeUndefined();
  });

  it("excludeRid strips __rid only", async () => {
    const os = { type: "base", objectType: "Employee" } as const;
    const compiled = await compileObjectSet(os, { now: () => NOW });
    const r = await loadObjectSet(
      compiled,
      { objectSet: os, select: [], excludeRid: true },
      ctx,
      baseDeps({
        Employee: [{ __pk: "E-1", __rid: "ri.tellus.main.object.1" }],
      }),
    );
    expect(r.data[0].__rid).toBeUndefined();
    expect(r.data[0].__primaryKey).toBe("E-1");
  });

  it("select limits properties", async () => {
    const os = { type: "base", objectType: "T" } as const;
    const compiled = await compileObjectSet(os, { now: () => NOW });
    const r = await loadObjectSet(
      compiled,
      { objectSet: os, select: ["a"] },
      ctx,
      baseDeps({ T: [{ __pk: "1", a: 1, b: 2 }] }),
    );
    expect(r.data[0].a).toBe(1);
    expect(r.data[0].b).toBeUndefined();
  });

  it("wraps authorized marked properties and omits unauthorized values", async () => {
    const os = { type: "base", objectType: "T" } as const;
    const compiled = await compileObjectSet(os, { now: () => NOW });
    const deps: ExecutorDeps = {
      ...baseDeps({
        T: [{ __pk: "1", publicValue: "ok", restrictedValue: "secret" }],
      }),
      secureProperties: async (_type, hits) =>
        hits.map((hit) => {
          const out = { ...hit };
          delete out.restrictedValue;
          out.__propertySecurity = {
            publicValue: { conjunctive: ["marking-a"] },
          };
          return out;
        }),
    };
    const result = await loadObjectSet(
      compiled,
      {
        objectSet: os,
        select: [],
        loadPropertySecurities: true,
      },
      ctx,
      deps,
    );
    expect(result.data[0].restrictedValue).toBeUndefined();
    expect(result.data[0].publicValue).toEqual({
      value: "ok",
      propertySecurityIndex: 0,
    });
    expect(result.propertySecurities).toEqual([
      {
        disjunction: [
          { type: "propertyMarkingSummary", conjunctive: ["marking-a"] },
        ],
      },
    ]);
  });

  it("omits nulls and default vector properties, but selectV2 can load them", async () => {
    const os = { type: "base", objectType: "T" } as const;
    const compiled = await compileObjectSet(os, { now: () => NOW });
    const rows = [{ __pk: "1", name: null, embedding: [0.1, 0.2], title: "One" }];
    const deps: ExecutorDeps = {
      ...baseDeps({ T: rows }),
      getSelectionMetadata: async () => ({
        primaryKeyPropertyApiName: null,
        titlePropertyApiName: "title",
        properties: {
          name: { baseType: "string" },
          embedding: { baseType: "vector" },
          title: { baseType: "string" },
        },
      }),
    };
    const defaults = await loadObjectSet(
      compiled,
      { objectSet: os, select: [], selectV2: [] },
      ctx,
      deps,
    );
    expect(defaults.totalCount).toBe("1");
    expect(typeof defaults.totalCount).toBe("string");
    expect(defaults.data[0].name).toBeUndefined();
    expect(defaults.data[0].embedding).toBeUndefined();
    const selected = await loadObjectSet(
      compiled,
      {
        objectSet: os,
        select: [],
        selectV2: [
          { type: "property", apiName: "embedding" },
          { type: "titleProperty" },
        ],
      },
      ctx,
      deps,
    );
    expect(selected.data[0].embedding).toEqual([0.1, 0.2]);
    expect(selected.data[0].title).toBe("One");
    expect(selected.data[0].name).toBeUndefined();
  });

  it("paginates with a fingerprint-bound token", async () => {
    const os = { type: "base", objectType: "T" } as const;
    const rows = Array.from({ length: 5 }, (_, i) => ({ __pk: `P-${i}` }));
    const deps = baseDeps({ T: rows });
    const compiled = await compileObjectSet(os, { now: () => NOW });

    const p1 = await loadObjectSet(
      compiled,
      { objectSet: os, select: [], pageSize: 2 },
      ctx,
      deps,
    );
    expect(p1.data.map((d) => d.__primaryKey)).toEqual(["P-0", "P-1"]);
    expect(p1.nextPageToken).toBeTruthy();

    const p2 = await loadObjectSet(
      compiled,
      { objectSet: os, select: [], pageSize: 2, pageToken: p1.nextPageToken! },
      ctx,
      deps,
    );
    expect(p2.data.map((d) => d.__primaryKey)).toEqual(["P-2", "P-3"]);

    await expect(
      loadObjectSet(
        compiled,
        {
          objectSet: os,
          select: ["differentSelection"],
          pageSize: 2,
          pageToken: p1.nextPageToken!,
        },
        ctx,
        deps,
      ),
    ).rejects.toThrowError(/different request options/);

    // cross-set reuse rejected
    const other = await compileObjectSet(
      { type: "base", objectType: "U" },
      { now: () => NOW },
    );
    await expect(
      loadObjectSet(
        other,
        { objectSet: { type: "base", objectType: "U" }, select: [], pageToken: p1.nextPageToken! },
        ctx,
        baseDeps({ U: [] }),
      ),
    ).rejects.toThrowError(/different object set/);
  });

  it("snapshot paging carries PIT state and ignores later live mutations", async () => {
    const os = { type: "base", objectType: "T" } as const;
    const compiled = await compileObjectSet(os, { now: () => NOW });
    const frozen = Array.from({ length: 4 }, (_, i) => ({ __pk: `P-${i}` }));
    const live = [...frozen];
    const lifecycle: string[] = [];
    const deps: ExecutorDeps = {
      keywordOf: async (_t, field) => field,
      translateWhere: async () => ({ match_all: {} }),
      assertSnapshotReady: async (types) => {
        expect(types).toEqual(["T"]);
        lifecycle.push("ready");
      },
      createPointInTime: async () => {
        lifecycle.push("open");
        return { T: "pit-T" };
      },
      closePointInTime: async (ids) => {
        expect(ids).toEqual({ T: "pit-T" });
        lifecycle.push("close");
      },
      mergeOverlay: async () => {
        throw new Error("snapshot reads must never merge the live overlay");
      },
      search: async (_type, body, options) => {
        expect(options?.pitId).toBe("pit-T");
        const rows = options?.pitId ? frozen : live;
        const after = body.search_after as unknown[] | undefined;
        const start = after
          ? rows.findIndex((row) => row.__pk === after.at(-1)) + 1
          : 0;
        const slice = rows.slice(start, start + Number(body.size));
        return {
          hits: slice.map((row) => ({
            _id: row.__pk,
            _source: row,
            _sort: [row.__pk],
          })),
          total: rows.length,
        };
      },
    };
    const snapshotCtx = { ...ctx, snapshot: true };
    const first = await loadObjectSet(
      compiled,
      { objectSet: os, select: [], pageSize: 2, snapshot: true },
      snapshotCtx,
      deps,
    );
    expect(first.data.map((row) => row.__primaryKey)).toEqual(["P-0", "P-1"]);
    live.splice(0, live.length, { __pk: "MUTATED" });
    const second = await loadObjectSet(
      compiled,
      {
        objectSet: os,
        select: [],
        pageSize: 2,
        snapshot: true,
        pageToken: first.nextPageToken!,
      },
      snapshotCtx,
      deps,
    );
    expect(second.data.map((row) => row.__primaryKey)).toEqual(["P-2", "P-3"]);
    expect(lifecycle).toEqual(["ready", "open", "close"]);
  });

  it("snapshot paging remains pinned when a transaction advances", async () => {
    const os = { type: "base", objectType: "T" } as const;
    const compiled = await compileObjectSet(os, { now: () => NOW });
    const versions: Array<number | null> = [];
    const deps: ExecutorDeps = {
      ...baseDeps({
        T: [{ __pk: "1" }, { __pk: "2" }, { __pk: "3" }],
      }),
      assertSnapshotReady: async () => undefined,
      createPointInTime: async () => ({ T: "pit-T" }),
      closePointInTime: async () => undefined,
      composeReadContext: async (_type, hits, _where, version) => {
        versions.push(version.transactionVersion);
        return hits;
      },
    };
    const first = await loadObjectSet(
      compiled,
      { objectSet: os, select: [], pageSize: 1, snapshot: true },
      {
        ...ctx,
        transactionId: "tx-1",
        transactionVersion: 2,
        snapshot: true,
      },
      deps,
    );
    await loadObjectSet(
      compiled,
      {
        objectSet: os,
        select: [],
        pageSize: 1,
        snapshot: true,
        pageToken: first.nextPageToken!,
      },
      {
        ...ctx,
        transactionId: "tx-1",
        transactionVersion: 9,
        snapshot: true,
      },
      deps,
    );
    expect(versions).toEqual([2, 2]);
  });

  it("paginates context-created objects without duplicates", async () => {
    const os = { type: "base", objectType: "T" } as const;
    const compiled = await compileObjectSet(os, { now: () => NOW });
    const deps: ExecutorDeps = {
      ...baseDeps({ T: [] }),
      assertSnapshotReady: async () => undefined,
      createPointInTime: async () => ({ T: "pit-T" }),
      closePointInTime: async () => undefined,
      composeReadContext: async () => [
        { __pk: "C-1", __primaryKey: "C-1", __apiName: "T" },
        { __pk: "C-2", __primaryKey: "C-2", __apiName: "T" },
      ],
      adjustReadContextTotal: async () => 2,
    };
    const context = {
      ...ctx,
      transactionId: "tx-created",
      transactionVersion: 2,
      snapshot: true,
    };
    const first = await loadObjectSet(
      compiled,
      { objectSet: os, select: [], pageSize: 1, snapshot: true },
      context,
      deps,
    );
    const second = await loadObjectSet(
      compiled,
      {
        objectSet: os,
        select: [],
        pageSize: 1,
        snapshot: true,
        pageToken: first.nextPageToken!,
      },
      context,
      deps,
    );
    expect(first.data.map((object) => object.__primaryKey)).toEqual(["C-1"]);
    expect(second.data.map((object) => object.__primaryKey)).toEqual(["C-2"]);
  });

  it("snapshot fails closed when recent overlay edits are not indexed", async () => {
    const os = { type: "base", objectType: "T" } as const;
    const compiled = await compileObjectSet(os, { now: () => NOW });
    const deps: ExecutorDeps = {
      ...baseDeps({ T: [] }),
      assertSnapshotReady: async () => {
        throw new ObjectSetExecutionError(
          "ConsistentSnapshotError",
          "pending overlay",
          {},
          409,
        );
      },
      createPointInTime: async () => ({ T: "pit-T" }),
      closePointInTime: async () => undefined,
    };
    await expect(
      loadObjectSet(
        compiled,
        { objectSet: os, select: [], snapshot: true },
        { ...ctx, snapshot: true },
        deps,
      ),
    ).rejects.toMatchObject({
      errorName: "ConsistentSnapshotError",
      statusCode: 409,
    });
  });

  it("cross-type union merges deterministically without duplicates", async () => {
    const os = {
      type: "union",
      objectSets: [
        { type: "base", objectType: "A" },
        { type: "base", objectType: "B" },
      ],
    } as const;
    const compiled = await compileObjectSet(os as never, { now: () => NOW });
    expect(compiled.crossType).toBe(true);
    const r = await loadObjectSet(
      compiled,
      { objectSet: os as never, select: [] },
      ctx,
      baseDeps({
        A: [{ __pk: "1" }, { __pk: "2" }],
        B: [{ __pk: "2" }, { __pk: "3" }],
      }),
    );
    const ids = r.data.map((d) => `${d.__apiName}:${d.__primaryKey}`);
    expect(ids).toEqual(["A:1", "A:2", "B:2", "B:3"]);
  });

  it("searchAround fulfils via the traverse dep", async () => {
    const os = {
      type: "searchAround",
      objectSet: { type: "base", objectType: "Employee" },
      link: "worksAt",
    } as const;
    const compiled = await compileObjectSet(os as never, { now: () => NOW });
    const deps: ExecutorDeps = {
      ...baseDeps({ Company: [{ __pk: "C-9", name: "Acme" }] }),
      traverse: async ({ link }) => {
        expect(link).toBe("worksAt");
        return { targetObjectType: "Company", targetPks: ["C-9"] };
      },
    };
    const r = await loadObjectSet(compiled, { objectSet: os as never, select: [] }, ctx, deps);
    expect(r.data[0].__apiName).toBe("Company");
    expect(r.data[0].name).toBe("Acme");
  });

  it("interfaceLinkSearchAround fans concrete targets into typed plans", async () => {
    const os = {
      type: "interfaceLinkSearchAround",
      objectSet: { type: "base", objectType: "Employee" },
      interfaceLink: "Owns",
    } as const;
    const compiled = await compileObjectSet(os as never, {
      now: () => NOW,
    });
    const deps: ExecutorDeps = {
      ...baseDeps({
        Vehicle: [{ __pk: "V-1" }],
        Building: [{ __pk: "B-1" }],
      }),
      traverse: async ({ interfaceLink }) => {
        expect(interfaceLink).toBe(true);
        return [
          { targetObjectType: "Vehicle", targetPks: ["V-1"] },
          { targetObjectType: "Building", targetPks: ["B-1"] },
        ];
      },
    };
    const result = await loadObjectSet(
      compiled,
      { objectSet: os as never, select: [] },
      ctx,
      deps,
    );
    expect(
      result.data.map((object) => object.__apiName).sort(),
    ).toEqual(["Building", "Vehicle"]);
  });

  it("static set resolves rids → typed plans", async () => {
    const os = { type: "static", objects: ["ri.tellus.main.object.1"] } as const;
    const compiled = await compileObjectSet(os as never, { now: () => NOW });
    const deps: ExecutorDeps = {
      ...baseDeps({ Employee: [{ __pk: "E-1", name: "A" }] }),
      resolveStaticRids: async (rids) => {
        expect(rids).toEqual(["ri.tellus.main.object.1"]);
        return [{ rid: rids[0]!, objectType: "Employee", primaryKey: "E-1" }];
      },
    };
    const r = await loadObjectSet(compiled, { objectSet: os as never, select: [] }, ctx, deps);
    expect(r.data[0].__primaryKey).toBe("E-1");
  });

  it("text nearestNeighbors fails typed (no silent full-text fallback)", async () => {
    const os = {
      type: "nearestNeighbors",
      objectSet: { type: "base", objectType: "T" },
      propertyIdentifier: { type: "property", apiName: "emb" },
      numNeighbors: 3,
      query: { type: "text", value: "similar docs" },
    } as const;
    const compiled = await compileObjectSet(os as never, { now: () => NOW });
    await expect(
      loadObjectSet(compiled, { objectSet: os as never, select: [] }, ctx, baseDeps({ T: [] })),
    ).rejects.toMatchObject({ errorName: "NearestNeighborsTextNotConfigured" });
  });
});

describe("aggregateObjectSet", () => {
  const os = { type: "base", objectType: "T" } as const;

  it("ungrouped count → single item", async () => {
    const compiled = await compileObjectSet(os, { now: () => NOW });
    const deps: ExecutorDeps = {
      keywordOf: async (_t, f) => f,
      translateWhere: async () => ({ match_all: {} }),
      search: async () => ({
        hits: [],
        total: 3,
        aggregations: { __all: { doc_count: 3, count_objects_0: { value: 3 } } },
      }),
    };
    const r = await aggregateObjectSet(
      compiled,
      { objectSet: os, aggregation: [{ type: "count" }], groupBy: [] },
      ctx,
      deps,
    );
    expect(r.accuracy).toBe("ACCURATE");
    expect(r.data).toHaveLength(1);
  });

  it("cross-type percentile → typed error, never faked", async () => {
    const cross = {
      type: "union",
      objectSets: [
        { type: "base", objectType: "A" },
        { type: "base", objectType: "B" },
      ],
    } as const;
    const compiled = await compileObjectSet(cross as never, { now: () => NOW });
    await expect(
      aggregateObjectSet(
        compiled,
        {
          objectSet: cross as never,
          aggregation: [{ type: "approximatePercentile", field: "x", approximatePercentile: 50 }],
          groupBy: [],
        },
        ctx,
        baseDeps({ A: [], B: [] }),
      ),
    ).rejects.toMatchObject({ errorName: "AggregationAccuracyNotSupported" });
  });

  it("aggregates the composed transaction/scenario view", async () => {
    const compiled = await compileObjectSet(os, { now: () => NOW });
    const deps: ExecutorDeps = {
      ...baseDeps({ T: [{ __pk: "1", dept: "A", amount: 2 }] }),
      composeReadContext: async (_type, hits) => [
        ...hits,
        {
          __pk: "2",
          __primaryKey: "2",
          __apiName: "T",
          dept: "A",
          amount: 3,
        },
      ],
    };
    const result = await aggregateObjectSet(
      compiled,
      {
        objectSet: os,
        aggregation: [
          { type: "count" },
          { type: "sum", field: "amount" },
        ],
        groupBy: [{ type: "exact", field: "dept" }],
      },
      {
        ...ctx,
        transactionId: "tx-1",
        transactionVersion: 2,
      },
      deps,
    );
    expect(result).toMatchObject({
      accuracy: "ACCURATE",
      data: [
        {
          group: { dept: "A" },
          metrics: [
            { name: "count_objects_0", value: 2 },
            { name: "sum_amount_1", value: 5 },
          ],
        },
      ],
    });
  });

  it("fingerprint binds aggregate page safety (no token path → no token needed)", async () => {
    const t = createPageTokenV2({
      ontologyRid: "o1",
      branchRid: null,
      fingerprint: objectSetFingerprint(os),
      orderBy: [],
      cursors: {},
    });
    expect(t.split(".")).toHaveLength(2);
  });
});
