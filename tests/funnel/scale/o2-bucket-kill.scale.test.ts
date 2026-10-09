// O2 — bucketed merge with duplicates, SIGKILL of the out-of-process DuckDB
// CLI mid-bucket, resume by runKey.
//
// v1 is indexed normally. The v2 merge runs on the production code path
// (out-of-process CLI, narrow dedup, fast path off so the dedup sort runs,
// bucket target = rows/4 ⇒ ≥4 hash buckets). Once ≥1 bucket checkpoint is
// committed, the live DuckDB CLI child is SIGKILLed. Then:
//   * the merge fails and object_instances still holds exactly v1;
//   * retrying with the SAME runKey skips the completed buckets (their
//     checkpoint rows are not rewritten) and lands exactly v2.
// For small (PR-lite) sizes a pacing shim delays each CLI start so the kill
// reliably lands inside a bucket; at nightly sizes buckets take seconds and
// TELLUS_SCALE_PACE_MS=0 runs the bare CLI.
import { LANE } from "../../laneEnv";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setFunnelRuntimeOverridesForTesting } from "../../../src/config/funnelRuntime";
import {
  ONTOLOGY_ID, childPids, cleanupScaleType, createScaleType, datasetShape, duckdbCli, expectedSnapshot,
  generateCsv, hasDuckdbCli, liveSnapshot, sampleIds, scaleRows, sleep, uploadCsv, workDir, writeReport, type ScaleType,
} from "./scaleHarness";

const ROWS = scaleRows();
const DS = datasetShape(ROWS, 0.25);
const STAMP = Date.now();
const API = `ScaleO2_${ROWS}_${STAMP}`;
const KEY_PREFIX = `tests/scale/o2/${STAMP}`;
const PACE_MS = Number(process.env.TELLUS_SCALE_PACE_MS ?? (ROWS <= 1_000_000 ? 400 : 0));

let db: typeof import("../../../src/db");
let storage: typeof import("../../../src/services/storageService");
let acts: typeof import("../../../src/services/funnel/temporal/activities");
let t: ScaleType | null = null;

const ctx = () => ({ ontologyId: ONTOLOGY_ID, objectTypeApiName: API, objectTypeRid: t!.objectTypeId, environmentId: LANE.TELLUS_ENVIRONMENT_ID });

beforeAll(async () => {
  await (await import("../../../src/services/testing/destructiveTestGuard")).assertDestructiveTestEnvironment({
    operation: "funnel-scale-o2",
    skipApiProbe: true,
  });
  db = await import("../../../src/db");
  storage = await import("../../../src/services/storageService");
  acts = await import("../../../src/services/funnel/temporal/activities");
  await storage.ensureBucket();
});

afterAll(async () => {
  setFunnelRuntimeOverridesForTesting(null);
  if (db) await cleanupScaleType(db, storage, t, KEY_PREFIX);
});

describe.skipIf(!hasDuckdbCli())(`O2 bucketed OOP merge, SIGKILL mid-bucket @ ${ROWS} rows`, () => {
  it("leaves live unchanged and resumes by runKey skipping completed buckets", { timeout: 4 * 3_600_000 }, async () => {
    const dir = workDir(API);
    const key = `${KEY_PREFIX}/source.csv`;
    t = await createScaleType(db, API, key);
    const ids = sampleIds(DS, 2);

    let cli = duckdbCli();
    if (PACE_MS > 0) {
      cli = path.join(dir, "duckdb-paced.sh");
      fs.writeFileSync(cli, `#!/bin/sh\nsleep ${(PACE_MS / 1000).toFixed(3)}\nexec ${duckdbCli()} "$@"\n`, { mode: 0o755 });
    }
    const bucketTarget = Math.ceil(DS.distinct / 4);
    setFunnelRuntimeOverridesForTesting({
      mergeOutOfProcess: true,
      duckdbCliPath: cli,
      mergeFastPath: false,
      mergeNarrowDedup: true,
      mergeBucketTargetRows: bucketTarget,
    });

    generateCsv(path.join(dir, "v1.csv"), DS, 1);
    await uploadCsv(storage, key, path.join(dir, "v1.csv"));
    const cl1 = await acts.runChangelogActivity(ctx());
    await acts.runMergeActivity({ ...ctx(), changelogSnapshotId: cl1.snapshotId, changelogOwnedProperties: cl1.ownedProperties, runKey: `${API}-v1` });
    const v1 = expectedSnapshot(DS, 1, ids);
    expect(await liveSnapshot(db, API, ids)).toEqual(v1);

    generateCsv(path.join(dir, "v2.csv"), DS, 2);
    await uploadCsv(storage, key, path.join(dir, "v2.csv"));
    const cl2 = await acts.runChangelogActivity(ctx());
    const runKey = `${API}-v2`;
    const mergeInput = { ...ctx(), changelogSnapshotId: cl2.snapshotId, changelogOwnedProperties: cl2.ownedProperties, runKey };

    const completed = async () =>
      (
        await db.query(
          `SELECT bucket_id, updated_at FROM funnel_merge_bucket WHERE run_key = $1 AND status = 'completed' ORDER BY bucket_id`,
          [runKey],
        )
      ).rows as Array<{ bucket_id: number; updated_at: Date | string }>;

    const attempt = acts.runMergeActivity(mergeInput).then(
      () => null,
      (e: unknown) => e,
    );
    let killed: number[] = [];
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      if ((await completed()).length >= 1) {
        const kids = childPids(process.pid);
        if (kids.length > 0) {
          for (const pid of kids) {
            try {
              process.kill(pid, "SIGKILL");
              killed.push(pid);
            } catch {
              /* exited */
            }
          }
          if (killed.length > 0) break;
        }
      }
      await sleep(10);
    }
    const err = await attempt;
    const before = await completed();
    const live = await liveSnapshot(db, API, ids);
    console.log(`[scale] O2 killed=${killed.join(",")} completedBuckets=${before.length} err=${String(err).slice(0, 200)}`);

    expect(killed.length, "a DuckDB CLI child was killed").toBeGreaterThan(0);
    expect(err, "the killed merge fails").toBeTruthy();
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(live, "live object_instances unchanged after the kill").toEqual(v1);

    const resumed = await acts.runMergeActivity(mergeInput);
    const after = await completed();
    const live2 = await liveSnapshot(db, API, ids);
    const report = {
      suite: "O2", rows: ROWS, dataset: DS, bucketTarget, paceMs: PACE_MS, killedPids: killed,
      bucketsCompletedBeforeKill: before.map((b) => b.bucket_id), bucketsAfterResume: after.map((b) => b.bucket_id),
      resumed: { objectsIndexed: resumed.objectsIndexed, upserts: resumed.upserts },
    };
    console.log(`[scale] report ${writeReport(`o2-${ROWS}`, report)}`);

    expect(after.length).toBeGreaterThan(before.length);
    for (const b of before) {
      const same = after.find((a) => a.bucket_id === b.bucket_id);
      expect(same ? new Date(same.updated_at).getTime() : null, `bucket ${b.bucket_id} skipped on resume`).toBe(new Date(b.updated_at).getTime());
    }
    expect(resumed.objectsIndexed).toBe(DS.distinct + DS.newRows);
    expect(live2).toEqual(expectedSnapshot(DS, 2, ids));
    const staging = await db.query(`SELECT count(*)::int AS n FROM merge_staging_instances WHERE object_type_api_name = $1`, [API]);
    expect(staging.rows[0].n).toBe(0);
  });
});
