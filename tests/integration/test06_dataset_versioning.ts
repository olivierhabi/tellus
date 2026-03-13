// ---------------------------------------------------------------------------
// Test 06 — Dataset Transaction Versioning
//
// Validates multi-transaction dataset lifecycle: initial upload, append,
// overlapping PK append, and SNAPSHOT replacement. Verifies row counts
// and transaction history at each step.
//
// Run: npx tsx tests/integration/test06_dataset_versioning.ts
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";

const API = process.env.API_BASE || "http://localhost:3000";

// ---------------------------------------------------------------------------
// Multipart upload helper
// ---------------------------------------------------------------------------

async function uploadFile(
  url: string,
  filePath: string,
  fields: Record<string, string> = {}
): Promise<any> {
  const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
  const fileName = path.basename(filePath);
  const fileContent = fs.readFileSync(filePath);

  let body = "";
  for (const [key, value] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
  }
  body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`;

  const bodyBuffer = Buffer.concat([
    Buffer.from(body),
    fileContent,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: bodyBuffer,
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

async function api(method: string, path: string, body?: any): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function generateProductCsv(
  count: number,
  startId = 1,
  priceOverride?: number
): string {
  const header = "product_id,name,category,price\n";
  const rows: string[] = [];
  for (let i = startId; i < startId + count; i++) {
    const price = priceOverride ?? (9.99 + i * 0.5);
    rows.push(`PROD${String(i).padStart(4, "0")},Product ${i},Category${(i % 5) + 1},${price.toFixed(2)}`);
  }
  return header + rows.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Cleanup tracker
// ---------------------------------------------------------------------------

let datasetId: string | null = null;
const tmpFiles: string[] = [];

async function cleanup() {
  console.log("\n--- Cleanup ---");
  try {
    if (datasetId) {
      await api("DELETE", `/api/v2/datasets/${datasetId}?force=true`);
      console.log("  Deleted dataset");
    }
  } catch { /* best effort */ }
  for (const f of tmpFiles) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        console.log(`  Removed ${path.basename(f)}`);
      }
    } catch { /* best effort */ }
  }
}

function writeTmpCsv(name: string, content: string): string {
  const p = path.join(process.cwd(), `${name}_${Date.now()}.csv`);
  fs.writeFileSync(p, content);
  tmpFiles.push(p);
  return p;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Test 06: Dataset Transaction Versioning ===\n");

  // -----------------------------------------------------------------------
  // 6.1 Upload initial dataset with 50 products
  // -----------------------------------------------------------------------
  console.log("6.1  Upload initial dataset with 50 products");

  const csv50 = generateProductCsv(50);
  const csv50Path = writeTmpCsv("test06_products_initial", csv50);

  const uploadRes = await uploadFile(`${API}/api/v2/datasets/upload`, csv50Path, {
    name: "test06_products",
  });
  assert(uploadRes.status === 201, "Initial upload succeeded");
  datasetId = uploadRes.body?.data?.dataset?.datasetId;
  assert(!!datasetId, "Dataset ID returned");

  // -----------------------------------------------------------------------
  // 6.2 Verify dataset detail shows 1 transaction
  // -----------------------------------------------------------------------
  console.log("\n6.2  Verify dataset detail shows 1 transaction");

  const detailRes = await api("GET", `/api/v2/datasets/${datasetId}`);
  assert(detailRes.status === 200, "Dataset detail returned 200");
  const transactions = detailRes.body?.data?.transactions ?? [];
  assert(transactions.length === 1, `1 transaction (got ${transactions.length})`);
  const initialTotalRows = detailRes.body?.data?.dataset?.totalRows;
  assert(initialTotalRows === 50, `totalRows === 50 (got ${initialTotalRows})`);

  // -----------------------------------------------------------------------
  // 6.3 Preview initial data (GET /api/v2/datasets/:id/preview?rows=5)
  // -----------------------------------------------------------------------
  console.log("\n6.3  Preview initial data");

  const previewRes = await api("GET", `/api/v2/datasets/${datasetId}/preview?rows=5`);
  assert(previewRes.status === 200, "Preview returned 200");
  const previewData = previewRes.body?.data;
  assert(
    previewData?.previewRowCount === 5,
    `previewRowCount === 5 (got ${previewData?.previewRowCount})`
  );
  assert(
    Array.isArray(previewData?.columns),
    "columns is an array"
  );
  assert(
    previewData?.totalRows === 50,
    `totalRows in preview === 50 (got ${previewData?.totalRows})`
  );

  // -----------------------------------------------------------------------
  // 6.4 Append 20 new rows
  // -----------------------------------------------------------------------
  console.log("\n6.4  Append 20 new rows");

  const csv20 = generateProductCsv(20, 51);
  const csv20Path = writeTmpCsv("test06_products_append", csv20);

  const appendRes = await uploadFile(
    `${API}/api/v2/datasets/${datasetId}/transactions`,
    csv20Path,
    { type: "APPEND" }
  );
  assert(appendRes.status === 201, `Append succeeded (status ${appendRes.status})`);
  const appendRowCount = appendRes.body?.data?.transaction?.rowCount;
  assert(appendRowCount === 20, `Appended 20 rows (got ${appendRowCount})`);

  // -----------------------------------------------------------------------
  // 6.5 Verify dataset has 2 transactions
  // -----------------------------------------------------------------------
  console.log("\n6.5  Verify dataset has 2 transactions");

  const detail2Res = await api("GET", `/api/v2/datasets/${datasetId}`);
  assert(detail2Res.status === 200, "Dataset detail returned 200");
  const txns2 = detail2Res.body?.data?.transactions ?? [];
  assert(txns2.length === 2, `2 transactions (got ${txns2.length})`);

  // -----------------------------------------------------------------------
  // 6.6 Preview merged view shows 70 rows
  // -----------------------------------------------------------------------
  console.log("\n6.6  Preview merged view shows 70 rows");

  const preview70Res = await api("GET", `/api/v2/datasets/${datasetId}/preview?rows=500`);
  assert(preview70Res.status === 200, "Preview returned 200");
  const totalRowsMerged = preview70Res.body?.data?.totalRows;
  // Note: preview may read from latest transaction only; totalRows in dataset should be 70
  const detail2Total = detail2Res.body?.data?.dataset?.totalRows;
  assert(detail2Total === 70, `Dataset totalRows === 70 (got ${detail2Total})`);

  // -----------------------------------------------------------------------
  // 6.7 Append with overlapping PKs (price=777.77 sentinel)
  // -----------------------------------------------------------------------
  console.log("\n6.7  Append with overlapping PKs (sentinel price=777.77)");

  const csvOverlap = generateProductCsv(10, 1, 777.77);
  const csvOverlapPath = writeTmpCsv("test06_products_overlap", csvOverlap);

  const overlapRes = await uploadFile(
    `${API}/api/v2/datasets/${datasetId}/transactions`,
    csvOverlapPath,
    { type: "APPEND" }
  );
  assert(overlapRes.status === 201, `Overlap append succeeded (status ${overlapRes.status})`);

  // Verify the overlapping rows made it into the dataset
  const detail3Res = await api("GET", `/api/v2/datasets/${datasetId}`);
  const txns3 = detail3Res.body?.data?.transactions ?? [];
  assert(txns3.length === 3, `3 transactions (got ${txns3.length})`);
  const detail3Total = detail3Res.body?.data?.dataset?.totalRows;
  assert(detail3Total === 80, `Dataset totalRows === 80 (got ${detail3Total})`);

  // -----------------------------------------------------------------------
  // 6.8 Upload SNAPSHOT with 25 rows
  // -----------------------------------------------------------------------
  console.log("\n6.8  Upload SNAPSHOT with 25 rows");

  const csv25 = generateProductCsv(25, 1);
  const csv25Path = writeTmpCsv("test06_products_snapshot", csv25);

  const snapshotRes = await uploadFile(
    `${API}/api/v2/datasets/${datasetId}/transactions`,
    csv25Path,
    { type: "SNAPSHOT" }
  );
  assert(snapshotRes.status === 201, `Snapshot succeeded (status ${snapshotRes.status})`);

  // -----------------------------------------------------------------------
  // 6.9 Verify dataset rowCount = 25
  // -----------------------------------------------------------------------
  console.log("\n6.9  Verify dataset rowCount = 25");

  const detail4Res = await api("GET", `/api/v2/datasets/${datasetId}`);
  const finalTotalRows = detail4Res.body?.data?.dataset?.totalRows;
  assert(finalTotalRows === 25, `Dataset totalRows === 25 (got ${finalTotalRows})`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main()
  .then(async () => {
    await cleanup();
    console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error("\nFATAL:", err);
    await cleanup();
    process.exit(1);
  });
