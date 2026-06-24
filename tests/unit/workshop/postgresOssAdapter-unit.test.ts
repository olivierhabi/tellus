// Unit tests for PostgresOssAdapter — predicate compilation, type whitelist,
// missing-table degradation. These tests use a fake WorkshopDb that records
// SQL + params, so we don't need a live Postgres connection.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setWorkshopDb, resetWorkshopDb } from "../../../src/services/workshop/db";
import { PostgresOssAdapter } from "../../../src/services/workshop/postgresOssAdapter";
import type { Predicate } from "../../../src/services/workshop/filterCompiler";

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function fakeDb(rows: Record<string, unknown>[] = [], totalCount: number | null = null) {
  const recorded: RecordedQuery[] = [];
  setWorkshopDb({
    query: async (sql, params) => {
      recorded.push({ sql, params: params ?? [] });
      // Distinguish count vs row queries
      if (/count\(\*\)/i.test(sql) && totalCount !== null) {
        return { rows: [{ c: totalCount }], rowCount: 1 } as never;
      }
      return { rows, rowCount: rows.length } as never;
    },
    withTransaction: async (fn) => fn({} as never),
  });
  return recorded;
}

const ctx = { jwt: "test", branchRid: null, userRid: "u-test" } as const;

beforeEach(() => {
  resetWorkshopDb();
});

afterEach(() => {
  resetWorkshopDb();
});

describe("PostgresOssAdapter — load", () => {
  it("reads a non-demo type from object_instances (generic path)", async () => {
    const recorded = fakeDb(
      [
        { primary_key: "ORD-1", properties: { id: "ORD-1", itemName: "Printer", quantity: 26 } },
      ],
      1,
    );
    const a = new PostgresOssAdapter();
    const r = await a.load(
      {
        ontologyRid: "ri.ontology.main.ontology.49aaa226-40f3-4516-bd0e-8c3010bd3edd",
        objectTypeApiName: "OlivierOrderJune",
        predicate: { type: "matchAll" },
        pageSize: 10,
      },
      ctx,
    );
    // Hits object_instances scoped by ontology uuid + type, returns the
    // JSONB properties bag verbatim (camelCase preserved).
    expect(recorded[0]?.sql).toMatch(/FROM object_instances/);
    expect(recorded[0]?.sql).toMatch(/object_type_api_name = \$2/);
    expect(recorded[0]?.params?.[0]).toBe("49aaa226-40f3-4516-bd0e-8c3010bd3edd");
    expect(recorded[0]?.params?.[1]).toBe("OlivierOrderJune");
    expect(r.objects).toEqual([{ id: "ORD-1", itemName: "Printer", quantity: 26 }]);
    expect(r.totalEstimate).toBe(1);
  });

  it("generic path falls back id → primary_key when properties lacks id", async () => {
    fakeDb([{ primary_key: "PK-9", properties: { itemName: "Desk" } }], 1);
    const a = new PostgresOssAdapter();
    const r = await a.load(
      {
        ontologyRid: "ri.ontology.main.ontology.49aaa226-40f3-4516-bd0e-8c3010bd3edd",
        objectTypeApiName: "OlivierOrderJune",
        predicate: { type: "matchAll" },
        pageSize: 10,
      },
      ctx,
    );
    expect(r.objects[0]).toEqual({ id: "PK-9", itemName: "Desk" });
  });

  it("generic path parameterizes JSONB field access (no injection surface)", async () => {
    const recorded = fakeDb([], 0);
    const a = new PostgresOssAdapter();
    await a.load(
      {
        ontologyRid: "ri.ontology.main.ontology.49aaa226-40f3-4516-bd0e-8c3010bd3edd",
        objectTypeApiName: "OlivierOrderJune",
        predicate: { type: "term", field: "DROP TABLE x --", value: "v" },
        pageSize: 5,
      },
      ctx,
    );
    // The malicious "field" is bound as a parameter, never interpolated.
    expect(recorded[0]?.sql).toMatch(/properties ->> \$3/);
    expect(recorded[0]?.params).toContain("DROP TABLE x --");
  });

  it("compiles matchAll → WHERE TRUE", async () => {
    const recorded = fakeDb([], 0);
    const a = new PostgresOssAdapter();
    await a.load(
      {
        ontologyRid: "ri.x",
        objectTypeApiName: "order",
        predicate: { type: "matchAll" },
        pageSize: 5,
      },
      ctx,
    );
    expect(recorded[0]?.sql).toMatch(/WHERE TRUE/);
  });

  it("compiles terms predicate to IN with parameter binding", async () => {
    const recorded = fakeDb([], 0);
    const a = new PostgresOssAdapter();
    const predicate: Predicate = {
      type: "terms",
      field: "status",
      values: ["assigned", "open"],
    };
    await a.load(
      { ontologyRid: "ri.x", objectTypeApiName: "order", predicate, pageSize: 5 },
      ctx,
    );
    expect(recorded[0]?.sql).toMatch(/status IN \(\$1, \$2\)/);
    expect(recorded[0]?.params).toEqual(["assigned", "open"]);
  });

  it("rejects unknown property names by compiling to FALSE (no SQL injection surface)", async () => {
    const recorded = fakeDb([], 0);
    const a = new PostgresOssAdapter();
    const predicate: Predicate = {
      type: "term",
      field: "DROP TABLE foo --",
      value: "x",
    };
    await a.load(
      { ontologyRid: "ri.x", objectTypeApiName: "order", predicate, pageSize: 5 },
      ctx,
    );
    expect(recorded[0]?.sql).toMatch(/WHERE FALSE/);
    expect(recorded[0]?.params).toEqual([]);
  });

  it("clamps pageSize to [1, 1000]", async () => {
    const recorded = fakeDb([], 0);
    const a = new PostgresOssAdapter();
    await a.load(
      {
        ontologyRid: "ri.x",
        objectTypeApiName: "order",
        predicate: { type: "matchAll" },
        pageSize: 9999,
      },
      ctx,
    );
    expect(recorded[0]?.sql).toMatch(/LIMIT 1001/); // 1000 + 1
  });

  it("degrades to empty when table is missing (42P01)", async () => {
    setWorkshopDb({
      query: async () => {
        const e = new Error('relation "workshop_demo_order" does not exist') as Error & {
          code?: string;
        };
        e.code = "42P01";
        throw e;
      },
      withTransaction: async (fn) => fn({} as never),
    });
    const a = new PostgresOssAdapter();
    const r = await a.load(
      {
        ontologyRid: "ri.x",
        objectTypeApiName: "order",
        predicate: { type: "matchAll" },
        pageSize: 5,
      },
      ctx,
    );
    expect(r.objects).toEqual([]);
    expect(r.totalEstimate).toBe(0);
  });

  it("rethrows non-missing-table errors", async () => {
    setWorkshopDb({
      query: async () => {
        throw new Error("connection refused");
      },
      withTransaction: async (fn) => fn({} as never),
    });
    const a = new PostgresOssAdapter();
    await expect(
      a.load(
        {
          ontologyRid: "ri.x",
          objectTypeApiName: "order",
          predicate: { type: "matchAll" },
          pageSize: 5,
        },
        ctx,
      ),
    ).rejects.toThrow(/connection refused/);
  });
});

describe("PostgresOssAdapter — aggregate", () => {
  it("returns empty buckets for unseeded type, preserving aggregation names", async () => {
    fakeDb();
    const a = new PostgresOssAdapter();
    const r = await a.aggregate(
      {
        ontologyRid: "ri.x",
        objectTypeApiName: "unknown",
        predicate: { type: "matchAll" },
        aggregations: [
          { name: "byStatus", property: "status", aggregation: { kind: "count" } },
        ],
      },
      ctx,
    );
    expect(r.buckets).toHaveLength(1);
    expect(r.buckets[0]?.name).toBe("byStatus");
    expect(r.buckets[0]?.groups).toEqual([]);
  });

  it("compiles GROUP BY against whitelisted column", async () => {
    const recorded = fakeDb([{ k: "assigned", c: 5 }, { k: "closed", c: 3 }]);
    const a = new PostgresOssAdapter();
    const r = await a.aggregate(
      {
        ontologyRid: "ri.x",
        objectTypeApiName: "order",
        predicate: { type: "matchAll" },
        aggregations: [
          {
            name: "byStatus",
            property: "status",
            groupBy: { kind: "topN", n: 5 },
            aggregation: { kind: "count" },
          },
        ],
      },
      ctx,
    );
    expect(recorded[0]?.sql).toMatch(/SELECT status AS k.*GROUP BY status/s);
    expect(recorded[0]?.sql).toMatch(/LIMIT 5/);
    expect(r.buckets[0]?.groups).toHaveLength(2);
    expect(r.buckets[0]?.groups[0]).toEqual({
      key: "assigned",
      values: { count: 5 },
    });
  });

  it("returns empty groups for unknown property without issuing SQL", async () => {
    const recorded = fakeDb();
    const a = new PostgresOssAdapter();
    const r = await a.aggregate(
      {
        ontologyRid: "ri.x",
        objectTypeApiName: "order",
        predicate: { type: "matchAll" },
        aggregations: [
          { name: "bogus", property: "no_such_col", aggregation: { kind: "count" } },
        ],
      },
      ctx,
    );
    expect(r.buckets[0]?.groups).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("degrades each aggregation to empty groups when table is missing", async () => {
    setWorkshopDb({
      query: async () => {
        const e = new Error("does not exist") as Error & { code?: string };
        e.code = "42P01";
        throw e;
      },
      withTransaction: async (fn) => fn({} as never),
    });
    const a = new PostgresOssAdapter();
    const r = await a.aggregate(
      {
        ontologyRid: "ri.x",
        objectTypeApiName: "order",
        predicate: { type: "matchAll" },
        aggregations: [
          { name: "a", property: "status", aggregation: { kind: "count" } },
          { name: "b", property: "assignee", aggregation: { kind: "count" } },
        ],
      },
      ctx,
    );
    expect(r.buckets.map((b) => b.name)).toEqual(["a", "b"]);
    expect(r.buckets.every((b) => b.groups.length === 0)).toBe(true);
  });
});
