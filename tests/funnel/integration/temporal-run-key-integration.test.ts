// ---------------------------------------------------------------------------
// projectStageToPostgres — runKey integration test
//
// Locks the correctness fix that makes "Save to ontology" re-index from
// scratch on repeat clicks. The parent Temporal workflow is long-lived
// and handles many signals; without the per-signal `runKey` suffix,
// every call to `projectStageToPostgres` upserts the SAME funnel_run
// row via its ON CONFLICT (temporal_workflow_id) clause and the UI
// sees no new run on a repeat save.
//
// This test exercises the activity directly against a real Postgres,
// bypassing Temporal entirely (the activity falls back to a
// `non-temporal-${apiName}` base workflowId when `@temporalio/activity`
// isn't initialised — see the activity's try/catch around Context.current()).
//
// The three contracts verified here:
//
//   1. Same runKey, two different stages → UPSERT into the same run_id.
//   2. Different runKeys on the same object type → TWO distinct run_ids.
//   3. runKey omitted → legacy workflow-scoped behaviour still holds
//      (preserves back-compat with any non-Temporal caller that
//      imports these activities).
//
// Requires: Postgres running at the configured DB URL. Uses the
// shared `query` helper so it participates in the same migrations
// the app boots against. Cleans up its fixture on teardown.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "../../../src/db";
import { projectStageToPostgres } from "../../../src/services/funnel/temporal/activities";

const STAMP = Date.now();
// Singleton-ontology adaptation: the deployment uses a single canonical
// enterprise ontology whose id is fixed (uq_ontology_singleton). We must
// NOT INSERT/DELETE ontology rows; object_type fixtures reference the
// canonical ontology_id for FK integrity instead.
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OBJECT_TYPE_API_NAME = `RunKeyProbe${STAMP}`;
let OBJECT_TYPE_ID = "";

beforeAll(async () => {
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({
    operation: "temporal-run-key-fixture-cleanup",
    skipApiProbe: true,
  });
  // Singleton-ontology adaptation: the canonical ontology already exists,
  // so we only insert our object_type fixture (FK satisfied by canonical).
  // `projectStageToPostgres` only needs a matching object_type_api_name to
  // INSERT/UPDATE funnel_run rows.
  const inserted = await query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     ON CONFLICT (ontology_id, api_name) DO NOTHING
     RETURNING object_type_id`,
    [ONTOLOGY_ID, OBJECT_TYPE_API_NAME, `RunKey Probe ${STAMP}`]
  );
  OBJECT_TYPE_ID = inserted.rows[0]?.object_type_id as string;

  // Clear any prior funnel_run rows for this object type so the
  // assertions count only rows created by this test.
  await query(
    `DELETE FROM funnel_run WHERE object_type_api_name = $1`,
    [OBJECT_TYPE_API_NAME]
  );
});

afterAll(async () => {
  // Ordering: funnel_stage_run is FK'd to funnel_run → delete stage
  // rows first. object_type_active_index_version might also carry a
  // row if the test touched replacement — clean both defensively.
  // Singleton-ontology adaptation: NEVER DELETE FROM ontology (would
  // remove the canonical singleton row); only clean this test's own
  // fixture rows below.
  await query(
    `DELETE FROM funnel_stage_run WHERE run_id IN
       (SELECT run_id FROM funnel_run WHERE object_type_api_name = $1)`,
    [OBJECT_TYPE_API_NAME]
  );
  await query(
    `DELETE FROM funnel_run WHERE object_type_api_name = $1`,
    [OBJECT_TYPE_API_NAME]
  );
  await query(
    `DELETE FROM object_type_active_index_version WHERE object_type_api_name = $1`,
    [OBJECT_TYPE_API_NAME]
  );
  if (OBJECT_TYPE_ID) {
    await query(`DELETE FROM object_type WHERE object_type_id = $1`, [OBJECT_TYPE_ID]);
  }
});

async function runsForProbe(): Promise<
  Array<{
    run_id: string;
    current_stage: string | null;
    status: string;
    temporal_workflow_id: string | null;
  }>
> {
  const res = await query(
    `SELECT run_id, current_stage, status, temporal_workflow_id
       FROM funnel_run
      WHERE object_type_api_name = $1
      ORDER BY started_at ASC`,
    [OBJECT_TYPE_API_NAME]
  );
  return res.rows;
}

describe("projectStageToPostgres — runKey scoping", () => {
  it("reuses the same run_id when runKey is stable across stage transitions", async () => {
    const runKey = `same-sig-${STAMP}`;

    // changelog → merge → indexing → hydration → done, same runKey throughout.
    for (const currentStage of ["changelog", "merge", "indexing", "hydration"] as const) {
      await projectStageToPostgres({
        ontologyId: ONTOLOGY_ID,
        objectTypeApiName: OBJECT_TYPE_API_NAME,
        currentStage,
        runKey,
      });
    }
    await projectStageToPostgres({
      ontologyId: ONTOLOGY_ID,
      objectTypeApiName: OBJECT_TYPE_API_NAME,
      currentStage: null,
      completedPrevious: "hydration",
      runKey,
    });

    const runs = await runsForProbe();
    // Exactly one run_id should exist for this runKey. If the ON
    // CONFLICT clause didn't collapse to the same row, we'd see 4 or
    // 5 rows here.
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].current_stage).toBeNull();
    // The composite key stores the runKey suffix.
    expect(runs[0].temporal_workflow_id).toContain(runKey);
  });

  it("creates a FRESH run_id when the runKey changes (repeat-save contract)", async () => {
    // Clear from the first test so counts are unambiguous.
    await query(
      `DELETE FROM funnel_stage_run WHERE run_id IN
         (SELECT run_id FROM funnel_run WHERE object_type_api_name = $1)`,
      [OBJECT_TYPE_API_NAME]
    );
    await query(`DELETE FROM funnel_run WHERE object_type_api_name = $1`, [
      OBJECT_TYPE_API_NAME,
    ]);

    const runKeyA = `sigA-${STAMP}`;
    const runKeyB = `sigB-${STAMP}`;

    // Simulate run A (full pipeline with runKey A).
    for (const currentStage of ["changelog", "merge", "indexing", "hydration"] as const) {
      await projectStageToPostgres({
        ontologyId: ONTOLOGY_ID,
        objectTypeApiName: OBJECT_TYPE_API_NAME,
        currentStage,
        runKey: runKeyA,
      });
    }
    await projectStageToPostgres({
      ontologyId: ONTOLOGY_ID,
      objectTypeApiName: OBJECT_TYPE_API_NAME,
      currentStage: null,
      completedPrevious: "hydration",
      runKey: runKeyA,
    });

    // Simulate run B (distinct runKey → distinct row).
    await projectStageToPostgres({
      ontologyId: ONTOLOGY_ID,
      objectTypeApiName: OBJECT_TYPE_API_NAME,
      currentStage: "changelog",
      runKey: runKeyB,
    });

    const runs = await runsForProbe();
    expect(runs.length).toBeGreaterThanOrEqual(2);

    // Identify the two rows.
    const rowA = runs.find((r) => r.temporal_workflow_id?.includes(runKeyA));
    const rowB = runs.find((r) => r.temporal_workflow_id?.includes(runKeyB));
    expect(rowA, "run A row must exist").toBeDefined();
    expect(rowB, "run B row must exist").toBeDefined();
    expect(rowA!.run_id).not.toBe(rowB!.run_id);

    // Run A completed, run B is still on changelog (running).
    expect(rowA!.status).toBe("completed");
    expect(rowB!.status).toBe("running");
    expect(rowB!.current_stage).toBe("changelog");
  });

  it("falls back to workflow-scoped behaviour when runKey is omitted (back-compat)", async () => {
    // Clear again.
    await query(
      `DELETE FROM funnel_stage_run WHERE run_id IN
         (SELECT run_id FROM funnel_run WHERE object_type_api_name = $1)`,
      [OBJECT_TYPE_API_NAME]
    );
    await query(`DELETE FROM funnel_run WHERE object_type_api_name = $1`, [
      OBJECT_TYPE_API_NAME,
    ]);

    // Two calls without runKey → must share the same workflowId →
    // upsert into the same row. This preserves the behaviour any
    // non-Temporal caller relied on before the runKey parameter was
    // introduced.
    await projectStageToPostgres({
      ontologyId: ONTOLOGY_ID,
      objectTypeApiName: OBJECT_TYPE_API_NAME,
      currentStage: "changelog",
    });
    await projectStageToPostgres({
      ontologyId: ONTOLOGY_ID,
      objectTypeApiName: OBJECT_TYPE_API_NAME,
      currentStage: "merge",
      completedPrevious: "changelog",
    });

    const runs = await runsForProbe();
    expect(runs).toHaveLength(1);
    expect(runs[0].temporal_workflow_id).toBe(
      `non-temporal-${OBJECT_TYPE_API_NAME}`
    );
    expect(runs[0].current_stage).toBe("merge");
  });
});
