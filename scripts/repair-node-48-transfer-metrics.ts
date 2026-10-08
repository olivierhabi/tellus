/**
 * Repair `48 mule_chain_metrics` — re-authored for the pipeline as it EXISTS.
 *
 * DAMAGE
 * The node's saved config is a skeleton: both Joins are bare
 * `{ function: 'Join' }` (their `rightNodeId`s pointed at deleted nodes
 * 815c09c7 and 51cfba76), and the canvas emits 5 identical
 * `fraud_transfers_matched * 100 -> _x` blocks plus 5 Drops. Nothing saved
 * from the canvas can execute, so no canvas edit can fix it — only a correct
 * server write can.
 *
 * SCOPE (explicit, documented in the node's own description)
 * Chain metrics (total_chains, both_fraud, precision, recall, ambiguous) are
 * NOT computable: they came from the deleted TRANSFER x CASH_OUT pair join,
 * and CASH_OUT is gone. This node now computes TRANSFER-leg metrics only:
 * volume, fraud volume, flag volume, and the two rates. If the CASH_OUT
 * branch is ever restored, this node must be re-authored again.
 *
 * CONTRACT
 * Aggregate v1: groupBy [] (single granule) + count/sum only. The t_is_fraud
 * flags are booleans (node 01 casts isFraud/isFlaggedFraud to boolean), and
 * the engine has no conditional-sum, so integer/numeric indicators are derived
 * FIRST via caseV2 — the same *_int pattern the original chain used.
 */
import "dotenv/config";
import foundryDb from "../src/config/foundryDb";
import { PipelineService } from "../src/services/pipelineService";
import {
  findMalformedTransformSteps,
  describeTransformStepIssues,
} from "../src/services/pipelines/transformStepIntegrity";

const PROJECT = "36271681-65d7-4c55-a6d0-20137f8212dc";
const PIPELINE = "0e798720-a162-46d1-830d-610a18747a2d";
const NODE = "da793f6e-54e8-4ad7-bd2c-9c5c96cb44ce"; // 48 mule_chain_metrics

const col = (v: string) => ({ kind: "column" as const, value: v });
const lit = (v: string, literalType: string) =>
  ({ kind: "literal" as const, value: v, literalType }) as never;

const REPAIRED_TRANSFORMS = [
  // Indicators — caseV2. `branch` + `defaultValue` + `outputColumn` per
  // CaseExpressionBaseSchema (caseV2), the same vocabulary the SQL compiler
  // reads, so NO translation is involved.
  {
    function: "CaseExpression",
    branches: [{ condition: { left: col("t_is_fraud"), operator: "==", right: lit("true", "boolean") }, value: lit("1", "integer") }],
    defaultValue: lit("0", "integer"),
    outputColumn: "fraud_ind",
    outputType: "integer",
  },
  {
    function: "CaseExpression",
    branches: [{ condition: { left: col("t_is_flagged_fraud"), operator: "==", right: lit("true", "boolean") }, value: lit("1", "integer") }],
    defaultValue: lit("0", "integer"),
    outputColumn: "flagged_ind",
    outputType: "integer",
  },
  {
    function: "CaseExpression",
    branches: [{ condition: { left: col("t_is_fraud"), operator: "==", right: lit("true", "boolean") }, value: col("t_amount") }],
    defaultValue: lit("0", "numeric"),
    outputColumn: "fraud_amount_ind",
    outputType: "numeric",
  },
  {
    function: "CaseExpression",
    branches: [{ condition: { left: col("t_is_flagged_fraud"), operator: "==", right: lit("true", "boolean") }, value: col("t_amount") }],
    defaultValue: lit("0", "numeric"),
    outputColumn: "flagged_amount_ind",
    outputType: "numeric",
  },
  // Single-granule aggregate over the TRANSFER leg.
  {
    function: "Aggregate",
    groupBy: [],
    aggregations: [
      { function: "count", outputColumn: "total_transfers" },
      { column: "t_amount", function: "sum", outputColumn: "total_amount" },
      { column: "fraud_ind", function: "sum", outputColumn: "fraudulent_transfers" },
      { column: "fraud_amount_ind", function: "sum", outputColumn: "fraudulent_amount" },
      { column: "flagged_ind", function: "sum", outputColumn: "flagged_transfers" },
      { column: "flagged_amount_ind", function: "sum", outputColumn: "flagged_amount" },
    ],
  },
  // fraud_rate_pct = fraudulent_transfers * 100 / total_transfers
  {
    function: "ApplyExpression",
    expression: { left: col("fraudulent_transfers"), operator: "*", right: lit("100", "numeric"), outputType: "numeric", outputColumn: "_x" },
  },
  {
    function: "ApplyExpression",
    expression: { left: col("_x"), operator: "/", right: col("total_transfers"), outputType: "numeric", outputColumn: "fraud_rate_pct" },
  },
  { function: "Drop", columns: ["_x"] },
  // flagged_rate_pct = flagged_transfers * 100 / total_transfers
  {
    function: "ApplyExpression",
    expression: { left: col("flagged_transfers"), operator: "*", right: lit("100", "numeric"), outputType: "numeric", outputColumn: "_x" },
  },
  {
    function: "ApplyExpression",
    expression: { left: col("_x"), operator: "/", right: col("total_transfers"), outputType: "numeric", outputColumn: "flagged_rate_pct" },
  },
  { function: "Drop", columns: ["_x"] },
  // NOTE: no Drop for fraud_ind/flagged_ind/fraud_amount_ind/flagged_amount_ind.
  // A groupBy:[] Aggregate emits ONLY its aggregation outputs, so those
  // indicator columns are already gone — dropping them would fail with
  // `Column "fraud_ind" in EXCLUDE list not found`.
];

async function main(): Promise<void> {
  const svc = new PipelineService(foundryDb as never);
  const node = await foundryDb("pipeline_nodes")
    .where({ id: NODE, pipeline_id: PIPELINE })
    .first("id", "label", "config");
  if (!node) throw new Error("node not found");

  const cfg = typeof node.config === "string"
    ? JSON.parse(node.config)
    : { ...(node.config as Record<string, unknown>) };

  // The guard that blocks the canvas must bless this write too.
  const issues = findMalformedTransformSteps(REPAIRED_TRANSFORMS);
  if (issues.length > 0) {
    throw new Error(`repair is itself malformed: ${describeTransformStepIssues(issues)}`);
  }
  console.log(`integrity guard: OK (${REPAIRED_TRANSFORMS.length} steps)`);

  const before = Array.isArray(cfg.transforms) ? cfg.transforms.length : 0;
  await svc.updateNode(PROJECT, PIPELINE, NODE, {
    config: {
      ...cfg,
      // Source is already node 10 (TRANSFER branch); leave the wiring alone.
      transforms: REPAIRED_TRANSFORMS,
      description:
        "TRANSFER-leg volume metrics ONLY. Chain metrics (total_chains, " +
        "precision, recall, ambiguous) are NOT computed here: they required " +
        "the deleted TRANSFER x CASH_OUT pair join. fraud_rate_pct and " +
        "flagged_rate_pct are shares of TRANSFER rows. If the CASH_OUT " +
        "branch is restored, re-author this node for chains.",
    },
  });

  const after = await foundryDb("pipeline_nodes").where({ id: NODE }).first("config");
  const afterCfg = typeof after.config === "string" ? JSON.parse(after.config) : after.config;
  const persisted = afterCfg.transforms as Array<Record<string, unknown>>;

  console.log(`\nbefore: ${before} steps (2 skeleton Joins + duplicated expressions)`);
  console.log(`after:  ${persisted.length} steps`);
  for (const t of persisted) {
    const detail =
      t.function === "CaseExpression"
        ? ` branches=${(t.branches as unknown[])?.length} → ${String(t.outputColumn)}`
        : t.function === "Aggregate"
          ? ` outputs=${((t.aggregations as Array<{ outputColumn: string }>) ?? []).map((a) => a.outputColumn).join(",")}`
          : t.function === "Drop"
            ? ` [${((t.columns as string[]) ?? []).join(",")}]`
            : "";
    console.log(`  ${t.function}${detail}`);
  }

  await foundryDb.destroy();
}

main().catch(async (e) => {
  console.error("FAILED:", e);
  await foundryDb.destroy();
  process.exit(1);
});