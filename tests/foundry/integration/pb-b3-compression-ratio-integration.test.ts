// ---------------------------------------------------------------------------
// PB-B3 acceptance (a) — Parquet vs CSV ratio benchmark.
//
// Skipped by default (PB_B3_RATIO_BENCHMARK=1 to opt in — the 1M-row
// fixture takes ~20s + ~180 MB of RAM). CI runs the smaller 10k-row
// variant that lives in pb-b3-parquet-writer-integration.test.ts.
//
// When opted in, generates a TPC-H-shape orders fixture with 1M rows
// of realistic repetition (limited customer ids, mostly "open" status,
// varying amounts) and measures the ZSTD-Parquet compression ratio vs
// plain CSV. Assert ≥5× per spec.
// ---------------------------------------------------------------------------

import { afterAll, describe, expect, it } from "vitest";
import {
  writeRowsToParquet,
  discardStagedParquet,
} from "../../../src/services/pipelines/parquetWriter";
import {
  isDuckDBAvailable,
  __resetPoolForTests,
} from "../../../src/services/duckdb/pool";

const hasDuck = isDuckDBAvailable();

afterAll(async () => {
  await __resetPoolForTests();
});

function generateOrders(n: number): {
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, unknown>>;
} {
  const columns = [
    { name: "order_id", type: "integer" },
    { name: "customer_id", type: "integer" },
    { name: "status", type: "string" },
    { name: "amount", type: "numeric" },
    { name: "clerk_note", type: "string" },
    { name: "order_priority", type: "string" },
  ];
  const priorities = ["1-URGENT", "2-HIGH", "3-MEDIUM", "4-NOT SPECIFIED", "5-LOW"];
  const statuses = ["open", "closed", "cancelled", "pending"];
  const notes = [
    "shipped via ground service",
    "priority tier standard",
    "late after customer delay",
    "tax adjustment applied",
  ];
  const rows = new Array<Record<string, unknown>>(n);
  for (let i = 0; i < n; i++) {
    rows[i] = {
      order_id: i + 1,
      customer_id: (i * 7919) % 10_000,
      status: statuses[i % 4],
      amount: Math.round(i * 123.456 * 100) / 100,
      clerk_note: notes[i % notes.length],
      order_priority: priorities[i % 5],
    };
  }
  return { columns, rows };
}

function rowsToCsvBytes(
  columns: Array<{ name: string; type: string }>,
  rows: Array<Record<string, unknown>>,
): number {
  // Streaming length calculation — avoids materialising a Buffer of the
  // full CSV for large N. Matches the exact CSV format the deploy path
  // emits (RFC-4180 with double-quote escaping).
  let size = columns.map((c) => c.name).join(",").length + 1; // +1 for \n
  for (const r of rows) {
    let lineLen = 0;
    for (let j = 0; j < columns.length; j++) {
      const v = r[columns[j].name];
      if (v == null) { /* empty field */ }
      else {
        const s = String(v);
        lineLen += /[,"\n]/.test(s) ? s.length + 2 + (s.match(/"/g)?.length ?? 0) : s.length;
      }
      if (j < columns.length - 1) lineLen += 1; // comma
    }
    size += lineLen + 1; // \n
  }
  return size;
}

describe("PB-B3 — compression ratio (1M-row TPC-H-like benchmark)", () => {
  it("Parquet ZSTD is ≥ 5× smaller than CSV on realistic orders data", async () => {
    if (!hasDuck) return;
    if (process.env.PB_B3_RATIO_BENCHMARK !== "1") {
      console.warn(
        "[pb-b3 ratio] skipping 1M-row benchmark (set PB_B3_RATIO_BENCHMARK=1 to run)",
      );
      return;
    }
    const N = 1_000_000;
    const { columns, rows } = generateOrders(N);
    const csvBytes = rowsToCsvBytes(columns, rows);
    const t0 = Date.now();
    const parquet = await writeRowsToParquet({ columns, rows });
    const elapsed = Date.now() - t0;
    try {
      expect(parquet.rowCountExact).toBe(N);
      const ratio = csvBytes / parquet.sizeBytes;
      console.log(
        `[pb-b3 ratio] N=${N} csv=${csvBytes}B parquet=${parquet.sizeBytes}B ratio=${ratio.toFixed(2)}× elapsed=${elapsed}ms`,
      );
      // Spec says 5–14×; assert ≥5× as the floor.
      expect(ratio).toBeGreaterThanOrEqual(5);
    } finally {
      discardStagedParquet(parquet.localPath);
    }
  }, 5 * 60 * 1000);
});
