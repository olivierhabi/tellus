// ---------------------------------------------------------------------------
// Indexing close-out §1.7 — registration-time marker validation against the
// REAL database (registerWithFoundryDataset → backing_datasource).
//
//   * a normal registration persists a locator that the changelog's strict
//     parser (parseFoundryMarker) and the invariant checker both accept, with
//     the dataset + object-type UUIDs in the right slots;
//   * a dataset id Postgres accepts but that is not canonical 36-char UUID
//     text (hyphenless `uuid` input) would build a malformed locator — the
//     service refuses with DATASOURCE_MARKER_INVALID and writes NOTHING.
// Fixtures are created and removed by this file (isolated lane only).
// ---------------------------------------------------------------------------

import { LANE } from "../../laneEnv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const STAMP = Date.now();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const KEY = `tests/indexing-closeout-registration/${STAMP}/accounts.csv`;

let db: typeof import("../../../src/db");
let svc: typeof import("../../../src/services/datasetDatasourceService");
let acts: typeof import("../../../src/services/funnel/temporal/activities");
let inv: typeof import("../../../src/services/funnel/funnelInvariants");
const otIds: string[] = [];
let datasetId = "";

async function createType(suffix: string): Promise<string> {
  const ot = await db.query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $2, 'experimental') RETURNING object_type_id::text AS id`,
    [ONTOLOGY_ID, `CloseoutReg${suffix}${STAMP}`],
  );
  const id = String(ot.rows[0].id);
  otIds.push(id);
  await db.query(
    `INSERT INTO property (object_type_id, api_name, display_name, base_type)
     VALUES ($1, 'name', 'Name', 'string')`,
    [id],
  );
  return id;
}

beforeAll(async () => {
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({ operation: "indexing-closeout-registration", skipApiProbe: true });
  process.env.TELLUS_ENVIRONMENT_ID = LANE.TELLUS_ENVIRONMENT_ID;
  db = await import("../../../src/db");
  svc = await import("../../../src/services/datasetDatasourceService");
  acts = await import("../../../src/services/funnel/temporal/activities");
  inv = await import("../../../src/services/funnel/funnelInvariants");
  const fd = await db.query(
    `INSERT INTO foundry_datasets (name, file_path, original_filename, status, format, row_count)
     VALUES ($1, $2, 'accounts.csv', 'ready', 'csv', 2) RETURNING id::text AS id`,
    [`closeout_reg_${STAMP}`, KEY],
  );
  datasetId = String(fd.rows[0].id);
  for (const [i, col] of ["id", "name"].entries()) {
    await db.query(
      `INSERT INTO dataset_columns (dataset_id, column_name, column_type, ordinal_position)
       VALUES ($1, $2, 'string', $3)`,
      [datasetId, col, i + 1],
    );
  }
});

afterAll(async () => {
  if (!db) return;
  for (const id of otIds) {
    await db.query(`DELETE FROM funnel_state WHERE object_type_id = $1`, [id]).catch(() => {});
    await db.query(`DELETE FROM backing_datasource WHERE object_type_id = $1`, [id]).catch(() => {});
    await db.query(`DELETE FROM property WHERE object_type_id = $1`, [id]).catch(() => {});
    await db.query(`DELETE FROM object_type WHERE object_type_id = $1`, [id]).catch(() => {});
  }
  if (datasetId) {
    await db.query(`DELETE FROM dataset_columns WHERE dataset_id = $1`, [datasetId]).catch(() => {});
    await db.query(`DELETE FROM foundry_datasets WHERE id = $1`, [datasetId]).catch(() => {});
  }
});

describe("§1.7 registration-time foundry marker validation (real DB)", () => {
  it("persists a locator the changelog parser and the invariant checker accept", async () => {
    const otId = await createType("Ok");
    await svc.registerWithFoundryDataset(otId, {
      foundryDatasetId: datasetId,
      columnMapping: { name: "name" },
      primaryKeyColumn: "id",
    });
    const r = await db.query(`SELECT file_path FROM backing_datasource WHERE object_type_id = $1`, [otId]);
    expect(r.rows).toHaveLength(1);
    const filePath = String(r.rows[0].file_path);
    expect(acts.parseFoundryMarker(filePath)).toEqual({
      s3Key: KEY,
      foundryDatasetUuid: datasetId,
      objectTypeUuid: otId,
    });
    expect(inv.classifyLocator(filePath, true)).toEqual({ kind: "foundry", key: KEY });
  });

  it("refuses a non-canonical dataset id with DATASOURCE_MARKER_INVALID and writes nothing", async () => {
    const otId = await createType("Bad");
    const hyphenless = datasetId.replace(/-/g, ""); // valid Postgres uuid input, not 36-char text
    const found = await db.query(`SELECT count(*)::int AS n FROM foundry_datasets WHERE id = $1`, [hyphenless]);
    expect(found.rows[0].n, "Postgres resolves the hyphenless id to the same row").toBe(1);

    await expect(
      svc.registerWithFoundryDataset(otId, {
        foundryDatasetId: hyphenless,
        columnMapping: { name: "name" },
        primaryKeyColumn: "id",
      }),
    ).rejects.toMatchObject({ code: "DATASOURCE_MARKER_INVALID" });

    const r = await db.query(`SELECT count(*)::int AS n FROM backing_datasource WHERE object_type_id = $1`, [otId]);
    expect(r.rows[0].n).toBe(0);
  });
});
