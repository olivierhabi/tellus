// ---------------------------------------------------------------------------
// FUNN-ISO — split-brain integration test (live Postgres).
//
// Proves the failure class that wedged OlivierOrder on 2026-07-31 can no
// longer occur:
//
//   NEGATIVE: an activity carrying a FOREIGN environment context is
//   rejected by the fence with FunnelExecutionEnvironmentMismatch
//   (never a successful no-op) — the exact pre-fix behavior that silently
//   completed against the wrong database.
//
//   POSITIVE: a correctly-identified run (lane env ⌢ lane DB seal ⌢ lane
//   namespace queue) reaches terminal 'indexed' and records per-stage
//   evidence.
//
//   FAIL-CLOSED: projecting 'indexed' for a run missing stage rows is
//   rejected (FunnelStaleStateTransition) — no green runs without evidence.
//
// Requires: the isolated test lane (FUNN-ISO-1) — lane Postgres
// (PGDATABASE=tellus_tests) with main migrations applied. Uses the canonical
// singleton ontology. Fixtures are apiName-stamped and cleaned up on
// teardown; the database SEAL agrees with the lane identity (the lane DB
// stays sealed as tellus-tests-main).
// ---------------------------------------------------------------------------

// LANE import must be first: its side effect pins the lane identity into
// process.env before any src module reads configuration.
import { LANE } from "../../laneEnv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const STAMP = Date.now();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT = `IsoProbe${STAMP}`;
const FOREIGN_OT = `IsoForeign${STAMP}`;
let OT_ID = "";
let FOREIGN_ID = "";

let db: typeof import("../../../src/db");
let guard: typeof import("../../../src/services/funnel/environmentGuard");
let projection: typeof import("../../../src/services/funnel/funnelStateProjection");

beforeAll(async () => {
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({
    operation: "environment-isolation-fixture",
    skipApiProbe: true,
  });
  process.env.TELLUS_ENVIRONMENT_ID = LANE.TELLUS_ENVIRONMENT_ID;
  db = await import("../../../src/db");
  guard = await import("../../../src/services/funnel/environmentGuard");
  projection = await import("../../../src/services/funnel/funnelStateProjection");

  await guard.sealDatabaseEnvironment({
    environmentId: LANE.TELLUS_ENVIRONMENT_ID,
    temporalNamespace: LANE.TEMPORAL_NAMESPACE,
    temporalTaskQueue: "q",
    temporalAddress: "x",
    workerBuildId: "test",
    mode: "local",
    workerIdentity: "t",
  });

  const ins = await db.query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     ON CONFLICT (ontology_id, api_name) DO NOTHING
     RETURNING object_type_id`,
    [ONTOLOGY_ID, OT, `Iso Probe ${STAMP}`],
  );
  OT_ID = ins.rows[0]?.object_type_id as string;
  const ins2 = await db.query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     ON CONFLICT (ontology_id, api_name) DO NOTHING
     RETURNING object_type_id`,
    [ONTOLOGY_ID, FOREIGN_OT, `Iso Foreign ${STAMP}`],
  );
  FOREIGN_ID = ins2.rows[0]?.object_type_id as string;

  await db.query(`DELETE FROM funnel_run WHERE object_type_api_name IN ($1, $2)`, [OT, FOREIGN_OT]);
  await db.query(`DELETE FROM funnel_state WHERE object_type_id IN ($1, $2)`, [OT_ID, FOREIGN_ID]);
});

afterAll(async () => {
  await db.query(`DELETE FROM funnel_run WHERE object_type_api_name IN ($1, $2)`, [OT, FOREIGN_OT]);
  await db.query(`DELETE FROM funnel_state WHERE object_type_id IN ($1, $2)`, [OT_ID, FOREIGN_ID]);
  await db.query(`DELETE FROM object_type WHERE object_type_id IN ($1, $2)`, [OT_ID, FOREIGN_ID]);
  await db.pool.end();
});

describe("FUNN-ISO split-brain prevention (integration)", () => {
  it("NEGATIVE: foreign-environment context is rejected by the fence", async () => {
    await expect(
      guard.fenceExecutionContext({ environmentId: "some-other-environment" }),
    ).rejects.toMatchObject({
      name: "FunnelExecutionEnvironmentMismatch",
      source: "context_vs_worker",
      expected: LANE.TELLUS_ENVIRONMENT_ID,
      actual: "some-other-environment",
    });
  });

  it("NEGATIVE: missing context env id is rejected (pre-FUNN-ISO callers can't slip through)", async () => {
    await expect(guard.fenceExecutionContext({})).rejects.toMatchObject({
      name: "FunnelExecutionEnvironmentMismatch",
      actual: "<missing>",
    });
  });

  it("POSITIVE: own environment passes the fence and returns the db seal", async () => {
    const out = await guard.fenceExecutionContext({ environmentId: LANE.TELLUS_ENVIRONMENT_ID });
    expect(out.dbEnvironmentId).toBe(LANE.TELLUS_ENVIRONMENT_ID);
  });

  it("FAIL-CLOSED: 'indexed' projection without stage evidence is rejected", async () => {
    // Create a run with all stage rows missing (simulates the phantom rows
    // the verify worker wrote during the incident).
    const run = await db.query(
      `INSERT INTO funnel_run (ontology_id, object_type_api_name, workflow_type, status, environment_id)
       VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'running', '${LANE.TELLUS_ENVIRONMENT_ID}')
       RETURNING run_id, started_at`,
      [ONTOLOGY_ID, FOREIGN_OT],
    );
    const runId = run.rows[0].run_id as string;

    await expect(
      projection.projectFunnelTerminalToState(ONTOLOGY_ID, FOREIGN_OT, "indexed", {
        runId,
        environmentId: LANE.TELLUS_ENVIRONMENT_ID,
        allowObjectTypeDeletedMarking: true,
      }),
    ).rejects.toThrow(/required stage/);

    // The funnel_state must NOT have flipped to indexed.
    const fs1 = await db.query(
      `SELECT status FROM funnel_state WHERE object_type_id = $1`,
      [FOREIGN_ID],
    );
    expect(fs1.rows.length === 0 || fs1.rows[0].status !== "indexed").toBe(true);
  });

  it("FAIL-CLOSED: missing object type marks the run object_type_deleted, not 'indexed'", async () => {
    const run = await db.query(
      `INSERT INTO funnel_run (ontology_id, object_type_api_name, workflow_type, status, environment_id)
       VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'running', '${LANE.TELLUS_ENVIRONMENT_ID}')
       RETURNING run_id`,
      [ONTOLOGY_ID, `Ghost${STAMP}`],
    );
    const runId = run.rows[0].run_id as string;

    await projection.projectFunnelTerminalToState(ONTOLOGY_ID, `Ghost${STAMP}`, "indexed", {
      runId,
      environmentId: LANE.TELLUS_ENVIRONMENT_ID,
      allowObjectTypeDeletedMarking: true,
    });

    const after = await db.query(
      `SELECT status, error_message FROM funnel_run WHERE run_id = $1`,
      [runId],
    );
    expect(after.rows[0].status).toBe("cancelled");
    expect(after.rows[0].error_message).toMatch(/object_type_deleted/);
  });

  it("CAS: a stale run cannot overwrite a newer run's terminal state", async () => {
    const old = await db.query(
      `INSERT INTO funnel_run (ontology_id, object_type_api_name, workflow_type, status, environment_id, started_at)
       VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'completed', '${LANE.TELLUS_ENVIRONMENT_ID}', now() - interval '10 minutes')
       RETURNING run_id`,
      [ONTOLOGY_ID, OT],
    );
    const fresh = await db.query(
      `INSERT INTO funnel_run (ontology_id, object_type_api_name, workflow_type, status, environment_id, started_at)
       VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'completed', '${LANE.TELLUS_ENVIRONMENT_ID}', now())
       RETURNING run_id`,
      [ONTOLOGY_ID, OT],
    );
    // Give both legitimate stage evidence.
    for (const rid of [old.rows[0].run_id, fresh.rows[0].run_id]) {
      for (const stage of ["changelog", "merge", "indexing", "hydration"]) {
        await db.query(
          `INSERT INTO funnel_stage_run (run_id, stage, status, attempt, started_at, finished_at)
           VALUES ($1, $2, 'succeeded', 1, now(), now())`,
          [rid, stage],
        );
      }
    }

    // Fresh run indexes first.
    await projection.projectFunnelTerminalToState(ONTOLOGY_ID, OT, "indexed", {
      runId: fresh.rows[0].run_id,
      objectsIndexed: 5,
      environmentId: LANE.TELLUS_ENVIRONMENT_ID,
    });
    // Older run's terminal projection must NOT demote the newer badge.
    await projection.projectFunnelTerminalToState(ONTOLOGY_ID, OT, "indexed", {
      runId: old.rows[0].run_id,
      objectsIndexed: 3,
      environmentId: LANE.TELLUS_ENVIRONMENT_ID,
    });

    const fs1 = await db.query(
      `SELECT status, objects_indexed, active_run_id FROM funnel_state WHERE object_type_id = $1`,
      [OT_ID],
    );
    expect(fs1.rows[0].status).toBe("indexed");
    expect(String(fs1.rows[0].active_run_id)).toBe(String(fresh.rows[0].run_id));
  });

  it("POSITIVE: full legitimate run reaches indexed with stage evidence", async () => {
    const run = await db.query(
      `INSERT INTO funnel_run (ontology_id, object_type_api_name, workflow_type, status, environment_id)
       VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'running', '${LANE.TELLUS_ENVIRONMENT_ID}')
       RETURNING run_id`,
      [ONTOLOGY_ID, FOREIGN_OT],
    );
    const runId = run.rows[0].run_id as string;
    for (const stage of ["changelog", "merge", "indexing", "hydration"]) {
      await db.query(
        `INSERT INTO funnel_stage_run (run_id, stage, status, attempt, started_at, finished_at)
         VALUES ($1, $2, 'succeeded', 1, now(), now())`,
        [runId, stage],
      );
    }
    await projection.projectFunnelTerminalToState(ONTOLOGY_ID, FOREIGN_OT, "indexed", {
      runId,
      objectsIndexed: 746,
      environmentId: LANE.TELLUS_ENVIRONMENT_ID,
    });
    const fs1 = await db.query(
      `SELECT status, objects_indexed FROM funnel_state WHERE object_type_id = $1`,
      [FOREIGN_ID],
    );
    expect(fs1.rows[0].status).toBe("indexed");
    // objects_indexed is the TOTAL from object_instances; fixture has none.
    expect(fs1.rows[0].objects_indexed).toBe(0);
  });
});
