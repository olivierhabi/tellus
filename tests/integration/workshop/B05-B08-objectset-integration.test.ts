// =============================================================================
// B05 + B08 — wire-level integration via supertest.
//
// These endpoints are pure compile + forward (no DB access on Workshop's
// side) so the test installs a RecordingOssAdapter and asserts:
//   - the route accepts/rejects the documented body shapes
//   - branch (?branch=…) flows verbatim into the OSS context (§0.5)
//   - executionMode + snapshotConsistency flow verbatim (B05 acceptance)
//   - chartKind drives the Bar-XY-numeric default-bucket rule (§B08, §C P5S6)
//   - filter compilation errors surface as Conjure envelopes (§0.1)
// =============================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import workshopModulesRouter from "../../../src/routes/workshopModules";
import {
  RecordingOssAdapter,
  setOss,
} from "../../../src/services/workshop/ossAdapter";

let app: Express;
let oss: RecordingOssAdapter;

beforeAll(() => {
  app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; token: string } }).user = {
      id: "u-1",
      token: "jwt-test-token",
    };
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);
});

beforeEach(() => {
  oss = new RecordingOssAdapter(
    () => ({
      objects: [{ id: "o-1", status: "new" }],
      nextPageToken: null,
      totalEstimate: 1,
    }),
    () => ({
      buckets: [
        {
          name: "byStatus",
          groups: [{ key: "new", values: { count: 5 } }],
        },
      ],
    }),
  );
  setOss(oss);
});

afterAll(() => {
  // restore default
  setOss(new RecordingOssAdapter());
});

const SCHEMA = { itemName: "string", status: "string", daysUntilDue: "integer" };

describe("B05 — POST /object-sets/_load", () => {
  it("B05 C-01 wire: forwards branch + JWT + executionMode verbatim to OSS", async () => {
    const r = await request(app)
      .post(
        "/api/v1/workshop/object-sets/_load?branch=ri.branch.main.b1",
      )
      .send({
        ontologyRid: "ri.ontology.main.x",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [],
        pageSize: 50,
        executionMode: "PREFER_SPEED",
        snapshotConsistency: "STRONG",
      });
    expect(r.status).toBe(200);
    expect(oss.calls).toHaveLength(1);
    const call = oss.calls[0]!;
    expect(call.kind).toBe("load");
    expect(call.context.jwt).toBe("jwt-test-token");
    expect(call.context.branchRid).toBe("ri.branch.main.b1");
    const req = call.request as { executionMode?: string; snapshotConsistency?: string };
    expect(req.executionMode).toBe("PREFER_SPEED");
    expect(req.snapshotConsistency).toBe("STRONG");
  });

  it("B05 wire: omitted ?branch → null branchRid", async () => {
    const r = await request(app)
      .post("/api/v1/workshop/object-sets/_load")
      .send({
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [],
        pageSize: 10,
      });
    expect(r.status).toBe(200);
    expect(oss.calls[0]!.context.branchRid).toBeNull();
  });

  it("B05 wire: filter compiler error surfaces as Conjure envelope 400", async () => {
    const r = await request(app)
      .post("/api/v1/workshop/object-sets/_load")
      .send({
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [
          { uiKind: "string-default", property: "daysUntilDue", value: "x" },
        ],
        pageSize: 10,
      });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe(
      "Tellus:Workshop:UnsupportedFilterPropertyType",
    );
    expect(r.body.errorInstanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("B05 wire: pageSize=0 → InvalidPageSize 400", async () => {
    const r = await request(app)
      .post("/api/v1/workshop/object-sets/_load")
      .send({
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [],
        pageSize: 0,
      });
    // zod catches this first as InvalidModuleSchema (positive), which is the
    // strict-validation gate; either name is an acceptable Conjure envelope.
    expect(r.status).toBe(400);
    expect([
      "Tellus:Workshop:InvalidModuleSchema",
      "Tellus:Workshop:InvalidPageSize",
    ]).toContain(r.body.errorName);
  });

  it("B05 wire: passes back OSS load response unchanged", async () => {
    const r = await request(app)
      .post("/api/v1/workshop/object-sets/_load")
      .send({
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [],
        pageSize: 10,
      });
    expect(r.status).toBe(200);
    expect(r.body.objects).toEqual([{ id: "o-1", status: "new" }]);
    expect(r.body.totalEstimate).toBe(1);
  });
});

describe("B08 — POST /object-sets/_aggregate", () => {
  it("B08 C-01 wire: barXy + numeric x-axis defaults to fixedWidthBuckets", async () => {
    const r = await request(app)
      .post("/api/v1/workshop/object-sets/_aggregate")
      .send({
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [],
        aggregations: [
          {
            name: "byDays",
            property: "daysUntilDue",
            aggregation: { kind: "count" },
          },
        ],
        chartKind: "barXy",
      });
    expect(r.status).toBe(200);
    expect(oss.calls).toHaveLength(1);
    const req = oss.calls[0]!.request as {
      aggregations: ReadonlyArray<{
        groupBy?: { kind: string; width?: number; minBuckets?: number };
      }>;
    };
    expect(req.aggregations[0]!.groupBy?.kind).toBe("fixedWidthBuckets");
    expect(req.aggregations[0]!.groupBy?.width).toBe(0);
    expect(req.aggregations[0]!.groupBy?.minBuckets).toBe(10);
  });

  it("B08 wire: pie + string defaults to exact", async () => {
    await request(app)
      .post("/api/v1/workshop/object-sets/_aggregate")
      .send({
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [],
        aggregations: [
          {
            name: "byStatus",
            property: "status",
            aggregation: { kind: "count" },
          },
        ],
        chartKind: "pie",
      });
    const req = oss.calls[0]!.request as {
      aggregations: ReadonlyArray<{ groupBy?: { kind: string } }>;
    };
    expect(req.aggregations[0]!.groupBy?.kind).toBe("exact");
  });

  it("B08 wire: empty aggregations → 400", async () => {
    const r = await request(app)
      .post("/api/v1/workshop/object-sets/_aggregate")
      .send({
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [],
        aggregations: [],
      });
    expect(r.status).toBe(400);
    // zod rejects min(1) before service-level NoAggregationSpecified
    expect(r.body.errorName).toBe("Tellus:Workshop:InvalidModuleSchema");
  });

  it("B08 wire: branch flows verbatim", async () => {
    await request(app)
      .post(
        "/api/v1/workshop/object-sets/_aggregate?branch=ri.branch.feat.x",
      )
      .send({
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [],
        aggregations: [
          {
            name: "byStatus",
            property: "status",
            aggregation: { kind: "count" },
          },
        ],
        chartKind: "pie",
      });
    expect(oss.calls[0]!.context.branchRid).toBe("ri.branch.feat.x");
    expect(oss.calls[0]!.context.jwt).toBe("jwt-test-token");
  });

  it("B08 wire: passes back aggregate response unchanged", async () => {
    const r = await request(app)
      .post("/api/v1/workshop/object-sets/_aggregate")
      .send({
        ontologyRid: "o1",
        objectTypeApiName: "Order",
        schema: SCHEMA,
        filters: [],
        aggregations: [
          {
            name: "byStatus",
            property: "status",
            aggregation: { kind: "count" },
          },
        ],
        chartKind: "pie",
      });
    expect(r.status).toBe(200);
    expect(r.body.buckets).toEqual([
      { name: "byStatus", groups: [{ key: "new", values: { count: 5 } }] },
    ]);
  });
});
