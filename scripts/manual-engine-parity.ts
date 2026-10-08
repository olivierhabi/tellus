/**
 * MANUAL TEST — engine/legacy parity for the transactions_clean chain.
 *
 * The DuckDB SQL compiler and the legacy TS evaluator are two implementations
 * of one contract, so shipping the engine path is only safe if they agree on
 * the values this pipeline actually derives. This feeds the SAME source rows
 * to both and diffs every derived column.
 *
 * The interesting cases are the ones we already hit as engine quirks:
 *   day           - a 31-branch ladder (floor() does not exist in the engine)
 *   hour_of_day   - depends on day
 *   amount_key    - TRY_CAST(amount*100 AS INTEGER): DuckDB ROUNDS a double,
 *                   the legacy path NULLs a non-integral one. PaySim amounts
 *                   have 2dp, so amount*100 can land on 983963.9999999999.
 *   transaction_id- string concat, must be byte-identical
 *
 * Run: node --import tsx scripts/manual-engine-parity.ts
 */
import "dotenv/config";
import { parse } from "csv-parse";
import { getObjectStream } from "../src/services/storageService";
import { applyExistingTransforms } from "../src/services/transform/applyExisting";
import { acquireConnection, releaseConnection } from "../src/services/duckdb/pool";
import { compileTransformChain } from "../src/services/pipelines/duckdbTransformEngine";
import type { TransformStep } from "../src/services/pipelines/duckdbTransformEngine";
import { sanitizeCsvHeader } from "../src/utils/csvHeader";
import { toDuckDbReadUri } from "../src/services/storageService";

const SOURCE_KEY =
  "projects/36271681-65d7-4c55-a6d0-20137f8212dc/folders/2c9d1bb3-5c44-4da5-9f6e-0798f41e2083/6e27e364-cf12-4a05-a938-9681fbba857d_paysim_dataset.csv";
const N = 5000;
const op = (kind: "column" | "literal", value: string, literalType?: string) =>
  literalType ? { kind, value, literalType } : { kind, value };
const col = (v: string) => op("column", v);
const lit = (v: string, t: string) => op("literal", v, t);

const COLS = ["step", "type", "amount", "name_orig", "old_balance_orig", "new_balance_orig",
  "name_dest", "old_balance_dest", "new_balance_dest", "is_fraud", "is_flagged_fraud"];

// Exactly the transforms stored on nodes 01 + 02, flattened.
const CHAIN = [
  { function: "Cast", expression: "step", targetType: "integer" },
  { function: "Cast", expression: "amount", targetType: "numeric" },
  { function: "Cast", expression: "oldbalanceOrg", targetType: "numeric" },
  { function: "Cast", expression: "newbalanceOrig", targetType: "numeric" },
  { function: "Cast", expression: "oldbalanceDest", targetType: "numeric" },
  { function: "Cast", expression: "newbalanceDest", targetType: "numeric" },
  { function: "Cast", expression: "isFraud", targetType: "boolean" },
  { function: "Cast", expression: "isFlaggedFraud", targetType: "boolean" },
  { function: "Rename", renames: [
    { from: "nameOrig", to: "name_orig" }, { from: "oldbalanceOrg", to: "old_balance_orig" },
    { from: "newbalanceOrig", to: "new_balance_orig" }, { from: "nameDest", to: "name_dest" },
    { from: "oldbalanceDest", to: "old_balance_dest" },
    { from: "newbalanceDest", to: "new_balance_dest" },
    { from: "isFraud", to: "is_fraud" }, { from: "isFlaggedFraud", to: "is_flagged_fraud" }] },
  { function: "ConcatenateStrings", expressions: [
    col("step"), col("type"), col("amount"), col("name_orig"), col("name_dest"),
    col("old_balance_orig"), col("new_balance_orig")],
    separator: "|", nullOutputIfAnyInputIsNull: true, outputColumn: "transaction_id" },
  { function: "CaseExpression",
    branches: Array.from({ length: 30 }, (_, i) => {
      const d = 30 - i;
      return { condition: { left: col("step"), operator: ">=", right: lit(String(d * 24), "integer") },
        value: lit(String(d), "integer") };
    }),
    defaultValue: lit("0", "integer"), outputColumn: "day", outputType: "integer" },
  { function: "ApplyExpression", expression: { left: col("day"), operator: "*",
    right: lit("24", "integer"), outputColumn: "_day24", outputType: "integer" } },
  { function: "ApplyExpression", expression: { left: col("step"), operator: "-",
    right: col("_day24"), outputColumn: "hour_of_day", outputType: "integer" } },
  { function: "ApplyExpression", expression: { left: col("amount"), operator: "*",
    right: lit("100", "numeric"), outputColumn: "_cents", outputType: "integer" } },
  { function: "ApplyExpression", expression: { left: col("_cents"), operator: "/",
    right: lit("100", "numeric"), outputColumn: "amount_key", outputType: "numeric" } },
  { function: "Drop", columns: ["_day24", "_cents"] },
] as unknown as TransformStep[];

const DERIVED = ["transaction_id", "day", "hour_of_day", "amount_key",
  "orig_balance_error", "dest_balance_error"];

async function readSourceRows(key: string, limit: number): Promise<Array<Record<string, string>>> {
  const stream = await getObjectStream(key);
  const rows: Array<Record<string, string>> = [];
  await new Promise<void>((resolve, reject) => {
    const p = parse({
      delimiter: ",",
      columns: (h: string[]) => sanitizeCsvHeader(h, { source: key }),
      skip_empty_lines: true, trim: true, relax_column_count: true, bom: true,
    });
    p.on("error", reject);
    p.on("data", (r: Record<string, string>) => {
      if (rows.length < limit) rows.push(r);
      else p.destroy();
    });
    p.on("close", () => resolve());
    p.on("end", () => resolve());
    stream.pipe(p);
  });
  return rows;
}

function norm(v: unknown): string {
  if (v === null || v === undefined) return "<null>";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(Math.round(v * 1e6) / 1e6);
  if (typeof v === "bigint") return String(v);
  return String(v);
}

async function main(): Promise<void> {
  console.log(`reading ${N} source rows from S3…`);
  const raw = await readSourceRows(SOURCE_KEY, N);
  console.log(`got ${raw.length} rows\n`);

  // ---- legacy TS evaluator ------------------------------------------------
  const legacy = applyExistingTransforms(raw as never, CHAIN as never) as Array<Record<string, unknown>>;

  // ---- DuckDB engine on the SAME rows ------------------------------------
  // Feed the identical slice through the engine by materializing it as a CSV
  // the engine reads, so there is zero chance of comparing different inputs.
  const { writeFileSync } = await import("node:fs");
  const header = Object.keys(raw[0] ?? {});
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header.join(","), ...raw.map((r) => header.map((h) => esc(r[h])).join(","))].join("\n");
  writeFileSync("/tmp/pb/parity_input.csv", csv);

  const conn = await acquireConnection({ skipHttpfs: true });
  const plan = compileTransformChain(CHAIN, { inputPath: "/tmp/pb/parity_input.csv" });
  for (const pre of plan.preambles) await conn.run(pre);
  const engine: Array<Record<string, unknown>> = [];
  for await (const r of conn.stream(plan.sql) as AsyncIterable<Record<string, unknown>>) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      o[k] = typeof v === "bigint"
        ? (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v))
        : v;
    }
    engine.push(o);
  }
  releaseConnection(conn);
  console.log(`legacy rows: ${legacy.length}   engine rows: ${engine.length}\n`);

  // ---- diff ---------------------------------------------------------------
  let mismatches = 0;
  const perColumn: Record<string, number> = {};
  const examples: Array<string> = [];
  const n = Math.min(legacy.length, engine.length);
  for (let i = 0; i < n; i += 1) {
    for (const c of DERIVED) {
      // orig/dest_balance_error are NOT in this chain; skip absent columns.
      if (!(c in legacy[i]) && !(c in engine[i])) continue;
      const a = norm(legacy[i][c]);
      const b = norm(engine[i][c]);
      if (a !== b) {
        mismatches += 1;
        perColumn[c] = (perColumn[c] ?? 0) + 1;
        if (examples.length < 40) {
          examples.push(`row ${i} ${c}: legacy=${a} engine=${b} (step=${legacy[i].step}, amount=${legacy[i].amount})`);
        }
      }
    }
  }
  const cells = n * DERIVED.length;
  console.log(`compared ${n} rows x ${DERIVED.length} derived columns = ${cells} cells`);
  console.log(`mismatches: ${mismatches} (${((mismatches / cells) * 100).toFixed(4)}%)\n`);
  if (Object.keys(perColumn).length) {
    console.log("per column:");
    for (const [c, k] of Object.entries(perColumn)) console.log(`  ${c.padEnd(22)} ${k}`);
    console.log("\nexamples (amount_key first 10):");
    for (const e of examples.filter((x) => x.includes("amount_key")).slice(0, 10)) console.log("  " + e);
    console.log("\nexamples (transaction_id first 3):");
    for (const e of examples.filter((x) => x.includes("transaction_id")).slice(0, 3)) console.log("  " + e);
  } else {
    console.log("PARITY: engine and legacy agree on every derived cell.");
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
