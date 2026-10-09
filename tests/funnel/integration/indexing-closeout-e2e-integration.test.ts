// ---------------------------------------------------------------------------
// Indexing close-out — end-to-end changelog → merge over a REAL
// foundry-bridged CSV in MinIO (checklist §2/§3 lite, §4.1, provenance).
//
// Drives the production Temporal activities directly (no Temporal server
// needed — the activities tolerate a missing activity Context) against the
// CI stack's Postgres + MinIO + DuckDB:
//
//   * CSV with duplicate primary keys → rowsEmitted / merged / materialised
//     counts equal the DISTINCT key count, values are last-wins by file order;
//   * provenance: object_instances.source_transaction_id is the foundry
//     dataset UUID carried in the locator marker (not nulled);
//   * no merge staging rows left behind after a successful promote;
//   * re-running the same source is idempotent; a changed source updates
//     and adds rows;
//   * §4.1: a malformed `#foundry-dataset:` marker FAILS the changelog loudly
//     (never a silent zero-row run) and leaves object_instances untouched;
//   * a well-formed marker whose object is missing fails with a "not
//     reachable" error; a header-only CSV trips the zero-row gate.
// ---------------------------------------------------------------------------

// LANE import must be first: its side effect pins the lane identity into
// process.env before any src module reads configuration.
import { LANE } from "../../laneEnv";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setFunnelRuntimeOverridesForTesting } from "../../../src/config/funnelRuntime";

const STAMP = Date.now();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT = `CloseoutE2E${STAMP}`;
const DATASET_UUID = randomUUID();
const KEY_PREFIX = `tests/indexing-closeout/${STAMP}`;
const KEY = `${KEY_PREFIX}/orders.csv`;
const EMPTY_KEY = `${KEY_PREFIX}/empty.csv`;
const MISSING_KEY = `${KEY_PREFIX}/does-not-exist.csv`;

let OT_ID = "";
let MAPPING_ID = "";

let db: typeof import("../../../src/db");
let storage: typeof import("../../../src/services/storageService");
let acts: typeof import("../../../src/services/funnel/temporal/activities");

// 1 and 3 are duplicated: last row in file order must win.
const CSV_V1 = [
  "id,name,qty",
  "1,alpha,10",
  "2,bravo,20",
  "3,charlie,30",
  "1,alpha-final,11",
  "4,delta,40",
  "3,charlie-final,31",
  "5,echo,50",
].join("\n") + "\n";
const V1_EXPECTED: Record<string, { name: string; qty: string }> = {
  "1": { name: "alpha-final", qty: "11" },
  "2": { name: "bravo", qty: "20" },
  "3": { name: "charlie-final", qty: "31" },
  "4": { name: "delta", qty: "40" },
  "5": { name: "echo", qty: "50" },
};

// v2: 2 changes, 6 is new.
const CSV_V2 = [
  "id,name,qty",
  "1,alpha-final,11",
  "2,bravo-v2,22",
  "3,charlie-final,31",
  "4,delta,40",
  "5,echo,50",
  "6,foxtrot,60",
].join("\n") + "\n";

function marker(key: string, datasetUuid: string): string {
  return `${key}#foundry-dataset:${datasetUuid}#object-type:${OT_ID}`;
}

async function setLocator(filePath: string): Promise<void> {
  await db.query(`UPDATE backing_datasource SET file_path = $2 WHERE mapping_id = $1`, [
    MAPPING_ID,
    filePath,
  ]);
}

function ctx() {
  return {
    ontologyId: ONTOLOGY_ID,
    objectTypeApiName: OT,
    objectTypeRid: OT_ID,
    environmentId: LANE.TELLUS_ENVIRONMENT_ID,
  };
}

async function runPipelinePass() {
  const cl = await acts.runChangelogActivity(ctx());
  const merge = await acts.runMergeActivity({
    ...ctx(),
    changelogSnapshotId: cl.snapshotId,
    changelogOwnedProperties: cl.ownedProperties,
  });
  return { cl, merge };
}

async function mergePathOf(snapshotId: string): Promise<string | null> {
  const r = await db.query(`SELECT summary_json->>'merge_path' AS p FROM funnel_snapshot WHERE snapshot_id = $1`, [
    snapshotId,
  ]);
  return (r.rows[0]?.p as string | undefined) ?? null;
}

async function instances(): Promise<
  Array<{ primary_key: string; properties: Record<string, unknown>; source_transaction_id: string | null }>
> {
  const r = await db.query(
    `SELECT primary_key, properties, source_transaction_id::text AS source_transaction_id
       FROM object_instances
      WHERE ontology_id = $1 AND object_type_api_name = $2
      ORDER BY primary_key`,
    [ONTOLOGY_ID, OT],
  );
  return r.rows;
}

beforeAll(async () => {
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({
    operation: "indexing-closeout-e2e-fixture-cleanup",
    skipApiProbe: true,
  });
  process.env.TELLUS_ENVIRONMENT_ID = LANE.TELLUS_ENVIRONMENT_ID;
  db = await import("../../../src/db");
  storage = await import("../../../src/services/storageService");
  acts = await import("../../../src/services/funnel/temporal/activities");
  const guard = await import("../../../src/services/funnel/environmentGuard");
  await guard.sealDatabaseEnvironment({
    environmentId: LANE.TELLUS_ENVIRONMENT_ID,
    temporalNamespace: "t", temporalTaskQueue: "q", temporalAddress: "x",
    workerBuildId: "test", mode: "local", workerIdentity: "t",
  });

  await storage.ensureBucket();
  await storage.uploadObject(KEY, Buffer.from(CSV_V1, "utf8"), "text/csv");
  await storage.uploadObject(EMPTY_KEY, Buffer.from("id,name,qty\n", "utf8"), "text/csv");

  const ins = await db.query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     RETURNING object_type_id`,
    [ONTOLOGY_ID, OT, `Closeout E2E ${STAMP}`],
  );
  OT_ID = ins.rows[0].object_type_id as string;

  const bd = await db.query(
    `INSERT INTO backing_datasource
       (object_type_id, dataset_name, file_path, file_format, column_mapping, primary_key_column)
     VALUES ($1, $2, $3, 'csv', '{}'::jsonb, 'id')
     RETURNING mapping_id`,
    [OT_ID, `closeout_e2e_${STAMP}`, marker(KEY, DATASET_UUID)],
  );
  MAPPING_ID = bd.rows[0].mapping_id as string;
});

afterAll(async () => {
  if (!db) return;
  await db.query(`DELETE FROM object_instances WHERE object_type_api_name = $1`, [OT]).catch(() => {});
  await db.query(`DELETE FROM merge_staging_instances WHERE object_type_api_name = $1`, [OT]).catch(() => {});
  await db
    .query(
      `DELETE FROM funnel_stage_run WHERE run_id IN (SELECT run_id FROM funnel_run WHERE object_type_api_name = $1)`,
      [OT],
    )
    .catch(() => {});
  await db.query(`DELETE FROM funnel_run WHERE object_type_api_name = $1`, [OT]).catch(() => {});
  await db.query(`DELETE FROM funnel_signal WHERE object_type_api_name = $1`, [OT]).catch(() => {});
  if (OT_ID) {
    await db.query(`DELETE FROM funnel_state WHERE object_type_id = $1`, [OT_ID]).catch(() => {});
    await db.query(`DELETE FROM backing_datasource WHERE object_type_id = $1`, [OT_ID]).catch(() => {});
    await db.query(`DELETE FROM object_type WHERE object_type_id = $1`, [OT_ID]).catch(() => {});
  }
  if (storage) {
    await storage.deletePrefix(`${KEY_PREFIX}/`).catch(() => {});
  }
});

describe("indexing close-out e2e: foundry CSV → changelog → merge → object_instances", () => {
  it(
    "materialises exactly the distinct keys, last-wins, with dataset provenance and no staging leftovers",
    { timeout: 180_000 },
    async () => {
      const { cl, merge } = await runPipelinePass();
      const distinct = Object.keys(V1_EXPECTED).length;

      expect(cl.rowsEmitted).toBe(distinct);
      // Duplicate-PK collapse is measured, not silent (ADR 2026-10-09
      // duplicate primary keys, phase 1): 7 data rows, 5 distinct keys.
      const q = await db.query(
        `SELECT summary_json->'source_quality' AS q FROM funnel_snapshot WHERE snapshot_id = $1`,
        [cl.snapshotId],
      );
      expect(q.rows[0]?.q).toEqual({
        sourceRows: 7,
        distinctPrimaryKeys: 5,
        duplicatePkRows: 2,
        nullOrEmptyPkRows: 0,
        duplicatePkSamples: ["1", "3"],
        // Recorded with the object type's policy (migration 197; default
        // lenient ⇒ the duplicates collapse instead of failing). The
        // collapse also shows up as an OSv2 violation code.
        policy: "lenient",
        restrictions: [{ code: "duplicate_primary_key", count: 2, samples: ["1", "3"] }],
      });
      expect(merge.mergedRowCount).toBe(distinct);
      expect(merge.objectsIndexed).toBe(distinct);

      const rows = await instances();
      expect(rows.map((r) => r.primary_key).sort()).toEqual(Object.keys(V1_EXPECTED).sort());
      for (const r of rows) {
        const want = V1_EXPECTED[r.primary_key];
        expect(String(r.properties.name), `name for pk ${r.primary_key}`).toBe(want.name);
        expect(String(r.properties.qty), `qty for pk ${r.primary_key}`).toBe(want.qty);
        // Provenance: the dataset UUID from the marker survives the merge.
        expect(r.source_transaction_id, `provenance for pk ${r.primary_key}`).toBe(DATASET_UUID);
      }

      const staging = await db.query(
        `SELECT count(*)::int AS n FROM merge_staging_instances
          WHERE ontology_id = $1 AND object_type_api_name = $2`,
        [ONTOLOGY_ID, OT],
      );
      expect(staging.rows[0].n).toBe(0);
    },
  );

  it("re-running the same source is idempotent", { timeout: 180_000 }, async () => {
    const before = await instances();
    const { cl, merge } = await runPipelinePass();
    expect(cl.rowsEmitted).toBe(before.length);
    expect(merge.objectsIndexed).toBe(before.length);
    expect(await instances()).toEqual(before);
  });

  it("a changed source updates existing keys and adds new ones", { timeout: 180_000 }, async () => {
    await storage.uploadObject(KEY, Buffer.from(CSV_V2, "utf8"), "text/csv");
    const { cl, merge } = await runPipelinePass();
    expect(cl.rowsEmitted).toBe(6);
    expect(merge.objectsIndexed).toBe(6);
    const byPk = new Map((await instances()).map((r) => [r.primary_key, r]));
    expect(byPk.size).toBe(6);
    expect(String(byPk.get("2")!.properties.name)).toBe("bravo-v2");
    expect(String(byPk.get("2")!.properties.qty)).toBe("22");
    expect(String(byPk.get("6")!.properties.name)).toBe("foxtrot");
    expect(String(byPk.get("1")!.properties.name)).toBe("alpha-final");
    expect(byPk.get("6")!.source_transaction_id).toBe(DATASET_UUID);
  });

  let currentCsv = CSV_V2;
  // The fast path above is what a single small source takes. Exercise every
  // merge strategy the pipeline can select (general, bucketed, legacy wide
  // sort, full PG tail): all must materialise the same result.
  for (const variant of [
    { label: "general SQL prefix (fast path off)", overrides: { mergeFastPath: false }, pk: "3", name: "charlie-general" },
    { label: "bucketed prefix (2-row buckets)", overrides: { mergeFastPath: false, mergeBucketTargetRows: 2 }, pk: "4", name: "delta-bucketed" },
    { label: "legacy wide-sort prefix", overrides: { mergeFastPath: false, mergeNarrowDedup: false }, pk: "5", name: "echo-wide" },
    { label: "full PG tail (delta off)", overrides: { mergeDelta: false }, pk: "1", name: "alpha-fulltail" },
  ]) {
    it(`${variant.label} materialises the same result shape`, { timeout: 180_000 }, async () => {
      setFunnelRuntimeOverridesForTesting(variant.overrides);
      try {
        const before = new Map((await instances()).map((r) => [r.primary_key, r]));
        // Start from v2 plus every earlier variant's change (cumulative state).
        const csv = currentCsv
          .split("\n")
          .map((line) => {
            if (!line.startsWith(`${variant.pk},`)) return line;
            const cols = line.split(",");
            cols[1] = variant.name; // change only the name
            return cols.join(",");
          })
          .join("\n");
        await storage.uploadObject(KEY, Buffer.from(csv, "utf8"), "text/csv");
        currentCsv = csv;
        const { cl, merge } = await runPipelinePass();
        expect(cl.rowsEmitted).toBe(6);
        expect(merge.objectsIndexed).toBe(6);
        const after = new Map((await instances()).map((r) => [r.primary_key, r]));
        expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
        expect(String(after.get(variant.pk)!.properties.name)).toBe(variant.name);
        for (const [pk, row] of after) {
          expect(row.source_transaction_id, `provenance for pk ${pk}`).toBe(DATASET_UUID);
          if (pk !== variant.pk) expect(row.properties, `pk ${pk} unchanged`).toEqual(before.get(pk)!.properties);
        }
        const path = await mergePathOf(merge.mergedSnapshotId);
        if (variant.overrides.mergeFastPath === false) expect(path).not.toBe("duckdb_sql_fast");
        if ("mergeBucketTargetRows" in variant.overrides) expect(path).toMatch(/bucketed/);
        if (process.env.TELLUS_EXPECT_OOP_MERGE === "1" && variant.overrides.mergeFastPath === false) {
          // CI funnel-oop lane: the production profile + bundled CLI must take
          // the out-of-process path — never a silent in-process fallback.
          expect(path).toMatch(/_cli$/);
        }
        const staging = await db.query(
          `SELECT count(*)::int AS n FROM merge_staging_instances
            WHERE ontology_id = $1 AND object_type_api_name = $2`,
          [ONTOLOGY_ID, OT],
        );
        expect(staging.rows[0].n).toBe(0);
      } finally {
        setFunnelRuntimeOverridesForTesting(null);
      }
    });
  }

  it("§4.1: a malformed foundry marker fails loudly and leaves object_instances untouched", { timeout: 120_000 }, async () => {
    const before = await instances();
    await setLocator(`${KEY}#foundry-dataset:not-a-uuid#object-type:${OT_ID}`);
    try {
      await expect(acts.runChangelogActivity(ctx())).rejects.toThrow(/malformed marker/i);
    } finally {
      await setLocator(marker(KEY, DATASET_UUID));
    }
    expect(await instances()).toEqual(before);
  });

  it("a well-formed marker whose object is missing fails as not reachable", { timeout: 120_000 }, async () => {
    const before = await instances();
    await setLocator(marker(MISSING_KEY, DATASET_UUID));
    try {
      await expect(acts.runChangelogActivity(ctx())).rejects.toThrow(/not reachable/i);
    } finally {
      await setLocator(marker(KEY, DATASET_UUID));
    }
    expect(await instances()).toEqual(before);
  });

  it("a header-only source trips the zero-row gate instead of indexing an empty snapshot", { timeout: 120_000 }, async () => {
    const before = await instances();
    await setLocator(marker(EMPTY_KEY, DATASET_UUID));
    try {
      // Either the zero-row gate ("emitted 0 rows for a non-empty source")
      // or a reader error — what must never happen is a silent success.
      await expect(acts.runChangelogActivity(ctx())).rejects.toThrow();
    } finally {
      await setLocator(marker(KEY, DATASET_UUID));
    }
    expect(await instances()).toEqual(before);
  });
});
