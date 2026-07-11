// ---------------------------------------------------------------------------
// scripts/test-merge-sql.ts
//
// Semantics test for the DuckDB SQL k-way merge overlay (Phase 1). Exercises
// the EXACT SQL chain from mergeStage.ts `mergeChangesSQL` against small
// synthetic changelog parquets + edits + existing instances, and asserts the
// per-PK merged_result against hand-computed expected values.
//
// Run: set -a && . ./.env && set +a && npx tsx scripts/test-merge-sql.ts
//
// NOTE: the SQL chain below MUST match mergeStage.ts `mergeChangesSQL` steps
// 2–10. It is duplicated here so the test can run without PG/MinIO/Iceberg
// (only DuckDB is needed). Drift = test invalid; keep in sync.
// ---------------------------------------------------------------------------
import fs from "fs";
import path from "path";
import os from "os";
import {
  acquireConnection,
  runAll,
  queryAll,
  streamQuery,
  releaseConnection,
  __resetPoolForTests,
  type DuckDBConnection,
} from "../src/services/duckdb/pool";
import type { ChangelogRow } from "../src/services/funnel/changelogStage";

interface TestContribution {
  datasource_id: string;
  owned_properties: string[];
  markings: string[];
  rows: ChangelogRow[];
}
interface TestEdit {
  primary_key: string;
  operation: string;
  executed_at: string;
  property_values?: Record<string, unknown>;
}

function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}
function sqlVarcharArray(arr: string[]): string {
  if (arr.length === 0) return "ARRAY[]::VARCHAR[]";
  return `ARRAY[${arr.map(sqlStr).join(",")}]::VARCHAR[]`;
}

/** Write changelog rows to a local parquet (DuckDB COPY). Returns the path. */
async function writeChangelogParquet(conn: DuckDBConnection, rows: ChangelogRow[]): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-cl-"));
  const localPath = path.join(dir, "c.parquet");
  const tbl = `test_cl_${Math.random().toString(36).slice(2)}`;
  await runAll(
    conn,
    `CREATE TEMP TABLE ${tbl} (
      primary_key VARCHAR, operation VARCHAR, properties VARCHAR,
      source_transaction_id VARCHAR, source_commit_timestamp VARCHAR
    )`,
  );
  if (rows.length > 0) {
    const vals = rows
      .map((r) =>
        `(${sqlStr(r.primary_key)},${sqlStr(r.operation)},${sqlStr(
          JSON.stringify(r.properties),
        )},${sqlStr(r.source_transaction_id)},${sqlStr(r.source_commit_timestamp)})`,
      )
      .join(",");
    await runAll(conn, `INSERT INTO ${tbl} VALUES ${vals}`);
  }
  await runAll(
    conn,
    `COPY (SELECT * FROM ${tbl}) TO '${localPath.replace(/'/g, "''")}' (FORMAT PARQUET, CODEC 'ZSTD')`,
  );
  await runAll(conn, `DROP TABLE ${tbl}`);
  return localPath;
}

interface MergedRow {
  primary_key: string;
  properties: Record<string, unknown>;
  markings: string[];
  operation: string;
  source_datasource_id: string | null;
  source_transaction_id: string | null;
}

/**
 * Run the SQL k-way merge overlay (steps 2–10 of mergeChangesSQL) + stream
 * merged_result. `existingInstances` is supplied directly (test path; no PG).
 */
async function runOverlaySQL(
  contributions: TestContribution[],
  pendingEdits: TestEdit[],
  editStrategy: "user_edit_wins" | "latest_wins",
  existingInstances: Record<string, { properties: Record<string, unknown>; markings: string[]; source_datasource_id: string | null; source_transaction_id: string | null }>,
): Promise<MergedRow[]> {
  const conn = await acquireConnection({ skipHttpfs: true });
  // write each contribution's changelog to a local parquet
  const localPaths: string[] = [];
  for (const c of contributions) {
    localPaths.push(await writeChangelogParquet(conn, c.rows));
  }

  // edit rows
  const editOpsRows: string[] = [];
  const editPropsRows: string[] = [];
  pendingEdits.forEach((e, seq) => {
    editOpsRows.push(`(${sqlStr(e.primary_key)},${sqlStr(e.operation)},${sqlStr(e.executed_at)},${seq})`);
    if (e.operation !== "delete" && e.property_values) {
      for (const [prop, val] of Object.entries(e.property_values)) {
        editPropsRows.push(
          `(${sqlStr(e.primary_key)},${sqlStr(prop)},${sqlStr(JSON.stringify(val))},${sqlStr(e.executed_at)},${seq})`,
        );
      }
    }
  });

  // ---- SQL chain (MUST match mergeStage.ts mergeChangesSQL steps 2–10) ----
  await runAll(conn, `CREATE OR REPLACE TEMP TABLE contrib_meta (contrib_idx INTEGER, datasource_id VARCHAR, owned_properties VARCHAR[], contrib_markings VARCHAR[])`);
  const metaVals = contributions.map((c, i) => `(${i},${sqlStr(c.datasource_id)},${sqlVarcharArray(c.owned_properties)},${sqlVarcharArray(c.markings)})`).join(",");
  if (metaVals) await runAll(conn, `INSERT INTO contrib_meta VALUES ${metaVals}`);

  const arms = contributions.map((_, i) => {
    const lp = localPaths[i].replace(/'/g, "''");
    return `SELECT ${i}::INTEGER AS contrib_idx, primary_key::VARCHAR AS primary_key, operation::VARCHAR AS operation, properties::VARCHAR AS properties, source_transaction_id::VARCHAR AS source_transaction_id, source_commit_timestamp::VARCHAR AS source_commit_timestamp FROM read_parquet('${lp}')`;
  });
  if (arms.length > 0) {
    await runAll(conn, `CREATE OR REPLACE TEMP TABLE changes AS ${arms.join(" UNION ALL ")}`);
  } else {
    await runAll(conn, `CREATE OR REPLACE TEMP TABLE changes (contrib_idx INTEGER, primary_key VARCHAR, operation VARCHAR, properties VARCHAR, source_transaction_id VARCHAR, source_commit_timestamp VARCHAR)`);
  }

  await runAll(conn, `CREATE OR REPLACE TEMP TABLE changes_seq AS SELECT *, CAST(row_number() OVER (ORDER BY contrib_idx, source_commit_timestamp, source_transaction_id, primary_key) AS BIGINT) AS glob_seq FROM changes`);

  await runAll(conn, `CREATE OR REPLACE TEMP TABLE per_pk_last_delete AS SELECT primary_key, COALESCE(max(glob_seq) FILTER (WHERE operation = 'DELETE'), -1) AS last_del_seq FROM changes_seq GROUP BY primary_key`);

  await runAll(conn, `CREATE OR REPLACE TEMP TABLE effective_rows AS WITH cand AS (SELECT c.primary_key, c.contrib_idx, cm.datasource_id, c.properties, c.source_transaction_id, c.source_commit_timestamp, c.glob_seq, row_number() OVER (PARTITION BY c.primary_key, c.contrib_idx ORDER BY c.glob_seq DESC) AS rn FROM changes_seq c JOIN per_pk_last_delete d ON d.primary_key = c.primary_key JOIN contrib_meta cm ON cm.contrib_idx = c.contrib_idx WHERE c.operation <> 'DELETE' AND c.glob_seq > d.last_del_seq) SELECT primary_key, contrib_idx, datasource_id, properties, source_transaction_id, source_commit_timestamp, glob_seq FROM cand WHERE rn = 1`);

  await runAll(conn, `CREATE OR REPLACE TEMP TABLE source_state AS WITH src_info AS (SELECT c.primary_key, first(cm.datasource_id ORDER BY c.glob_seq DESC) AS source_datasource_id, first(c.source_transaction_id ORDER BY c.glob_seq DESC) AS source_transaction_id, first(c.source_commit_timestamp ORDER BY c.glob_seq DESC) AS source_timestamp FROM changes_seq c JOIN contrib_meta cm ON cm.contrib_idx = c.contrib_idx GROUP BY c.primary_key), eff_props AS (SELECT primary_key, list_reduce(list_prepend('{}'::JSON, list(properties::JSON ORDER BY contrib_idx, glob_seq)), (acc, p) -> json_merge_patch(acc, p)) AS properties FROM effective_rows GROUP BY primary_key), eff_pks AS (SELECT DISTINCT primary_key FROM effective_rows), src_markings AS (SELECT c.primary_key, COALESCE(array_sort(array_agg(DISTINCT trim(m)) FILTER (WHERE m IS NOT NULL AND trim(m) <> '')), ARRAY[]::VARCHAR[]) AS markings FROM changes_seq c JOIN contrib_meta cm ON cm.contrib_idx = c.contrib_idx LEFT JOIN unnest(cm.contrib_markings) AS t(m) ON true GROUP BY c.primary_key) SELECT s.primary_key, s.source_datasource_id, s.source_transaction_id, s.source_timestamp, (ep.primary_key IS NULL) AS tombstoned, COALESCE(epp.properties, '{}'::JSON) AS properties, mk.markings FROM src_info s LEFT JOIN eff_pks ep ON ep.primary_key = s.primary_key LEFT JOIN eff_props epp ON epp.primary_key = s.primary_key LEFT JOIN src_markings mk ON mk.primary_key = s.primary_key`);

  // existing (test-supplied, no PG)
  await runAll(conn, `CREATE OR REPLACE TEMP TABLE existing (primary_key VARCHAR, properties VARCHAR, markings VARCHAR[], source_datasource_id VARCHAR, source_transaction_id VARCHAR)`);
  const exEntries = Object.entries(existingInstances);
  for (let i = 0; i < exEntries.length; i += 500) {
    const chunk = exEntries.slice(i, i + 500);
    if (chunk.length === 0) continue;
    const vals = chunk.map(([pk, ex]) => `(${sqlStr(pk)},${sqlStr(JSON.stringify(ex.properties))},${sqlVarcharArray(ex.markings ?? [])},${sqlStr(ex.source_datasource_id ?? "")},${sqlStr(ex.source_transaction_id ?? "")})`).join(",");
    if (vals) await runAll(conn, `INSERT INTO existing VALUES ${vals}`);
  }

  await runAll(conn, `CREATE OR REPLACE TEMP TABLE edit_ops (primary_key VARCHAR, operation VARCHAR, created_at VARCHAR, edit_seq INTEGER)`);
  if (editOpsRows.length > 0) await runAll(conn, `INSERT INTO edit_ops VALUES ${editOpsRows.join(",")}`);
  await runAll(conn, `CREATE OR REPLACE TEMP TABLE edit_props (primary_key VARCHAR, prop VARCHAR, value VARCHAR, created_at VARCHAR, edit_seq INTEGER)`);
  if (editPropsRows.length > 0) await runAll(conn, `INSERT INTO edit_props VALUES ${editPropsRows.join(",")}`);
  await runAll(conn, `CREATE OR REPLACE TEMP TABLE edit_bucket AS SELECT primary_key, first(operation ORDER BY created_at DESC, edit_seq ASC) AS edit_op FROM edit_ops GROUP BY primary_key`);
  await runAll(conn, `CREATE OR REPLACE TEMP TABLE edit_props_latest AS WITH x AS (SELECT primary_key, prop, value, created_at, row_number() OVER (PARTITION BY primary_key, prop ORDER BY edit_seq DESC) AS rn FROM edit_props) SELECT primary_key, prop, value, created_at FROM x WHERE rn = 1`);

  await runAll(conn, `CREATE OR REPLACE TEMP TABLE merged_result AS WITH pks AS (SELECT primary_key FROM source_state UNION SELECT primary_key FROM edit_bucket), all_markings AS (SELECT primary_key, COALESCE(array_sort(array_agg(DISTINCT trim(m)) FILTER (WHERE m IS NOT NULL AND trim(m) <> '')), ARRAY[]::VARCHAR[]) AS markings FROM (SELECT p.primary_key, unnest(s.markings) AS m FROM pks p LEFT JOIN source_state s ON s.primary_key = p.primary_key UNION ALL SELECT p.primary_key, unnest(e.markings) AS m FROM pks p LEFT JOIN existing e ON e.primary_key = p.primary_key) GROUP BY primary_key), overrides AS (SELECT ep.primary_key, json_group_object(ep.prop, ep.value::JSON) AS ov FROM edit_props_latest ep JOIN edit_bucket eb ON eb.primary_key = ep.primary_key LEFT JOIN source_state s ON s.primary_key = ep.primary_key WHERE eb.edit_op IS DISTINCT FROM 'delete' AND ( ${sqlStr(editStrategy)} = 'user_edit_wins' OR s.source_timestamp IS NULL OR ep.created_at > s.source_timestamp ) GROUP BY ep.primary_key) SELECT p.primary_key, CASE WHEN (s.tombstoned AND (eb.edit_op IS NULL OR eb.edit_op = 'delete')) OR (s.primary_key IS NULL AND eb.edit_op = 'delete') THEN 'delete' ELSE 'upsert' END AS operation, CASE WHEN (s.tombstoned AND (eb.edit_op IS NULL OR eb.edit_op = 'delete')) OR (s.primary_key IS NULL AND eb.edit_op = 'delete') THEN '{}'::JSON ELSE json_merge_patch(COALESCE(s.properties, e.properties::JSON, '{}'::JSON), COALESCE(ov.ov, '{}'::JSON)) END AS properties, COALESCE(am.markings, ARRAY[]::VARCHAR[]) AS markings, COALESCE(s.source_datasource_id, e.source_datasource_id) AS source_datasource_id, COALESCE(s.source_transaction_id, e.source_transaction_id) AS source_transaction_id FROM pks p LEFT JOIN source_state s ON s.primary_key = p.primary_key LEFT JOIN existing e ON e.primary_key = p.primary_key LEFT JOIN edit_bucket eb ON eb.primary_key = p.primary_key LEFT JOIN overrides ov ON ov.primary_key = p.primary_key LEFT JOIN all_markings am ON am.primary_key = p.primary_key`);

  // stream merged_result
  const out: MergedRow[] = [];
  for await (const r of streamQuery<Record<string, unknown>>(conn, `SELECT primary_key, CAST(properties AS VARCHAR) AS properties, to_json(markings) AS markings, operation, COALESCE(source_datasource_id, '') AS source_datasource_id, COALESCE(source_transaction_id, '') AS source_transaction_id FROM merged_result ORDER BY primary_key`)) {
    out.push({
      primary_key: String(r.primary_key),
      properties: JSON.parse(String(r.properties)),
      markings: JSON.parse(String(r.markings)),
      operation: String(r.operation),
      source_datasource_id: String(r.source_datasource_id ?? "") || null,
      source_transaction_id: String(r.source_transaction_id ?? "") || null,
    });
  }
  // cleanup local parquets
  for (const lp of localPaths) {
    try { fs.rmSync(path.dirname(lp), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  releaseConnection(conn);
  return out;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
function check(cond: boolean, msg: string, got?: unknown, exp?: unknown) {
  if (cond) { pass++; console.log("  ok:", msg); }
  else { fail++; console.log("  FAIL:", msg, "\n    got:", JSON.stringify(got), "\n    exp:", JSON.stringify(exp)); }
}
function findByPk(rows: MergedRow[], pk: string): MergedRow | undefined {
  return rows.find((r) => r.primary_key === pk);
}

// ---------------------------------------------------------------------------
// Case (a): normal upsert — 1 contrib, INSERT only.
// ---------------------------------------------------------------------------
async function caseA() {
  console.log("\n[case A] normal upsert (1 contrib, INSERT)");
  const rows: MergedRow[] = await runOverlaySQL(
    [{
      datasource_id: "ds-a", owned_properties: ["name", "val"], markings: [],
      rows: [
        { primary_key: "k1", operation: "INSERT", properties: { name: "Alice", val: 1 }, source_transaction_id: "t1", source_commit_timestamp: "2020-01-01T00:00:00Z" },
        { primary_key: "k2", operation: "INSERT", properties: { name: "Bob", val: 2 }, source_transaction_id: "t2", source_commit_timestamp: "2020-01-02T00:00:00Z" },
      ],
    }],
    [], "user_edit_wins", {},
  );
  check(rows.length === 2, "2 rows", rows.length, 2);
  check(findByPk(rows, "k1")?.operation === "upsert", "k1 upsert");
  check(findByPk(rows, "k1")?.properties.name === "Alice", "k1 name=Alice", findByPk(rows, "k1")?.properties);
  check(findByPk(rows, "k1")?.properties.val === 1, "k1 val=1");
  check(findByPk(rows, "k1")?.markings.length === 0, "k1 markings=[]", findByPk(rows, "k1")?.markings, []);
  check(findByPk(rows, "k1")?.source_datasource_id === "ds-a", "k1 src ds-a");
}

// ---------------------------------------------------------------------------
// Case (b): tombstone-then-untombstone (DELETE then INSERT — properties reset).
// ---------------------------------------------------------------------------
async function caseB() {
  console.log("\n[case B] tombstone-then-untombstone (DELETE then INSERT)");
  const rows: MergedRow[] = await runOverlaySQL(
    [{
      datasource_id: "ds-b", owned_properties: ["name"], markings: [],
      rows: [
        { primary_key: "k1", operation: "INSERT", properties: { name: "Alice" }, source_transaction_id: "t1", source_commit_timestamp: "2020-01-01T00:00:00Z" },
        { primary_key: "k1", operation: "DELETE", properties: {}, source_transaction_id: "t2", source_commit_timestamp: "2020-01-02T00:00:00Z" },
        { primary_key: "k1", operation: "INSERT", properties: { name: "Alice2" }, source_transaction_id: "t3", source_commit_timestamp: "2020-01-03T00:00:00Z" },
      ],
    }],
    [], "user_edit_wins", {},
  );
  check(rows.length === 1, "1 row (untombstoned)", rows.length, 1);
  const k1 = findByPk(rows, "k1");
  check(k1?.operation === "upsert", "k1 upsert (untombstoned)");
  check(k1?.properties.name === "Alice2", "k1 name=Alice2 (post-DELETE INSERT wins, props reset)", k1?.properties);
  check(k1?.source_transaction_id === "t3", "k1 src tx=t3 (last row)", k1?.source_transaction_id, "t3");

  // Also test terminal tombstone (DELETE with no later INSERT)
  const rows2: MergedRow[] = await runOverlaySQL(
    [{
      datasource_id: "ds-b2", owned_properties: ["name"], markings: [],
      rows: [
        { primary_key: "k2", operation: "INSERT", properties: { name: "Bob" }, source_transaction_id: "t1", source_commit_timestamp: "2020-01-01T00:00:00Z" },
        { primary_key: "k2", operation: "DELETE", properties: {}, source_transaction_id: "t2", source_commit_timestamp: "2020-01-02T00:00:00Z" },
      ],
    }],
    [], "user_edit_wins", {},
  );
  const k2 = findByPk(rows2, "k2");
  check(k2?.operation === "delete", "k2 delete (terminal tombstone)", k2?.operation, "delete");
  check(k2?.properties && Object.keys(k2.properties).length === 0, "k2 props={} (tombstoned)", k2?.properties, {});
  check(k2?.source_transaction_id === "t2", "k2 src tx=t2 (last row is DELETE)", k2?.source_transaction_id, "t2");
}

// ---------------------------------------------------------------------------
// Case (c): markings union across 3 datasources (DELETE carries forward).
// ---------------------------------------------------------------------------
async function caseC() {
  console.log("\n[case C] markings union across 3 datasources");
  const rows: MergedRow[] = await runOverlaySQL(
    [
      { datasource_id: "ds1", owned_properties: ["a"], markings: ["m1", " m2 "],
        rows: [{ primary_key: "k1", operation: "INSERT", properties: { a: 1 }, source_transaction_id: "t1", source_commit_timestamp: "2020-01-01T00:00:00Z" }] },
      { datasource_id: "ds2", owned_properties: ["b"], markings: ["m2", "m3"],
        rows: [{ primary_key: "k1", operation: "INSERT", properties: { b: 2 }, source_transaction_id: "t2", source_commit_timestamp: "2020-01-02T00:00:00Z" }] },
      { datasource_id: "ds3", owned_properties: ["c"], markings: ["m4"],
        rows: [{ primary_key: "k1", operation: "DELETE", properties: {}, source_transaction_id: "t3", source_commit_timestamp: "2020-01-03T00:00:00Z" }] },
    ],
    [], "user_edit_wins", {},
  );
  const k1 = findByPk(rows, "k1");
  // ds3's DELETE is terminal → k1 tombstoned → delete. But markings carry
  // forward across ALL contributions (m1, m2, m3, m4) — unionMarkings.
  check(k1?.operation === "delete", "k1 delete (terminal tombstone from ds3)", k1?.operation, "delete");
  check(JSON.stringify(k1?.markings) === JSON.stringify(["m1", "m2", "m3", "m4"]), "k1 markings union [m1,m2,m3,m4] (trim+dedup+sort, DELETE carries forward)", k1?.markings, ["m1", "m2", "m3", "m4"]);
}

// ---------------------------------------------------------------------------
// Case (d): user_edit_wins — edit pins a prop against a later source update.
// ---------------------------------------------------------------------------
async function caseD() {
  console.log("\n[case D] user_edit_wins pins prop vs later source update");
  const rows: MergedRow[] = await runOverlaySQL(
    [{
      datasource_id: "ds-d", owned_properties: ["name", "val"], markings: [],
      rows: [{ primary_key: "k1", operation: "INSERT", properties: { name: "Source", val: 1 }, source_transaction_id: "t1", source_commit_timestamp: "2020-01-01T00:00:00Z" }],
    }],
    [{ primary_key: "k1", operation: "update", executed_at: "2019-01-01T00:00:00Z", property_values: { name: "UserEdit" } }],
    "user_edit_wins", {},
  );
  const k1 = findByPk(rows, "k1");
  // user_edit_wins: even though the edit's createdAt (2019) is OLDER than the
  // source timestamp (2020), the edited prop is pinned.
  check(k1?.properties.name === "UserEdit", "k1 name=UserEdit (pinned, edit older than source but user_edit_wins)", k1?.properties);
  check(k1?.properties.val === 1, "k1 val=1 (unedited tracks source)", k1?.properties);
}

// ---------------------------------------------------------------------------
// Case (e): latest_wins — edit wins only when createdAt > source_timestamp.
// ---------------------------------------------------------------------------
async function caseE() {
  console.log("\n[case E] latest_wins (edit wins iff createdAt > source_timestamp)");
  // (e1) edit newer than source → edit wins
  const rowsNew: MergedRow[] = await runOverlaySQL(
    [{ datasource_id: "ds-e1", owned_properties: ["name", "val"], markings: [],
      rows: [{ primary_key: "k1", operation: "INSERT", properties: { name: "Source", val: 1 }, source_transaction_id: "t1", source_commit_timestamp: "2020-01-01T00:00:00Z" }] }],
    [{ primary_key: "k1", operation: "update", executed_at: "2021-01-01T00:00:00Z", property_values: { name: "EditNewer" } }],
    "latest_wins", {},
  );
  const k1new = findByPk(rowsNew, "k1");
  check(k1new?.properties.name === "EditNewer", "e1: edit newer → name=EditNewer", k1new?.properties);
  check(k1new?.properties.val === 1, "e1: val=1 (unaffected)", k1new?.properties);

  // (e2) edit older than source → source wins (edit NOT pinned)
  const rowsOld: MergedRow[] = await runOverlaySQL(
    [{ datasource_id: "ds-e2", owned_properties: ["name", "val"], markings: [],
      rows: [{ primary_key: "k1", operation: "INSERT", properties: { name: "Source", val: 1 }, source_transaction_id: "t1", source_commit_timestamp: "2020-01-01T00:00:00Z" }] }],
    [{ primary_key: "k1", operation: "update", executed_at: "2019-01-01T00:00:00Z", property_values: { name: "EditOlder" } }],
    "latest_wins", {},
  );
  const k1old = findByPk(rowsOld, "k1");
  check(k1old?.properties.name === "Source", "e2: edit older → name=Source (source wins)", k1old?.properties);
}

// ---------------------------------------------------------------------------
// Case (f): user-only edit (no source row) — base from existing, edit applied.
// ---------------------------------------------------------------------------
async function caseF() {
  console.log("\n[case F] user-only edit (no source row, base from existing)");
  const rows: MergedRow[] = await runOverlaySQL(
    [],  // no contributions — no source rows
    [{ primary_key: "k1", operation: "update", executed_at: "2020-06-01T00:00:00Z", property_values: { name: "UserOnly" } }],
    "user_edit_wins",
    { k1: { properties: { name: "Existing", val: 9 }, markings: ["ex"], source_datasource_id: "ds-prev", source_transaction_id: "t-prev" } },
  );
  const k1 = findByPk(rows, "k1");
  check(k1?.operation === "upsert", "k1 upsert (user-only edit, no source)", k1?.operation, "upsert");
  check(k1?.properties.name === "UserOnly", "k1 name=UserOnly (edit overlays existing)", k1?.properties);
  check(k1?.properties.val === 9, "k1 val=9 (carried from existing)", k1?.properties);
  check(JSON.stringify(k1?.markings) === JSON.stringify(["ex"]), "k1 markings=[ex] (from existing, no source markings)", k1?.markings, ["ex"]);
}

// ---------------------------------------------------------------------------
// Case (g): delete-only-no-source PK (user delete edit, no source, no existing)
// → delete with markings=[].
// ---------------------------------------------------------------------------
async function caseG() {
  console.log("\n[case G] delete-only-no-source (user delete, no source/existing)");
  const rows: MergedRow[] = await runOverlaySQL(
    [],
    [{ primary_key: "k1", operation: "delete", executed_at: "2020-06-01T00:00:00Z" }],
    "user_edit_wins", {},
  );
  const k1 = findByPk(rows, "k1");
  check(k1?.operation === "delete", "k1 delete (user delete, no source)", k1?.operation, "delete");
  check(JSON.stringify(k1?.markings) === JSON.stringify([]), "k1 markings=[] (delete-only-no-source COALESCE fix)", k1?.markings, []);
  check(k1?.source_datasource_id === null, "k1 src ds=null (no source)", k1?.source_datasource_id, null);
}

// ---------------------------------------------------------------------------
// Case (h): multi-row-per-PK within a contribution (glob_seq fold order)
// ---------------------------------------------------------------------------
async function caseH() {
  console.log("\n[case H] multi-row-per-PK within contribution (fold order)");
  // Same PK k1 gets INSERT(name=A), UPDATE(name=B), INSERT(name=C). The
  // effective row (last non-DELETE since last DELETE) should be name=C.
  const rows: MergedRow[] = await runOverlaySQL(
    [{
      datasource_id: "ds-h", owned_properties: ["name"], markings: [],
      rows: [
        { primary_key: "k1", operation: "INSERT", properties: { name: "A" }, source_transaction_id: "t1", source_commit_timestamp: "2020-01-01T00:00:00Z" },
        { primary_key: "k1", operation: "UPDATE", properties: { name: "B" }, source_transaction_id: "t2", source_commit_timestamp: "2020-01-02T00:00:00Z" },
        { primary_key: "k1", operation: "INSERT", properties: { name: "C" }, source_transaction_id: "t3", source_commit_timestamp: "2020-01-03T00:00:00Z" },
      ],
    }],
    [], "user_edit_wins", {},
  );
  const k1 = findByPk(rows, "k1");
  check(k1?.operation === "upsert", "k1 upsert");
  check(k1?.properties.name === "C", "k1 name=C (last live row wins)", k1?.properties);
  check(k1?.source_transaction_id === "t3", "k1 src tx=t3 (last row)", k1?.source_transaction_id, "t3");
}

async function main() {
  await caseA();
  await caseB();
  await caseC();
  await caseD();
  await caseE();
  await caseF();
  await caseG();
  await caseH();
  await __resetPoolForTests();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERR:", e.message, e.stack); process.exit(1); });
