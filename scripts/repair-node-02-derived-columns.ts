/**
 * Repair `02 Keys & derived columns` (node 0f6dcde5) — the shared upstream of
 * ALL FOUR outputs.
 *
 * DAMAGE
 * The canvas transform editor round-tripped this node's config through a
 * lossy model and persisted skeletons: the CaseExpression lost its `branches`
 * (the 30-day ladder that derives `day`), the amount_key pair was replaced by
 * 8 duplicated `_day24` expressions, and the Drop lost its real targets. The
 * node kept its id/label so it still renders, but it can never execute.
 *
 * WHY A SERVER-SIDE REPAIR
 * The frontend non-destructive merge preserves the PERSISTED step when the
 * editor has nothing real to send — and the persisted step is itself a
 * skeleton. So the canvas cannot self-heal this node; only a correct server
 * write can. Once this lands, the editor hydrates a valid CaseExpression and
 * Apply works normally again.
 *
 * CONTRACT (Palantir caseV2 / concatStringsV1)
 *   https://www.palantir.com/docs/foundry/pb-functions-expression/caseV2
 *   CaseExpression = { branches[1..100], defaultValue, outputColumn, outputType? }
 * This shape is identical in storage and in the SQL compiler
 * (compileCaseExpression reads step.branches / step.defaultValue), so no
 * translation is involved — the earlier `step.branches.map` TypeError was
 * purely the deleted branches.
 *
 * DERIVATIONS (all from `step`, the dataset's integer hour offset, and `amount`)
 *   day         = floor(step / 24), expressed as a 30-branch ladder because
 *                 the platform has no date-part or integer-division function
 *   hour_of_day = step - (day * 24)
 *   amount_key  = round(amount, 2) via a *100 then /100 round-trip
 * These reproduce the values verified in the engine probe.
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
const NODE = "0f6dcde5-dea7-40eb-9fd1-96b2b903c866"; // 02 Keys & derived columns

const col = (v: string) => ({ kind: "column" as const, value: v });
const lit = (v: string, literalType: string) =>
  ({ kind: "literal" as const, value: v, literalType }) as never;

/** 30 days × 24h. First-true-wins, so evaluate day 30 downwards. */
const DAY_LADDER = Array.from({ length: 30 }, (_, i) => {
  const d = 30 - i;
  return {
    condition: { left: col("step"), operator: ">=", right: lit(String(d * 24), "integer") },
    value: lit(String(d), "integer"),
  };
});

const REPAIRED_TRANSFORMS = [
  // concatStringsV1 — kept verbatim; it survived the round-trip intact.
  {
    function: "ConcatenateStrings",
    expressions: [
      col("step"), col("type"), col("amount"), col("name_orig"),
      col("name_dest"), col("old_balance_orig"), col("new_balance_orig"),
    ],
    separator: "|",
    nullOutputIfAnyInputIsNull: true,
    outputColumn: "transaction_id",
  },
  // caseV2 — day-of-month bucket from the hour offset.
  {
    function: "CaseExpression",
    branches: DAY_LADDER,
    defaultValue: lit("0", "integer"),
    outputColumn: "day",
    outputType: "integer",
  },
  // hour_of_day = step - (day * 24)
  {
    function: "ApplyExpression",
    expression: {
      left: col("day"), operator: "*", right: lit("24", "integer"),
      outputType: "integer", outputColumn: "_day24",
    },
  },
  {
    function: "ApplyExpression",
    expression: {
      left: col("step"), operator: "-", right: col("_day24"),
      outputType: "integer", outputColumn: "hour_of_day",
    },
  },
  // amount_key = round(amount, 2) via a cents round-trip.
  {
    function: "ApplyExpression",
    expression: {
      left: col("amount"), operator: "*", right: lit("100", "numeric"),
      outputType: "numeric", outputColumn: "_cents",
    },
  },
  {
    function: "ApplyExpression",
    expression: {
      left: col("_cents"), operator: "/", right: lit("100", "numeric"),
      outputType: "numeric", outputColumn: "amount_key",
    },
  },
  // Balance-error columns consumed downstream as
  // t_orig_balance_error / t_dest_balance_error (node "10 TRANSFER branch").
  // A sender's recorded balance delta that disagrees with the amount moved is
  // the standard inconsistency signal, hence delta MINUS amount.
  {
    function: "ApplyExpression",
    expression: {
      left: col("new_balance_orig"), operator: "-", right: col("old_balance_orig"),
      outputType: "numeric", outputColumn: "_debit",
    },
  },
  {
    function: "ApplyExpression",
    expression: {
      left: col("_debit"), operator: "-", right: col("amount"),
      outputType: "numeric", outputColumn: "orig_balance_error",
    },
  },
  {
    function: "ApplyExpression",
    expression: {
      left: col("old_balance_dest"), operator: "-", right: col("new_balance_dest"),
      outputType: "numeric", outputColumn: "_credit",
    },
  },
  {
    function: "ApplyExpression",
    expression: {
      left: col("_credit"), operator: "-", right: col("amount"),
      outputType: "numeric", outputColumn: "dest_balance_error",
    },
  },
  {
    function: "Drop",
    columns: ["_day24", "_cents", "_debit", "_credit"],
  },
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

  // The guard that blocks the canvas must also bless this write — otherwise
  // the repair is no more trustworthy than what it replaces.
  const issues = findMalformedTransformSteps(REPAIRED_TRANSFORMS);
  if (issues.length > 0) {
    throw new Error(`repair is itself malformed: ${describeTransformStepIssues(issues)}`);
  }
  console.log(`integrity guard: OK (${REPAIRED_TRANSFORMS.length} steps)`);
  console.log(`day ladder branches: ${DAY_LADDER.length} (step >= 720 -> 30 … step >= 24 -> 1, else 0)`);

  const before = Array.isArray(cfg.transforms) ? cfg.transforms.length : 0;
  await svc.updateNode(PROJECT, PIPELINE, NODE, {
    config: {
      ...cfg,
      transforms: REPAIRED_TRANSFORMS,
      description:
        "Derives transaction_id (concatStringsV1), day (caseV2 30-day ladder over " +
        "the `step` hour offset), hour_of_day, amount_key (cents round-trip) and " +
        "the two balance-error columns consumed downstream.",
    },
  });

  const after = await foundryDb("pipeline_nodes").where({ id: NODE }).first("config");
  const afterCfg = typeof after.config === "string" ? JSON.parse(after.config) : after.config;
  const persisted = afterCfg.transforms as Array<Record<string, unknown>>;

  console.log(`\nbefore: ${before} steps (skeletons)`);
  console.log(`after:  ${persisted.length} steps`);
  for (const t of persisted) {
    console.log(`  ${t.function}${t.outputColumn ? ` → ${String(t.outputColumn)}` : ""}`);
  }
  const ce = persisted.find((t) => t.function === "CaseExpression");
  console.log(`\nCaseExpression branches persisted: ${(ce?.branches as unknown[])?.length}`);
  console.log(`previewSnapshot preserved: ${afterCfg.previewSnapshot !== undefined ? "yes" : "no (stale — re-Apply in the canvas)"}`);

  await foundryDb.destroy();
}

main().catch(async (e) => {
  console.error("FAILED:", e);
  await foundryDb.destroy();
  process.exit(1);
});