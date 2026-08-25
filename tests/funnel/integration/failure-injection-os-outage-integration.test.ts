// Failure-injection #12 — OpenSearch catastrophically unreachable.
//
// The endpoint is overridden at module-LOAD time in this file (every
// vitest file gets an isolated process). The real OpenSearch-sync activity
// must throw against the dead port; the workflow's real failure projector
// must then terminate the run as failed, never false-green indexed.
import "dotenv/config";

process.env.OPENSEARCH_URL = "http://127.0.0.1:9"; // UNREACHABLE
process.env.OPENSEARCH_REQUEST_TIMEOUT = "1000";
process.env.OPENSEARCH_MAX_RETRIES = "1";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LANE } from "../../laneEnv";

const STAMP = Date.now();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT = `OsOutage${STAMP}`;
let OT_ID = "";

let db: typeof import("../../../src/db");
let dispatcher: typeof import("../../../src/services/funnel/funnelDispatcher");

beforeAll(async () => {
  // setupFiles may have loaded the OpenSearch singleton before this test
  // module set the dead endpoint. Reset the module graph so the dispatcher
  // below constructs its client from 127.0.0.1:9, not the healthy lane URL.
  vi.resetModules();
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({
    operation: "os-outage-fixture-cleanup",
    skipApiProbe: true,
  });
  db = await import("../../../src/db");
  dispatcher = await import("../../../src/services/funnel/funnelDispatcher");
  const ins = await db.query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     ON CONFLICT (ontology_id, api_name) DO NOTHING RETURNING object_type_id`,
    [ONTOLOGY_ID, OT, `OS Outage ${STAMP}`],
  );
  OT_ID = ins.rows[0]?.object_type_id as string;
  const pk = await db.query(
    `INSERT INTO property (object_type_id, api_name, display_name, base_type, is_required, ordinal)
     VALUES ($1, 'pk', 'PK', 'string', true, 0) RETURNING property_id`,
    [OT_ID],
  );
  await db.query(
    `UPDATE object_type SET primary_key_property_id = $1 WHERE object_type_id = $2`,
    [pk.rows[0].property_id, OT_ID],
  );
  // One content slice so the indexing stage has work to attempt.
  const br = await db.query(
    `SELECT branch_id FROM ontology_branch WHERE ontology_id = $1 AND name = 'main'`,
    [ONTOLOGY_ID],
  );
  await db.query(
    `INSERT INTO ontology_edit (ontology_id, object_type_api_name, primary_key, operation, property_values, link_edits, executed_by, branch_id)
     VALUES ($1, $2, 'row-1', 'update', '{}', '[]', 'test', $3)`,
    [ONTOLOGY_ID, OT, br.rows[0].branch_id],
  );
});

afterAll(async () => {
  await db.pool.end();
});

describe("failure-injection #12 — OS outage", () => {
  it("dead OpenSearch endpoint: sync throws and the run projects 'failed', never 'indexed'", async () => {
    const client = await db.pool.connect();
    try {
      const r = await client.query(
        `INSERT INTO funnel_signal (ontology_id, object_type_api_name, signal_type, payload)
         VALUES ($1, $2, 'sourceTransactionCommitted', '{}') RETURNING signal_id`,
        [ONTOLOGY_ID, OT],
      );
      void r;
    } finally { client.release(); }
    // Build the merged/object_instances fixture through the real PG pipeline.
    // That legacy dispatcher does not own OpenSearch sync; the Temporal
    // sync activity below is the injected boundary under test.
    await dispatcher.drainPendingSignals({ objectTypes: [OT] });
    const instances = await db.query(
      `SELECT count(*)::int AS n FROM object_instances WHERE object_type_api_name = $1`,
      [OT],
    );
    expect(instances.rows[0].n).toBe(1);
    await db.query(`DELETE FROM funnel_stage_run WHERE run_id IN (SELECT run_id FROM funnel_run WHERE object_type_api_name = $1)`, [OT]);
    await db.query(`DELETE FROM funnel_run WHERE object_type_api_name = $1`, [OT]);
    await db.query(`DELETE FROM funnel_signal WHERE object_type_api_name = $1`, [OT]);
    await db.query(`DELETE FROM funnel_state WHERE object_type_id = $1`, [OT_ID]);

    const runKey = `os-outage-${STAMP}`;
    const temporalWorkflowId = `ObjectTypeFunnelWorkflow/${ONTOLOGY_ID}/${OT_ID}:${runKey}`;
    const inserted = await db.query(
      `INSERT INTO funnel_run
         (ontology_id, object_type_api_name, workflow_type, status, environment_id,
          temporal_workflow_id, definition_version, execution_plan)
       VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'running', $3, $4, 1,
               '{"definitionVersion":1,"requiredStages":["changelog","merge","indexing","hydration"],"optionalStages":[],"stageDependencies":{}}')
       RETURNING run_id`,
      [ONTOLOGY_ID, OT, LANE.TELLUS_ENVIRONMENT_ID, temporalWorkflowId],
    );
    const runId = inserted.rows[0].run_id as string;
    const activities = await import("../../../src/services/funnel/temporal/activities");
    await expect(activities.syncOpenSearchActivity({
      ontologyId: ONTOLOGY_ID,
      objectTypeApiName: OT,
      objectTypeRid: OT_ID,
      environmentId: LANE.TELLUS_ENVIRONMENT_ID,
    })).rejects.toThrow(/connect|ECONNREFUSED/i);

    const intermediate = await db.query(`SELECT status FROM funnel_run WHERE run_id = $1`, [runId]);
    expect(intermediate.rows[0].status).toBe("running");
    const preTerminalState = await db.query(`SELECT count(*)::int AS n FROM funnel_state WHERE object_type_id = $1`, [OT_ID]);
    expect(preTerminalState.rows[0].n).toBe(0);

    await activities.projectFunnelTerminalActivity({
      ontologyId: ONTOLOGY_ID,
      objectTypeApiName: OT,
      objectTypeRid: OT_ID,
      environmentId: LANE.TELLUS_ENVIRONMENT_ID,
      status: "failed",
      errorMessage: "OpenSearch endpoint unreachable",
      funnelRunId: runId,
      runKey,
    });
    const finalRun = await db.query(`SELECT status, error_message FROM funnel_run WHERE run_id = $1`, [runId]);
    const finalState = await db.query(`SELECT status, error_message FROM funnel_state WHERE object_type_id = $1`, [OT_ID]);
    expect(finalRun.rows[0].status).toBe("failed");
    expect(finalRun.rows[0].error_message).toMatch(/OpenSearch endpoint unreachable/);
    expect(finalState.rows[0].status).toBe("failed");
    expect(finalState.rows[0].status).not.toBe("indexed");
  });
});
