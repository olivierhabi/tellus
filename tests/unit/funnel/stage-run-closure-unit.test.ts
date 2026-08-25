// ---------------------------------------------------------------------------
// stageRunClosure — the terminal-run stage-row invariant, in isolation.
//
// WHAT WENT WRONG. Closing `funnel_stage_run` rows was implemented only in the
// two boot sweeps in durableWorkflow.ts, and those close rows exclusively for
// run_ids they themselves transitioned — selected by `funnel_run.status =
// 'running'`. Every OTHER writer that moved a run to a terminal status updated
// `funnel_run` alone, so its stage rows became permanently unreachable: an
// already-'failed' run is never selected by a sweep again. The read path returns
// stage rows verbatim and the FE maps `status === "running"` to a spinner, so a
// stranded merge row rendered a merge node that spun forever underneath a
// "Failed" header. 106 such rows existed in the dev database.
//
// WHAT THIS SUITE PINS. `query` is mocked, so these are assertions about the SQL
// this module emits and its error contract — not about Postgres. The predicate
// shape is the whole fix: widen the status filter and a live stage gets killed
// mid-flight; drop the terminal-status subquery from the by-workflow-id variant
// and it can close the stage rows of a run that is still executing. Both are
// silent in production and invisible to tsc, which is why they are asserted on
// the emitted text.
//
// Postgres-level proof that the predicate behaves under a real race is a
// separate concern and is not claimed here.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/** Every SQL statement this module issued, with its bound parameters. */
const calls: Array<{ sql: string; params: unknown[] }> = [];
/** What the mocked `query` should do on its next invocation. */
let behaviour: { kind: "rows"; count: number } | { kind: "throw"; error: Error } = {
  kind: "rows",
  count: 0,
};

vi.mock("../../../src/db", () => ({
  query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (behaviour.kind === "throw") throw behaviour.error;
    return { rowCount: behaviour.count, rows: [] };
  },
}));

import {
  closeOpenStageRuns,
  closeOpenStageRunsByWorkflowId,
} from "../../../src/services/funnel/stageRunClosure";

/** Collapse whitespace so assertions are not hostage to SQL formatting. */
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls.length = 0;
  behaviour = { kind: "rows", count: 0 };
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("closeOpenStageRuns — by run id", () => {
  it("closes only pending/running rows, and only for the given run", () => {
    // Widening either half of this predicate is destructive: including
    // 'succeeded' would rewrite completed history; dropping the run_id filter
    // would close every open stage row in the environment.
    void closeOpenStageRuns("run-1", "boom");
    const sql = flat(calls[0].sql);
    expect(sql).toContain("UPDATE funnel_stage_run");
    expect(sql).toContain("WHERE run_id = $1");
    expect(sql).toContain("AND status IN ('pending', 'running')");
    expect(calls[0].params[0]).toBe("run-1");
  });

  it("records 'failed' — funnel_stage_run has no 'cancelled' status", () => {
    // The CHECK is pending|running|succeeded|failed|timed_out. A cancelled run's
    // open stages must therefore land on 'failed' carrying the cancellation
    // reason; writing 'cancelled' would violate the constraint and throw.
    void closeOpenStageRuns("run-1", "run cancelled: object_type_deleted");
    const sql = flat(calls[0].sql);
    expect(sql).toContain("SET status = 'failed'");
    expect(sql).not.toContain("'cancelled'");
    expect(calls[0].params[1]).toBe("run cancelled: object_type_deleted");
  });

  it("preserves an existing error_message and finished_at via COALESCE", async () => {
    // The original cause of a stage's failure is the useful diagnostic. If a
    // stage already recorded why it died, this bookkeeping pass must not
    // overwrite it with the generic run-level reason.
    await closeOpenStageRuns("run-1", "boom");
    const sql = flat(calls[0].sql);
    expect(sql).toContain("error_message = COALESCE(error_message, $2)");
    expect(sql).toContain("finished_at = COALESCE(finished_at, now())");
  });

  it("returns the number of rows it closed", async () => {
    behaviour = { kind: "rows", count: 3 };
    await expect(closeOpenStageRuns("run-1", "boom")).resolves.toBe(3);
  });

  it("substitutes a reason when the caller passes an empty one", async () => {
    // An empty error_message is worse than a generic one: it reads as "failed
    // for no reason" to whoever opens the row next.
    await closeOpenStageRuns("run-1", "");
    expect(calls[0].params[1]).toBe(
      "run reached a terminal status with this stage still open",
    );
  });

  it("issues no query at all for an empty run id", async () => {
    await expect(closeOpenStageRuns("", "boom")).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("closeOpenStageRuns — failure contract", () => {
  it("swallows a database error and reports 0 instead of throwing", async () => {
    // This runs on paths that are ALREADY handling a failure. Throwing here
    // would replace the real error with a bookkeeping error, which is how a
    // root cause gets lost. A transitional deployment without the B3 tables
    // must also not crash the funnel.
    behaviour = { kind: "throw", error: new Error('relation "funnel_stage_run" does not exist') };
    await expect(closeOpenStageRuns("run-1", "boom")).resolves.toBe(0);
  });

  it("logs the swallowed failure so it is not invisible", async () => {
    behaviour = { kind: "throw", error: new Error("connection terminated") };
    await closeOpenStageRuns("run-7", "boom");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(payload.type).toBe("funnel_stage_run_closure_failed");
    expect(payload.runId).toBe("run-7");
    expect(payload.error).toContain("connection terminated");
  });
});

describe("closeOpenStageRunsByWorkflowId", () => {
  it("only touches runs that are ALREADY terminal", () => {
    // The load-bearing assertion. This variant is keyed by workflow id because
    // the Temporal failure projection has no run id to hand. Without the
    // terminal-status subquery it could close the stage rows of a run that is
    // still executing under that workflow id — killing a live merge in the UI.
    void closeOpenStageRunsByWorkflowId("ObjectTypeFunnelWorkflow/o/rid:key", "boom");
    const sql = flat(calls[0].sql);
    expect(sql).toContain("SELECT run_id FROM funnel_run");
    expect(sql).toContain("WHERE temporal_workflow_id = $1");
    expect(sql).toContain("AND status IN ('completed', 'failed', 'cancelled')");
    // And it still restricts which stage rows it rewrites.
    expect(sql).toContain("sr.status IN ('pending', 'running')");
  });

  it("binds the workflow id, not a run id", async () => {
    await closeOpenStageRunsByWorkflowId("wf-abc", "run failed: heartbeat timeout");
    expect(calls[0].params[0]).toBe("wf-abc");
    expect(calls[0].params[1]).toBe("run failed: heartbeat timeout");
  });

  it("returns the closed-row count and swallows errors the same way", async () => {
    behaviour = { kind: "rows", count: 2 };
    await expect(closeOpenStageRunsByWorkflowId("wf-abc", "boom")).resolves.toBe(2);

    behaviour = { kind: "throw", error: new Error("nope") };
    await expect(closeOpenStageRunsByWorkflowId("wf-abc", "boom")).resolves.toBe(0);
    const payload = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(payload.temporalWorkflowId).toBe("wf-abc");
  });

  it("issues no query for an empty workflow id", async () => {
    await expect(closeOpenStageRunsByWorkflowId("", "boom")).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("every terminal writer is wired to a closure call", () => {
  // The module is only useful if it is actually CALLED. These assertions read
  // the four production sites that move a run to a terminal status; a fifth
  // writer added later without a closure call reintroduces the leak, and this
  // is the cheapest place to notice.
  const read = (rel: string) =>
    require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../", rel),
      "utf8",
    ) as string;

  it("durableWorkflow.runWorkflow closes stage rows on BOTH success and failure", () => {
    const src = read("src/services/funnel/durableWorkflow.ts");
    expect(src).toContain('from "./stageRunClosure"');
    // The confirmed leak was the catch branch, which updated funnel_run alone.
    expect(src.match(/closeOpenStageRuns\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("funnelStateProjection closes on the cancelled and failed projections", () => {
    const src = read("src/services/funnel/funnelStateProjection.ts");
    expect(src).toContain('from "./stageRunClosure"');
    expect(src).toContain("closeOpenStageRuns(");
    // The failed path knows a workflow id, not a run id.
    expect(src).toContain("closeOpenStageRunsByWorkflowId(");
  });

  it("the Temporal completion projection closes stages beyond completedPrevious", () => {
    // Its own update targets only `input.completedPrevious`; an earlier stage
    // whose projection was lost would otherwise stay open forever.
    const src = read("src/services/funnel/temporal/activities.ts");
    expect(src).toContain('from "../stageRunClosure"');
    expect(src).toContain("closeOpenStageRuns(");
  });
});
