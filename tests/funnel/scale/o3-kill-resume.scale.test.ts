// O3 — kill the whole merge WORKER mid staging-load, then resume.
//
// v1 is indexed. The v2 merge runs in a child Node process
// (mergeRunner.ts). As soon as that process's Postgres backend is touching
// merge_staging_instances, the child is SIGKILLed (its open transaction dies
// with the connection). Then:
//   * object_instances still equals v1 exactly (staging never leaks live);
//   * a fresh process retrying the identical activity input promotes v2
//     exactly once: exact count, sampled last-wins values, no staging rows,
//     and a second retry after success changes nothing.
import { LANE } from "../../laneEnv";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ONTOLOGY_ID, cleanupScaleType, createScaleType, datasetShape, expectedSnapshot, generateCsv,
  liveSnapshot, sampleIds, scaleRows, sleep, uploadCsv, workDir, writeReport, type ScaleType,
} from "./scaleHarness";

const ROWS = scaleRows();
const DS = datasetShape(ROWS, 0.1);
const STAMP = Date.now();
const API = `ScaleO3_${ROWS}_${STAMP}`;
const KEY_PREFIX = `tests/scale/o3/${STAMP}`;
const RUNNER = path.resolve(__dirname, "mergeRunner.ts");

let db: typeof import("../../../src/db");
let storage: typeof import("../../../src/services/storageService");
let acts: typeof import("../../../src/services/funnel/temporal/activities");
let t: ScaleType | null = null;

const ctx = () => ({ ontologyId: ONTOLOGY_ID, objectTypeApiName: API, objectTypeRid: t!.objectTypeId, environmentId: LANE.TELLUS_ENVIRONMENT_ID });

function startRunner(input: unknown) {
  const child = spawn(process.execPath, ["--import", "tsx", RUNNER, JSON.stringify(input)], {
    cwd: path.resolve(__dirname, "../../.."),
    env: { ...process.env, PGAPPNAME: `scale-o3-${STAMP}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (out += String(d)));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal, out })),
  );
  return { child, done };
}

beforeAll(async () => {
  await (await import("../../../src/services/testing/destructiveTestGuard")).assertDestructiveTestEnvironment({
    operation: "funnel-scale-o3",
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

describe(`O3 kill merge worker mid staging-load, resume @ ${ROWS} rows`, () => {
  it("keeps live unchanged and promotes exactly once on resume", { timeout: 4 * 3_600_000 }, async () => {
    const dir = workDir(API);
    const key = `${KEY_PREFIX}/source.csv`;
    t = await createScaleType(db, API, key);
    const ids = sampleIds(DS, 2);

    generateCsv(path.join(dir, "v1.csv"), DS, 1);
    await uploadCsv(storage, key, path.join(dir, "v1.csv"));
    const cl1 = await acts.runChangelogActivity(ctx());
    await acts.runMergeActivity({ ...ctx(), changelogSnapshotId: cl1.snapshotId, changelogOwnedProperties: cl1.ownedProperties });
    const v1 = expectedSnapshot(DS, 1, ids);
    expect(await liveSnapshot(db, API, ids)).toEqual(v1);

    generateCsv(path.join(dir, "v2.csv"), DS, 2);
    await uploadCsv(storage, key, path.join(dir, "v2.csv"));
    const cl2 = await acts.runChangelogActivity(ctx());
    const input = { ...ctx(), changelogSnapshotId: cl2.snapshotId, changelogOwnedProperties: cl2.ownedProperties, runKey: `${API}-v2` };

    // Attempt 1: SIGKILL the worker once its backend is in the staging load.
    const a1 = startRunner(input);
    let killedAt: string | null = null;
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline && a1.child.exitCode === null) {
      const r = await db.query(
        `SELECT query FROM pg_stat_activity WHERE application_name = $1 AND query ILIKE 'INSERT INTO merge_staging_instances%' LIMIT 1`,
        [`scale-o3-${STAMP}`],
      );
      if (r.rows.length > 0) {
        killedAt = String(r.rows[0].query).replace(/\s+/g, " ").slice(0, 120);
        a1.child.kill("SIGKILL");
        break;
      }
      await sleep(5);
    }
    const r1 = await a1.done;
    // Let Postgres notice the dropped connection and roll the txn back.
    for (let i = 0; i < 100; i++) {
      const n = await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`, [`scale-o3-${STAMP}`]);
      if (n.rows[0].n === 0) break;
      await sleep(100);
    }
    const liveAfterKill = await liveSnapshot(db, API, ids);
    console.log(`[scale] O3 killedAt=${killedAt} signal=${r1.signal}`);

    expect(killedAt, "worker reached the staging load before finishing").not.toBeNull();
    expect(r1.signal).toBe("SIGKILL");
    expect(liveAfterKill, "live unchanged after worker kill").toEqual(v1);

    // Attempt 2: fresh process, identical input.
    const a2 = startRunner(input);
    const r2 = await a2.done;
    expect(r2.code, r2.out.slice(-2000)).toBe(0);
    const res2 = JSON.parse(/MERGE_RESULT (.*)/.exec(r2.out)![1]);
    const live2 = await liveSnapshot(db, API, ids);
    expect(res2.objectsIndexed).toBe(DS.distinct + DS.newRows);
    expect(live2).toEqual(expectedSnapshot(DS, 2, ids));
    const staging = await db.query(`SELECT count(*)::int AS n FROM merge_staging_instances WHERE object_type_api_name = $1`, [API]);
    expect(staging.rows[0].n, "no staging rows after promote").toBe(0);
    const dupes = await db.query(
      `SELECT count(*)::int AS n FROM (SELECT primary_key FROM object_instances WHERE ontology_id = $1 AND object_type_api_name = $2
         GROUP BY branch_id, primary_key HAVING count(*) > 1) d`,
      [ONTOLOGY_ID, API],
    );
    expect(dupes.rows[0].n).toBe(0);

    // Attempt 3: a duplicate delivery after success is a no-op on live data.
    const a3 = startRunner(input);
    const r3 = await a3.done;
    expect(r3.code, r3.out.slice(-2000)).toBe(0);
    expect(await liveSnapshot(db, API, ids)).toEqual(live2);

    console.log(`[scale] report ${writeReport(`o3-${ROWS}`, { suite: "O3", rows: ROWS, dataset: DS, killedAt, resumed: res2 })}`);
  });
});
