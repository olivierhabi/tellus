// =============================================================================
// B08 — Aggregation service unit tests
//
// Spec §B08 + §F07 + §C Phase 5 Step 6:
//   "default to fixedWidthBuckets to avoid the visual squashing the doc calls
//    out in Phase 5 Step 6" — for Bar XY over numeric x-axis.
//
// Contract IDs:
//   B08 C-01: Bar XY numeric x-axis defaults to fixedWidthBuckets
//   B08 C-02: Bar XY string x-axis (non-numeric) does NOT default to buckets
//   B08 C-03: Pie chart over string defaults to exact
//   B08 C-04: Explicit groupBy is preserved (no default applied)
//   B08 C-05: Unknown property → 400
//   B08 C-06: sum/avg/min/max requires numeric `on`
//   B08 C-07: empty aggregations array → NoAggregationSpecified 400
//   B08 C-08: forwards branch + JWT + executionMode verbatim to OSS
// =============================================================================

import { describe, expect, it, beforeEach } from "vitest";
import {
  aggregate,
  applyChartKindDefaults,
} from "../../../src/services/workshop/aggregationService.js";
import {
  RecordingOssAdapter,
  setOss,
  type OssAggregationDef,
  type OssRequestContext,
} from "../../../src/services/workshop/ossAdapter.js";
import type { PropertyType } from "../../../src/services/workshop/filterCompiler.js";
import { WorkshopError } from "../../../src/services/workshop/errors.js";

const SCHEMA: Record<string, PropertyType> = {
  daysUntilDue: "integer",
  status: "string",
  unitPrice: "double",
  customerName: "string",
};

const CTX: OssRequestContext = {
  jwt: "jwt-test",
  branchRid: "ri.branch.b1",
  userRid: "u1",
};

let oss: RecordingOssAdapter;
beforeEach(() => {
  oss = new RecordingOssAdapter();
  setOss(oss);
});

describe("B08 C-01: Bar XY numeric x-axis defaults to fixedWidthBuckets", () => {
  it("default-applied when groupBy missing", () => {
    const a: OssAggregationDef = {
      name: "byDays",
      property: "daysUntilDue",
      aggregation: { kind: "count" },
    };
    const out = applyChartKindDefaults(a, SCHEMA, "barXy");
    expect(out.groupBy).toEqual({
      kind: "fixedWidthBuckets",
      width: 0,
      minBuckets: 10,
    });
  });
});

describe("B08 C-02: Bar XY non-numeric does NOT bucket", () => {
  it("string x-axis stays as-is", () => {
    const a: OssAggregationDef = {
      name: "byStatus",
      property: "status",
      aggregation: { kind: "count" },
    };
    const out = applyChartKindDefaults(a, SCHEMA, "barXy");
    expect(out.groupBy).toBeUndefined();
  });
});

describe("B08 C-03: Pie + string defaults to exact", () => {
  it("string property + pie → exact", () => {
    const a: OssAggregationDef = {
      name: "statusPie",
      property: "status",
      aggregation: { kind: "count" },
    };
    const out = applyChartKindDefaults(a, SCHEMA, "pie");
    expect(out.groupBy).toEqual({ kind: "exact" });
  });
});

describe("B08 C-04: Explicit groupBy preserved", () => {
  it("explicit fixedWidthBuckets honored", () => {
    const a: OssAggregationDef = {
      name: "byDays",
      property: "daysUntilDue",
      aggregation: { kind: "count" },
      groupBy: { kind: "fixedWidthBuckets", width: 7, minBuckets: 4 },
    };
    const out = applyChartKindDefaults(a, SCHEMA, "barXy");
    expect(out.groupBy).toEqual({
      kind: "fixedWidthBuckets",
      width: 7,
      minBuckets: 4,
    });
  });
});

describe("B08 C-05: unknown property → 400", () => {
  it("rejects unknown property in def", async () => {
    try {
      await aggregate(
        {
          ontologyRid: "o1",
          objectTypeApiName: "Order",
          schema: SCHEMA,
          filters: [],
          aggregations: [
            {
              name: "x",
              property: "doesNotExist",
              aggregation: { kind: "count" },
            },
          ],
        },
        CTX,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkshopError);
      expect((err as WorkshopError).errorName).toBe(
        "Tellus:Workshop:UnknownAggregationProperty",
      );
    }
  });
});

describe("B08 C-06: sum/avg/min/max require numeric `on`", () => {
  it.each(["sum", "avg", "min", "max"] as const)(
    "%s on string property → UnsupportedAggregationPropertyType",
    async (kind) => {
      try {
        await aggregate(
          {
            ontologyRid: "o1",
            objectTypeApiName: "Order",
            schema: SCHEMA,
            filters: [],
            aggregations: [
              {
                name: "x",
                property: "status",
                aggregation: { kind, on: "status" },
              },
            ],
          },
          CTX,
        );
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkshopError);
        expect((err as WorkshopError).errorName).toBe(
          "Tellus:Workshop:UnsupportedAggregationPropertyType",
        );
      }
    },
  );

  it("sum over numeric works", async () => {
    await aggregate(
      {
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [],
        aggregations: [
          {
            name: "totalPrice",
            property: "unitPrice",
            aggregation: { kind: "sum", on: "unitPrice" },
          },
        ],
      },
      CTX,
    );
    expect(oss.calls).toHaveLength(1);
    expect(oss.calls[0]!.kind).toBe("aggregate");
  });
});

describe("B08 C-07: empty aggregations → 400", () => {
  it("rejects with NoAggregationSpecified", async () => {
    try {
      await aggregate(
        {
          ontologyRid: "o1",
          objectTypeApiName: "Order",
          schema: SCHEMA,
          filters: [],
          aggregations: [],
        },
        CTX,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkshopError);
      expect((err as WorkshopError).errorName).toBe(
        "Tellus:Workshop:NoAggregationSpecified",
      );
    }
  });
});

describe("B08 C-08: branch + JWT + executionMode forwarded verbatim", () => {
  it("OSS sees the same context object", async () => {
    await aggregate(
      {
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [{ uiKind: "enum-multi", property: "status", value: ["new"] }],
        aggregations: [
          {
            name: "byStatus",
            property: "status",
            aggregation: { kind: "count" },
          },
        ],
        chartKind: "pie",
        executionMode: "PREFER_SPEED",
      },
      CTX,
    );
    expect(oss.calls).toHaveLength(1);
    const c = oss.calls[0]!;
    expect(c.context.jwt).toBe("jwt-test");
    expect(c.context.branchRid).toBe("ri.branch.b1");
    expect(c.context.userRid).toBe("u1");
    const req = c.request as { executionMode?: string };
    expect(req.executionMode).toBe("PREFER_SPEED");
  });
});
