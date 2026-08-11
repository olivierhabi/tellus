#!/usr/bin/env node
// Live per-stage row audit for pipeline 0c05f9cf-c4cb-488c-8f5b-1e1497390caa
// "[Olivier] All Orders 10" — no cached / preview-snapshot counts, only
// what DuckDB sees executing the actual node configs against the live
// MinIO CSVs.
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import duckdb from "duckdb";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BUCKET = "tellus-uploads";
const sources = {
  bureau:
    "projects/36271681-65d7-4c55-a6d0-20137f8212dc/folders/5dc26e40-c4bf-4261-88b6-6ebc944a7130/08b7e750-10d8-4286-96c7-ad3d369f7b0e_orders_bureau_transactional_system.csv",
  office:
    "projects/36271681-65d7-4c55-a6d0-20137f8212dc/folders/5dc26e40-c4bf-4261-88b6-6ebc944a7130/3047bf7e-3c44-4024-8727-7e77ba3be04a_orders_office_goods.csv",
  cust:
    "projects/36271681-65d7-4c55-a6d0-20137f8212dc/folders/5dc26e40-c4bf-4261-88b6-6ebc944a7130/7ecf3d1e-cb38-485f-860b-3023d90674ac_consolidated_customers.csv",
  out:
    "projects/36271681-65d7-4c55-a6d0-20137f8212dc/pipeline-outputs/0c05f9cf-c4cb-488c-8f5b-1e1497390caa/_olivier__all_orders_10_2026-05-16T16-06-06-284Z.csv",
};

const s3 = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  forcePathStyle: true,
});

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "pipe-audit-"));

async function download(key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const local = path.join(tmpdir, path.basename(key));
  const ws = fs.createWriteStream(local);
  await new Promise((res, rej) => {
    r.Body.pipe(ws).on("finish", res).on("error", rej);
  });
  return local;
}

function all(db, sql, params = []) {
  return new Promise((res, rej) => {
    db.all(sql, ...params, (err, rows) => (err ? rej(err) : res(rows)));
  });
}

const bureauLocal = await download(sources.bureau);
const officeLocal = await download(sources.office);
const custLocal = await download(sources.cust);
const outLocal = await download(sources.out);

const db = new duckdb.Database(":memory:");
const con = db.connect();
const q = (sql) =>
  new Promise((res, rej) =>
    con.all(sql, (err, rows) => (err ? rej(err) : res(rows)))
  );

// Load raw inputs
await q(`CREATE TABLE bureau_raw AS SELECT * FROM read_csv_auto('${bureauLocal}', header=true)`);
await q(`CREATE TABLE office_raw AS SELECT * FROM read_csv_auto('${officeLocal}', header=true)`);
await q(`CREATE TABLE cust_raw   AS SELECT * FROM read_csv_auto('${custLocal}',   header=true)`);
await q(`CREATE TABLE out_csv    AS SELECT * FROM read_csv_auto('${outLocal}',    header=true)`);

async function count(t) {
  const r = await q(`SELECT COUNT(*) AS c FROM ${t}`);
  return Number(r[0].c);
}
async function cols(t) {
  const r = await q(`DESCRIBE ${t}`);
  return r.map((c) => c.column_name);
}

const bureauCols = await cols("bureau_raw");
const officeCols = await cols("office_raw");
const custCols = await cols("cust_raw");
const outCols = await cols("out_csv");

console.log("=== ENTRY STATE ===");
console.log(`bureau_raw rows=${await count("bureau_raw")}  cols=${bureauCols.join(",")}`);
console.log(`office_raw rows=${await count("office_raw")}  cols=${officeCols.join(",")}`);
console.log(`cust_raw   rows=${await count("cust_raw")}    cols=${custCols.join(",")}`);
console.log(`out_csv    rows=${await count("out_csv")}     cols=${outCols.join(",")}`);
console.log();

// ----- Clean Bureau (9e0686a4) -----
// Per node config: Cast order_due_date->timestamp, Filter order_id is_not_null
// (keep), Rename order_id->orderid, Normalize.
// Normalize lowercases column names; we mimic the end state.
await q(`CREATE TABLE clean_bureau AS
  SELECT
    LOWER(REGEXP_REPLACE(TRIM("order_id"), '[\\s]+', '_', 'g'))    AS orderid,
    "customer_id" AS customer_id,
    "status" AS status,
    "assignee" AS assignee,
    "quantity" AS quantity,
    "item_name" AS item_name,
    "unit_price" AS unit_price,
    TRY_CAST("order_due_date" AS TIMESTAMP) AS order_due_date,
    "days_until_due" AS days_until_due
  FROM bureau_raw
  WHERE "order_id" IS NOT NULL AND TRIM(CAST("order_id" AS VARCHAR)) <> ''`);
console.log(`Clean Bureau (9e0686a4):           in=${await count("bureau_raw")}  out=${await count("clean_bureau")}`);

// ----- Clean Office Goods (6c5a2645) -----
// Cast dueDateTime->timestamp, Filter orderId is_not_null,
// Drop orderPlacementDate, Rename dueDateTime->order_due_date, Normalize.
await q(`CREATE TABLE clean_office AS
  SELECT
    TRY_CAST("dueDateTime" AS TIMESTAMP) AS order_due_date,
    "orderId" AS orderid,
    "customer_id" AS customer_id,
    "status" AS status,
    "assignee" AS assignee,
    "quantity" AS quantity,
    "item_name" AS item_name,
    "unit_price" AS unit_price,
    "days_until_due" AS days_until_due
  FROM office_raw
  WHERE "orderId" IS NOT NULL AND TRIM(CAST("orderId" AS VARCHAR)) <> ''`);
console.log(`Clean Office Goods (6c5a2645):     in=${await count("office_raw")}  out=${await count("clean_office")}`);

// ----- Join 1 (b6ea90b5) — left: clean_bureau ⟕ cust on customer_id = officegoods_customer_id -----
await q(`CREATE TABLE join_bureau_cust AS
  SELECT b.*, c.consolidated_customer_id, c.customer_name
    FROM clean_bureau b
    LEFT JOIN cust_raw c ON b."customer_id" = c."officegoods_customer_id"`);
console.log(`Join 1 (b6ea90b5) left bureau⟕cust: in=${await count("clean_bureau")}  out=${await count("join_bureau_cust")}`);

// ----- Join 2 (6077786c) — left: clean_office ⟕ cust on customer_id = officegoods_customer_id -----
await q(`CREATE TABLE join_office_cust AS
  SELECT o.*, c.consolidated_customer_id, c.customer_name
    FROM clean_office o
    LEFT JOIN cust_raw c ON o."customer_id" = c."officegoods_customer_id"`);
console.log(`Join 2 (6077786c) left office⟕cust: in=${await count("clean_office")}  out=${await count("join_office_cust")}`);

// ----- Union (bfce89ef) — config has rightNodeId=join1, sourceNodeId=join2 -----
// The node config does NOT specify a unionType; we check both flavours so
// we can attribute the loss precisely.
const unionAllCols = await cols("join_office_cust");
await q(`CREATE TABLE union_all_v AS
  SELECT ${unionAllCols.map((c) => `"${c}"`).join(",")} FROM join_office_cust
  UNION ALL
  SELECT ${unionAllCols.map((c) => `"${c}"`).join(",")} FROM join_bureau_cust`);
await q(`CREATE TABLE union_distinct_v AS
  SELECT ${unionAllCols.map((c) => `"${c}"`).join(",")} FROM join_office_cust
  UNION
  SELECT ${unionAllCols.map((c) => `"${c}"`).join(",")} FROM join_bureau_cust`);
console.log(`Union (bfce89ef) UNION ALL:        out=${await count("union_all_v")}`);
console.log(`Union (bfce89ef) UNION DISTINCT:   out=${await count("union_distinct_v")}`);

// ----- Output dataset on disk -----
console.log(`Output dataset CSV (1d95946d):      rows=${await count("out_csv")}`);

// ----- LOSS hunting -----
console.log("\n=== LOSS HUNTING ===");

// Compare output to union_all
const outOnlyVsUnionAll = await q(`SELECT COUNT(*) AS c FROM out_csv`);
const unionAllCount = await count("union_all_v");
const unionDistinctCount = await count("union_distinct_v");
const outCount = Number(outOnlyVsUnionAll[0].c);
console.log(`output.rows=${outCount}  union_all=${unionAllCount}  union_distinct=${unionDistinctCount}`);

// Find rows in UNION ALL not present in the output (by orderid)
const missingByOrderId = await q(`
  WITH u AS (SELECT DISTINCT "orderid" AS orderid FROM union_all_v WHERE "orderid" IS NOT NULL)
  SELECT u.orderid
    FROM u
    LEFT JOIN (SELECT DISTINCT "orderid" AS orderid FROM out_csv WHERE "orderid" IS NOT NULL) o
      ON u.orderid = o.orderid
   WHERE o.orderid IS NULL
   LIMIT 10`);
console.log(`union_all.distinct_orderids missing from output (sample):`);
for (const r of missingByOrderId) console.log(`  - ${r.orderid}`);

// Distinct orderids
const distinctOrderIdsUnion = await q(`SELECT COUNT(DISTINCT "orderid") AS c FROM union_all_v`);
const distinctOrderIdsOut = await q(`SELECT COUNT(DISTINCT "orderid") AS c FROM out_csv`);
console.log(`union_all.distinct(orderid)=${distinctOrderIdsUnion[0].c}  output.distinct(orderid)=${distinctOrderIdsOut[0].c}`);

// Check the orderId shape: bureau uses random UUIDs; office uses values
// like "A74270364-fc220883-…" — does Union DISTINCT collapse them?
// Show a sample union row count per source-of-origin
const perSrc = await q(`
  WITH tagged AS (
    SELECT 'office' AS src, "orderid" FROM join_office_cust
    UNION ALL
    SELECT 'bureau' AS src, "orderid" FROM join_bureau_cust)
  SELECT src, COUNT(*) AS rows, COUNT(DISTINCT "orderid") AS distinct_ids
    FROM tagged GROUP BY src`);
for (const r of perSrc) console.log(`  union tagged: src=${r.src} rows=${r.rows} distinct_orderid=${r.distinct_ids}`);

// Examine if output equals UNION DISTINCT (suggests union-distinct semantics).
const outVsDistinct = await q(`
  SELECT 'in_out_not_in_distinct' AS bucket, COUNT(*) AS c FROM (
    SELECT "orderid" FROM out_csv EXCEPT SELECT "orderid" FROM union_distinct_v) t
  UNION ALL
  SELECT 'in_distinct_not_in_out', COUNT(*) FROM (
    SELECT "orderid" FROM union_distinct_v EXCEPT SELECT "orderid" FROM out_csv) t`);
for (const r of outVsDistinct) console.log(`  output↔distinct ${r.bucket}=${r.c}`);

// Cleanup
fs.rmSync(tmpdir, { recursive: true, force: true });
console.log("\nDONE");
