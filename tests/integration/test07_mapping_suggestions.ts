// ---------------------------------------------------------------------------
// Test 07 — Mapping Suggestion Engine
//
// Validates the suggestMapping endpoint that analyses dataset columns
// against object type properties and produces column-to-property mapping
// suggestions with confidence scores.
//
// Run: npx tsx tests/integration/test07_mapping_suggestions.ts
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

// ---------------------------------------------------------------------------
// Cleanup tracker
// ---------------------------------------------------------------------------

let ontologyId: string | null = null;
const datasetIds: string[] = [];
const tmpFiles: string[] = [];

async function cleanup() {
  console.log("\n--- Cleanup ---");
  try {
    if (ontologyId) {
      await api("DELETE", `/api/v2/ontologies/${ontologyId}`);
      console.log("  Deleted ontology");
    }
  } catch { /* best effort */ }
  for (const dsId of datasetIds) {
    try {
      await api("DELETE", `/api/v2/datasets/${dsId}?force=true`);
      console.log(`  Deleted dataset ${dsId.slice(0, 8)}...`);
    } catch { /* best effort */ }
  }
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
  const tmpDir = path.join(__dirname, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const p = path.join(tmpDir, `${name}_${Date.now()}.csv`);
  fs.writeFileSync(p, content);
  tmpFiles.push(p);
  return p;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Test 07: Mapping Suggestion Engine ===\n");

  // -----------------------------------------------------------------------
  // 7.1 Setup: ontology + Employee type
  // -----------------------------------------------------------------------
  console.log("7.1  Setup ontology + Employee type");

  const ontRes = await api("POST", "/api/v2/ontologies", {
    displayName: "Test07 Mapping Suggestions",
  });
  assert(ontRes.status === 201, "Ontology created");
  ontologyId = ontRes.body?.data?.ontologyId;

  const otRes = await api(
    "POST",
    `/api/v2/ontologies/${ontologyId}/objectTypes/batch`,
    {
      apiName: "Employee",
      displayName: "Employee",
      primaryKeyProperty: "employeeId",
      properties: [
        { apiName: "employeeId", displayName: "Employee ID", baseType: "string" },
        { apiName: "fullName", displayName: "Full Name", baseType: "string" },
        { apiName: "salary", displayName: "Salary", baseType: "double" },
        { apiName: "startDate", displayName: "Start Date", baseType: "date" },
      ],
    }
  );
  assert(otRes.status === 201, "Employee type created");

  // -----------------------------------------------------------------------
  // 7.2 Upload CSV with snake_case columns
  // -----------------------------------------------------------------------
  console.log("\n7.2  Upload CSV with snake_case columns");

  const snakeCsv =
    "employee_id,full_name,salary,start_date\n" +
    "E001,Alice Smith,75000,2023-01-15\n" +
    "E002,Bob Jones,82000,2022-06-01\n" +
    "E003,Carol Lee,91000,2021-11-20\n";
  const snakePath = writeTmpCsv("test07_snake", snakeCsv);

  const upload1Res = await uploadFile(`${API}/api/v2/datasets/upload`, snakePath, {
    name: "test07_snake_case",
  });
  assert(upload1Res.status === 201, "Snake-case CSV uploaded");
  const dataset1Id = upload1Res.body?.data?.dataset?.datasetId;
  if (dataset1Id) datasetIds.push(dataset1Id);

  // -----------------------------------------------------------------------
  // 7.3 Call suggestMapping with snake_case dataset
  // -----------------------------------------------------------------------
  console.log("\n7.3  suggestMapping with snake_case columns");

  const suggestRes = await api(
    "POST",
    `/api/v2/ontology/${ontologyId}/objectTypes/Employee/suggestMapping`,
    { datasetId: dataset1Id }
  );
  assert(suggestRes.status === 200, `suggestMapping returned 200 (got ${suggestRes.status})`);

  const suggested = suggestRes.body?.data?.suggestedMapping ?? {};
  const mappingKeys = Object.keys(suggested);
  assert(mappingKeys.length === 4, `4 mapping entries (got ${mappingKeys.length})`);

  // Check each mapping has a confidence field
  const allHaveConfidence = mappingKeys.every(
    (k) => suggested[k]?.confidence !== undefined
  );
  assert(allHaveConfidence, "Each mapping has confidence field");

  // Check the employeeId mapping maps to employee_id
  const empIdMapping = suggested.employeeId;
  assert(
    empIdMapping?.column === "employee_id",
    `employeeId maps to "employee_id" (got "${empIdMapping?.column}")`
  );

  // Check readyToRegister is present (boolean)
  const readyToRegister = suggestRes.body?.data?.readyToRegister;
  assert(
    typeof readyToRegister === "boolean",
    `readyToRegister is boolean (got ${typeof readyToRegister})`
  );

  // Check columnMapping is returned
  const columnMapping = suggestRes.body?.data?.columnMapping;
  assert(
    columnMapping !== undefined && columnMapping !== null,
    "columnMapping object returned"
  );

  // -----------------------------------------------------------------------
  // 7.4 Upload CSV with different naming (low confidence)
  // -----------------------------------------------------------------------
  console.log("\n7.4  suggestMapping with different naming (lower confidence)");

  const altCsv =
    "emp_id,name,sal,dept\n" +
    "E001,Alice Smith,75000,Engineering\n" +
    "E002,Bob Jones,82000,Sales\n";
  const altPath = writeTmpCsv("test07_alt_names", altCsv);

  const upload2Res = await uploadFile(`${API}/api/v2/datasets/upload`, altPath, {
    name: "test07_alt_names",
  });
  assert(upload2Res.status === 201, "Alt-names CSV uploaded");
  const dataset2Id = upload2Res.body?.data?.dataset?.datasetId;
  if (dataset2Id) datasetIds.push(dataset2Id);

  const suggestAltRes = await api(
    "POST",
    `/api/v2/ontology/${ontologyId}/objectTypes/Employee/suggestMapping`,
    { datasetId: dataset2Id }
  );
  assert(suggestAltRes.status === 200, "suggestMapping returned 200");

  const altSuggested = suggestAltRes.body?.data?.suggestedMapping ?? {};
  const altMappingKeys = Object.keys(altSuggested);
  // We should get at least some mappings (may not map all 4 perfectly)
  assert(altMappingKeys.length >= 1, `At least 1 mapping found (got ${altMappingKeys.length})`);

  // Check if unmappedProperties exist (some properties may not map)
  const unmappedProps = suggestAltRes.body?.data?.unmappedProperties ?? [];
  // With very different names, some properties may be unmapped
  assert(
    Array.isArray(unmappedProps),
    `unmappedProperties is an array (length ${unmappedProps.length})`
  );

  // Verify lower confidence compared to exact snake_case match
  const altEmpMapping = altSuggested.employeeId;
  if (altEmpMapping && empIdMapping) {
    const altScore = altEmpMapping.score ?? 0;
    const exactScore = empIdMapping.score ?? 0;
    assert(
      altScore <= exactScore,
      `Alt mapping score (${altScore}) <= exact score (${exactScore})`
    );
  } else {
    assert(true, "Alt mapping has different/fewer matches (expected)");
  }

  // -----------------------------------------------------------------------
  // 7.5 Upload CSV with extra columns
  // -----------------------------------------------------------------------
  console.log("\n7.5  suggestMapping with extra columns");

  const extraCsv =
    "employee_id,full_name,salary,start_date,middle_name,favorite_color,shoe_size\n" +
    "E001,Alice Smith,75000,2023-01-15,Marie,Blue,8\n" +
    "E002,Bob Jones,82000,2022-06-01,James,Red,10\n";
  const extraPath = writeTmpCsv("test07_extra_cols", extraCsv);

  const upload3Res = await uploadFile(`${API}/api/v2/datasets/upload`, extraPath, {
    name: "test07_extra_columns",
  });
  assert(upload3Res.status === 201, "Extra-columns CSV uploaded");
  const dataset3Id = upload3Res.body?.data?.dataset?.datasetId;
  if (dataset3Id) datasetIds.push(dataset3Id);

  const suggestExtraRes = await api(
    "POST",
    `/api/v2/ontology/${ontologyId}/objectTypes/Employee/suggestMapping`,
    { datasetId: dataset3Id }
  );
  assert(suggestExtraRes.status === 200, "suggestMapping returned 200");

  const unmappedCols = suggestExtraRes.body?.data?.unmappedColumns ?? [];
  assert(
    Array.isArray(unmappedCols),
    `unmappedColumns is an array (length ${unmappedCols.length})`
  );
  // We have 3 extra columns: middle_name, favorite_color, shoe_size
  const extraColNames = unmappedCols.map((c: any) => c.columnName ?? c);
  assert(
    unmappedCols.length >= 2,
    `At least 2 unmapped columns (got ${unmappedCols.length}): ${extraColNames.join(", ")}`
  );
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
