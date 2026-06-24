// ---------------------------------------------------------------------------
// /api/v1/ontology/:ontologyId/objectTypes/:apiName/dataStore — integration
//
// Happy path + every error path + the three schema-status branches
// driven by a row in object_type_active_index_version. Pairs with the
// pure-function unit test at
// `tests/funnel/unit/object-data-store-unit.test.ts`.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../../helpers/api";
import { query } from "../../../src/db";

const STAMP = Date.now();
// Single-ontology (ONTOLOGY_SINGLETON): there is exactly ONE ontology row —
// the canonical 00000000-0000-0000-0000-000000000001 (uq_ontology_singleton).
// Any other ontology id in the path is collapsed onto it at the edge, so all
// fixtures reference the canonical id directly.
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT_API_NAME = `DataStoreProbe${STAMP}`;
let OT_ID = "";

beforeAll(async () => {
  // Single-ontology: the canonical ontology already exists (seeded) and is
  // UNIQUE — never INSERT INTO ontology (would violate uq_ontology_singleton).
  // The FK on object_type.ontology_id is satisfied by the canonical row, so
  // we only need to seed this test's own fixture object_type.
  const ot = await query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     ON CONFLICT DO NOTHING
     RETURNING object_type_id`,
    [ONTOLOGY_ID, OT_API_NAME, `DataStore Probe ${STAMP}`],
  );
  OT_ID = ot.rows[0]?.object_type_id as string;
});

afterAll(async () => {
  await query(
    `DELETE FROM object_type_active_index_version WHERE object_type_api_name = $1`,
    [OT_API_NAME],
  );
  if (OT_ID) {
    await query(`DELETE FROM object_type WHERE object_type_id = $1`, [OT_ID]);
  }
  // Single-ontology: NEVER DELETE FROM ontology — that would drop the one
  // shared canonical row. Only this test's own fixture rows (cleaned above)
  // are removed.
});

describe("GET /dataStore — happy path", () => {
  it("returns up_to_date + null schemaDetail when no replacement row exists", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/${OT_API_NAME}/dataStore`,
    );
    expect(status).toBe(200);
    expect(body.objectTypeApiName).toBe(OT_API_NAME);
    expect(typeof body.indexName).toBe("string");
    expect(body.displayName).toBe("Object Storage V2");
    expect(body.schemaStatus).toBe("up_to_date");
    expect(body.schemaDetail).toBeNull();
    // pipelineStatus defaults to "idle" when no funnel_state row exists.
    expect(["idle", "not_indexed", "indexed"]).toContain(body.pipelineStatus);
  });

  it("maps REPLACEMENT_BACKFILL → schemaStatus: migrating", async () => {
    // Migration 018 made `target_api_name` NOT NULL on
    // object_type_active_index_version (so the replacement state
    // machine can distinguish object-type vs link-type targets). The
    // test INSERT must now provide it — mirrors the
    // object_type_api_name value for object-type targets.
    await query(
      `INSERT INTO object_type_active_index_version
         (object_type_api_name, target_api_name, active_version, pending_version, state)
       VALUES ($1, $1, 1, 2, 'REPLACEMENT_BACKFILL')
       ON CONFLICT (object_type_api_name) DO UPDATE
         SET target_api_name = EXCLUDED.target_api_name,
             pending_version = EXCLUDED.pending_version,
             state = EXCLUDED.state,
             updated_at = now()`,
      [OT_API_NAME],
    );
    const { body } = await api(
      "GET",
      `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/${OT_API_NAME}/dataStore`,
    );
    expect(body.schemaStatus).toBe("migrating");
    expect(body.schemaDetail.replacementState).toBe("REPLACEMENT_BACKFILL");
    expect(body.schemaDetail.activeVersion).toBe(1);
    expect(body.schemaDetail.pendingVersion).toBe(2);
  });

  it("maps ROLLED_BACK → schemaStatus: out_of_date", async () => {
    await query(
      `UPDATE object_type_active_index_version
          SET state = 'ROLLED_BACK', updated_at = now()
        WHERE object_type_api_name = $1`,
      [OT_API_NAME],
    );
    const { body } = await api(
      "GET",
      `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/${OT_API_NAME}/dataStore`,
    );
    expect(body.schemaStatus).toBe("out_of_date");
    expect(body.schemaDetail.replacementState).toBe("ROLLED_BACK");
  });

  it("maps CUTOVER_COMPLETE → schemaStatus: up_to_date (with row present)", async () => {
    await query(
      `UPDATE object_type_active_index_version
          SET state = 'CUTOVER_COMPLETE', updated_at = now()
        WHERE object_type_api_name = $1`,
      [OT_API_NAME],
    );
    const { body } = await api(
      "GET",
      `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/${OT_API_NAME}/dataStore`,
    );
    expect(body.schemaStatus).toBe("up_to_date");
    expect(body.schemaDetail.replacementState).toBe("CUTOVER_COMPLETE");
  });
});

describe("GET /dataStore — error paths", () => {
  it("collapses any ontology id to the canonical (singleton) and resolves the fixture object type", async () => {
    // Single-ontology (ONTOLOGY_SINGLETON): a non-canonical ontology id in the
    // path is collapsed onto the one canonical ontology at the edge, so the
    // request resolves (200) instead of 404. The old "ontology doesn't exist"
    // premise is no longer reachable — under one-ontology, every id resolves
    // to the canonical, which exists.
    const { status, body } = await api(
      "GET",
      `/api/v1/ontology/00000000-0000-0000-0000-000000000000/objectTypes/${OT_API_NAME}/dataStore`,
    );
    expect(status).toBe(200);
    expect(body.objectTypeApiName).toBe(OT_API_NAME);
  });

  it("404s with OBJECT_TYPE_NOT_FOUND when the apiName doesn't exist under the ontology", async () => {
    const { status, body } = await api(
      "GET",
      `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/NoSuchType_xyz/dataStore`,
    );
    expect(status).toBe(404);
    expect(body.error?.code ?? body.errorCode).toBe("OBJECT_TYPE_NOT_FOUND");
  });

  it("accepts the 'default' alias for ontologyId", async () => {
    // Alias resolver must route this through to the canonical ontology;
    // the apiName then doesn't exist under that ontology so a 404 is
    // expected — but it must be OBJECT_TYPE_NOT_FOUND, not
    // ONTOLOGY_NOT_FOUND.
    const { status, body } = await api(
      "GET",
      `/api/v1/ontology/default/objectTypes/NoSuchType_xyz/dataStore`,
    );
    expect(status).toBe(404);
    expect(body.error?.code ?? body.errorCode).toBe("OBJECT_TYPE_NOT_FOUND");
  });
});
