// O1 — 1M/5M/10M benchmarks with budgets (TELLUS_SCALE_ROWS; 100k = PR lite).
// Full pass (10 % duplicate rows) then an incremental pass (5 % changed, 1 %
// new) through the REAL changelog → merge activities; exact counts and
// sampled last-wins values; wall time + Node maxRSS vs budgets.json. The
// report lands in TELLUS_SCALE_REPORT_DIR for the nightly artifact.
import { LANE } from "../../laneEnv";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import budgets from "./budgets.json";
import {
  ONTOLOGY_ID, cleanupScaleType, createScaleType, datasetShape, expectedSnapshot, generateCsv,
  liveSnapshot, sampleIds, scaleRows, uploadCsv, workDir, writeReport, type ScaleType,
} from "./scaleHarness";

const ROWS = scaleRows();
const DS = datasetShape(ROWS, 0.1);
const STAMP = Date.now();
const API = `ScaleO1_${ROWS}_${STAMP}`;
const KEY_PREFIX = `tests/scale/o1/${STAMP}`;
const BUDGET = (budgets as unknown as Record<string, { changelogMs: number; mergeMs: number; incrementalMergeMs: number; maxRssMb: number }>)[
  String(ROWS)
];

let db: typeof import("../../../src/db");
let storage: typeof import("../../../src/services/storageService");
let acts: typeof import("../../../src/services/funnel/temporal/activities");
let t: ScaleType | null = null;

beforeAll(async () => {
  await (await import("../../../src/services/testing/destructiveTestGuard")).assertDestructiveTestEnvironment({
    operation: "funnel-scale-o1",
    skipApiProbe: true,
  });
  db = await import("../../../src/db");
  storage = await import("../../../src/services/storageService");
  acts = await import("../../../src/services/funnel/temporal/activities");
  await storage.ensureBucket();
});

afterAll(async () => {
  if (db) await cleanupScaleType(db, storage, t, KEY_PREFIX);
});

async function pass() {
  const ctx = { ontologyId: ONTOLOGY_ID, objectTypeApiName: API, objectTypeRid: t!.objectTypeId, environmentId: LANE.TELLUS_ENVIRONMENT_ID };
  const t0 = Date.now();
  const cl = await acts.runChangelogActivity(ctx);
  const t1 = Date.now();
  const m = await acts.runMergeActivity({ ...ctx, changelogSnapshotId: cl.snapshotId, changelogOwnedProperties: cl.ownedProperties });
  const t2 = Date.now();
  const p = await db.query(`SELECT summary_json->>'merge_path' AS p FROM funnel_snapshot WHERE snapshot_id = $1`, [m.mergedSnapshotId]);
  return { changelogMs: t1 - t0, mergeMs: t2 - t1, rowsEmitted: cl.rowsEmitted, objectsIndexed: m.objectsIndexed, upserts: m.upserts, mergePath: p.rows[0]?.p ?? null };
}

describe(`O1 funnel benchmark @ ${ROWS} rows`, () => {
  it("full + incremental passes are exact and within budget", { timeout: 4 * 3_600_000 }, async () => {
    const dir = workDir(API);
    const key = `${KEY_PREFIX}/source.csv`;
    t = await createScaleType(db, API, key);
    const ids = sampleIds(DS, 2);

    const g0 = Date.now();
    generateCsv(path.join(dir, "v1.csv"), DS, 1);
    await uploadCsv(storage, key, path.join(dir, "v1.csv"));
    const genMs = Date.now() - g0;
    const full = await pass();
    const live1 = await liveSnapshot(db, API, ids);

    generateCsv(path.join(dir, "v2.csv"), DS, 2);
    await uploadCsv(storage, key, path.join(dir, "v2.csv"));
    const inc = await pass();
    const live2 = await liveSnapshot(db, API, ids);
    const maxRssMb = Math.round(process.resourceUsage().maxRSS / 1024);

    const report = {
      suite: "O1", rows: ROWS, dataset: DS, profile: process.env.TELLUS_DEPLOYMENT_STRICT === "1" ? "production" : "test",
      genAndUploadMs: genMs, full, incremental: { ...inc, mergeMs: inc.mergeMs }, maxRssMb, budget: BUDGET ?? null,
    };
    console.log(`[scale] report ${writeReport(`o1-${ROWS}`, report)}`);

    expect(full.rowsEmitted).toBe(DS.distinct);
    expect(full.objectsIndexed).toBe(DS.distinct);
    expect(live1).toEqual(expectedSnapshot(DS, 1, ids));
    expect(inc.objectsIndexed).toBe(DS.distinct + DS.newRows);
    expect(live2).toEqual(expectedSnapshot(DS, 2, ids));
    // Production profile: any dedup sort runs in the DuckDB CLI child. The
    // sort-free fast path (single contribution, provably unique PKs) stays
    // in-process by design — it has no sort to spill — and this benchmark's
    // maxRSS budget is what bounds it at 10M rows.
    if (process.env.TELLUS_EXPECT_OOP_MERGE === "1") {
      for (const p of [full.mergePath, inc.mergePath]) expect(p).toMatch(/^duckdb_sql_fast$|_cli$/);
    }

    if (BUDGET && process.env.TELLUS_SCALE_ENFORCE_BUDGETS !== "0") {
      expect(full.changelogMs, "full changelog wall").toBeLessThanOrEqual(BUDGET.changelogMs);
      expect(full.mergeMs, "full merge wall").toBeLessThanOrEqual(BUDGET.mergeMs);
      expect(inc.mergeMs, "incremental merge wall").toBeLessThanOrEqual(BUDGET.incrementalMergeMs);
      expect(maxRssMb, "Node maxRSS MiB").toBeLessThanOrEqual(BUDGET.maxRssMb);
    }
  });
});
