// ---------------------------------------------------------------------------
// OSv2 data restrictions + full/incremental indexing plan — end to end over
// REAL foundry-bridged sources in MinIO, driving the production Temporal
// activities against Postgres + MinIO + DuckDB (no Temporal server).
//
//   * lenient (default): duplicate PKs collapse last-wins and every OSv2
//     violation is recorded in summary_json.source_quality.restrictions;
//   * strict: the same CSV fails the changelog NON-RETRYABLY with counts +
//     samples, commits no snapshot and leaves object_instances untouched;
//     a clean CSV passes; a forbidden primary-key type fails up front;
//   * strict JSON (per-row tracker path): empty strings, nested arrays,
//     null array elements and duplicate PKs fail;
//   * merge records the Palantir plan: first load full, a small change
//     incremental with a delta of exactly the changed rows (adds included),
//     > 80% changed full.
// ---------------------------------------------------------------------------

import { LANE } from "../../laneEnv";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const STAMP = Date.now();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT = `RestrictE2E${STAMP}`;
const DATASET_UUID = randomUUID();
const KEY_PREFIX = `tests/indexing-restrictions/${STAMP}`;
const CSV_KEY = `${KEY_PREFIX}/orders.csv`;
const JSON_KEY = `${KEY_PREFIX}/orders.json`;

let OT_ID = "";
let MAPPING_ID = "";
let PK_PROP_ID = "";

let db: typeof import("../../../src/db");
let storage: typeof import("../../../src/services/storageService");
let acts: typeof import("../../../src/services/funnel/temporal/activities");
let merge: typeof import("../../../src/services/funnel/mergeStage");

const header = "id,name,price";
const rows = (n: number, f: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => f(i + 1));

// 10 rows; pk 3 duplicated; price NaN on pk 4 and -Infinity on pk 7.
const DIRTY_CSV =
  [
    header,
    ...rows(10, (i) =>
      i === 4 ? `${i},n${i},NaN` : i === 7 ? `${i},n${i},-Infinity` : `${i},n${i},${i}.5`,
    ),
    "3,n3-final,3.75",
  ].join("\n") + "\n";
const cleanCsv = (n: number, tag = "") =>
  [header, ...rows(n, (i) => `${i},n${i}${tag},${i}.5`)].join("\n") + "\n";

function marker(key: string): string {
  return `${key}#foundry-dataset:${DATASET_UUID}#object-type:${OT_ID}`;
}
function ctx() {
  return {
    ontologyId: ONTOLOGY_ID,
    objectTypeApiName: OT,
    objectTypeRid: OT_ID,
    environmentId: LANE.TELLUS_ENVIRONMENT_ID,
  };
}
async function setPolicy(p: "lenient" | "strict") {
  await db.query(`UPDATE object_type SET indexing_data_policy = $2 WHERE object_type_id = $1`, [OT_ID, p]);
}
async function setSource(key: string, format: "csv" | "json", body: string) {
  await storage.uploadObject(key, Buffer.from(body, "utf8"), format === "csv" ? "text/csv" : "application/json");
  await db.query(`UPDATE backing_datasource SET file_path = $2, file_format = $3 WHERE mapping_id = $1`, [
    MAPPING_ID,
    marker(key),
    format,
  ]);
}
async function snapshotCount(): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM funnel_snapshot s
       JOIN funnel_dataset d ON d.dataset_table_id = s.dataset_table_id
      WHERE d.namespace LIKE $1`,
    [`%${OT}%`],
  );
  return r.rows[0].n as number;
}
async function liveCount(): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM object_instances WHERE ontology_id = $1 AND object_type_api_name = $2`,
    [ONTOLOGY_ID, OT],
  );
  return r.rows[0].n as number;
}
async function summaryOf(snapshotId: string): Promise<Record<string, any>> {
  const r = await db.query(`SELECT summary_json FROM funnel_snapshot WHERE snapshot_id = $1`, [snapshotId]);
  return r.rows[0].summary_json;
}
async function pass() {
  const cl = await acts.runChangelogActivity(ctx());
  const m = await acts.runMergeActivity({
    ...ctx(),
    changelogSnapshotId: cl.snapshotId,
    changelogOwnedProperties: cl.ownedProperties,
  });
  return { cl, m };
}
async function failureOf(p: Promise<unknown>): Promise<{ message: string; type?: string; nonRetryable?: boolean }> {
  try {
    await p;
  } catch (err) {
    return err as never;
  }
  throw new Error("expected the changelog to fail");
}

beforeAll(async () => {
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({ operation: "indexing-restrictions-e2e-fixture-cleanup", skipApiProbe: true });
  process.env.TELLUS_ENVIRONMENT_ID = LANE.TELLUS_ENVIRONMENT_ID;
  db = await import("../../../src/db");
  storage = await import("../../../src/services/storageService");
  acts = await import("../../../src/services/funnel/temporal/activities");
  merge = await import("../../../src/services/funnel/mergeStage");
  const guard = await import("../../../src/services/funnel/environmentGuard");
  await guard.sealDatabaseEnvironment({
    environmentId: LANE.TELLUS_ENVIRONMENT_ID,
    temporalNamespace: "t", temporalTaskQueue: "q", temporalAddress: "x",
    workerBuildId: "test", mode: "local", workerIdentity: "t",
  });
  await storage.ensureBucket();
  await storage.uploadObject(CSV_KEY, Buffer.from(DIRTY_CSV, "utf8"), "text/csv");

  const ins = await db.query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental') RETURNING object_type_id`,
    [ONTOLOGY_ID, OT, `Restrictions E2E ${STAMP}`],
  );
  OT_ID = ins.rows[0].object_type_id as string;
  const props = await db.query(
    `INSERT INTO property (object_type_id, api_name, display_name, base_type, is_array)
     VALUES ($1, 'id', 'Id', 'string', false), ($1, 'name', 'Name', 'string', false),
            ($1, 'price', 'Price', 'double', false), ($1, 'tags', 'Tags', 'string_array', true)
     RETURNING property_id, api_name`,
    [OT_ID],
  );
  PK_PROP_ID = props.rows.find((r: { api_name: string }) => r.api_name === "id").property_id;
  await db.query(`UPDATE object_type SET primary_key_property_id = $2 WHERE object_type_id = $1`, [OT_ID, PK_PROP_ID]);
  const bd = await db.query(
    `INSERT INTO backing_datasource
       (object_type_id, dataset_name, file_path, file_format, column_mapping, primary_key_column)
     VALUES ($1, $2, $3, 'csv', '{}'::jsonb, 'id') RETURNING mapping_id`,
    [OT_ID, `restrict_e2e_${STAMP}`, marker(CSV_KEY)],
  );
  MAPPING_ID = bd.rows[0].mapping_id as string;
});

afterAll(async () => {
  if (!db) return;
  await db.query(`DELETE FROM object_instances WHERE object_type_api_name = $1`, [OT]).catch(() => {});
  await db.query(`DELETE FROM merge_staging_instances WHERE object_type_api_name = $1`, [OT]).catch(() => {});
  await db.query(`DELETE FROM funnel_index_watermark WHERE object_type_api_name = $1`, [OT]).catch(() => {});
  if (OT_ID) {
    await db.query(`DELETE FROM funnel_state WHERE object_type_id = $1`, [OT_ID]).catch(() => {});
    await db.query(`DELETE FROM backing_datasource WHERE object_type_id = $1`, [OT_ID]).catch(() => {});
    await db.query(`UPDATE object_type SET primary_key_property_id = NULL WHERE object_type_id = $1`, [OT_ID]).catch(() => {});
    await db.query(`DELETE FROM object_type WHERE object_type_id = $1`, [OT_ID]).catch(() => {});
  }
  if (storage) await storage.deletePrefix(`${KEY_PREFIX}/`).catch(() => {});
});

describe("OSv2 data restrictions (per object type policy)", () => {
  it("strict: a dirty CSV fails non-retryably with counts + samples and commits nothing", { timeout: 120_000 }, async () => {
    await setPolicy("strict");
    const snapsBefore = await snapshotCount();
    const err = await failureOf(acts.runChangelogActivity(ctx()));
    expect(err.type).toBe("IndexingDataRestrictionError");
    expect(err.nonRetryable).toBe(true);
    expect(err.message).toMatch(/duplicate_primary_key: 1 samples=\["3"\]/);
    expect(err.message).toMatch(/non_finite_number: 2 columns=\["price"\] samples=\["pk=4 column=price","pk=7 column=price"\]/);
    expect(await snapshotCount()).toBe(snapsBefore);
    expect(await liveCount()).toBe(0);
  });

  it("lenient: the same CSV indexes (last-wins) and records every violation", { timeout: 180_000 }, async () => {
    await setPolicy("lenient");
    const { cl, m } = await pass();
    expect(cl.rowsEmitted).toBe(10);
    expect(m.objectsIndexed).toBe(10);
    const q = (await summaryOf(cl.snapshotId)).source_quality;
    expect(q.policy).toBe("lenient");
    expect(q.duplicatePkRows).toBe(1);
    expect(q.restrictions).toEqual([
      { code: "duplicate_primary_key", count: 1, samples: ["3"] },
      {
        code: "non_finite_number",
        count: 2,
        samples: ["pk=4 column=price", "pk=7 column=price"],
        columns: ["price"],
      },
    ]);
    const plan = (await summaryOf(m.mergedSnapshotId)).indexing_plan;
    expect(plan).toMatchObject({ mode: "full", reason: "no_previous_snapshot", totalRows: 10 });
  });

  it("merge plan: a small change (1 update + 1 add) is incremental with an exact delta", { timeout: 180_000 }, async () => {
    const before = await merge.loadMergedIndexingPlan("00000000-0000-0000-0000-000000000000");
    expect(before).toBeNull();
    const csv = DIRTY_CSV.replace("2,n2,2.5", "2,n2-v2,2.5").trimEnd() + "\n11,n11,11.5\n";
    await setSource(CSV_KEY, "csv", csv);
    const { m } = await pass();
    expect(m.objectsIndexed).toBe(11);
    const s = await summaryOf(m.mergedSnapshotId);
    expect(s.indexing_plan).toMatchObject({
      mode: "incremental",
      reason: "delta_within_threshold",
      totalRows: 11,
      changedRows: 2,
    });
    expect(s.delta_parquet_ref?.rowCount).toBe(2);
    const delta: string[] = [];
    for await (const r of merge.streamMergedRowsFromSnapshot(m.mergedSnapshotId, { delta: true })) {
      delta.push(`${r.primary_key}:${String(r.properties.name)}`);
    }
    expect(delta.sort()).toEqual(["11:n11", "2:n2-v2"]);
    // The add went through the delta PG tail too (drift check vs the
    // previous snapshot's live set, not this run's count).
    const r = await db.query(
      `SELECT properties->>'name' AS n FROM object_instances
        WHERE ontology_id = $1 AND object_type_api_name = $2 AND primary_key = '11'`,
      [ONTOLOGY_ID, OT],
    );
    expect(r.rows[0]?.n).toBe("n11");
  });

  it("merge plan: > 80% of rows changed ⇒ full", { timeout: 180_000 }, async () => {
    await setSource(CSV_KEY, "csv", cleanCsv(11, "-all"));
    const { m } = await pass();
    const plan = (await summaryOf(m.mergedSnapshotId)).indexing_plan;
    expect(plan).toMatchObject({ mode: "full", reason: "changed_fraction_above_threshold", totalRows: 11 });
    expect(plan.changedRows).toBeGreaterThan(0.8 * 11);
  });

  it("strict: a clean CSV passes", { timeout: 180_000 }, async () => {
    await setPolicy("strict");
    await setSource(CSV_KEY, "csv", cleanCsv(11, "-clean"));
    const { cl } = await pass();
    expect(cl.rowsEmitted).toBe(11);
    expect((await summaryOf(cl.snapshotId)).source_quality.restrictions).toEqual([]);
  });

  it("strict JSON (per-row tracker): empty strings, nested arrays, null elements, duplicates", { timeout: 120_000 }, async () => {
    await setPolicy("strict");
    const lines = [
      { id: "1", name: "a", price: 1, tags: ["x"] },
      { id: "2", name: "", price: 2, tags: ["x"] },
      { id: "3", name: "c", price: 3, tags: [["nested"]] },
      { id: "4", name: "d", price: 4, tags: ["x", null] },
      { id: "1", name: "a2", price: 1, tags: ["y"] },
    ];
    await setSource(JSON_KEY, "json", JSON.stringify(lines));
    const before = await liveCount();
    const err = await failureOf(acts.runChangelogActivity(ctx()));
    expect(err.type).toBe("IndexingDataRestrictionError");
    expect(err.nonRetryable).toBe(true);
    for (const code of ["duplicate_primary_key", "empty_string", "nested_array", "null_array_element"]) {
      expect(err.message).toContain(code);
    }
    expect(await liveCount()).toBe(before);
  });

  it("strict: a forbidden primary-key type (double) fails before reading", { timeout: 60_000 }, async () => {
    await setPolicy("strict");
    await setSource(CSV_KEY, "csv", cleanCsv(3));
    await db.query(`UPDATE property SET base_type = 'double' WHERE property_id = $1`, [PK_PROP_ID]);
    try {
      const err = await failureOf(acts.runChangelogActivity(ctx()));
      expect(err.nonRetryable).toBe(true);
      expect(err.message).toMatch(/forbidden_primary_key_type: 1 samples=\["primary key 'id' has type double"\]/);
    } finally {
      await db.query(`UPDATE property SET base_type = 'string' WHERE property_id = $1`, [PK_PROP_ID]);
    }
  });
});
