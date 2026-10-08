/**
 * MANUAL TEST — engineBuild.buildWithEngine against the LIVE pipeline graph.
 *
 * Reads the real pipeline_nodes rows (configs, wiring, dataset paths) straight
 * from Postgres, hands them to the engine builder unmodified, and checks the
 * result. Nothing here is hand-transcribed: if the stored config shape and the
 * engine's step shape ever diverge again, this fails.
 *
 * Run: node --import tsx scripts/manual-enginebuild-live.ts [outputNodeLabel]
 */
import "dotenv/config";
import foundryDb from "../src/config/foundryDb";
import { buildWithEngine, EngineIneligibleError, engineReadPath } from "../src/services/pipelines/engineBuild";
import type { PipelineNodeInfo } from "../src/services/pipelines/engineBuild";

const PROJECT = "36271681-65d7-4c55-a6d0-20137f8212dc";
const PIPELINE = "0e798720-a162-46d1-830d-610a18747a2d";
const STAGING = "s3://tellus-uploads/_engine_staging/manual-test/";
const wantLabel = process.argv[2];

async function loadGraph(): Promise<Map<string, PipelineNodeInfo>> {
  const rows = (await foundryDb("pipeline_nodes as pn")
    .join("pipelines as p", "pn.pipeline_id", "p.id")
    .leftJoin("foundry_datasets as fd", "pn.dataset_id", "fd.id")
    .where({ "pn.pipeline_id": PIPELINE, "p.project_id": PROJECT })
    .select(
      "pn.id", "pn.node_type", "pn.config", "pn.dataset_id",
      "fd.file_path as dataset_path",
    )) as Array<Record<string, unknown>>;

  const map = new Map<string, PipelineNodeInfo>();
  for (const r of rows) {
    const cfg = typeof r.config === "string"
      ? JSON.parse(r.config as string)
      : ((r.config ?? {}) as Record<string, unknown>);
    // The dataset node's file lives on the OUTPUT that owns it in some
    // pipelines; here node.dataset_id points straight at the source dataset.
    const filePath = (r.dataset_path as string | null) ?? null;
    map.set(r.id as string, {
      nodeId: r.id as string,
      nodeType: r.node_type as string,
      config: cfg,
      sourceNodeId: (cfg.sourceNodeId as string | null) ?? null,
      datasetPath: filePath ? engineReadPath(filePath) : null,
    });
  }
  return map;
}

async function main(): Promise<void> {
  const nodes = await loadGraph();
  console.log(`loaded ${nodes.size} nodes from the live pipeline\n`);

  const outputs = (await foundryDb("pipeline_nodes")
    .where({ pipeline_id: PIPELINE, node_type: "output" })
    .select("id", "label")) as Array<{ id: string; label: string }>;

  const label = wantLabel ?? "transactions_clean";
  const out = outputs.find((o) => o.label === label);
  if (!out) {
    console.error(`no output labelled '${label}'. available: ${outputs.map((o) => o.label).join(", ")}`);
    process.exit(1);
  }

  const t0 = Date.now();
  try {
    const res = await buildWithEngine(out.id, {
      nodes,
      sinkFor: (nodeId) => `${STAGING}${nodeId}.parquet`,
      stagingPrefix: STAGING,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`BUILD OK  ${label}`);
    console.log(`  sink        : ${res.sinkPath}`);
    console.log(`  rows        : ${res.rowCount.toLocaleString()}`);
    console.log(`  columns (${res.columns.length}): ${res.columns.map((c) => c.name).join(", ")}`);
    console.log(`  stages      : ${res.stages.length}`);
    for (const s of res.stages) console.log(`      ${s.nodeId.slice(0, 8)}  ${s.rowCount.toLocaleString().padStart(12)} rows`);
    console.log(`  wall clock  : ${secs}s`);
    console.log(`  peak RSS    : ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
  } catch (e) {
    if (e instanceof EngineIneligibleError) {
      console.log(`INELIGIBLE (falls back to the legacy path): ${e.message}`);
      process.exit(2);
    }
    console.error("BUILD FAILED:", e);
    process.exit(1);
  } finally {
    await foundryDb.destroy();
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
