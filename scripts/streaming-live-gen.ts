// Generates the ACTUAL compileStreamingJob() SQL for the §2 Kafka→Iceberg live
// proof, with in-container addressing + S3 creds injected into the Iceberg sink
// (storage creds are deployment config the compiler intentionally omits).
import { compileStreamingJob } from "../src/services/pipelines/flinkSqlCompiler";

const plan = compileStreamingJob({
  jobName: "tellus_pb_b5_kafka_live",
  inputs: [
    {
      id: "n1",
      label: "orders",
      kind: "stream",
      source: "orders.v1",
      bootstrapServers: "kafka:29092", // resolveStreamingSources injects this from env
      format: "json",
      columns: [
        { name: "order_id", type: "integer" },
        { name: "customer_id", type: "integer" },
        { name: "status", type: "string" },
        { name: "amount", type: "numeric" },
      ],
    },
  ],
  // A real transform: keep only PAID orders (Filter pushed into the Flink job).
  transforms: [
    {
      function: "Filter",
      mode: "keep",
      match: "all",
      conditions: [{ column: "status", operator: "eq", value: "PAID" }],
    },
  ],
  outputSchema: [
    { name: "order_id", type: "integer" },
    { name: "customer_id", type: "integer" },
    { name: "status", type: "string" },
    { name: "amount", type: "numeric" },
  ],
  outputIceberg: {
    warehouse: "streaming-test",
    namespace: "kafka_live",
    table: "paid_orders",
    catalogUri: "http://lakekeeper:8181/catalog", // Iceberg REST endpoint (in-container)
  },
  parallelism: 1,
});

// Inject S3 storage creds into the iceberg sink DDL (deployment storage config).
const s3props = [
  // Force Iceberg's AWS S3FileIO (not Hadoop's s3:// filesystem) for MinIO.
  "'io-impl' = 'org.apache.iceberg.aws.s3.S3FileIO'",
  "'s3.endpoint' = 'http://minio:9000'",
  "'s3.path-style-access' = 'true'",
  "'s3.access-key-id' = 'tellus-s3-49f524d9'",
  "'s3.secret-access-key' = 'kYJtYYunruhlPtOow9PD5FyRa36BXPM'",
].join(",\n  ");

const statements = plan.statements.map((s) =>
  s.includes("'connector' = 'iceberg'")
    ? s.replace(/\)\s*$/, `,\n  ${s3props}\n)`)
    : s,
);

// SQL client runs statements separated by ';'. Streaming INSERT must be async.
console.log("SET 'execution.runtime-mode' = 'streaming';");
console.log("SET 'table.dml-sync' = 'false';");
for (const s of statements) console.log(s + ";");
