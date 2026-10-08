/**
 * REAL deploy of `transactions_clean` alone — the final end-to-end proof.
 *
 * Calls DeploymentService.startDeployment (exactly what POST /deploy invokes),
 * limited to the one output, then polls the deployment row until it reaches a
 * terminal state and prints the per-output result. No HTTP auth involved; the
 * full server-side flow runs: staleness gate, engine build, expectation gate,
 * upload, dataset registration, build_results.
 *
 * Run: node --import tsx scripts/deploy-transactions-clean.ts
 */
import "dotenv/config";
import foundryDb from "../src/config/foundryDb";
import { DeploymentService } from "../src/services/deploymentService";
import { TransformService } from "../src/services/transformService";

const PROJECT = "36271681-65d7-4c55-a6d0-20137f8212dc";
const PIPELINE = "0e798720-a162-46d1-830d-610a18747a2d";
const OUTPUT = "8b18cbaa-67f1-465a-82a1-f39d464b95e0"; // transactions_clean
const TRIGGERED_BY = "4f0becdd-db36-4b81-9aee-45491cd000cd"; // project member

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const svc = new DeploymentService(
    foundryDb as never,
    new TransformService(foundryDb as never) as never,
  );

  console.log(`triggering deploy of transactions_clean (${OUTPUT.slice(0, 8)})…`);
  const started = (await svc.startDeployment(PROJECT, PIPELINE, TRIGGERED_BY, {
    outputNodeIds: [OUTPUT],
  })) as unknown as { deploymentId?: string; id?: string; status?: string };
  const deploymentId = started.deploymentId ?? started.id;
  if (!deploymentId) throw new Error(`no deploymentId returned: ${JSON.stringify(started)}`);
  console.log(`deployment: ${deploymentId}`);

  const t0 = Date.now();
  for (;;) {
    await sleep(10000);
    const dep = await foundryDb("pipeline_deployments")
      .where({ id: deploymentId })
      .first("status", "error_message", "build_results");
    if (!dep) throw new Error("deployment row vanished");
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[+${elapsed}s] status=${dep.status}`);
    if (dep.status !== "running" && dep.status !== "queued" && dep.status !== "pending") {
      console.log(`\nterminal: ${dep.status} after ${elapsed}s`);
      const results = (
        typeof dep.build_results === "string"
          ? JSON.parse(dep.build_results)
          : (dep.build_results ?? [])
      ) as Array<Record<string, unknown>>;
      for (const r of results) {
        console.log(`\n  ${r.nodeLabel}: ${r.status}`);
        console.log(`    rows=${r.rowCount} cols=${r.columnCount} ms=${r.durationMs}`);
        console.log(`    dataset=${r.datasetId}`);
        console.log(`    file=${r.filePath}`);
        if (r.error) console.log(`    ERROR: ${String(r.error).slice(0, 400)}`);
      }
      if (dep.error_message) {
        console.log(`\ndeployment error: ${String(dep.error_message).slice(0, 500)}`);
      }
      break;
    }
    if (Date.now() - t0 > 30 * 60 * 1000) {
      console.log("timed out waiting (30 min) — deployment still running");
      break;
    }
  }

  await foundryDb.destroy();
}

main().catch(async (e) => {
  console.error("FAILED:", e);
  await foundryDb.destroy();
  process.exit(1);
});