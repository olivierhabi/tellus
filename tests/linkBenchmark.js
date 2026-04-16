#!/usr/bin/env node
// ===========================================================================
// Link Resolution Performance Benchmark (Task 28)
//
// Generates test data, runs link resolution benchmarks, and reports
// p50/p95/p99 latencies against target thresholds.
//
// Prerequisites:
//   - Server running on port 3000
//   - PostgreSQL and OpenSearch available
//
// Run:  node tests/linkBenchmark.js
// ===========================================================================

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

async function uploadCSV(path, csvContent) {
  const boundary = "----BenchmarkBoundary" + Date.now();
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="data.csv"\r\n` +
    `Content-Type: text/csv\r\n\r\n` +
    csvContent +
    `\r\n--${boundary}--\r\n`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

function percentile(sortedArr, p) {
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, index)];
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pad(str, len) {
  str = String(str);
  while (str.length < len) str = " " + str;
  return str;
}

function padRight(str, len) {
  str = String(str);
  while (str.length < len) str += " ";
  return str;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NUM_EMPLOYEES = 10000;
const NUM_TICKETS = 50000;
const NUM_COURSES = 500;
const NUM_COMPANIES = 200;
const NUM_M2M_ROWS = 100000;
const DEPARTMENTS = ["Engineering", "Sales", "Marketing", "Support", "Finance"];
const TICKET_STATUSES = ["open", "closed", "in_progress"];

// ---------------------------------------------------------------------------
// Data generation
// ---------------------------------------------------------------------------

function generateEmployeeCSV() {
  const lines = ["employeeId,fullName,department,companyId"];
  for (let i = 1; i <= NUM_EMPLOYEES; i++) {
    const id = `BEMP-${String(i).padStart(5, "0")}`;
    const name = `Employee ${i}`;
    const dept = randomChoice(DEPARTMENTS);
    const companyNum = ((i - 1) % NUM_COMPANIES) + 1;
    const companyId = `BCOMP-${String(companyNum).padStart(3, "0")}`;
    lines.push(`${id},${name},${dept},${companyId}`);
  }
  return lines.join("\n");
}

function generateTicketCSV() {
  const lines = ["ticketId,title,status,assigneeEmployeeId"];
  for (let i = 1; i <= NUM_TICKETS; i++) {
    const id = `BTKT-${String(i).padStart(6, "0")}`;
    const title = `Ticket ${i}`;
    const status = randomChoice(TICKET_STATUSES);
    const empNum = ((i - 1) % NUM_EMPLOYEES) + 1;
    const empId = `BEMP-${String(empNum).padStart(5, "0")}`;
    lines.push(`${id},${title},${status},${empId}`);
  }
  return lines.join("\n");
}

function generateCourseCSV() {
  const lines = ["courseId,courseName"];
  for (let i = 1; i <= NUM_COURSES; i++) {
    const id = `BCRS-${String(i).padStart(4, "0")}`;
    lines.push(`${id},Course ${i}`);
  }
  return lines.join("\n");
}

function generateJoinTableCSV() {
  const lines = ["employeeId,courseId"];
  const used = new Set();
  let count = 0;
  while (count < NUM_M2M_ROWS) {
    const empNum = Math.floor(Math.random() * NUM_EMPLOYEES) + 1;
    const crsNum = Math.floor(Math.random() * NUM_COURSES) + 1;
    const empId = `BEMP-${String(empNum).padStart(5, "0")}`;
    const crsId = `BCRS-${String(crsNum).padStart(4, "0")}`;
    const key = `${empId}:${crsId}`;
    if (!used.has(key)) {
      used.add(key);
      lines.push(`${empId},${crsId}`);
      count++;
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTotal = performance.now();
  console.log("=== Link Resolution Performance Benchmark ===\n");

  // Check server health
  const health = await request("GET", "/health");
  if (health.status !== 200) {
    console.error("Server not reachable. Aborting.");
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Step 1: Create benchmark ontology and object types
  // -----------------------------------------------------------------------

  console.log("Step 1: Setting up benchmark data...");
  const ontologyName = `benchmark_links_${Date.now()}`;

  // Create ontology
  let { body: ontBody } = await request("POST", "/api/v1/ontologies", {
    displayName: ontologyName,
    description: "Performance benchmark ontology",
  });
  const ONTOLOGY_ID = ontBody?.ontologyId;
  if (!ONTOLOGY_ID) {
    console.error("Failed to create benchmark ontology:", ontBody);
    process.exit(1);
  }
  console.log(`  Ontology: ${ONTOLOGY_ID}`);

  // Create BenchEmployee object type
  await request("POST", `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/batch`, {
    apiName: "BenchEmployee",
    displayName: "Bench Employee",
    description: "Benchmark employee",
    primaryKeyProperty: "employeeId",
    properties: [
      { apiName: "employeeId", displayName: "Employee ID", baseType: "string" },
      { apiName: "fullName", displayName: "Full Name", baseType: "string" },
      { apiName: "department", displayName: "Department", baseType: "string" },
      { apiName: "companyId", displayName: "Company ID", baseType: "string" },
    ],
  });
  console.log("  Created BenchEmployee object type");

  // Create BenchTicket object type
  await request("POST", `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/batch`, {
    apiName: "BenchTicket",
    displayName: "Bench Ticket",
    description: "Benchmark ticket",
    primaryKeyProperty: "ticketId",
    properties: [
      { apiName: "ticketId", displayName: "Ticket ID", baseType: "string" },
      { apiName: "title", displayName: "Title", baseType: "string" },
      { apiName: "status", displayName: "Status", baseType: "string" },
      {
        apiName: "assigneeEmployeeId",
        displayName: "Assignee Employee ID",
        baseType: "string",
      },
    ],
  });
  console.log("  Created BenchTicket object type");

  // Create BenchCourse object type
  await request("POST", `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/batch`, {
    apiName: "BenchCourse",
    displayName: "Bench Course",
    description: "Benchmark course",
    primaryKeyProperty: "courseId",
    properties: [
      { apiName: "courseId", displayName: "Course ID", baseType: "string" },
      { apiName: "courseName", displayName: "Course Name", baseType: "string" },
    ],
  });
  console.log("  Created BenchCourse object type");

  // -----------------------------------------------------------------------
  // Step 1b: Register datasources and upload CSVs
  // -----------------------------------------------------------------------

  console.log("\nStep 1b: Generating and uploading CSV data...");

  // Write CSV files via datasource registration and indexing
  const fs = require("fs");
  const path = require("path");
  const dataDir = path.join(__dirname, "..", "data");

  // Generate CSVs
  console.log(`  Generating ${NUM_EMPLOYEES.toLocaleString()} employees...`);
  const employeeCSV = generateEmployeeCSV();
  const empPath = path.join(dataDir, "bench_employees.csv");
  fs.writeFileSync(empPath, employeeCSV);

  console.log(`  Generating ${NUM_TICKETS.toLocaleString()} tickets...`);
  const ticketCSV = generateTicketCSV();
  const tktPath = path.join(dataDir, "bench_tickets.csv");
  fs.writeFileSync(tktPath, ticketCSV);

  console.log(`  Generating ${NUM_COURSES.toLocaleString()} courses...`);
  const courseCSV = generateCourseCSV();
  const crsPath = path.join(dataDir, "bench_courses.csv");
  fs.writeFileSync(crsPath, courseCSV);

  console.log(
    `  Generating ${NUM_M2M_ROWS.toLocaleString()} M2M join table rows...`
  );
  const joinCSV = generateJoinTableCSV();
  const joinPath = path.join(dataDir, "bench_join_emp_courses.csv");
  fs.writeFileSync(joinPath, joinCSV);

  // Register datasources
  await request(
    "POST",
    `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/BenchEmployee/datasource`,
    { filePath: empPath }
  );
  await request(
    "POST",
    `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/BenchTicket/datasource`,
    { filePath: tktPath }
  );
  await request(
    "POST",
    `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/BenchCourse/datasource`,
    { filePath: crsPath }
  );
  console.log("  Registered all datasources");

  // Index all three object types (sequentially for stability)
  console.log("  Indexing BenchEmployee...");
  await request(
    "POST",
    `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/BenchEmployee/index`,
    {}
  );
  // Wait for indexing to complete
  await waitForIndexing(ONTOLOGY_ID, "BenchEmployee");

  console.log("  Indexing BenchTicket...");
  await request(
    "POST",
    `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/BenchTicket/index`,
    {}
  );
  await waitForIndexing(ONTOLOGY_ID, "BenchTicket");

  console.log("  Indexing BenchCourse...");
  await request(
    "POST",
    `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/BenchCourse/index`,
    {}
  );
  await waitForIndexing(ONTOLOGY_ID, "BenchCourse");

  // -----------------------------------------------------------------------
  // Step 1c: Create link types and upload join table
  // -----------------------------------------------------------------------

  console.log("\nStep 1c: Creating link types...");

  // FK link: BenchEmployee -> BenchTicket (ONE_TO_MANY, FK on target)
  await request("POST", `/api/v1/ontologies/${ONTOLOGY_ID}/linkTypes`, {
    apiName: "benchEmployeeTickets",
    displayName: "Employee Tickets",
    cardinality: "ONE_TO_MANY",
    sourceObjectTypeApiName: "BenchEmployee",
    targetObjectTypeApiName: "BenchTicket",
    targetPropertyApiName: "assigneeEmployeeId",
  });
  console.log("  Created benchEmployeeTickets (ONE_TO_MANY)");

  // M2M link: BenchEmployee -> BenchCourse
  await request("POST", `/api/v1/ontologies/${ONTOLOGY_ID}/linkTypes`, {
    apiName: "benchEmployeeCourses",
    displayName: "Employee Courses",
    cardinality: "MANY_TO_MANY",
    sourceObjectTypeApiName: "BenchEmployee",
    targetObjectTypeApiName: "BenchCourse",
    isBidirectional: true,
  });
  console.log("  Created benchEmployeeCourses (MANY_TO_MANY)");

  // Upload join table
  const uploadResult = await uploadCSV(
    `/api/v1/ontologies/${ONTOLOGY_ID}/linkTypes/benchEmployeeCourses/upload`,
    joinCSV
  );
  if (uploadResult.status === 200 || uploadResult.status === 201) {
    console.log("  Uploaded M2M join table");
  } else {
    console.log(
      `  Join table upload status: ${uploadResult.status} (non-critical)`
    );
  }

  // -----------------------------------------------------------------------
  // Step 2: Warm up
  // -----------------------------------------------------------------------

  console.log("\nStep 2: Warming up (10 requests)...");
  for (let i = 0; i < 10; i++) {
    const empNum = Math.floor(Math.random() * NUM_EMPLOYEES) + 1;
    const empId = `BEMP-${String(empNum).padStart(5, "0")}`;
    await request(
      "GET",
      `/api/v1/objects/BenchEmployee/${empId}/links/benchEmployeeTickets`
    );
  }
  console.log("  Warm-up complete");

  // -----------------------------------------------------------------------
  // Step 3: Run benchmarks
  // -----------------------------------------------------------------------

  console.log("\nStep 3: Running benchmarks...\n");

  const benchmarks = [
    {
      name: "FK link resolution",
      description: `Resolve ONE_TO_MANY from single employee -> ~${Math.round(NUM_TICKETS / NUM_EMPLOYEES)} tickets`,
      iterations: 100,
      target: { p50: 15, p95: 20, p99: 50 },
      run: async () => {
        const empNum = Math.floor(Math.random() * NUM_EMPLOYEES) + 1;
        const empId = `BEMP-${String(empNum).padStart(5, "0")}`;
        const start = performance.now();
        await request(
          "GET",
          `/api/v1/objects/BenchEmployee/${empId}/links/benchEmployeeTickets`
        );
        return performance.now() - start;
      },
    },
    {
      name: "Search Around (Engineering)",
      description: `Find all tickets for Engineering employees (~${Math.round(NUM_EMPLOYEES / DEPARTMENTS.length)} employees)`,
      iterations: 20,
      target: { p50: 100, p95: 200, p99: 500 },
      run: async () => {
        const start = performance.now();
        await request(
          "POST",
          `/api/v1/ontologies/${ONTOLOGY_ID}/linkTypes/benchEmployeeTickets/searchAround`,
          {
            direction: "forward",
            sourceFilter: { department: "Engineering" },
            pageSize: 100,
          }
        );
        return performance.now() - start;
      },
    },
    {
      name: "M2M link resolution",
      description: `Resolve MANY_TO_MANY from single employee -> ~${Math.round(NUM_M2M_ROWS / NUM_EMPLOYEES)} courses`,
      iterations: 100,
      target: { p50: 50, p95: 500, p99: 1000 },
      run: async () => {
        const empNum = Math.floor(Math.random() * NUM_EMPLOYEES) + 1;
        const empId = `BEMP-${String(empNum).padStart(5, "0")}`;
        const start = performance.now();
        await request(
          "GET",
          `/api/v1/objects/BenchEmployee/${empId}/links/benchEmployeeCourses`
        );
        return performance.now() - start;
      },
    },
    {
      name: "Link count",
      description: "Count linked tickets for a single employee",
      iterations: 100,
      target: { p50: 5, p95: 15, p99: 30 },
      run: async () => {
        const empNum = Math.floor(Math.random() * NUM_EMPLOYEES) + 1;
        const empId = `BEMP-${String(empNum).padStart(5, "0")}`;
        const start = performance.now();
        await request(
          "GET",
          `/api/v1/objects/BenchEmployee/${empId}/links/benchEmployeeTickets/count`
        );
        return performance.now() - start;
      },
    },
    {
      name: "Bulk link count",
      description: "Get counts for all link types on a single employee",
      iterations: 50,
      target: { p50: 20, p95: 50, p99: 100 },
      run: async () => {
        const empNum = Math.floor(Math.random() * NUM_EMPLOYEES) + 1;
        const empId = `BEMP-${String(empNum).padStart(5, "0")}`;
        const start = performance.now();
        await request(
          "POST",
          `/api/v1/ontologies/${ONTOLOGY_ID}/linkTypes/bulkCount`,
          {
            objectTypeApiName: "BenchEmployee",
            objectPK: empId,
          }
        );
        return performance.now() - start;
      },
    },
  ];

  const results = [];

  for (const bench of benchmarks) {
    process.stdout.write(`  Running: ${bench.name} (${bench.iterations} iterations)...`);
    const times = [];
    for (let i = 0; i < bench.iterations; i++) {
      const elapsed = await bench.run();
      times.push(elapsed);
    }
    times.sort((a, b) => a - b);
    const p50 = Math.round(percentile(times, 50));
    const p95 = Math.round(percentile(times, 95));
    const p99 = Math.round(percentile(times, 99));
    const status = p95 <= bench.target.p95 ? "PASS" : "FAIL";
    results.push({ name: bench.name, p50, p95, p99, targetP95: bench.target.p95, status });
    console.log(` done (p50=${p50}ms, p95=${p95}ms, p99=${p99}ms) ${status}`);
  }

  // -----------------------------------------------------------------------
  // Step 4: Report
  // -----------------------------------------------------------------------

  console.log("\n=== Link Resolution Benchmark Results ===");
  console.log(
    `Data: ${NUM_EMPLOYEES.toLocaleString()} employees, ${NUM_TICKETS.toLocaleString()} tickets, ${NUM_COURSES.toLocaleString()} courses, ${NUM_M2M_ROWS.toLocaleString()} M2M join rows\n`
  );

  const hdr =
    "| " +
    padRight("Benchmark", 34) +
    " | " +
    pad("p50 (ms)", 8) +
    " | " +
    pad("p95 (ms)", 8) +
    " | " +
    pad("p99 (ms)", 8) +
    " | " +
    pad("Target p95", 10) +
    " | " +
    padRight("Status", 6) +
    " |";
  const sep = "|" + "-".repeat(36) + "|" + "-".repeat(10) + "|" + "-".repeat(10) + "|" + "-".repeat(10) + "|" + "-".repeat(12) + "|" + "-".repeat(8) + "|";

  console.log(hdr);
  console.log(sep);

  let passCount = 0;
  for (const r of results) {
    if (r.status === "PASS") passCount++;
    const row =
      "| " +
      padRight(r.name, 34) +
      " | " +
      pad(String(r.p50), 8) +
      " | " +
      pad(String(r.p95), 8) +
      " | " +
      pad(String(r.p99), 8) +
      " | " +
      pad(r.targetP95 + " ms", 10) +
      " | " +
      padRight(r.status, 6) +
      " |";
    console.log(row);
  }

  console.log("");
  console.log(
    `Overall: ${passCount}/${results.length} benchmarks within target p95 latency.`
  );

  // -----------------------------------------------------------------------
  // Step 5: Teardown
  // -----------------------------------------------------------------------

  console.log("\nStep 5: Cleaning up benchmark data...");

  // Delete link types
  await request(
    "DELETE",
    `/api/v1/ontologies/${ONTOLOGY_ID}/linkTypes/benchEmployeeTickets`
  );
  await request(
    "DELETE",
    `/api/v1/ontologies/${ONTOLOGY_ID}/linkTypes/benchEmployeeCourses`
  );

  // Delete object types
  await request(
    "DELETE",
    `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/BenchTicket`
  );
  await request(
    "DELETE",
    `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/BenchEmployee`
  );
  await request(
    "DELETE",
    `/api/v1/ontologies/${ONTOLOGY_ID}/objectTypes/BenchCourse`
  );

  // Delete ontology
  await request("DELETE", `/api/v1/ontologies/${ONTOLOGY_ID}`);

  // Delete OpenSearch indices
  try {
    await fetch(`http://localhost:9200/ontology-benchemployee`, { method: "DELETE" });
    await fetch(`http://localhost:9200/ontology-benchticket`, { method: "DELETE" });
    await fetch(`http://localhost:9200/ontology-benchcourse`, { method: "DELETE" });
  } catch {
    // indices may not exist
  }

  // Clean up CSV files
  try {
    fs.unlinkSync(empPath);
    fs.unlinkSync(tktPath);
    fs.unlinkSync(crsPath);
    fs.unlinkSync(joinPath);
  } catch {
    // files may not exist
  }

  // Clean up join table file if written by upload endpoint
  try {
    const joinTablesDir = path.join(dataDir, "join_tables");
    const files = fs.readdirSync(joinTablesDir);
    for (const f of files) {
      if (f.includes("benchEmployeeCourses")) {
        fs.unlinkSync(path.join(joinTablesDir, f));
      }
    }
  } catch {
    // directory may not exist
  }

  const totalTime = ((performance.now() - startTotal) / 1000).toFixed(1);
  console.log(`\nBenchmark complete in ${totalTime}s.`);

  // Exit with failure if any benchmark failed
  if (passCount < results.length) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Utility: wait for indexing to complete
// ---------------------------------------------------------------------------

async function waitForIndexing(ontologyId, objectType, maxWaitMs = 600000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { body } = await request(
      "GET",
      `/api/v1/ontologies/${ontologyId}/objectTypes/${objectType}`
    );
    const state = body?.objectType?.indexingState?.status;
    if (state === "indexed" || state === "stale") {
      return;
    }
    if (state === "failed") {
      console.warn(`  Warning: Indexing failed for ${objectType}`);
      return;
    }
    // Wait 1 second before checking again
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn(`  Warning: Indexing timeout for ${objectType}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
