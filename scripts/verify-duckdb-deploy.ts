/**
 * MANUAL VERIFICATION — the real deploy code path, no HTTP auth in the way.
 *
 * Calls DeploymentService.tryDuckDbEngineBuild exactly as the deploy loop
 * does, with real args from the database, against real MinIO. Everything that
 * makes a dataset exist happens here: eligibility, the staged DuckDB build,
 * the SQL expectation gate, the streamed upload, and the foundry_datasets /
 * dataset_columns / pipeline_nodes commit.
 *
 * Run: node --import tsx scripts/verify-duckdb-deploy.ts <outputLabel>
 */
import "dotenv/config";
import foundryDb from "../src/config/foundryDb";
import { DeploymentService } from "../src/services/deploymentService";
import { TransformService } from "../src/services/transformService";

const t0global = Date.now();
const mark = (m: string) => console.log(`[+${((Date.now() - t0global) / 1000).toFixed(1)}s] ${m}`);

const PROJECT = "36271681-65d7-4c55-a6d0-20137f8212dc";
const PIPELINE = "0e798720-a162-46d1-830d-610a18747a2d";

async function main(): Promise<void> {
  const label = process.argv[2] ?? "transactions_clean";
  const knex = foundryDb;
  mark("knex ready");
  const svc = new DeploymentService(knex as never, new TransformService() as never);
  const pipeline = await knex("pipelines").where({ id: PIPELINE }).first();
  const outputNode = await knex("pipeline_nodes")
    .where({ pipeline_id: PIPELINE, node_type: "output", label })
    .first();
  if (!outputNode) {
    console.error(`no output labelled '${label}'`);
    await knex.destroy();
    process.exit(1);
  }
  const cfg = typeof outputNode.config === "string"
    ? JSON.parse(outputNode.config)
    : (outputNode.config ?? {});
  const deploymentId = crypto.randomUUID();

  mark(`output row loaded: ${outputNode.label}`);
  console.log(`output        : ${outputNode.label}`);
  console.log(`compute_type  : ${pipeline.compute_type}`);
  console.log(`output_format : ${pipeline.output_format}`);

  mark("calling tryDuckDbEngineBuild…");
  const t0 = Date.now();
  const res = await (svc as never as {
    tryDuckDbEngineBuild: (a: unknown) => Promise<{
      datasetId: string; filePath: string; rowCount: number; columnCount: number;
    } | null>;
  }).tryDuckDbEngineBuild({
    projectId: PROJECT,
    pipelineId: PIPELINE,
    deploymentId,
    outputNode,
    cfg,
    pipeline,
    triggeredBy: "4f0becdd-db36-4b81-9aee-45491cd000cd",
  });

  mark("returned");
  if (!res) {
    console.log("\nRESULT: null — path declined, deploy would fall back to the in-process path");
    await knex.destroy();
    process.exit(2);
  }

  console.log("\nBUILD OK");
  console.log(`  datasetId   : ${res.datasetId}`);
  console.log(`  filePath    : ${res.filePath}`);
  console.log(`  rowCount    : ${res.rowCount.toLocaleString()}`);
  console.log(`  columnCount : ${res.columnCount}`);
  console.log(`  wall clock  : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  peak RSS    : ${Math.round(process.memoryUsage().rss / 1048576)} MB`);

  // Prove the dataset row and its columns really landed.
  const ds = await knex("foundry_datasets").where({ id: res.datasetId }).first();
  const cols = await knex("dataset_columns").where({ dataset_id: res.datasetId })
    .select("column_name", "column_type").orderBy("ordinal_position");
  console.log(`\n  foundry_datasets: format=${ds.format} rows=${ds.row_count} bytes=${ds.file_size_bytes}`);
  console.log(`  columns (${cols.length}): ${cols.map((c: { column_name: string }) => c.column_name).join(", ")}`);

  await knex.destroy();
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });