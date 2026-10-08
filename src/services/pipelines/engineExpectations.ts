// ---------------------------------------------------------------------------
// Data expectations evaluated ON THE ENGINE, not in the Node heap.
//
// WHY
// The legacy evaluator (pipelines/expectations.ts) takes
// `rows: Array<Record<string, unknown>>` and walks the whole array. That is
// fine for a preview slice and fatal for a 6,362,620-row deploy: holding the
// rows at all is the OOM. But every expectation type is a plain aggregate —
// COUNT(*), a per-column null count, a distinct-key count — so on the engine
// they become single SQL statements and cost constant Node memory regardless
// of dataset size.
//
// This is the reason the engine deploy path can evaluate expectations at all.
// `evaluateExpectationsOnEngine` returns the SAME ExpectationResult[] shape as
// the in-heap evaluator, so the deploy code that gates a build on
// severity='fail' does not care which engine produced the verdict.
//
// PARITY IS THE POINT
// Each translation reproduces the in-heap semantics exactly, including the
// fiddly bits:
//   - `not_null` treats null AND empty-string as nullish (isNullishCell).
//   - `unique` counts rows BEYOND the first per key (total - distinct), and
//     coerces null to '' before joining the key, matching String(v ?? '').
// Diverging here would silently change what a 'fail' gate means, so
// engineExpectations-parity-unit.test.ts pins every case against the
// in-heap evaluator on the same data.
// ---------------------------------------------------------------------------

import type { PipelineExpectation, ExpectationResult } from "./expectations";

const q = (p: string) => `'${p.replace(/'/g, "''")}'`;

export interface EngineQuery {
  /** Run one aggregate query and return its single row. */
  one: (sql: string) => Promise<Record<string, unknown>>;
}

/** Identifier quoting — column names come from user-authored expectations. */
function ident(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** `count(*)` over the built sink. */
function countSql(src: string): string {
  return `SELECT COUNT(*)::BIGINT AS n FROM ${src}`;
}

function n(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Evaluate expectations against a materialised sink without reading rows.
 * `source` must be a DuckDB table expression over the sink, e.g.
 * `read_parquet('/tmp/…/result.parquet')`.
 */
export async function evaluateExpectationsOnEngine(
  expectations: PipelineExpectation[],
  source: string,
  qy: EngineQuery,
): Promise<ExpectationResult[]> {
  const out: ExpectationResult[] = [];

  for (const e of expectations) {
    let status: "PASS" | "FAIL" = "PASS";
    let detail = "";

    switch (e.type) {
      case "row_count_bounds": {
        const min = typeof e.config.min === "number" ? (e.config.min as number) : null;
        const max = typeof e.config.max === "number" ? (e.config.max as number) : null;
        const row = await qy.one(countSql(source));
        const total = n(row.n);
        if (min !== null && total < min) {
          status = "FAIL";
          detail = `row count ${total} < minimum ${min}`;
        } else if (max !== null && total > max) {
          status = "FAIL";
          detail = `row count ${total} > maximum ${max}`;
        } else {
          detail = `row count ${total} within [${min ?? "-∞"}, ${max ?? "+∞"}]`;
        }
        break;
      }

      case "not_null": {
        const cols = (e.config.columns as string[]) ?? [];
        // Zero columns: no SELECT list is legal SQL, but the in-heap
        // evaluator still reports its "fully populated" PASS line. Reproduce
        // it verbatim so an empty rule reads the same on either engine.
        if (cols.length === 0) {
          detail = `0 column(s) fully populated across ${await countOf(qy, source)} rows`;
          break;
        }
        // One scan, one aggregate row: null/empty counts per column.
        const selects = cols.map(
          (c) =>
            `SUM(CASE WHEN ${ident(c)} IS NULL OR CAST(${ident(c)} AS VARCHAR) = '' ` +
            `THEN 1 ELSE 0 END)::BIGINT AS ${ident(`__nn_${cols.indexOf(c)}`)}`,
        );
        const row = await qy.one(
          `SELECT ${selects.join(", ")} FROM ${source}`,
        );
        const offenders = cols
          .map((c, i) => ({ c, bad: n(row[`__nn_${i}`]) }))
          .filter((x) => x.bad > 0);
        if (offenders.length > 0) {
          status = "FAIL";
          detail =
            `${offenders.length} column(s) contain null/empty cells: ` +
            offenders
              .map((x) => `${x.c} (${x.bad} row${x.bad === 1 ? "" : "s"})`)
              .join(", ");
        } else {
          detail = `${cols.length} column(s) fully populated across ${await countOf(qy, source)} rows`;
        }
        break;
      }

      case "unique": {
        const cols = (e.config.columns as string[]) ?? [];
        if (cols.length === 0) {
          detail = `() unique across ${await countOf(qy, source)} rows`;
          break;
        }
        // total - distinct == the in-heap evaluator's `dupes` counter, which
        // increments for every row AFTER the first occurrence of a key.
        // NULL and '' must collapse to the SAME value or the key splits and
        // the count drifts.
        const keyExpr = cols
          .map((c) => `COALESCE(CAST(${ident(c)} AS VARCHAR), '')`)
          .join(" || '' || ");
        const row = await qy.one(
          `SELECT COUNT(*)::BIGINT AS total, ` +
            `COUNT(DISTINCT (${keyExpr}))::BIGINT AS distinct_keys FROM ${source}`,
        );
        const total = n(row.total);
        const distinct = n(row.distinct_keys);
        const dupes = total - distinct;
        if (dupes > 0) {
          status = "FAIL";
          detail = `${dupes} duplicate row(s) on unique key (${cols.join(", ")})`;
        } else {
          detail = `(${cols.join(", ")}) unique across ${total} rows`;
        }
        break;
      }
    }

    out.push({
      expectationId: e.id,
      name: e.name,
      type: e.type,
      severity: e.severity,
      status,
      detail,
    });
  }

  return out;
}

/** Row count only — used for the PASS-branch detail text. */
async function countOf(qy: EngineQuery, source: string): Promise<number> {
  const row = await qy.one(countSql(source));
  return n(row.n);
}

/** Convenience: build the reader expression for a local Parquet sink. */
export function parquetSource(path: string): string {
  return `read_parquet(${q(path)})`;
}