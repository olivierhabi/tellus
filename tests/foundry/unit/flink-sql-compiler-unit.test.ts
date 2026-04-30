// ---------------------------------------------------------------------------
// PB-B5 — Flink SQL compiler (unit).
//
// No Flink cluster required. Pins the emitted SQL shape + rejection
// paths (STREAMING_TRANSFORM_NOT_SUPPORTED) for the v1 subset.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  compileStreamingJob,
  type DatasetNode,
} from "../../../src/services/pipelines/flinkSqlCompiler";
import type { TransformStep } from "../../../src/services/pipelines/duckdbTransformEngine";

const ORDERS_TOPIC: DatasetNode = {
  id: "n1",
  label: "orders",
  kind: "stream",
  source: "orders.v1",
  columns: [
    { name: "order_id", type: "integer" },
    { name: "customer_id", type: "integer" },
    { name: "status", type: "string" },
    { name: "amount", type: "numeric" },
  ],
};

const CUSTOMERS_BATCH: DatasetNode = {
  id: "n2",
  label: "customers",
  kind: "batch",
  source: "iceberg://_pipeline.ops.customers.output",
  columns: [
    { name: "id", type: "integer" },
    { name: "name", type: "string" },
  ],
};

const ICEBERG = {
  warehouse: "tellus-pipeline",
  namespace: "_pipeline.ops.orders_stream",
  table: "output",
  catalogUri: "http://lakekeeper:8181",
};

describe("compileStreamingJob", () => {
  it("emits a Kafka CREATE TABLE for stream sources", () => {
    const plan = compileStreamingJob({
      jobName: "orders",
      inputs: [ORDERS_TOPIC],
      transforms: [],
      outputSchema: ORDERS_TOPIC.columns,
      outputIceberg: ICEBERG,
    });
    const ddl = plan.statements.find((s) => s.includes("'connector' = 'kafka'"));
    expect(ddl).toBeDefined();
    expect(ddl).toMatch(/'topic' = 'orders\.v1'/);
    expect(ddl).toMatch(/'scan\.startup\.mode' = 'earliest-offset'/);
  });

  it("emits an Iceberg CREATE TABLE sink with REST catalog", () => {
    const plan = compileStreamingJob({
      jobName: "orders",
      inputs: [ORDERS_TOPIC],
      transforms: [],
      outputSchema: ORDERS_TOPIC.columns,
      outputIceberg: ICEBERG,
    });
    const sink = plan.statements.find((s) =>
      s.includes("'connector' = 'iceberg'") && s.includes("sink_output"),
    );
    expect(sink).toBeDefined();
    expect(sink).toMatch(/'catalog-type' = 'rest'/);
    expect(sink).toMatch(/'warehouse' = 'tellus-pipeline'/);
    expect(sink).toMatch(/'format-version' = '2'/);
  });

  it("emits INSERT INTO sink SELECT projection", () => {
    const plan = compileStreamingJob({
      jobName: "orders",
      inputs: [ORDERS_TOPIC],
      transforms: [],
      outputSchema: [
        { name: "order_id", type: "integer" },
        { name: "status", type: "string" },
      ],
      outputIceberg: ICEBERG,
    });
    const dml = plan.statements.find((s) => s.startsWith("INSERT INTO"));
    expect(dml).toBeDefined();
    expect(dml).toMatch(/INSERT INTO `sink_output`/);
    expect(dml).toMatch(/SELECT `order_id`, `status` FROM src/);
  });

  it("compiles a Filter chain to WHERE", () => {
    const plan = compileStreamingJob({
      jobName: "orders",
      inputs: [ORDERS_TOPIC],
      transforms: [
        {
          function: "Filter",
          mode: "keep",
          match: "all",
          conditions: [{ column: "status", operator: "eq", value: "open" }],
        } as TransformStep,
      ],
      outputSchema: ORDERS_TOPIC.columns,
      outputIceberg: ICEBERG,
    });
    const dml = plan.statements.find((s) => s.startsWith("INSERT INTO"))!;
    expect(dml).toMatch(/WHERE \(CAST\(`status` AS STRING\) = 'open'\)/);
  });

  it("compiles a Cast with replace-in-place using EXCEPT + TRY_CAST", () => {
    const plan = compileStreamingJob({
      jobName: "orders",
      inputs: [ORDERS_TOPIC],
      transforms: [
        { function: "Cast", expression: "amount", targetType: "numeric" } as TransformStep,
      ],
      outputSchema: ORDERS_TOPIC.columns,
      outputIceberg: ICEBERG,
    });
    const dml = plan.statements.find((s) => s.startsWith("INSERT INTO"))!;
    expect(dml).toMatch(
      /SELECT \* EXCEPT \(`amount`\), TRY_CAST\(`amount` AS DOUBLE\) AS `amount`/,
    );
  });

  it("compiles an equi-join when the right side is a registered source", () => {
    const plan = compileStreamingJob({
      jobName: "orders_x_customers",
      inputs: [ORDERS_TOPIC, CUSTOMERS_BATCH],
      transforms: [
        {
          function: "Join",
          rightPath: "customers",
          joinType: "inner",
          on: [{ left: "customer_id", right: "id" }],
        } as TransformStep,
      ],
      outputSchema: ORDERS_TOPIC.columns,
      outputIceberg: ICEBERG,
    });
    const dml = plan.statements.find((s) => s.startsWith("INSERT INTO"))!;
    expect(dml).toMatch(/INNER JOIN `src_1_customers` AS r ON l\.`customer_id` = r\.`id`/);
  });

  it("rejects cross joins with STREAMING_TRANSFORM_NOT_SUPPORTED", () => {
    try {
      compileStreamingJob({
        jobName: "x",
        inputs: [ORDERS_TOPIC, CUSTOMERS_BATCH],
        transforms: [
          {
            function: "Join",
            rightPath: "customers",
            joinType: "cross",
            allowCrossJoin: true,
          } as TransformStep,
        ],
        outputSchema: ORDERS_TOPIC.columns,
        outputIceberg: ICEBERG,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("STREAMING_TRANSFORM_NOT_SUPPORTED");
    }
  });

  it("rejects Normalize with STREAMING_TRANSFORM_NOT_SUPPORTED", () => {
    try {
      compileStreamingJob({
        jobName: "x",
        inputs: [ORDERS_TOPIC],
        transforms: [{ function: "Normalize" } as TransformStep],
        outputSchema: ORDERS_TOPIC.columns,
        outputIceberg: ICEBERG,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("STREAMING_TRANSFORM_NOT_SUPPORTED");
    }
  });

  it("rejects joins with unregistered right-side sources", () => {
    try {
      compileStreamingJob({
        jobName: "x",
        inputs: [ORDERS_TOPIC],
        transforms: [
          {
            function: "Join",
            rightPath: "ghost_topic",
            joinType: "inner",
            on: [{ left: "customer_id", right: "id" }],
          } as TransformStep,
        ],
        outputSchema: ORDERS_TOPIC.columns,
        outputIceberg: ICEBERG,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("STREAMING_TRANSFORM_NOT_SUPPORTED");
    }
  });

  it("refuses to compile a pipeline with no sources", () => {
    try {
      compileStreamingJob({
        jobName: "x",
        inputs: [],
        transforms: [],
        outputSchema: [],
        outputIceberg: ICEBERG,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("STREAMING_NO_SOURCES");
    }
  });
});
