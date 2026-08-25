// ---------------------------------------------------------------------------
// /api/v1/funnel/runs/* — integration
//
// Covers BOTH URL shapes:
//   GET /api/v1/funnel/runs/:objectType              (legacy apiName)
//   GET /api/v1/funnel/runs/objectTypeId/:uuid       (UUID, preferred)
//
// Both must return the same payload shape, filter out
// `temporal_handoff` rows (a pre-existing invariant to prevent UI
// flash-green on signal dispatch), and clamp `?limit=N` correctly.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../../helpers/api";
import { query } from "../../../src/db";

const STAMP = Date.now();
// Singleton-ontology adaptation: the deployment has ONE canonical ontology
// (uq_ontology_singleton) whose id is fixed. POST/DELETE/IMPORT on /ontology
// are frozen (-> 409), and any ontology id collapses to the canonical. So we
// reuse the canonical ontology instead of inserting/deleting our own.
const ONTOLOGY_ID = `00000000-0000-0000-0000-000000000001`;
const OT_API_NAME = `RunsProbe${STAMP}`;
let OT_ID = "";
let REAL_RUN_ID = "";
let HANDOFF_RUN_ID = "";

beforeAll(async () => {
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({
    operation: "funnel-runs-fixture-cleanup",
    skipApiProbe: true,
  });
  // Singleton-ontology: do NOT insert into ontology (uq_ontology_singleton).
  // The canonical ontology row already exists; just insert our own
  // object_type fixture (FK satisfied by the canonical ontology_id).
  const ot = await query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     ON CONFLICT DO NOTHING
     RETURNING object_type_id`,
    [ONTOLOGY_ID, OT_API_NAME, `Runs Probe ${STAMP}`],
  );
  OT_ID = ot.rows[0]?.object_type_id as string;

  // Seed two synthetic runs so the endpoint has something non-trivial
  // to return: one REAL workflow run (surfaced to clients), one
  // `temporal_handoff` bookkeeping row (must be filtered out).
  const real = await query(
    `INSERT INTO funnel_run
       (ontology_id, object_type_api_name, workflow_type, status, started_at)
     VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'completed', now())
     RETURNING run_id`,
    [ONTOLOGY_ID, OT_API_NAME],
  );
  REAL_RUN_ID = real.rows[0].run_id;

  const handoff = await query(
    `INSERT INTO funnel_run
       (ontology_id, object_type_api_name, workflow_type, status, started_at, completed_at)
     VALUES ($1, $2, 'temporal_handoff', 'completed', now(), now())
     RETURNING run_id`,
    [ONTOLOGY_ID, OT_API_NAME],
  );
  HANDOFF_RUN_ID = handoff.rows[0].run_id;
});

afterAll(async () => {
  await query(
    `DELETE FROM funnel_stage_run WHERE run_id = ANY($1::uuid[])`,
    [[REAL_RUN_ID, HANDOFF_RUN_ID].filter(Boolean)],
  );
  await query(`DELETE FROM funnel_run WHERE object_type_api_name = $1`, [
    OT_API_NAME,
  ]);
  if (OT_ID) {
    await query(`DELETE FROM object_type WHERE object_type_id = $1`, [OT_ID]);
  }
  // Singleton-ontology: do NOT delete from ontology — that would remove the
  // shared canonical ontology row. Only the test's own fixture rows above are
  // torn down (funnel_stage_run, funnel_run, object_type).
});

describe("GET /api/v1/funnel/runs/:objectType (legacy apiName)", () => {
  it("returns real runs and filters out temporal_handoff rows", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v1/funnel/runs/${encodeURIComponent(OT_API_NAME)}?limit=10`,
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.runs)).toBe(true);
    expect(Array.isArray(body.stages)).toBe(true);

    const runIds = body.runs.map((r: { run_id: string }) => r.run_id);
    expect(runIds).toContain(REAL_RUN_ID);
    expect(
      runIds,
      "temporal_handoff rows must NOT leak into /runs",
    ).not.toContain(HANDOFF_RUN_ID);
  });

  it("returns an empty runs array (not 404) for an unknown apiName", async () => {
    const { status, body } = await api(
      "GET",
      "/api/v1/funnel/runs/NoSuchApiName_xyz123?limit=1",
    );
    expect(status).toBe(200);
    expect(body.runs).toEqual([]);
  });

  it("clamps an out-of-range limit to 100", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v1/funnel/runs/${encodeURIComponent(OT_API_NAME)}?limit=9999`,
    );
    expect(status).toBe(200);
    expect(body.runs.length).toBeLessThanOrEqual(100);
  });
});

describe("GET /api/v1/funnel/runs/objectTypeId/:uuid (preferred)", () => {
  it("resolves UUID → apiName and returns the same shape", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v1/funnel/runs/objectTypeId/${OT_ID}?limit=10`,
    );
    expect(status).toBe(200);
    const runIds = body.runs.map((r: { run_id: string }) => r.run_id);
    expect(runIds).toContain(REAL_RUN_ID);
    expect(runIds).not.toContain(HANDOFF_RUN_ID);
  });

  it("404s with OBJECT_TYPE_NOT_FOUND for a bogus UUID", async () => {
    const { status, body } = await api(
      "GET",
      "/api/v1/funnel/runs/objectTypeId/00000000-0000-0000-0000-000000000000?limit=1",
    );
    expect(status).toBe(404);
    expect(body.error).toBe("OBJECT_TYPE_NOT_FOUND");
  });
});
