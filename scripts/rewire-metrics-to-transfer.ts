/**
 * Re-point `48 mule_chain_metrics` at `10 TRANSFER branch`, changing nothing
 * else. Goes through PipelineService.updateNode so the node's saved
 * previewSnapshot survives (updateNode strips/reattaches it deliberately — a
 * raw SQL UPDATE would not).
 *
 * Run: node --import tsx scripts/rewire-metrics-to-transfer.ts
 */
import "dotenv/config";
import foundryDb from "../src/config/foundryDb";
import { PipelineService } from "../src/services/pipelineService";

const PROJECT = "36271681-65d7-4c55-a6d0-20137f8212dc";
const PIPELINE = "0e798720-a162-46d1-830d-610a18747a2d";
const METRICS_NODE = "da793f6e-54e8-4ad7-bd2c-9c5c96cb44ce"; // 48 mule_chain_metrics
const TRANSFER_BRANCH = "ee7f5d6d-8290-40d5-bc71-45e6a37a5d8a"; // 10 TRANSFER branch

async function main(): Promise<void> {
  const svc = new PipelineService(foundryDb as never);

  const target = await foundryDb("pipeline_nodes")
    .where({ id: METRICS_NODE, pipeline_id: PIPELINE })
    .first("id", "label", "config");
  if (!target) throw new Error("metrics node not found");

  const src = await foundryDb("pipeline_nodes")
    .where({ id: TRANSFER_BRANCH, pipeline_id: PIPELINE })
    .first("id", "label");
  if (!src) throw new Error("TRANSFER branch not found");

  const cfg =
    typeof target.config === "string"
      ? JSON.parse(target.config)
      : { ...(target.config as Record<string, unknown>) };

  console.log(`before: ${target.label}  sourceNodeId = ${cfg.sourceNodeId ?? "(null)"}`);
  if (cfg.sourceNodeId === TRANSFER_BRANCH) {
    console.log("already connected — nothing to do");
    await foundryDb.destroy();
    return;
  }

  // ONLY the source changes. Every transform is left exactly as authored.
  const next = { ...cfg, sourceNodeId: TRANSFER_BRANCH };
  await svc.updateNode(PROJECT, PIPELINE, METRICS_NODE, { config: next });

  const after = await foundryDb("pipeline_nodes")
    .where({ id: METRICS_NODE })
    .first("config");
  const afterCfg =
    typeof after.config === "string" ? JSON.parse(after.config) : after.config;
  console.log(`after:  sourceNodeId = ${afterCfg.sourceNodeId}  (${src.label})`);
  console.log(`transforms preserved: ${afterCfg.transforms.length} (was ${cfg.transforms.length})`);
  console.log(
    `previewSnapshot preserved: ${afterCfg.previewSnapshot !== undefined ? "yes" : "no"}`,
  );

  await foundryDb.destroy();
}

main().catch(async (e) => {
  console.error("FAILED:", e);
  await foundryDb.destroy();
  process.exit(1);
});