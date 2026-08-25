// ---------------------------------------------------------------------------
// Pipeline-definition evolution — FUNN-ISO-4 (integration, lane PG).
//
// Proves: (a) runs keep the immutable plan they were dispatched under, so a
// "deployed v2" can never rewrite v1 completion criteria; (b) optional
// stages are represented explicitly; (c) unknown shapes fail closed;
// (d) duplicate stage completion stays idempotent; (e) dispatch stamping.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LANE } from "../../laneEnv";

const STAMP = Date.now();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT = `PlanEvo${STAMP}`;
let OT_ID = "";

let db: typeof import("../../../src/db");
let projection: typeof import("../../../src/services/funnel/funnelStateProjection");
let dispatcher: typeof import("../../../src/services/funnel/funnelDispatcher");
let planLib: typeof import("../../../src/services/funnel/executionPlan");

async function insertRun(apiName: string, plan: Record<string, unknown>): Promise<string> {
  const uniqueWf = `ObjectTypeFunnelWorkflow/${ONTOLOGY_ID}/${apiName}:sig-${Math.random().toString(36).slice(2)}`;
  const r = await db.query(
    `INSERT INTO funnel_run
       (ontology_id, object_type_api_name, workflow_type, status, environment_id, temporal_workflow_id,
        definition_version, execution_plan)
     VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'running', $3, $4, $5, $6::jsonb)
     RETURNING run_id`,
    [ONTOLOGY_ID, apiName, LANE.TELLUS_ENVIRONMENT_ID, uniqueWf,
     (plan.definitionVersion ?? 1) as number, JSON.stringify(plan)],
  );
  return r.rows[0].run_id as string;
}

async function insertStages(runId: string, stages: [string, string][], firstErrorStage?: string) {
  for (const [stage, status] of stages) {
    await db.query(
      `INSERT INTO funnel_stage_run (run_id, stage, status, attempt, started_at, finished_at)
       VALUES ($1, $2, $3, 1, now(), now())`,
      [runId, stage, status],
    );
  }
  void firstErrorStage;
}

beforeAll(async () => {
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({
    operation: "pipeline-evolution-fixture",
    skipApiProbe: true,
  });
  db = await import("../../../src/db");
  projection = await import("../../../src/services/funnel/funnelStateProjection");
  dispatcher = await import("../../../src/services/funnel/funnelDispatcher");
  planLib = await import("../../../src/services/funnel/executionPlan");
  const ins = await db.query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental') RETURNING object_type_id`,
    [ONTOLOGY_ID, OT, `Plan Evolution ${STAMP}`],
  );
  OT_ID = ins.rows[0].object_type_id;
});

afterAll(async () => {
  await db.query(`DELETE FROM object_type WHERE object_type_id = $1`, [OT_ID]);
  await db.pool.end();
});

describe("pipeline-definition evolution", () => {
  it("v1-dispatched run requires the full v1 stage set even after v2 exists in the registry", async () => {
    expect(planLib.PIPELINE_DEFINITION_V2.optionalStages).toContain("hydration");
    // v1 snapshot: full 4-stage requirement, hydration row deliberately missing.
    const runId = await insertRun(OT, JSON.parse(JSON.stringify(planLib.PIPELINE_DEFINITION_V1)));
    await insertStages(runId, [
      ["changelog", "succeeded"],
      ["merge", "succeeded"],
      ["indexing", "succeeded"],
      // hydration: missing
    ]);
    await expect(
      projection.projectFunnelTerminalToState(ONTOLOGY_ID, OT, "indexed", {
        runId,
        environmentId: LANE.TELLUS_ENVIRONMENT_ID,
      }),
    ).rejects.toThrow(/required stage/);
  });

  it("v2-dispatched run completes with hydration optional (conditionally dropped stage represented explicitly)", async () => {
    const runId = await insertRun(OT, JSON.parse(JSON.stringify(planLib.PIPELINE_DEFINITION_V2)));
    await insertStages(runId, [
      ["changelog", "succeeded"],
      ["merge", "succeeded"],
      ["indexing", "succeeded"],
    ]);
    await projection.projectFunnelTerminalToState(ONTOLOGY_ID, OT, "indexed", {
      runId,
      environmentId: LANE.TELLUS_ENVIRONMENT_ID,
    });
    const fs1 = await db.query(
      `SELECT status FROM funnel_state WHERE object_type_id = $1`, [OT_ID]);
    expect(fs1.rows[0].status).toBe("indexed");
  });

  it("unknown definition version fails closed", async () => {
    const runId = await insertRun(OT, {
      definitionVersion: 77,
      requiredStages: ["changelog"],
      optionalStages: [],
      stageDependencies: {},
    });
    await insertStages(runId, [["changelog", "succeeded"]]);
    await expect(
      projection.projectFunnelTerminalToState(ONTOLOGY_ID, OT, "indexed", {
        runId,
        environmentId: LANE.TELLUS_ENVIRONMENT_ID,
      }),
    ).rejects.toThrow(/not registered/);
    expect(() => planLib.getDefinition(77)).toThrow(/not registered/);
  });

  it("stage definitions not in the persisted plan fail closed (corrupt plan shape)", async () => {
    // The DB constraint prevents stage rows outside the run's plan from
    // ENTERING funnel_stage_run — so "unknown stage" surfaces through a
    // corrupt PLAN shape (a stage name missing from the registrar).
    const runId = await insertRun(OT, {
      definitionVersion: 1,
      requiredStages: ["stage_not_in_plan_model" as never],
      optionalStages: [],
      stageDependencies: {},
    });
    await insertStages(runId, [["changelog", "succeeded"]]);
    await expect(
      projection.projectFunnelTerminalToState(ONTOLOGY_ID, OT, "indexed", {
        runId,
        environmentId: LANE.TELLUS_ENVIRONMENT_ID,
      }),
    ).rejects.toThrow();
  });

  it("duplicate stage completion remains idempotent", async () => {
    const runId = await insertRun(OT, JSON.parse(JSON.stringify(planLib.PIPELINE_DEFINITION_V2)));
    await insertStages(runId, [
      ["changelog", "succeeded"],
      ["merge", "succeeded"],
      ["indexing", "succeeded"],
    ]);
    // Idempotent duplicate with attempt=2.
    await db.query(
      `INSERT INTO funnel_stage_run (run_id, stage, status, attempt, started_at, finished_at)
       VALUES ($1, 'changelog', 'succeeded', 2, now(), now())`,
      [runId],
    );
    await projection.projectFunnelTerminalToState(ONTOLOGY_ID, OT, "indexed", {
      runId,
      environmentId: LANE.TELLUS_ENVIRONMENT_ID,
    });
    const fs1 = await db.query(
      `SELECT status FROM funnel_state WHERE object_type_id = $1`, [OT_ID]);
    expect(fs1.rows[0].status).toBe("indexed");
  });

  it("dispatch stamps the immutable execution plan snapshot on the run row", async () => {
    const runId = await dispatcher.insertDispatchPendingRun(
      ONTOLOGY_ID, OT,
      `ObjectTypeFunnelWorkflow/${ONTOLOGY_ID}/dummy-stamp-test:sig-plan-stamp`,
      { stamp: true },
    );
    expect(runId).toBeTruthy();
    const r = await db.query(
      `SELECT definition_version, execution_plan FROM funnel_run WHERE run_id = $1`,
      [runId]);
    expect(r.rows[0].definition_version).toBe(planLib.CURRENT_DEFINITION_VERSION);
    const plan = r.rows[0].execution_plan;
    expect(plan.requiredStages).toEqual(planLib.currentDefinition().requiredStages);
    expect(plan.optionalStages).toEqual(planLib.currentDefinition().optionalStages);
    // Immutable: even if a future definition is deployed, this row's criteria
    // do not change with the module constant.
  });
});
