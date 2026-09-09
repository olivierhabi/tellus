// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §1 — Trino batch compute engine unit tests.
//
// Pins the compiled SQL (no Trino cluster needed, same philosophy as the
// Flink compiler tests), exercises the engine registry/test seam, and the
// Iceberg location parser the executeBuild strangler-fig branch relies on.
// ---------------------------------------------------------------------------
import { describe, it, expect, afterEach } from "vitest";
import {
  compileBatchJob,
  compileFusedJob,
  foldLinearArm,
  normalizeName,
  mapTrinoType,
  type LinearArm,
} from "../../../src/services/pipelines/trinoSqlCompiler";
import {
  NoopTrinoEngine,
  getTrinoEngine,
  setTrinoEngineForTests,
  trinoCoordinatorConfigured,
} from "../../../src/services/pipelines/trinoAdapter";
import {
  selectedBatchEngine,
  batchEngineMinRows,
  parseIcebergLocation,
} from "../../../src/services/pipelines/computeEngine";

const OUTPUT = {
  warehouse: "tellus-pipeline",
  namespace: "_pipeline.proj_x.pipe_y",
  table: "output",
  catalogUri: "http://localhost:8181",
};

const SOURCE = {
  id: "node-1",
  label: "orders",
  namespace: "_pipeline.proj_x.src",
  table: "orders",
  columns: [
    { name: "Order ID", type: "string" },
    { name: "amount", type: "numeric" },
    { name: "created", type: "timestamp" },
  ],
};

describe("trinoSqlCompiler", () => {
  it("compiles ConcatenateStrings into the Trino projection", () => {
    const plan = compileBatchJob({
      catalog: "iceberg",
      inputs: [SOURCE],
      transforms: [{
        function: "ConcatenateStrings",
        expressions: [
          { kind: "column", value: "Order ID" },
          { kind: "literal", value: "tail", literalType: "string" },
        ],
        separator: "--",
        nullOutputIfAnyInputIsNull: false,
        outputColumn: "joined",
      }],
      output: OUTPUT,
    });
    expect(plan.statements.at(-1)).toContain("concat_ws('--', CAST(\"Order ID\" AS VARCHAR), CAST('tail' AS VARCHAR)) AS \"joined\"");
    expect(plan.outputSchema).toContainEqual({ name: "joined", type: "string" });
  });
  it("compiles a plain projection into schema DDL + INSERT SELECT", () => {
    const plan = compileBatchJob({
      catalog: "iceberg",
      inputs: [SOURCE],
      transforms: [],
      output: OUTPUT,
    });
    expect(plan.statements).toHaveLength(3);
    expect(plan.statements[0]).toBe(
      'CREATE SCHEMA IF NOT EXISTS "iceberg"."_pipeline.proj_x.pipe_y"',
    );
    expect(plan.statements[1]).toContain('"Order ID" VARCHAR');
    expect(plan.statements[1]).toContain('"amount" DOUBLE');
    expect(plan.statements[2]).toContain(
      'INSERT INTO "iceberg"."_pipeline.proj_x.pipe_y"."output" SELECT',
    );
    expect(plan.sink).toBe('"iceberg"."_pipeline.proj_x.pipe_y"."output"');
    expect(plan.outputSchema.map((c) => c.name)).toEqual([
      "Order ID",
      "amount",
      "created",
    ]);
  });

  it("pins reads to the input snapshot for reproducible builds", () => {
    const plan = compileBatchJob({
      catalog: "iceberg",
      inputs: [{ ...SOURCE, snapshotId: "4216" }],
      transforms: [],
      output: OUTPUT,
    });
    expect(plan.statements[2]).toContain("FOR VERSION AS OF 4216");
  });

  it("folds Cast / Filter / Drop / Rename into one SELECT", () => {
    const plan = compileBatchJob({
      catalog: "iceberg",
      inputs: [SOURCE],
      transforms: [
        { function: "Cast", expression: "amount", targetType: "integer" },
        {
          function: "Filter",
          mode: "keep",
          match: "all",
          conditions: [{ column: "Order ID", operator: "starts_with", value: "A" }],
        },
        { function: "Drop", columns: ["created"] },
        { function: "Rename", renames: [{ from: "Order ID", to: "order_id" }] },
      ],
      output: OUTPUT,
    });
    const insert = plan.statements[2];
    expect(insert).toContain('TRY_CAST("amount" AS BIGINT) AS "amount"');
    expect(insert).toContain("WHERE (CAST(\"Order ID\" AS VARCHAR) LIKE 'A%'");
    expect(insert).not.toContain('"created"');
    expect(insert).toContain('AS "order_id"');
    expect(plan.outputSchema.map((c) => c.name)).toEqual(["order_id", "amount"]);
  });

  it("compiles Normalize as a compile-time projection rename (no UDF)", () => {
    const plan = compileBatchJob({
      catalog: "iceberg",
      inputs: [SOURCE],
      transforms: [{ function: "Normalize", removeSpecialCharacters: true }],
      output: OUTPUT,
    });
    expect(plan.statements[2]).toContain('"Order ID" AS "order_id"');
    expect(plan.outputSchema.map((c) => c.name)).toEqual([
      "order_id",
      "amount",
      "created",
    ]);
  });

  it("escapes single quotes and LIKE wildcards in filter values", () => {
    const plan = compileBatchJob({
      catalog: "iceberg",
      inputs: [SOURCE],
      transforms: [
        {
          function: "Filter",
          conditions: [
            { column: "Order ID", operator: "contains", value: "o'%_x" },
          ],
        },
      ],
      output: OUTPUT,
    });
    expect(plan.statements[2]).toContain("LIKE '%o''\\%\\_x%' ESCAPE '\\'");
  });

  it("compiles an equi-join against a registered Iceberg input with right_ collision prefix", () => {
    const right = {
      id: "node-2",
      label: "customers",
      namespace: "_pipeline.proj_x.src",
      table: "customers",
      columns: [
        { name: "id", type: "string" },
        { name: "amount", type: "numeric" }, // collides with left
      ],
    };
    const plan = compileBatchJob({
      catalog: "iceberg",
      inputs: [SOURCE, right],
      transforms: [
        {
          function: "Join",
          rightPath: "node-2",
          joinType: "left",
          on: [{ left: "Order ID", right: "id" }],
        },
      ],
      output: OUTPUT,
    });
    const insert = plan.statements[2];
    expect(insert).toContain('LEFT JOIN "iceberg"."_pipeline.proj_x.src"."customers" AS t1');
    expect(insert).toContain('ON t0."Order ID" = t1."id"');
    expect(insert).toContain('t1."amount" AS "right_amount"');
  });

  it("rejects cross joins without the cardinality guard", () => {
    expect(() =>
      compileBatchJob({
        catalog: "iceberg",
        inputs: [SOURCE],
        transforms: [
          { function: "Join", rightPath: "node-1", joinType: "cross" },
        ],
        output: OUTPUT,
      }),
    ).toThrowError(/allowCrossJoin/);
  });

  it("rejects joins whose right side is not a registered Iceberg input", () => {
    expect(() =>
      compileBatchJob({
        catalog: "iceberg",
        inputs: [SOURCE],
        transforms: [
          {
            function: "Join",
            rightPath: "s3://bucket/raw.csv",
            joinType: "inner",
            on: [{ left: "Order ID", right: "id" }],
          },
        ],
        output: OUTPUT,
      }),
    ).toThrowError(/not a registered Iceberg input/);
  });

  it("rejects empty-source plans", () => {
    expect(() =>
      compileBatchJob({ catalog: "iceberg", inputs: [], transforms: [], output: OUTPUT }),
    ).toThrowError(/at least one source/);
  });

  it("normalizeName matches the in-process Normalize semantics", () => {
    expect(normalizeName("Order ID")).toBe("order_id");
    expect(normalizeName("a-b.c  d")).toBe("a_b_c_d");
    expect(normalizeName("Price ($)", true)).toBe("price");
  });

  it("maps platform types to Trino types", () => {
    expect(mapTrinoType("integer")).toBe("BIGINT");
    expect(mapTrinoType("numeric")).toBe("DOUBLE");
    expect(mapTrinoType("timestamp")).toBe("TIMESTAMP(6)");
    expect(mapTrinoType("string")).toBe("VARCHAR");
  });
});

describe("trinoAdapter registry", () => {
  afterEach(() => {
    setTrinoEngineForTests(null);
    delete process.env.TRINO_URL;
    delete process.env.TELLUS_BATCH_ENGINE;
    delete process.env.TELLUS_BATCH_ENGINE_MIN_ROWS;
  });

  it("defaults to the noop engine when TRINO_URL is unset", async () => {
    const engine = getTrinoEngine();
    expect(engine.name).toBe("trino-noop");
    await expect(engine.available()).resolves.toBe(true);
  });

  it("honours the test override seam", () => {
    const noop = new NoopTrinoEngine();
    setTrinoEngineForTests(noop);
    expect(getTrinoEngine()).toBe(noop);
  });

  it("noop engine records executed plans and returns stats, not rows", async () => {
    const noop = new NoopTrinoEngine();
    const plan = { statements: ["SELECT 1"], sources: [], sink: "s" };
    const res = await noop.executePlan(plan, OUTPUT);
    expect(noop.executed).toHaveLength(1);
    expect(res.engine).toBe("trino-noop");
    expect(res.queryIds).toEqual(["noop_0"]);
    expect(res).not.toHaveProperty("rows");
  });

  it("selectedBatchEngine defaults to auto; honors explicit overrides", () => {
    expect(selectedBatchEngine()).toBe("auto");
    process.env.TELLUS_BATCH_ENGINE = "trino";
    expect(selectedBatchEngine()).toBe("trino");
    process.env.TELLUS_BATCH_ENGINE = "in-process";
    expect(selectedBatchEngine()).toBe("in-process");
    process.env.TELLUS_BATCH_ENGINE = "node";
    expect(selectedBatchEngine()).toBe("in-process");
    process.env.TELLUS_BATCH_ENGINE = "garbage";
    expect(selectedBatchEngine()).toBe("auto");
  });

  it("trinoCoordinatorConfigured gates auto mode on a real coordinator", () => {
    expect(trinoCoordinatorConfigured()).toBe(false); // no TRINO_URL, no override
    process.env.TRINO_URL = "http://trino:8088";
    expect(trinoCoordinatorConfigured()).toBe(true);
    delete process.env.TRINO_URL;
    const noop = new NoopTrinoEngine();
    setTrinoEngineForTests(noop);
    expect(trinoCoordinatorConfigured()).toBe(true); // injected engine counts
    setTrinoEngineForTests(null);
    expect(trinoCoordinatorConfigured()).toBe(false);
  });

  it("batchEngineMinRows defaults to 500k and rejects garbage", () => {
    expect(batchEngineMinRows()).toBe(500_000);
    process.env.TELLUS_BATCH_ENGINE_MIN_ROWS = "1000";
    expect(batchEngineMinRows()).toBe(1000);
    process.env.TELLUS_BATCH_ENGINE_MIN_ROWS = "not-a-number";
    expect(batchEngineMinRows()).toBe(500_000);
  });
});

describe("parseIcebergLocation", () => {
  it("parses the Funnel colon convention", () => {
    expect(
      parseIcebergLocation("tellus-funnel:ns.sub.orders"),
    ).toEqual({
      warehouse: "tellus-funnel",
      namespace: "ns.sub",
      table: "orders",
      snapshotId: null,
    });
  });

  it("parses the pipeline-deploy slash convention with snapshot pin", () => {
    expect(
      parseIcebergLocation(
        "tellus-pipeline/_pipeline.proj.pipe/output#snapshot=991",
      ),
    ).toEqual({
      warehouse: "tellus-pipeline",
      namespace: "_pipeline.proj.pipe",
      table: "output",
      snapshotId: "991",
    });
  });

  it("returns null for CSV S3 keys", () => {
    expect(
      parseIcebergLocation("projects/p/uploads/raw.csv"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Node fusion — join/union NODES over two Iceberg arms (retires the
// in-process executeJoin / union arrays for large data).
// ---------------------------------------------------------------------------
const ORDERS: LinearArm = {
  source: {
    id: "n_orders",
    label: "orders",
    namespace: "ns",
    table: "orders",
    snapshotId: "42",
    columns: [
      { name: "order_id", type: "integer" },
      { name: "customer_id", type: "integer" },
      { name: "amount", type: "numeric" },
    ],
  },
  transforms: [],
};
const CUSTOMERS: LinearArm = {
  source: {
    id: "n_cust",
    label: "customers",
    namespace: "ns",
    table: "customers",
    columns: [
      { name: "customer_id", type: "integer" },
      { name: "name", type: "string" },
    ],
  },
  transforms: [],
};
const FUSED_OUT = {
  warehouse: "tellus-pipeline",
  namespace: "_pipeline.proj.pipe",
  table: "output",
  catalogUri: "http://localhost:8181",
};

describe("foldLinearArm", () => {
  it("folds a linear chain into one SELECT exposing post-transform names", () => {
    const folded = foldLinearArm("iceberg", {
      source: ORDERS.source,
      transforms: [
        { function: "Filter", mode: "keep", match: "all", conditions: [{ column: "amount", operator: "is_not_null" }] },
        { function: "Rename", renames: [{ from: "amount", to: "total" }] },
      ],
    });
    expect(folded.columns.map((c) => c.name)).toEqual(["order_id", "customer_id", "total"]);
    expect(folded.select).toContain('FROM "iceberg"."ns"."orders" FOR VERSION AS OF 42');
    expect(folded.select).toContain("WHERE");
    expect(folded.select).toContain('"amount" AS "total"');
  });
});

describe("compileFusedJob — join node", () => {
  const job = compileFusedJob({
    catalog: "iceberg",
    left: ORDERS,
    right: CUSTOMERS,
    fusion: { kind: "join", joinType: "inner", on: [{ left: "customer_id", right: "customer_id" }] },
    output: FUSED_OUT,
  });
  const insert = job.statements[2];

  it("composes both arms as subqueries joined in SQL (no Node arrays)", () => {
    expect(insert).toContain("FROM (SELECT");
    expect(insert).toContain(") AS t0 INNER JOIN (SELECT");
    expect(insert).toContain(') AS t1 ON t0."customer_id" = t1."customer_id"');
  });

  it("prefixes the right-side name collision with right_ (executeJoin parity)", () => {
    // customer_id exists on both → right side becomes right_customer_id
    expect(insert).toContain('t1."customer_id" AS "right_customer_id"');
    expect(job.outputSchema.map((c) => c.name)).toEqual([
      "order_id",
      "customer_id",
      "amount",
      "right_customer_id",
      "name",
    ]);
  });

  it("pins each arm to its Iceberg snapshot", () => {
    expect(insert).toContain("FOR VERSION AS OF 42"); // orders pinned
  });

  it("rejects a cross join without the cardinality guard", () => {
    expect(() =>
      compileFusedJob({
        catalog: "iceberg",
        left: ORDERS,
        right: CUSTOMERS,
        fusion: { kind: "join", joinType: "cross", on: [] },
        output: FUSED_OUT,
      }),
    ).toThrow(/allowCrossJoin/);
  });
});

describe("compileFusedJob — union node (by name)", () => {
  const job = compileFusedJob({
    catalog: "iceberg",
    left: ORDERS,
    right: CUSTOMERS,
    fusion: { kind: "union" },
    output: FUSED_OUT,
  });
  const insert = job.statements[2];

  it("unions by name with left ordering and null-fill", () => {
    // union schema = unique(left ++ right) preserving left order
    expect(job.outputSchema.map((c) => c.name)).toEqual([
      "order_id",
      "customer_id",
      "amount",
      "name",
    ]);
    expect(insert).toContain("UNION ALL");
    // right arm lacks order_id/amount → CAST(NULL ...) fill
    expect(insert).toContain('CAST(NULL AS BIGINT) AS "order_id"');
    expect(insert).toContain('CAST(NULL AS DOUBLE) AS "amount"');
    // left arm lacks name → null-filled too
    expect(insert).toContain('CAST(NULL AS VARCHAR) AS "name"');
  });
});
