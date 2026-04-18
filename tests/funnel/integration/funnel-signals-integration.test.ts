// ---------------------------------------------------------------------------
// /api/v1/funnel/signals + /drain — integration
//
// Locks the HTTP contract of the durable signal queue. Needs only the
// running API (port 3000) + Postgres. Does NOT require Temporal; with
// Temporal down the handler still returns `temporal: false` and writes
// to `funnel_signal` so the dispatcher picks it up.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../../helpers/api";
import { query } from "../../../src/db";

const STAMP = Date.now();
const ONTOLOGY_ID = `22222222-aaaa-aaaa-aaaa-${STAMP.toString(16).padStart(12, "0").slice(-12)}`;
const OT_API_NAME = `SignalsProbe${STAMP}`;
let OT_ID = "";

beforeAll(async () => {
  await query(
    `INSERT INTO ontology (ontology_id, display_name, description, created_by)
     VALUES ($1, $2, 'signals integration fixture', 'vitest')
     ON CONFLICT DO NOTHING`,
    [ONTOLOGY_ID, `Signals Fixture ${STAMP}`],
  );
  const res = await query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     ON CONFLICT DO NOTHING
     RETURNING object_type_id`,
    [ONTOLOGY_ID, OT_API_NAME, `Signals Probe ${STAMP}`],
  );
  OT_ID = res.rows[0]?.object_type_id as string;
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

describe("POST /api/v1/funnel/signals", () => {
  it("rejects a request missing objectTypeApiName", async () => {
    const { status, body } = await api("POST", "/api/v1/funnel/signals", {
      signalType: "editBatchPending",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("BAD_REQUEST");
  });

  it("rejects a request missing signalType", async () => {
    const { status, body } = await api("POST", "/api/v1/funnel/signals", {
      objectTypeApiName: OT_API_NAME,
    });
    expect(status).toBe(400);
    expect(body.error).toBe("BAD_REQUEST");
  });

  it("404s when ontologyId is omitted and the apiName doesn't resolve", async () => {
    const { status, body } = await api("POST", "/api/v1/funnel/signals", {
      objectTypeApiName: "NoSuchObjectTypeEverDefined_xyz123",
      signalType: "editBatchPending",
    });
    expect(status).toBe(404);
    expect(body.error).toBe("OBJECT_TYPE_NOT_FOUND");
  });

  it("accepts a well-formed signal and returns 202 with a UUID signalId", async () => {
    const { status, body } = await api("POST", "/api/v1/funnel/signals", {
      ontologyId: ONTOLOGY_ID,
      objectTypeApiName: OT_API_NAME,
      signalType: "editBatchPending",
    });
    expect(status).toBe(202);
    expect(body.signalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.temporal).toBe("boolean");

    // Durable — the row must be in funnel_signal before the handler replied.
    const rows = await query(
      `SELECT signal_id, signal_type FROM funnel_signal WHERE signal_id = $1`,
      [body.signalId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].signal_type).toBe("editBatchPending");
  });

  it("auto-resolves ontologyId when only apiName is supplied", async () => {
    const { status, body } = await api("POST", "/api/v1/funnel/signals", {
      objectTypeApiName: OT_API_NAME,
      signalType: "sourceTransactionCommitted",
    });
    expect(status).toBe(202);
    const rows = await query(
      `SELECT ontology_id FROM funnel_signal WHERE signal_id = $1`,
      [body.signalId],
    );
    expect(rows.rows[0].ontology_id).toBe(ONTOLOGY_ID);
  });
});

describe("POST /api/v1/funnel/drain", () => {
  it("returns a runsStarted count without error (no filter)", async () => {
    const { status, body } = await api("POST", "/api/v1/funnel/drain", {});
    expect(status).toBe(200);
    expect(typeof body.runsStarted).toBe("number");
    expect(body.runsStarted).toBeGreaterThanOrEqual(0);
  });

  it("accepts an objectTypes filter array", async () => {
    const { status, body } = await api("POST", "/api/v1/funnel/drain", {
      objectTypes: [OT_API_NAME],
    });
    expect(status).toBe(200);
    expect(typeof body.runsStarted).toBe("number");
  });
});
