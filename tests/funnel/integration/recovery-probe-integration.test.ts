// ---------------------------------------------------------------------------
// FUNN-ISO — OlivierOrder recovery reproduction test (live Postgres, PG
// dispatcher path).
//
// Reproduces the 2026-07-31 incident scenario at the projection+dispatcher
// layer: an object type with 746 backing rows must end at
// funnel_state = (indexed, 746) with per-stage evidence and a single
// environment identity — never "fully indexed funnel / 0 objects / stuck
// in Indexing".
//
// The test:
//   1. seeds an object type with 746 object_instances rows,
//   2. sends a funnel signal and drains it via the PG dispatcher
//      (Temporal is not connected inside the test process → PG path),
//   3. asserts the terminal projection reported the TOTAL count (746),
//      that all four stages committed, every run/env column is stamped,
//      and that no foreign-environment rows exist.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const STAMP = Date.now();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT = `RecoveryProbe${STAMP}`;
const N_ROWS = 746;
let OT_ID = "";
let ROOT_BRANCH = "";

let db: typeof import("../../../src/db");

beforeAll(async () => {
  process.env.TELLUS_ENVIRONMENT_ID = "tellus-dev";
  db = await import("../../../src/db");
  const guard = await import("../../../src/services/funnel/environmentGuard");
  await guard.sealDatabaseEnvironment({
    environmentId: "tellus-dev",
    temporalNamespace: "t", temporalTaskQueue: "q", temporalAddress: "x",
    workerBuildId: "test", mode: "local", workerIdentity: "t",
  });

  const ins = await db.query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     ON CONFLICT (ontology_id, api_name) DO NOTHING
     RETURNING object_type_id`,
    [ONTOLOGY_ID, OT, `Recovery Probe ${STAMP}`],
  );
  OT_ID = ins.rows[0]?.object_type_id as string;

  const br = await db.query(
    `SELECT branch_id FROM ontology_branch WHERE ontology_id = $1 AND name = 'main' LIMIT 1`,
    [ONTOLOGY_ID],
  );
  ROOT_BRANCH = br.rows[0]?.branch_id as string;

  const dsRes = await db.query(
    `SELECT mapping_id FROM backing_datasource WHERE object_type_id = $1`,
    [OT_ID],
  );

  // Seed 746 instance rows — the fixture mirrors OlivierOrder's CSV shape.
  await db.query(
    `INSERT INTO object_instances
       (ontology_id, branch_id, object_type_api_name, primary_key, properties,
        source_datasource_id, source_transaction_id)
     SELECT $1, $2, $3, 'row-' || g,
            jsonb_build_object('item_name', 'item-' || g, 'qty', g % 97),
            NULLIF($4, '')::uuid,
            '00000000-0000-0000-0000-000000000001'::uuid
       FROM generate_series(1, $5) g`,
    [ONTOLOGY_ID, ROOT_BRANCH, OT, dsRes.rows[0]?.mapping_id ?? "", N_ROWS],
  );
});

afterAll(async () => {
  await db.query(`DELETE FROM object_instances WHERE object_type_api_name = $1`, [OT]);
  await db.query(`DELETE FROM funnel_run WHERE object_type_api_name = $1`, [OT]);
  await db.query(`DELETE FROM funnel_signal WHERE object_type_api_name = $1`, [OT]);
  await db.query(`DELETE FROM funnel_state WHERE object_type_id = $1`, [OT_ID]);
  await db.query(`DELETE FROM object_type WHERE object_type_id = $1`, [OT_ID]);
  await db.pool.end();
});

describe("FUNN-ISO recovery reproduction (746 rows)", () => {
  it(
    "funnel pass over 746 rows ends at indexed/746 with full stage evidence and one env identity",
    { timeout: 120_000 },
    async () => {
      const { sendSignal } = await import("../../../src/services/funnel/durableWorkflow");
      const { drainPendingSignals } = await import("../../../src/services/funnel/funnelDispatcher");

      const signalId = await sendSignal({
        ontologyId: ONTOLOGY_ID,
        objectTypeApiName: OT,
        signalType: "editBatchPending",
      });
      expect(signalId).toBeTruthy();

      // In the test process Temporal is NOT connected → PG dispatcher path.
      const started = await drainPendingSignals({ objectTypes: [OT] });
      expect(started).toBeGreaterThanOrEqual(1);

      // Terminal: indexed with the TOTAL count.
      const fs1 = await db.query(
        `SELECT status, objects_indexed, environment_id, error_message
           FROM funnel_state WHERE object_type_id = $1`,
        [OT_ID],
      );
      expect(fs1.rows[0].status).toBe("indexed");
      expect(fs1.rows[0].objects_indexed).toBe(N_ROWS);
      expect(fs1.rows[0].environment_id).toBe("tellus-dev");
      expect(fs1.rows[0].error_message).toBeNull();

      // All 4 stages committed in ONE funnel_run with the dev identity.
      const runs = await db.query(
        `SELECT run_id, status, environment_id FROM funnel_run
          WHERE object_type_api_name = $1 ORDER BY started_at DESC`,
        [OT],
      );
      const pipelineRuns = runs.rows.filter(
        (r: { status: string }) => true,
      );
      expect(pipelineRuns.length).toBeGreaterThanOrEqual(1);
      expect(pipelineRuns.every((r: { environment_id: string }) => r.environment_id === "tellus-dev")).toBe(true);

      const stages = await db.query(
        `SELECT stage, status FROM funnel_stage_run WHERE run_id = $1`,
        [pipelineRuns[0].run_id],
      );
      const stageNames = stages.rows
        .filter((s: { status: string }) => s.status === "succeeded")
        .map((s: { stage: string }) => s.stage);
      for (const needed of ["changelog", "merge", "indexing", "hydration"]) {
        expect(stageNames).toContain(needed);
      }

      // No foreign-environment rows for this type at all.
      const foreign = await db.query(
        `SELECT count(*)::int AS n FROM funnel_run
          WHERE object_type_api_name = $1 AND environment_id <> 'tellus-dev'`,
        [OT],
      );
      expect(foreign.rows[0].n).toBe(0);

      // Signal consumed by a run (outbox drained).
      const sig = await db.query(
        `SELECT consumed_at, consumed_by_run_id FROM funnel_signal WHERE signal_id = $1`,
        [signalId],
      );
      expect(sig.rows[0].consumed_at).not.toBeNull();
      expect(sig.rows[0].consumed_by_run_id).not.toBeNull();
    },
  );
});
