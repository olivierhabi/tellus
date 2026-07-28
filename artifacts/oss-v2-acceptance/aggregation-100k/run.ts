import { Client } from "@opensearch-project/opensearch";
import pg from "pg";
import {
  buildV2Aggs,
  parseV2AggResponse,
  assertAccuracy,
} from "../../../src/services/oss/aggregationV2";

const os = new Client({ node: process.env.OPENSEARCH_URL! });
const sql = new pg.Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});
const index = "oss-v2-aggregation-100k";
const percentile = (xs: number[], p: number) =>
  xs.slice().sort((a, b) => a - b)[Math.ceil((p / 100) * xs.length) - 1]!;

async function main() {
await sql.connect();
await sql.query("DROP TABLE IF EXISTS oss_v2_aggregation_100k");
await sql.query(`
  CREATE TABLE oss_v2_aggregation_100k (
    primary_key text PRIMARY KEY,
    group_value text,
    object_type text NOT NULL
  )
`);
await sql.query(`
  INSERT INTO oss_v2_aggregation_100k
  SELECT 'pk-' || n, 'group-' || lpad(n::text, 6, '0'),
         CASE WHEN n % 2 = 0 THEN 'TypeA' ELSE 'TypeB' END
    FROM generate_series(1, 100000) n
`);
await sql.query(`
  INSERT INTO oss_v2_aggregation_100k
  VALUES ('pk-null', NULL, 'TypeA')
`);
const authoritative = (
  await sql.query(`
    SELECT count(*)::int AS source_rows,
           count(DISTINCT group_value)::int AS distinct_non_null_groups,
           count(*) FILTER (WHERE group_value IS NULL)::int AS null_rows
      FROM oss_v2_aggregation_100k
  `)
).rows[0];

await os.indices.delete({ index, ignore_unavailable: true });
await os.indices.create({
  index,
  body: {
    mappings: {
      properties: {
        __pk: { type: "keyword" },
        __objectType: { type: "keyword" },
        group_value: { type: "keyword" },
      },
    },
  },
});
for (let start = 1; start <= 100000; start += 5000) {
  const body: unknown[] = [];
  for (let n = start; n < start + 5000 && n <= 100000; n++) {
    body.push({ index: { _index: index, _id: `pk-${n}` } });
    body.push({
      __pk: `pk-${n}`,
      __objectType: n % 2 === 0 ? "TypeA" : "TypeB",
      group_value: `group-${String(n).padStart(6, "0")}`,
    });
  }
  const result = await os.bulk({ body, refresh: false });
  if (result.body.errors) throw new Error(`bulk failed at ${start}`);
}
await os.index({
  index,
  id: "pk-null",
  body: { __pk: "pk-null", __objectType: "TypeA" },
  refresh: true,
});

const groupBy = [{
  type: "exact" as const,
  field: "group_value",
  includeNullValues: true,
  defaultValue: "__NULL__",
}];
const { aggs, metricNames } = buildV2Aggs(
  [{ type: "count" }],
  groupBy,
  (field) => field,
);
const latencies: number[] = [];
let termsResponse: any;
for (let i = 0; i < 20; i++) {
  const started = performance.now();
  termsResponse = await os.search({
    index,
    body: { size: 0, aggs },
  });
  latencies.push(performance.now() - started);
}
const parsed = parseV2AggResponse(
  termsResponse.body.aggregations,
  groupBy,
  metricNames,
);
let requireAccurate: Record<string, unknown>;
try {
  requireAccurate = { result: assertAccuracy(parsed, "REQUIRE_ACCURATE") };
} catch (error) {
  requireAccurate = {
    errorName: (error as { errorName?: string }).errorName,
    message: (error as Error).message,
  };
}

let after: Record<string, unknown> | undefined;
let compositePages = 0;
let compositeGroups = 0;
let duplicateGroups = 0;
const seen = new Set<string>();
do {
  const response: any = await os.search({
    index,
    body: {
      size: 0,
      aggs: {
        groups: {
          composite: {
            size: 1000,
            ...(after ? { after } : {}),
            sources: [
              {
                group_value: {
                  terms: { field: "group_value", missing_bucket: true },
                },
              },
            ],
          },
        },
      },
    },
  });
  const bucket = response.body.aggregations.groups;
  compositePages++;
  for (const item of bucket.buckets) {
    const key = JSON.stringify(item.key);
    if (seen.has(key)) duplicateGroups++;
    seen.add(key);
    compositeGroups++;
  }
  after = bucket.after_key;
} while (after);

const report = {
  releaseCommit: process.env.RELEASE_COMMIT,
  source: authoritative,
  implementationRequest: aggs,
  implementationResult: {
    returnedGroups: parsed.items.length,
    excludedItems: parsed.excludedItems,
    allowApproximate: assertAccuracy(parsed, "ALLOW_APPROXIMATE"),
    requireAccurate,
    compositePaginationExposedByTellus: false,
  },
  backendControl: {
    compositePages,
    compositeGroups,
    duplicateGroups,
    missingGroups:
      authoritative.distinct_non_null_groups +
      (authoritative.null_rows > 0 ? 1 : 0) -
      compositeGroups,
  },
  latencyMs: {
    samples: latencies.length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  },
};
console.log(JSON.stringify(report, null, 2));
await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
