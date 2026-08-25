/**
 * Repeatable real PostgreSQL/OpenSearch acceptance for exact composite
 * ObjectSet aggregation.
 *
 * Required env: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD,
 * OPENSEARCH_URL. Prints one JSON report and exits non-zero on any mismatch.
 */
import { Client as OpenSearchClient } from "@opensearch-project/opensearch";
import pg from "pg";
import { compileObjectSet } from "../../../src/services/oss/objectSetCompiler";
import {
  aggregateObjectSet,
  type ExecutorDeps,
} from "../../../src/services/oss/objectSetExecutor";

const INDEX = "oss-v2-aggregation-100k";
const NULL_GROUP = "__NULL__";
const os = new OpenSearchClient({ node: process.env.OPENSEARCH_URL! });
const sql = new pg.Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

function percentile(values: number[], value: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil((value / 100) * ordered.length) - 1)]!;
}

async function main(): Promise<void> {
  await sql.connect();
  await sql.query("DROP TABLE IF EXISTS oss_v2_aggregation_100k");
  await sql.query(`
    CREATE TABLE oss_v2_aggregation_100k (
      primary_key text PRIMARY KEY,
      group_value text,
      metric_value double precision NOT NULL,
      metric_text text NOT NULL,
      object_type text NOT NULL
    )
  `);
  await sql.query(`
    INSERT INTO oss_v2_aggregation_100k
    SELECT 'pk-' || n,
           'group-' || lpad(n::text, 6, '0'),
           n::double precision,
           'distinct-' || (n % 17),
           CASE WHEN n % 2 = 0 THEN 'TypeA' ELSE 'TypeB' END
      FROM generate_series(1, 100000) n
  `);
  await sql.query(`
    INSERT INTO oss_v2_aggregation_100k
    VALUES ('pk-null', NULL, 0, 'distinct-null', 'TypeA')
  `);
  const authoritativeRows = (
    await sql.query<{
      group_value: string | null;
      count_value: string;
      sum_value: number;
      avg_value: number;
      min_value: number;
      max_value: number;
      exact_distinct: string;
    }>(`
      SELECT group_value,
             count(*)::text AS count_value,
             sum(metric_value) AS sum_value,
             avg(metric_value) AS avg_value,
             min(metric_value) AS min_value,
             max(metric_value) AS max_value,
             count(DISTINCT metric_text)::text AS exact_distinct
        FROM oss_v2_aggregation_100k
       GROUP BY group_value
       ORDER BY group_value NULLS FIRST
    `)
  ).rows;

  await os.indices.delete({ index: INDEX, ignore_unavailable: true });
  await os.indices.create({
    index: INDEX,
    body: {
      settings: { number_of_shards: 2, number_of_replicas: 0 },
      mappings: {
        properties: {
          __pk: { type: "keyword" },
          __objectType: { type: "keyword" },
          group_value: { type: "keyword" },
          metric_value: { type: "double" },
          metric_text: { type: "keyword" },
        },
      },
    },
  });
  for (let start = 1; start <= 100_000; start += 5_000) {
    const body: unknown[] = [];
    for (let value = start; value < start + 5_000 && value <= 100_000; value++) {
      body.push({ index: { _index: INDEX, _id: `pk-${value}` } });
      body.push({
        __pk: `pk-${value}`,
        __objectType: value % 2 === 0 ? "TypeA" : "TypeB",
        group_value: `group-${String(value).padStart(6, "0")}`,
        metric_value: value,
        metric_text: `distinct-${value % 17}`,
      });
    }
    const bulk = await os.bulk({ body, refresh: false });
    if (bulk.body.errors) throw new Error(`OpenSearch bulk failed at ${start}`);
  }
  await os.index({
    index: INDEX,
    id: "pk-null",
    body: {
      __pk: "pk-null",
      __objectType: "TypeA",
      metric_value: 0,
      metric_text: "distinct-null",
    },
    refresh: true,
  });
  await os.indices.refresh({ index: INDEX });
  await os.cluster.health({
    index: INDEX,
    wait_for_status: "green",
    wait_for_no_relocating_shards: true,
    wait_for_no_initializing_shards: true,
    timeout: "30s",
  });
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  let requests = 0;
  let retriedPages = 0;
  let injectTransientFailure = true;
  const pageLatencies: number[] = [];
  const deps: ExecutorDeps = {
    keywordOf: async (_objectType, field) => field,
    translateWhere: async () => ({ match_all: {} }),
    search: async (_objectType, body) => {
      requests += 1;
      if (injectTransientFailure) {
        injectTransientFailure = false;
        retriedPages += 1;
        throw new Error("injected transient OpenSearch interruption");
      }
      const started = performance.now();
      let response;
      try {
        response = await os.search({ index: INDEX, body });
      } catch (error) {
        const backend = error as {
          meta?: { body?: { error?: { type?: string; reason?: string } } };
        };
        console.error(
          JSON.stringify({
            event: "aggregation_page_failed",
            type: backend.meta?.body?.error?.type,
            reason: backend.meta?.body?.error?.reason,
            error: backend.meta?.body?.error,
          }),
        );
        throw error;
      }
      pageLatencies.push(performance.now() - started);
      const payload = response.body as {
        hits: { total?: number | { value: number } };
        aggregations?: Record<string, unknown>;
      };
      return {
        hits: [],
        total:
          typeof payload.hits.total === "number"
            ? payload.hits.total
            : payload.hits.total?.value ?? 0,
        aggregations: payload.aggregations,
      };
    },
  };
  const objectSet = { type: "base", objectType: "Fixture" } as const;
  const compiled = await compileObjectSet(objectSet, {
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });
  const started = performance.now();
  const result = await aggregateObjectSet(
    compiled,
    {
      objectSet,
      aggregation: [
        { type: "count", name: "count" },
        { type: "sum", field: "metric_value", name: "sum" },
        { type: "avg", field: "metric_value", name: "avg" },
        { type: "min", field: "metric_value", name: "min" },
        { type: "max", field: "metric_value", name: "max" },
      ],
      groupBy: [
        {
          type: "exact",
          field: "group_value",
          includeNullValues: true,
          defaultValue: NULL_GROUP,
        },
      ],
      accuracy: "REQUIRE_ACCURATE",
    },
    {
      ontologyRid: "acceptance",
      branchRid: null,
      tenant: "acceptance",
      transactionId: null,
      scenarioRid: null,
      snapshot: false,
    },
    deps,
  );
  const runtimeMs = performance.now() - started;
  const actualByGroup = new Map(
    result.data.map((item) => [
      String(item.group.group_value),
      Object.fromEntries(item.metrics.map((metric) => [metric.name, metric.value])),
    ]),
  );
  let missingGroups = 0;
  let metricMismatches = 0;
  for (const expected of authoritativeRows) {
    const key = expected.group_value ?? NULL_GROUP;
    const actual = actualByGroup.get(key);
    if (!actual) {
      missingGroups += 1;
      continue;
    }
    const expectedValues: Record<string, number> = {
      count: Number(expected.count_value),
      sum: expected.sum_value,
      avg: expected.avg_value,
      min: expected.min_value,
      max: expected.max_value,
    };
    for (const [metric, expectedValue] of Object.entries(expectedValues)) {
      if (Math.abs(Number(actual[metric]) - expectedValue) > 0.000_001) {
        metricMismatches += 1;
      }
    }
  }
  const duplicateGroups = result.data.length - actualByGroup.size;
  let additionalMetricMismatches = 0;
  const additionalMetrics = [
    { type: "exactDistinct" as const, field: "metric_text", name: "value" },
    {
      type: "approximateDistinct" as const,
      field: "metric_text",
      name: "value",
    },
    {
      type: "approximatePercentile" as const,
      field: "metric_value",
      approximatePercentile: 50,
      name: "value",
    },
  ];
  for (const metric of additionalMetrics) {
    const additional = await aggregateObjectSet(
      compiled,
      {
        objectSet,
        aggregation: [metric],
        groupBy: [
          {
            type: "exact",
            field: "group_value",
            includeNullValues: true,
            defaultValue: NULL_GROUP,
          },
        ],
        accuracy: "REQUIRE_ACCURATE",
      },
      {
        ontologyRid: "acceptance",
        branchRid: null,
        tenant: "acceptance",
        transactionId: null,
        scenarioRid: null,
        snapshot: false,
      },
      deps,
    );
    if (additional.data.length !== authoritativeRows.length) {
      additionalMetricMismatches += Math.abs(
        additional.data.length - authoritativeRows.length,
      );
    }
    for (const item of additional.data) {
      const group = String(item.group.group_value);
      const actual = Number(item.metrics[0]?.value);
      const expected =
        metric.type === "approximatePercentile"
          ? group === NULL_GROUP
            ? 0
            : Number(group.slice("group-".length))
          : 1;
      if (Math.abs(actual - expected) > 0.000_001) {
        additionalMetricMismatches += 1;
      }
    }
  }
  const report = {
    sourceRows: 100_001,
    expectedGroups: authoritativeRows.length,
    actualGroups: result.data.length,
    missingGroups,
    duplicateGroups,
    metricMismatches: metricMismatches + additionalMetricMismatches,
    additionalMetricMismatches,
    accuracy: result.accuracy,
    compositePages: pageLatencies.length,
    requests,
    retriedPages,
    runtimeMs,
    latencyMs: {
      p50: percentile(pageLatencies, 50),
      p95: percentile(pageLatencies, 95),
      p99: percentile(pageLatencies, 99),
    },
    processMemory: process.memoryUsage(),
  };
  console.log(JSON.stringify(report, null, 2));
  await sql.end();
  if (
    report.expectedGroups !== 100_001 ||
    report.actualGroups !== 100_001 ||
    missingGroups !== 0 ||
    duplicateGroups !== 0 ||
    metricMismatches + additionalMetricMismatches !== 0 ||
    result.accuracy !== "ACCURATE"
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
