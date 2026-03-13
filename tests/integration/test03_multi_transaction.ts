// ---------------------------------------------------------------------------
// Integration Test 03: Multi-Transaction Dataset (Append and Snapshot)
//
// Tests the dataset transaction model: initial SNAPSHOT upload, APPEND
// with overlapping and new PKs, and SNAPSHOT replacement. Verifies that
// reindex correctly merges append data and replaces on snapshot.
//
// Run: npx tsx tests/integration/test03_multi_transaction.ts
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import os from "os";

const BASE = process.env.API_BASE || "http://localhost:3000";

async function run() {
  let passed = 0;
  let failed = 0;
  const suiteStart = Date.now();

  console.log("=== Integration Test: Multi-Transaction Dataset (Append & Merge) ===\n");

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function api(method: string, urlPath: string, body?: unknown) {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  function assert(condition: boolean, label: string, detail?: string) {
    const t = Date.now() - suiteStart;
    if (condition) {
      console.log(`  Test ${label}: PASS (${t}ms)`);
      passed++;
    } else {
      console.error(`  Test ${label}: FAIL (${t}ms)${detail ? " — " + detail : ""}`);
      failed++;
    }
  }

  async function uploadFile(url: string, filePath: string, fields: Record<string, string> = {}) {
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);
    let body = "";
    for (const [key, value] of Object.entries(fields)) {
      body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
    }
    body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`;
    const bodyBuffer = Buffer.concat([Buffer.from(body), fileContent, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: bodyBuffer,
    });
    return { status: res.status, body: await res.json() };
  }

  // -------------------------------------------------------------------------
  // CSV generators
  // -------------------------------------------------------------------------

  const CATEGORIES = ["Electronics", "Clothing", "Food", "Books", "Hardware"];

  function generateProductCSV(start: number, count: number, priceOverride?: number): string {
    const header = "product_id,product_name,price,category,in_stock";
    const rows: string[] = [header];
    for (let i = start; i < start + count; i++) {
      const id = `PROD-${String(i).padStart(4, "0")}`;
      const name = `Product ${i}`;
      const price = priceOverride ?? (10 + Math.round(Math.random() * 990 * 100) / 100);
      const cat = CATEGORIES[i % CATEGORIES.length];
      const inStock = i % 3 !== 0 ? "true" : "false";
      rows.push(`${id},${name},${price},${cat},${inStock}`);
    }
    return rows.join("\n");
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let ontologyId: string | null = null;
  let datasetId: string | null = null;
  const tmpFiles: string[] = [];

  function tmpPath(suffix: string): string {
    const p = path.join(os.tmpdir(), `tellus_test03_${suffix}_${Date.now()}.csv`);
    tmpFiles.push(p);
    return p;
  }

  try {
    // -----------------------------------------------------------------------
    // 3.1 Setup: ontology + Product type
    // -----------------------------------------------------------------------
    const ontRes = await api("POST", "/api/v2/ontologies", {
      displayName: "Multi-Transaction Test",
      description: "Test 03 — append and snapshot",
    });
    ontologyId = ontRes.body?.data?.ontologyId ?? null;

    const otRes = await api("POST", `/api/v2/ontologies/${ontologyId}/objectTypes/batch`, {
      apiName: "Product",
      displayName: "Product",
      primaryKeyProperty: "productId",
      titleProperty: "productName",
      properties: [
        { apiName: "productId", displayName: "Product ID", baseType: "string" },
        { apiName: "productName", displayName: "Product Name", baseType: "string" },
        { apiName: "price", displayName: "Price", baseType: "double" },
        { apiName: "category", displayName: "Category", baseType: "string" },
        { apiName: "inStock", displayName: "In Stock", baseType: "boolean" },
      ],
    });
    assert(otRes.status === 201 && !!ontologyId, "3.1 Setup ontology + Product type", `status=${otRes.status}`);

    // -----------------------------------------------------------------------
    // 3.2 Upload initial 50 products (PROD-0001 through PROD-0050)
    // -----------------------------------------------------------------------
    const csv1 = generateProductCSV(1, 50);
    const file1 = tmpPath("initial");
    fs.writeFileSync(file1, csv1);

    const up1 = await uploadFile(`${BASE}/api/v2/datasets/upload`, file1, {
      name: "product_data_test03",
      transactionType: "SNAPSHOT",
    });
    datasetId = up1.body?.data?.dataset?.datasetId ?? null;
    assert(up1.status === 201 && !!datasetId, "3.2 Upload initial 50 products", `status=${up1.status}`);

    // -----------------------------------------------------------------------
    // 3.3 Register datasource + reindex (50 objects)
    // -----------------------------------------------------------------------
    await api("POST", `/api/v2/ontologies/${ontologyId}/objectTypes/Product/datasource`, {
      datasetId,
      columnMapping: {
        productId: "product_id",
        productName: "product_name",
        price: "price",
        category: "category",
        inStock: "in_stock",
      },
    });

    const rix1 = await api("POST", `/api/v2/ontology/${ontologyId}/objectTypes/Product/reindex?force=true`);
    const indexed1 = rix1.body?.data?.result?.totalObjectsIndexed ?? -1;
    assert(indexed1 === 50, "3.3 Reindex — 50 objects indexed", `indexed=${indexed1}`);

    // -----------------------------------------------------------------------
    // 3.4 Record original prices for PROD-0046..PROD-0050 (overlap set)
    // -----------------------------------------------------------------------
    const originalPrices: Record<string, number> = {};
    for (let i = 46; i <= 50; i++) {
      const pk = `PROD-${String(i).padStart(4, "0")}`;
      const r = await api("GET", `/api/v2/objects/Product/${pk}`);
      originalPrices[pk] = r.body?.data?.price ?? r.body?.price ?? -1;
    }
    assert(
      Object.values(originalPrices).every((p) => p > 0),
      "3.4 Record original prices for overlap set",
      `prices=${JSON.stringify(originalPrices)}`,
    );

    // -----------------------------------------------------------------------
    // 3.5 Append 15 rows: 10 new (PROD-0051..PROD-0060) + 5 overlapping
    //     (PROD-0046..PROD-0050 with price=888.88)
    // -----------------------------------------------------------------------

    // Build append CSV: 5 overlapping + 10 new
    const appendHeader = "product_id,product_name,price,category,in_stock";
    const appendRows: string[] = [appendHeader];
    // 5 overlapping with price override
    for (let i = 46; i <= 50; i++) {
      const id = `PROD-${String(i).padStart(4, "0")}`;
      appendRows.push(`${id},Product ${i} Updated,888.88,${CATEGORIES[i % CATEGORIES.length]},true`);
    }
    // 10 new
    for (let i = 51; i <= 60; i++) {
      const id = `PROD-${String(i).padStart(4, "0")}`;
      appendRows.push(`${id},Product ${i},42.99,${CATEGORIES[i % CATEGORIES.length]},true`);
    }
    const file2 = tmpPath("append");
    fs.writeFileSync(file2, appendRows.join("\n"));

    const boundary2 = "----FormBoundary" + Math.random().toString(36).slice(2);
    const fc2 = fs.readFileSync(file2);
    let mb2 = `--${boundary2}\r\nContent-Disposition: form-data; name="type"\r\n\r\nAPPEND\r\n`;
    mb2 += `--${boundary2}\r\nContent-Disposition: form-data; name="file"; filename="append.csv"\r\nContent-Type: text/csv\r\n\r\n`;
    const buf2 = Buffer.concat([Buffer.from(mb2), fc2, Buffer.from(`\r\n--${boundary2}--\r\n`)]);

    const appendRes = await fetch(`${BASE}/api/v2/datasets/${datasetId}/transactions`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary2}` },
      body: buf2,
    });
    const appendBody = await appendRes.json();
    assert(appendRes.status === 201, "3.5 Append 15 rows (10 new + 5 overlap)", `status=${appendRes.status}`);

    // -----------------------------------------------------------------------
    // 3.6 Reindex — verify total count
    //     50 original + 10 new = 60 (overlapping PKs merge, not duplicate)
    //     Expect 60 total objects
    // -----------------------------------------------------------------------
    const rix2 = await api("POST", `/api/v2/ontology/${ontologyId}/objectTypes/Product/reindex?force=true`);
    const indexed2 = rix2.body?.data?.result?.totalObjectsIndexed ?? -1;
    // With PK-based merging, overlapping rows replace, so 50 + 10 new = 60
    assert(indexed2 === 60, "3.6 Reindex after append — 60 total", `indexed=${indexed2}`);

    // -----------------------------------------------------------------------
    // 3.7 Verify new products exist (PROD-0051, PROD-0060)
    // -----------------------------------------------------------------------
    const new51 = await api("GET", "/api/v2/objects/Product/PROD-0051");
    const new60 = await api("GET", "/api/v2/objects/Product/PROD-0060");
    assert(
      new51.status === 200 && new60.status === 200,
      "3.7 Verify new products exist (PROD-0051, PROD-0060)",
      `s51=${new51.status}, s60=${new60.status}`,
    );

    // -----------------------------------------------------------------------
    // 3.8 CRITICAL: Verify overlapping products have price 888.88
    // -----------------------------------------------------------------------
    let overlapCorrect = true;
    for (let i = 46; i <= 50; i++) {
      const pk = `PROD-${String(i).padStart(4, "0")}`;
      const r = await api("GET", `/api/v2/objects/Product/${pk}`);
      const p = r.body?.data?.price ?? r.body?.price ?? -1;
      if (p !== 888.88) {
        overlapCorrect = false;
        console.error(`    ${pk}: expected 888.88, got ${p}`);
      }
    }
    assert(overlapCorrect, "3.8 CRITICAL: Overlapping products have price 888.88");

    // -----------------------------------------------------------------------
    // 3.9 Verify untouched products unchanged (PROD-0001)
    // -----------------------------------------------------------------------
    const untouched = await api("GET", "/api/v2/objects/Product/PROD-0001");
    const untouchedPrice = untouched.body?.data?.price ?? untouched.body?.price ?? -1;
    assert(untouchedPrice > 0 && untouchedPrice !== 888.88, "3.9 Untouched products unchanged", `price=${untouchedPrice}`);

    // -----------------------------------------------------------------------
    // 3.10 Upload SNAPSHOT with 25 products (PROD-0001..PROD-0025)
    // -----------------------------------------------------------------------
    const csv3 = generateProductCSV(1, 25, 77.77);
    const file3 = tmpPath("snapshot");
    fs.writeFileSync(file3, csv3);

    const boundary3 = "----FormBoundary" + Math.random().toString(36).slice(2);
    const fc3 = fs.readFileSync(file3);
    let mb3 = `--${boundary3}\r\nContent-Disposition: form-data; name="type"\r\n\r\nSNAPSHOT\r\n`;
    mb3 += `--${boundary3}\r\nContent-Disposition: form-data; name="file"; filename="snapshot.csv"\r\nContent-Type: text/csv\r\n\r\n`;
    const buf3 = Buffer.concat([Buffer.from(mb3), fc3, Buffer.from(`\r\n--${boundary3}--\r\n`)]);

    const snapRes = await fetch(`${BASE}/api/v2/datasets/${datasetId}/transactions`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary3}` },
      body: buf3,
    });
    assert(snapRes.status === 201, "3.10 Upload SNAPSHOT with 25 products", `status=${snapRes.status}`);

    // -----------------------------------------------------------------------
    // 3.11 Reindex — verify 25 total (SNAPSHOT replaces all)
    // -----------------------------------------------------------------------
    const rix3 = await api("POST", `/api/v2/ontology/${ontologyId}/objectTypes/Product/reindex?force=true`);
    const indexed3 = rix3.body?.data?.result?.totalObjectsIndexed ?? -1;
    assert(indexed3 === 25, "3.11 Reindex after SNAPSHOT — 25 total", `indexed=${indexed3}`);

  } finally {
    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------
    console.log("\n  [cleanup] Removing test data...");
    if (ontologyId) await api("DELETE", `/api/v2/ontologies/${ontologyId}`).catch(() => {});
    if (datasetId) await api("DELETE", `/api/v2/datasets/${datasetId}?force=true`).catch(() => {});
    for (const f of tmpFiles) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const elapsed = Date.now() - suiteStart;
  console.log(`\n=== Results: ${passed} passed, ${failed} failed (${elapsed}ms) ===\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
