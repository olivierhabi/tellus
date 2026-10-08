/**
 * MANUAL TEST — DuckDB engine path against the real 6,362,620-row PaySim source.
 *
 * Proves the engine can execute every stage of the pipeline graph WITHOUT
 * materializing rows in the Node heap: each stage is compiled by the product
 * compiler (compileTransformChain) and sunk with COPY ... TO PARQUET, so the
 * data goes engine -> disk and the Node process only ever sees COUNT results.
 *
 * Run: node --import tsx scripts/manual-engine-path-probe.ts
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { acquireConnection, releaseConnection } from "../src/services/duckdb/pool";
import { compileTransformChain } from "../src/services/pipelines/duckdbTransformEngine";
import type { TransformStep } from "../src/services/pipelines/duckdbTransformEngine";
import { toDuckDbReadUri } from "../src/services/storageService";

const STAGE_DIR = "/tmp/pb/stage";
mkdirSync(STAGE_DIR, { recursive: true });

// The source object key exactly as pipeline_nodes stores it.
const SOURCE_KEY =
  "projects/36271681-65d7-4c55-a6d0-20137f8212dc/folders/2c9d1bb3-5c44-4da5-9f6e-0798f41e2083/6e27e364-cf12-4a05-a938-9681fbba857d_paysim_dataset.csv";

const COLS = ["step", "type", "amount", "name_orig", "old_balance_orig", "new_balance_orig",
  "name_dest", "old_balance_dest", "new_balance_dest", "is_fraud", "is_flagged_fraud",
  "transaction_id", "day", "hour_of_day", "amount_key", "orig_balance_error",
  "dest_balance_error"];

const op = (kind: "column" | "literal", value: string, literalType?: string) =>
  literalType ? { kind, value, literalType } : { kind, value };
const col = (v: string) => op("column", v);
const lit = (v: string, t: string) => op("literal", v, t);

// ---------------------------------------------------------------- chains
// Mirrors node "02 Keys & derived columns" (stored config, verbatim shape).
const cleanChain = [
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

// Branch A / B: filter + t_/c_ prefix rename.
const branch = (type: string, pfx: string) => ([
  { function: "Filter", mode: "keep", match: "all",
    conditions: [{ column: "type", operator: "eq", value: type }] },
  { function: "Rename", renames: COLS.map((c) => ({ from: c, to: `${pfx}${c}` })) },
] as unknown as TransformStep[]);

// The chain-level derived columns on node 30 (after the join).
const chainDerived = [
  { function: "Rename", renames: [
    { from: "t_step", to: "step" }, { from: "t_amount", to: "amount" },
    { from: "t_amount_key", to: "amount_key" }, { from: "t_day", to: "day" },
    { from: "t_hour_of_day", to: "hour_of_day" }] },
  { function: "ConcatenateStrings", expressions: [col("t_transaction_id"), col("c_transaction_id")],
    separator: "|", nullOutputIfAnyInputIsNull: true, outputColumn: "chain_id" },
  { function: "ApplyExpression", expression: { left: col("t_name_dest"), operator: "==",
    right: col("c_name_orig"), outputColumn: "account_link_match", outputType: "boolean" } },
  { function: "CaseExpression", branches: [
      { condition: { left: col("t_is_fraud"), operator: "==", right: lit("false", "boolean") },
        value: lit("false", "boolean") },
      { condition: { left: col("c_is_fraud"), operator: "==", right: lit("false", "boolean") },
        value: lit("false", "boolean") }],
    defaultValue: lit("true", "boolean"), outputColumn: "both_fraud", outputType: "boolean" },
  { function: "CaseExpression", branches: [
      { condition: { left: col("both_fraud"), operator: "==", right: lit("true", "boolean") },
        value: lit("1", "integer") }],
    defaultValue: lit("0", "integer"), outputColumn: "both_fraud_int", outputType: "integer" },
  { function: "CaseExpression", branches: [
      { condition: { left: col("t_is_flagged_fraud"), operator: "==", right: lit("true", "boolean") },
        value: lit("true", "boolean") },
      { condition: { left: col("c_is_flagged_fraud"), operator: "==", right: lit("true", "boolean") },
        value: lit("true", "boolean") }],
    defaultValue: lit("false", "boolean"), outputColumn: "any_flagged", outputType: "boolean" },
  { function: "ApplyExpression", expression: { left: col("amount"), operator: ">=",
    right: lit("10000000", "numeric"), outputColumn: "is_capped_amount", outputType: "boolean" } },
  { function: "CaseExpression", branches: [
      { condition: { left: col("t_new_balance_orig"), operator: "!=", right: lit("0", "numeric") },
        value: lit("false", "boolean") },
      { condition: { left: col("t_old_balance_orig"), operator: "!=", right: col("amount") },
        value: lit("false", "boolean") }],
    defaultValue: lit("true", "boolean"), outputColumn: "full_drain", outputType: "boolean" },
] as unknown as TransformStep[];

const KEEP = ["chain_id", "step", "amount", "day", "hour_of_day", "amount_key",
  "t_transaction_id", "c_transaction_id", "t_name_orig", "t_name_dest",
  "c_name_orig", "c_name_dest", "account_link_match", "both_fraud", "any_flagged",
  "is_capped_amount", "full_drain", "pair_count_per_key", "is_ambiguous",
  "both_fraud_int"];

// ---------------------------------------------------------------- runner
interface Row { [k: string]: unknown }
const results: Array<Record<string, unknown>> = [];
let peakRss = 0;

function sampleRss(): void {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
}

async function query(conn: any, sql: string): Promise<Row[]> {
  const stream = conn.stream(sql);
  const rows: Row[] = [];
  for await (const r of stream) { rows.push(normalise(r)); sampleRss(); }
  return rows;
}
function normalise(r: Row): Row {
  const o: Row = {};
  for (const [k, v] of Object.entries(r)) {
    o[k] = typeof v === "bigint"
      ? (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString())
      : v;
  }
  return o;
}

async function stage(
  conn: any, name: string, inputPath: string, transforms: TransformStep[],
): Promise<string> {
  const plan = compileTransformChain(transforms, { inputPath });
  for (const p of plan.preambles) await query(conn, p);
  const sink = `${STAGE_DIR}/${name}.parquet`;
  const t0 = Date.now();
  await query(conn, `COPY (${plan.sql}) TO '${sink}' (FORMAT PARQUET)`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const [{ n }] = await query(conn, `SELECT count(*)::BIGINT AS n FROM read_parquet('${sink}')`);
  sampleRss();
  const rowCount = Number(n);
  results.push({ stage: name, rows: rowCount, secs, peakRssMB: Math.round(peakRss / 1048576) });
  console.log(`  ${name.padEnd(22)} ${rowCount.toLocaleString().padStart(12)} rows  ${String(secs).padStart(6)}s  peakRSS=${Math.round(peakRss / 1048576)}MB`);
  return sink;
}

async function main(): Promise<void> {
  const inputUri = toDuckDbReadUri(SOURCE_KEY);
  console.log(`source URI : ${inputUri.replace(/:\/\/[^@/]*@/, "://***@")}`);
  console.log(`stage dir  : ${STAGE_DIR}`);
  console.log(`duckdb mem : ${process.env.DUCKDB_MEMORY_LIMIT ?? "1GB (pool default)"}, spills to /tmp/duckdb_spill\n`);

  const conn = await acquireConnection();
  const t0 = Date.now();
  try {
    // transactions_clean = node 01 (cast+rename) then node 02 (this chain).
    // node 01 is folded in here as the Cast/Rename prefix so the probe is a
    // single linear chain over the raw CSV.
    const castRename = [
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
    ] as unknown as TransformStep[];
    const clean = await stage(conn, "transactions_clean", inputUri, [...castRename, ...cleanChain]);

    // Branches hang off node 02, so they carry the derived columns too.
    const base = [...castRename, ...cleanChain];
    const a = await stage(conn, "branchA_transfer", inputUri, [...base, ...branch("TRANSFER", "t_")]);
    const b = await stage(conn, "branchB_cashout", inputUri, [...base, ...branch("CASH_OUT", "c_")]);

    // Node 30: the join. Engine JoinStep takes rightPath + `on`, not the
    // node-id form the node config stores.
    const joinStep = {
      function: "Join", rightPath: b, joinType: "inner",
      on: [{ left: "t_step", right: "c_step" }, { left: "t_amount_key", right: "c_amount_key" }],
    } as unknown as TransformStep;
    const pairs = await stage(conn, "pairs_joined", a, [joinStep, ...chainDerived]);

    // Node 31: pair counts per (step, amount_key).
    const counts = await stage(conn, "pair_counts", pairs, [
      { function: "Aggregate", groupBy: ["step", "amount_key"],
        aggregations: [{ function: "count", outputColumn: "pair_count_per_key" }] },
    ] as unknown as TransformStep[]);

    // Node 32: attach counts, flag ambiguity, project. The engine has no
    // coalesceJoinKeys, so the pair-counts join uses suffixed keys and the
    // Select keeps the chain-side step/amount_key.
    const back = await stage(conn, "mule_chains", pairs, [
      { function: "Join", rightPath: counts, joinType: "inner",
        on: [{ left: "step", right: "step" }, { left: "amount_key", right: "amount_key" }] },
      { function: "ApplyExpression", expression: { left: col("pair_count_per_key"), operator: ">",
        right: lit("1", "integer"), outputColumn: "is_ambiguous", outputType: "boolean" } },
      { function: "Select", columns: KEEP },
    ] as unknown as TransformStep[]);

    console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)}s   peak Node RSS ${Math.round(peakRss / 1048576)} MB`);
    writeFileSync("/tmp/pb/engine-probe.json", JSON.stringify({ results, sink: back }, null, 2));

    // --- correctness spot-checks against the role's validation pair --------
    const pair = await query(conn,
      `SELECT step, amount, t_name_orig, t_name_dest, c_name_orig, c_name_dest,
              account_link_match, both_fraud, chain_id
       FROM read_parquet('${back}')
       WHERE step = 1 AND amount = 181`);
    console.log("\n--- the role's validation pair (step 1, amount 181.0) ---");
    for (const r of pair) console.log("  " + JSON.stringify(r));

    const [agg] = await query(conn,
      `SELECT count(*)::BIGINT AS chains,
              count(*) FILTER (WHERE both_fraud)::BIGINT AS both_fraud,
              count(*) FILTER (WHERE is_ambiguous)::BIGINT AS ambiguous,
              count(*) FILTER (WHERE account_link_match)::BIGINT AS acct_match,
              max(pair_count_per_key)::BIGINT AS max_pairs,
              sum(amount)::DOUBLE AS layered
       FROM read_parquet('${back}')`);
    console.log("\n--- mule_chains aggregates ---");
    console.log("  " + JSON.stringify(agg));

    // ---- recall / precision, the same shape as nodes 46/47/48 -------------
    const [metrics] = await query(conn, `
      WITH chains AS (SELECT * FROM read_parquet('${back}')),
      denom AS (
        SELECT count(*)::BIGINT AS fraudulent_transfers_total
        FROM read_parquet('${a}') WHERE t_is_fraud
      ),
      numer AS (
        SELECT count(DISTINCT t_transaction_id)::BIGINT AS fraud_transfers_matched
        FROM read_parquet('${pairs}') WHERE t_is_fraud
      )
      SELECT (SELECT fraudulent_transfers_total FROM denom) AS fraudulent_transfers_total,
             (SELECT fraud_transfers_matched FROM numer) AS fraud_transfers_matched,
             count(*)::BIGINT AS total_chains,
             count(*) FILTER (WHERE both_fraud)::BIGINT AS chains_both_fraud,
             count(*) FILTER (WHERE any_flagged)::BIGINT AS chains_any_flagged,
             count(*) FILTER (WHERE is_ambiguous)::BIGINT AS chains_ambiguous,
             sum(amount)::DOUBLE AS total_amount_layered
      FROM chains`);
    const m = metrics as Record<string, number>;
    const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(2) + "%" : "n/a");
    console.log("\n--- mule_chain_metrics (engine) ---");
    console.log(`  total_chains                 : ${m.total_chains}`);
    console.log(`  chains_both_fraud            : ${m.chains_both_fraud}`);
    console.log(`  chains_any_flagged           : ${m.chains_any_flagged}`);
    console.log(`  chains_ambiguous             : ${m.chains_ambiguous}`);
    console.log(`  total_amount_layered         : ${m.total_amount_layered}`);
    console.log(`  fraudulent_transfers_total   : ${m.fraudulent_transfers_total}`);
    console.log(`  fraud_transfers_matched      : ${m.fraud_transfers_matched}`);
    console.log(`  recall_pct                   : ${pct(m.fraud_transfers_matched, m.fraudulent_transfers_total)}`);
    console.log(`  precision_pct                : ${pct(m.chains_both_fraud, m.total_chains)}`);

    // ---- bounded slice for the legacy-vs-engine parity diff ---------------
    await query(conn, `COPY (
      SELECT * FROM read_parquet('${clean}') LIMIT 2000
    ) TO '${STAGE_DIR}/parity_engine.parquet' (FORMAT PARQUET)`);
    console.log("\nwrote /tmp/pb/stage/parity_engine.parquet (2000 rows) for the parity diff");
  } finally {
    releaseConnection(conn);
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });

// ---------------------------------------------------------------------------
// Recall / precision + a bounded slice exported for the legacy parity diff.
// Appended as a second entry point so the first run's numbers stay readable.
export {};
