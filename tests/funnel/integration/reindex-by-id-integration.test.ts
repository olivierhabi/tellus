// ---------------------------------------------------------------------------
// /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId — integration
//
// Wire-level coverage of the UUID-keyed Save-to-Ontology endpoint
// family introduced in src/routes/reindexById.ts + src/server.ts:
//
//   POST /...                 — commit / emit editBatchPending signal
//   GET  /.../status          — pipeline status (via reindexRouter)
//   GET  /.../history         — paginated reindex history
//
// The UUID resolver middleware writes `res.locals.apiName`; these
// tests lock that the downstream handlers see the resolved apiName
// (status body.objectType matches what we created) and the error
// envelope is correct on the 404 path.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../../helpers/api";
import { query } from "../../../src/db";

const STAMP = Date.now();
const ONTOLOGY_ID = `55555555-aaaa-aaaa-aaaa-${STAMP.toString(16).padStart(12, "0").slice(-12)}`;
const OT_API_NAME = `ReindexByIdProbe${STAMP}`;
let OT_ID = "";

beforeAll(async () => {
  await query(
    `INSERT INTO ontology (ontology_id, display_name, description, created_by)
     VALUES ($1, $2, 'reindexById integration fixture', 'vitest')
     ON CONFLICT DO NOTHING`,
    [ONTOLOGY_ID, `ReindexById Fixture ${STAMP}`],
  );
  const ot = await query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     ON CONFLICT DO NOTHING
     RETURNING object_type_id`,
    [ONTOLOGY_ID, OT_API_NAME, `ReindexById Probe ${STAMP}`],
  );
  OT_ID = ot.rows[0]?.object_type_id as string;
});

afterAll(async () => {
  await query(`DELETE FROM funnel_signal WHERE object_type_api_name = $1`, [
    OT_API_NAME,
  ]);
  if (OT_ID) {
    await query(`DELETE FROM object_type WHERE object_type_id = $1`, [OT_ID]);
  }
  await query(`DELETE FROM ontology WHERE ontology_id = $1`, [ONTOLOGY_ID]);
});

describe("POST /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId", () => {
  it("returns 202 with {status:'accepted', signalId, ontologyId, objectTypeApiName}", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${ONTOLOGY_ID}/objectTypeId/${OT_ID}`,
    );
    expect(status).toBe(202);
    // The handler wraps via sendSuccess — body shape is flat JSON with
    // status/signalId/... at the top (no `.data` wrapper on the wire).
    expect(body.status ?? body.data?.status).toBe("accepted");
    const signalId = body.signalId ?? body.data?.signalId;
    expect(signalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.objectTypeApiName ?? body.data?.objectTypeApiName).toBe(
      OT_API_NAME,
    );
    expect(body.ontologyId ?? body.data?.ontologyId).toBe(ONTOLOGY_ID);

    // Durable queue — the signal must be in Postgres before the
    // response returned. Without that, a Temporal restart would
    // silently drop the save.
    const rows = await query(
      `SELECT signal_type FROM funnel_signal WHERE signal_id = $1`,
      [signalId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].signal_type).toBe("editBatchPending");
  });

  it("404s with OBJECT_TYPE_NOT_FOUND for a bogus objectTypeId UUID", async () => {
    const { status, body } = await api(
      "POST",
      `/api/v1/ontology/${ONTOLOGY_ID}/objectTypeId/00000000-0000-0000-0000-000000000000`,
    );
    expect(status).toBe(404);
    expect(body.error?.code ?? body.errorCode ?? body.error).toBe(
      "OBJECT_TYPE_NOT_FOUND",
    );
  });

  it("produces a fresh signalId on repeat commits (no deduplication at the HTTP layer)", async () => {
    const first = await api(
      "POST",
      `/api/v1/ontology/${ONTOLOGY_ID}/objectTypeId/${OT_ID}`,
    );
    const second = await api(
      "POST",
      `/api/v1/ontology/${ONTOLOGY_ID}/objectTypeId/${OT_ID}`,
    );
    const a = first.body.signalId ?? first.body.data?.signalId;
    const b = second.body.signalId ?? second.body.data?.signalId;
    expect(a).not.toBe(b);
  });
});

describe("GET /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId/status", () => {
  it("resolves the apiName via res.locals and surfaces it in the response body", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v1/ontology/${ONTOLOGY_ID}/objectTypeId/${OT_ID}/status`,
    );
    expect(status).toBe(200);
    // The reindexRouter's status handler echoes the resolved apiName
    // as `objectType`. If the middleware's res.locals write didn't
    // survive the layer hand-off, this would be undefined and the
    // handler would fail its own ontology/apiName lookup.
    expect(body.objectType ?? body.data?.objectType).toBe(OT_API_NAME);
  });

  it("404s with OBJECT_TYPE_NOT_FOUND for a bogus objectTypeId UUID", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v1/ontology/${ONTOLOGY_ID}/objectTypeId/00000000-0000-0000-0000-000000000000/status`,
    );
    expect(status).toBe(404);
    expect(body.error?.code ?? body.errorCode ?? body.error).toBe(
      "OBJECT_TYPE_NOT_FOUND",
    );
  });
});
