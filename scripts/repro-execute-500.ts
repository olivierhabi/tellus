/**
 * Reproduce the 500 that the canvas "Execute" button produced on
 * `48 mule_chain_metrics`, before and after the readSource guard.
 *
 * Same entry point as POST /nodes/:nodeId/transforms/execute
 * (pipelineController.executeChain → TransformService.executeChain →
 * executeChainInternal → executeTransformChain), invoked directly so no
 * bearer token is needed.
 *
 * Run: node --import tsx scripts/repro-execute-500.ts
 */
import "dotenv/config";
import foundryDb from "../src/config/foundryDb";
import { TransformService } from "../src/services/transformService";

const PROJECT = "36271681-65d7-4c55-a6d0-20137f8212dc";
const PIPELINE = "0e798720-a162-46d1-830d-610a18747a2d";
const NODE = process.argv[2] ?? "da793f6e-54e8-4ad7-bd2c-9c5c96cb44ce";

async function main(): Promise<void> {
  const svc = new TransformService(foundryDb as never);
  const node = await foundryDb("pipeline_nodes")
    .where({ id: NODE, pipeline_id: PIPELINE })
    .first("id", "label", "config", "node_type");
  if (!node) throw new Error("node not found");

  const cfg = typeof node.config === "string"
    ? JSON.parse(node.config)
    : (node.config as Record<string, unknown>);
  const transforms = (cfg.transforms as Array<Record<string, unknown>>) ?? [];

  console.log(`node: ${node.label}`);
  console.log(`sourceNodeId: ${String(cfg.sourceNodeId).slice(0, 8)}`);
  console.log(`transforms: ${transforms.length}`);
  for (const [i, t] of transforms.entries()) {
    const fn = t.function as string;
    const extra =
      fn === "Join"
        ? ` rightNodeId=${String((t as Record<string, unknown>).rightNodeId ?? "—").slice(0, 8)}` +
          ` rightPath=${String((t as Record<string, unknown>).rightPath ?? "—")}` +
          ` on=${JSON.stringify((t as Record<string, unknown>).on ?? null)}`
        : "";
    console.log(`  [${i}] ${fn}${extra}`);
  }

  console.log("\n--- calling executeChain (what the Execute button does) ---");
  try {
    const out = await svc.executeChain(PROJECT, PIPELINE, NODE);
    console.log("RESULT ok:", {
      rowCount: out.rowCount,
      columns: out.columns?.length,
      engine: out.engine,
    });
    const cols = (out.columns ?? []).map((c: { name: string }) => c.name);
    console.log("  columns:", cols.join(", "));
    for (const want of ["day", "hour_of_day", "amount_key", "transaction_id",
                        "orig_balance_error", "dest_balance_error"]) {
      console.log(`  ${want.padEnd(20)} ${cols.includes(want) ? "present" : "*** MISSING ***"}`);
    }
    const sample = (out.rows ?? [])[0];
    if (sample) {
      console.log("  first row:", JSON.stringify(sample));
    }
  } catch (e) {
    const err = e as { message?: string; statusCode?: number; code?: string; name?: string };
    console.log(`THREW ${err.name ?? "Error"} status=${err.statusCode ?? "-"} code=${err.code ?? "-"}`);
    console.log(`message: ${err.message}`);
    const isOpaqueTypeError =
      /Cannot read properties of undefined/.test(err.message ?? "") &&
      !err.code;
    console.log(
      isOpaqueTypeError
        ? "\n=> STILL AN OPAQUE 500 (unguarded TypeError)"
        : "\n=> now a structured, actionable client error",
    );
  }

  await foundryDb.destroy();
}

main().catch(async (e) => {
  console.error("harness failure:", e);
  await foundryDb.destroy();
  process.exit(1);
});