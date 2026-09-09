// ---------------------------------------------------------------------------
// Data expectations — Foundry Pipeline Builder parity
// (foundry-docs: build-time data expectations / health checks).
//
// An expectation is a declarative data-quality rule evaluated against the
// rows a build is about to publish:
//
//   row_count_bounds  { min?, max? }                     build-size sanity
//   not_null          { columns: string[] }              no null/empty cells
//   unique            { columns: string[] }              key uniqueness
//
// severity='fail' blocks the build BEFORE any transaction commits (the
// pre-existing dataset stays untouched); severity='warn' records but lets
// the build through. `evaluateExpectations` is pure: no I/O — the deploy
// path calls it synchronously.
// ---------------------------------------------------------------------------

export interface PipelineExpectation {
  id: string;
  pipelineId: string;
  nodeId: string | null;
  name: string;
  type: "row_count_bounds" | "not_null" | "unique";
  config: Record<string, unknown>;
  severity: "fail" | "warn";
  active: boolean;
}

export interface ExpectationResult {
  expectationId: string;
  name: string;
  type: string;
  severity: "fail" | "warn";
  status: "PASS" | "FAIL";
  /** Human condition, e.g. "row count 5 >= min 100". */
  detail: string;
}

function isNullishCell(v: unknown): boolean {
  return v === null || v === undefined || String(v) === "";
}

export function evaluateExpectations(
  expectations: PipelineExpectation[],
  rows: Array<Record<string, unknown>>,
): ExpectationResult[] {
  return expectations.map((e) => {
    let status: "PASS" | "FAIL" = "PASS";
    let detail = "";
    switch (e.type) {
      case "row_count_bounds": {
        const min = typeof e.config.min === "number" ? (e.config.min as number) : null;
        const max = typeof e.config.max === "number" ? (e.config.max as number) : null;
        if (min !== null && rows.length < min) {
          status = "FAIL";
          detail = `row count ${rows.length} < minimum ${min}`;
        } else if (max !== null && rows.length > max) {
          status = "FAIL";
          detail = `row count ${rows.length} > maximum ${max}`;
        } else {
          detail = `row count ${rows.length} within [${min ?? "-\u221E"}, ${max ?? "+\u221E"}]`;
        }
        break;
      }
      case "not_null": {
        const cols = (e.config.columns as string[]) ?? [];
        const offenders: Record<string, number> = {};
        for (const row of rows) {
          for (const col of cols) {
            if (isNullishCell(row[col])) offenders[col] = (offenders[col] ?? 0) + 1;
          }
        }
        const bad = Object.entries(offenders);
        if (bad.length > 0) {
          status = "FAIL";
          detail = `${bad.length} column(s) contain null/empty cells: ` +
            bad.map(([c, n]) => `${c} (${n} row${n === 1 ? "" : "s"})`).join(", ");
        } else {
          detail = `${cols.length} column(s) fully populated across ${rows.length} rows`;
        }
        break;
      }
      case "unique": {
        const cols = (e.config.columns as string[]) ?? [];
        const seen = new Set<string>();
        let dupes = 0;
        for (const row of rows) {
          const key = cols.map((c) => String(row[c] ?? "")).join("");
          if (seen.has(key)) dupes++;
          else seen.add(key);
        }
        if (dupes > 0) {
          status = "FAIL";
          detail = `${dupes} duplicate row(s) on unique key (${cols.join(", ")})`;
        } else {
          detail = `(${cols.join(", ")}) unique across ${rows.length} rows`;
        }
        break;
      }
    }
    return {
      expectationId: e.id,
      name: e.name,
      type: e.type,
      severity: e.severity,
      status,
      detail,
    };
  });
}

interface ExpectationRow {
  id: string;
  pipeline_id: string;
  node_id: string | null;
  name: string;
  type: "row_count_bounds" | "not_null" | "unique";
  config: Record<string, unknown> | string;
  severity: "fail" | "warn";
  active: boolean;
}

export function mapExpectationRow(r: ExpectationRow): PipelineExpectation {
  return {
    id: r.id,
    pipelineId: r.pipeline_id,
    nodeId: r.node_id,
    name: r.name,
    type: r.type,
    config: typeof r.config === "string" ? JSON.parse(r.config) : (r.config ?? {}),
    severity: r.severity,
    active: Boolean(r.active),
  };
}
