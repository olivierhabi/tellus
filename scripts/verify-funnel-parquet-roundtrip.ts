// Real DuckDB + real MinIO round-trip for the funnel parquet store.
// Verifies writeParquetRef + readParquetRows (changelog + merged) end-to-end
// — the actual parquet encode (DuckDB COPY ... FORMAT PARQUET) + decode
// (read_parquet) + MinIO multipart upload/download. Run via `npx tsx`.
import "dotenv/config";
import {
  writeParquetRef,
  readParquetRows,
  CHANGELOG_PARQUET_COLUMNS,
  MERGED_PARQUET_COLUMNS,
  changelogParquetKey,
  mergedParquetKey,
  parseJsonColumn,
  parseJsonArrayColumn,
  PARQUET_REF_VERSION,
} from "../src/services/funnel/funnelParquetStore";
import { deleteObject } from "../src/services/storageService";

const N = 5000;
let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("  ✗ " + msg);
    failures++;
  } else {
    console.log("  ✓ " + msg);
  }
}

async function main() {
  console.log(`[round-trip] changelog ${N} rows`);
  const rows = Array.from({ length: N }, (_, i) => ({
    primary_key: `pk-${i}`,
    operation: i % 7 === 0 ? "UPDATE" : "INSERT",
    properties: JSON.stringify({ orderId: i, customerId: `c-${i % 50}`, status: "ok" }),
    source_transaction_id: "00000000-0000-0000-0000-000000000000",
    source_commit_timestamp: "2026-07-10T00:00:00.000Z",
  }));
  const key = changelogParquetKey("_roundtrip-verify", "snap-cl-" + N);
  const ref = await writeParquetRef({
    columns: CHANGELOG_PARQUET_COLUMNS,
    rows: (async function* () {
      for (const r of rows) yield r;
    })(),
    key,
    objectTypeApiName: "_roundtrip-verify",
    stage: "changelog",
  });
  assert(ref !== null, "writeParquetRef returned a non-null ref");
  assert(ref!.refVersion === PARQUET_REF_VERSION, `refVersion=${ref!.refVersion}`);
  assert(ref!.rowCount === N, `rowCount=${ref!.rowCount} (expected ${N})`);
  assert(ref!.sizeBytes > 0, `sizeBytes=${ref!.sizeBytes} > 0`);
  assert(ref!.bucket === "tellus-uploads", `bucket=${ref!.bucket}`);
  assert(ref!.key === key, `key=${ref!.key}`);

  const back = await readParquetRows(ref!, (r) => ({
    primary_key: String(r.primary_key),
    operation: String(r.operation),
    properties: JSON.parse(String(r.properties)),
  }));
  assert(back.length === N, `read count=${back.length} (expected ${N})`);
  assert(back[0].primary_key === "pk-0", `first=${back[0]?.primary_key}`);
  assert(back[N - 1].primary_key === `pk-${N - 1}`, `last=${back[N - 1]?.primary_key}`);
  assert(back[7].operation === "UPDATE", `op[7]=${back[7]?.operation}`);
  assert(JSON.stringify(back[0].properties) === JSON.stringify({ orderId: 0, customerId: "c-0", status: "ok" }), "properties round-trip equal");
  // order preserved
  let orderOk = true;
  for (let i = 0; i < back.length; i++) if (back[i].primary_key !== `pk-${i}`) { orderOk = false; break; }
  assert(orderOk, "row order preserved");
  await deleteObject(key).catch(() => {});

  console.log(`[round-trip] merged ${N} rows (markings JSON array)`);
  const mrows = Array.from({ length: N }, (_, i) => ({
    primary_key: `pk-${i}`,
    properties: JSON.stringify({ orderId: i }),
    markings: JSON.stringify(["m1", "m2"]),
    operation: i % 10 === 0 ? "delete" : "upsert",
    source_datasource_id: i % 10 === 0 ? "" : "00000000-0000-0000-0000-000000000000",
    source_transaction_id: "00000000-0000-0000-0000-000000000000",
  }));
  const mkey = mergedParquetKey("_roundtrip-verify", "snap-merged-" + N);
  const mref = await writeParquetRef({
    columns: MERGED_PARQUET_COLUMNS,
    rows: (async function* () {
      for (const r of mrows) yield r;
    })(),
    key: mkey,
    objectTypeApiName: "_roundtrip-verify",
    stage: "merged",
  });
  const mback = await readParquetRows(mref!, (r) => ({
    primary_key: String(r.primary_key),
    properties: parseJsonColumn(r.properties),
    markings: parseJsonArrayColumn(r.markings),
    operation: r.operation === "delete" ? "delete" : "upsert",
    source_datasource_id:
      r.source_datasource_id != null && r.source_datasource_id !== ""
        ? String(r.source_datasource_id)
        : null,
  }));
  assert(mback.length === N, `merged read count=${mback.length}`);
  assert(mback[0].markings.length === 2 && mback[0].markings[0] === "m1", `markings=${JSON.stringify(mback[0]?.markings)}`);
  // row 0: i%10===0 → delete; row 1 → upsert
  assert(mback[0].operation === "delete", `merged op[0]=${mback[0]?.operation}`);
  assert(mback[1].operation === "upsert", `merged op[1]=${mback[1]?.operation}`);
  assert(mback[10].operation === "delete", `merged op[10]=${mback[10]?.operation}`);
  // empty source_datasource_id is stored as NULL (toSqlLiteral "" → NULL),
  // read back as null — the null round-trips correctly.
  assert(mback[10].source_datasource_id === null, `merged sdi[10]=${JSON.stringify(mback[10]?.source_datasource_id)}`);
  await deleteObject(mkey).catch(() => {});

  console.log(failures === 0 ? "\nROUND-TRIP PASS" : `\nROUND-TRIP FAIL (${failures} assertions)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
