/**
 * FOUNDRY-GAPS §6 — LIVE verification of Iceberg branches & tags.
 *
 * Drives the PRODUCTION sidecar bridge functions (icebergCreateBranch /
 * CreateTag / ListRefs / DropRef / FastForward) against the REAL running
 * Lakekeeper REST catalog + MinIO — no mocks. Creates a throwaway table,
 * exercises the full ref lifecycle, asserts the catalog actually persisted
 * each ref, and cleans up.
 *
 * Run (host talks to localhost; DNS override maps minio/lakekeeper→127.0.0.1):
 *   LAKEKEEPER_URL=http://localhost:8181 S3_ENDPOINT=http://minio:9000 \
 *   PB_B4_LOCAL_DNS_OVERRIDE=1 LAKEKEEPER_PIPELINE_WAREHOUSE=tellus-funnel \
 *   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *   npx tsx scripts/verify-iceberg-refs-live.ts
 */
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";
import {
  icebergCreateOrGet,
  icebergAppend,
  icebergSnapshots,
  icebergCreateBranch,
  icebergCreateTag,
  icebergListRefs,
  icebergDropRef,
  icebergFastForward,
  icebergSidecarAvailable,
} from "../src/services/pipelines/icebergSidecar";

const WAREHOUSE = process.env.LAKEKEEPER_PIPELINE_WAREHOUSE ?? "tellus-funnel";
const STAMP = Date.now().toString().slice(-9);
const NS = `_refs_live.t_${STAMP}`;
const TABLE = "refs_demo";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✔\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✘ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  }
}

function parquetFixture(rows: Array<{ id: number; status: string }>): string {
  const p = path.join(os.tmpdir(), `refs-${randomUUID()}.parquet`);
  const script = `
import sys, json
import pyarrow as pa, pyarrow.parquet as pq
rows = json.loads(sys.argv[1])
pq.write_table(pa.table({"id":[r["id"] for r in rows],"status":[r["status"] for r in rows]}), sys.argv[2], compression="zstd")
`;
  const res = spawnSync("python3", ["-c", script, JSON.stringify(rows), p], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`parquet fixture failed: ${res.stderr}`);
  return p;
}

async function main(): Promise<void> {
  console.log(`\n── §6 Iceberg branches & tags — LIVE against ${process.env.LAKEKEEPER_URL} (warehouse=${WAREHOUSE}) ──\n`);

  if (!(await icebergSidecarAvailable())) {
    console.error("PyIceberg sidecar unavailable — install pyiceberg+pyarrow.");
    process.exit(2);
  }

  const common = { warehouse: WAREHOUSE, namespace: NS, table: TABLE };

  // 1. Real table + first commit → snapshot A.
  await icebergCreateOrGet({ ...common, columns: [
    { name: "id", type: "integer" }, { name: "status", type: "string" },
  ]});
  const f1 = parquetFixture([{ id: 1, status: "a" }, { id: 2, status: "b" }]);
  const appA = await icebergAppend({ ...common, parquetFiles: [f1] });
  fs.rmSync(f1, { force: true });
  const snapA = appA.snapshotId;
  check("table created + first append committed a snapshot", !!snapA, `snapshot=${snapA}`);

  // 2. Create a branch + a tag at snapshot A.
  const br = await icebergCreateBranch({ ...common, refName: "dev" });
  check("create_branch 'dev' returns branch type at snapshot A", br.type === "branch" && br.snapshotId === snapA, `${br.type}@${br.snapshotId}`);
  const tg = await icebergCreateTag({ ...common, refName: "v1" });
  check("create_tag 'v1' returns tag type at snapshot A", tg.type === "tag" && tg.snapshotId === snapA, `${tg.type}@${tg.snapshotId}`);

  // 3. Catalog actually persisted them.
  const refs1 = await icebergListRefs(common);
  const names1 = refs1.refs.map((r) => r.name).sort();
  check("list_refs shows main + dev + v1 (catalog persisted)", ["dev", "main", "v1"].every((n) => names1.includes(n)), names1.join(","));
  const devRow = refs1.refs.find((r) => r.name === "dev");
  const v1Row = refs1.refs.find((r) => r.name === "v1");
  check("dev is type=branch, v1 is type=tag in catalog metadata", devRow?.type === "branch" && v1Row?.type === "tag", `dev=${devRow?.type} v1=${v1Row?.type}`);

  // 4. Advance main, then fast-forward dev → main.
  const f2 = parquetFixture([{ id: 3, status: "c" }]);
  const appB = await icebergAppend({ ...common, parquetFiles: [f2] });
  fs.rmSync(f2, { force: true });
  const snapB = appB.snapshotId;
  check("second append advances main to a new snapshot B", !!snapB && snapB !== snapA, `B=${snapB}`);

  const ff = await icebergFastForward({ ...common, branchName: "dev", toRef: "main" });
  check("fast_forward dev → main moves dev to snapshot B", ff.fastForwarded && ff.snapshotId === snapB, `dev now @${ff.snapshotId}`);
  const refs2 = await icebergListRefs(common);
  check("list_refs confirms dev advanced; v1 tag still pinned at A", refs2.refs.find((r) => r.name === "dev")?.snapshot_id === snapB && refs2.refs.find((r) => r.name === "v1")?.snapshot_id === snapA);

  // 5. Drop the tag.
  const dropped = await icebergDropRef({ ...common, refName: "v1" });
  check("drop_ref 'v1' reports type=tag dropped", dropped.dropped === "v1" && dropped.type === "tag", `${dropped.type}`);
  const refs3 = await icebergListRefs(common);
  check("list_refs no longer contains v1 (catalog mutated)", !refs3.refs.some((r) => r.name === "v1"), refs3.refs.map((r) => r.name).join(","));

  console.log(`\n${failed === 0 ? "\x1b[32m✔ ALL LIVE §6 CHECKS PASSED" : "\x1b[31m✘ SOME CHECKS FAILED"}\x1b[0m — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\x1b[31mLIVE §6 harness crashed:\x1b[0m", err);
  process.exit(1);
});
