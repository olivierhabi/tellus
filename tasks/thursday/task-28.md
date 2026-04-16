# TASK 28: Build Performance Benchmark for Link Resolution

**Objective:** Create a benchmark script that measures the performance of link resolution at various scales. This helps identify bottlenecks and set expectations for the human operator.

**Prerequisites:** Tasks 1-12 and Task 17 must be complete. The Express server must be running at `http://localhost:3000` with PostgreSQL and OpenSearch accessible.

**Implementation:** Create `tests/linkBenchmark.js`:

**Step 1: Generate test data**

Create a dedicated benchmark ontology with `apiName: "benchmark_links_${Date.now()}"` via API calls:

- Object type `BenchEmployee`: properties `employeeId` (string, PK), `fullName` (string), `department` (string), `companyId` (string). Generate and upload a CSV with 10,000 employees. Assign `department` randomly from `['Engineering', 'Sales', 'Marketing', 'Support', 'Finance']`. Assign `companyId` from 200 companies (`BCOMP-001` through `BCOMP-200`), distributed roughly uniformly (~50 employees per company).
- Object type `BenchTicket`: properties `ticketId` (string, PK), `title` (string), `status` (string), `assigneeEmployeeId` (string). Generate and upload a CSV with 50,000 tickets (~5 per employee), with `status` randomly from `['open', 'closed', 'in_progress']`.
- Object type `BenchCourse`: properties `courseId` (string, PK), `courseName` (string). Generate and upload a CSV with 500 courses.
- Index all object types into OpenSearch.
- Create link types:
  - `benchEmployeeTickets`: BenchEmployee → BenchTicket, ONE_TO_MANY, FK: `assigneeEmployeeId` on target
  - `benchEmployeeCourses`: BenchEmployee → BenchCourse, MANY_TO_MANY, join table
- Generate a join table CSV with 100,000 rows (random employee-course pairings, ~10 courses per employee).
- Upload the join table via Task 17 endpoint.

**Step 2: Warm up**

Run 10 link resolution requests (not measured) to warm up OpenSearch caches and JIT compilation.

**Step 3: Run benchmarks**

```javascript
const benchmarks = [
    {
        name: 'FK link resolution (single employee → tickets)',
        description: 'Resolves ONE_TO_MANY from a single employee to their ~5 tickets',
        run: async () => {
            // Pick 100 random employee PKs
            // For each: GET /api/v1/objects/BenchEmployee/{pk}/links/benchEmployeeTickets
            // Measure response time for each request
        },
        iterations: 100,
        target: { p50: 15, p95: 20, p99: 50 }  // milliseconds
    },
    {
        name: 'Search Around (Engineering employee tickets)',
        description: 'Finds all tickets for employees in Engineering department (~2000 employees → ~10000 tickets)',
        run: async () => {
            // POST /api/v1/objects/BenchEmployee/searchAround
            // Body: { sourceFilter: { type: "eq", field: "department", value: "Engineering" },
            //         linkType: "benchEmployeeTickets", $pageSize: 100 }
        },
        iterations: 20,
        target: { p50: 100, p95: 200, p99: 500 }
    },
    {
        name: 'M2M link resolution (single employee → courses)',
        description: 'Resolves MANY_TO_MANY from a single employee to their ~10 courses via 100K-row join table',
        run: async () => {
            // Pick 100 random employee PKs
            // For each: GET /api/v1/objects/BenchEmployee/{pk}/links/benchEmployeeCourses
        },
        iterations: 100,
        target: { p50: 50, p95: 500, p99: 1000 }
    },
    {
        name: 'Link count (single object)',
        description: 'Counts linked tickets for a single employee',
        run: async () => {
            // Pick 100 random employee PKs
            // For each: GET /api/v1/objects/BenchEmployee/{pk}/links/benchEmployeeTickets/count
        },
        iterations: 100,
        target: { p50: 5, p95: 15, p99: 30 }
    },
    {
        name: 'Bulk link count (all links for one object)',
        description: 'Gets counts for all link types on a single employee',
        run: async () => {
            // Pick 50 random employee PKs
            // For each: GET /api/v1/objects/BenchEmployee/{pk}/links
        },
        iterations: 50,
        target: { p50: 20, p95: 50, p99: 100 }
    }
];
```

**Step 4: Measure and report**

For each benchmark:
1. Run `iterations` requests sequentially (not parallel — we're measuring single-request latency).
2. Record the response time for each request in milliseconds.
3. Calculate p50, p95, p99 from the recorded times.
4. Compare against the target thresholds.

**Output format (print to stdout):**

```
=== Link Resolution Benchmark Results ===
Data: 10,000 employees, 50,000 tickets, 500 courses, 100,000 M2M join rows

| Benchmark                        | p50 (ms) | p95 (ms) | p99 (ms) | Target p95 | Status |
|----------------------------------|----------|----------|----------|------------|--------|
| FK link resolution               |       12 |       18 |       35 |      20 ms | PASS   |
| Search Around (Engineering)      |       85 |      150 |      320 |     200 ms | PASS   |
| M2M link resolution              |       45 |      380 |      720 |     500 ms | PASS   |
| Link count                       |        3 |        8 |       15 |      15 ms | PASS   |
| Bulk link count                  |       18 |       42 |       78 |      50 ms | PASS   |

Overall: 5/5 benchmarks within target p95 latency.
```

**Status column:** `PASS` if actual p95 <= target p95. `FAIL` if actual p95 > target p95.

**Step 5: Teardown**

Delete all benchmark data:
1. Delete OpenSearch indices: `DELETE /ontology-benchemployee`, `DELETE /ontology-benchticket`, `DELETE /ontology-benchcourse`.
2. Delete the benchmark ontology via API (cascades to object types and link types).
3. Delete the join table CSV file.

**Percentile calculation:** Use the nearest-rank method:
```javascript
function percentile(sortedArr, p) {
    const index = Math.ceil((p / 100) * sortedArr.length) - 1;
    return sortedArr[Math.max(0, index)];
}
```

**Dependencies:** Uses Node.js built-in `fetch` for HTTP calls. Uses `performance.now()` for timing. No external dependencies required.

**File to create:** `tests/linkBenchmark.js`

**Run command:** `node tests/linkBenchmark.js`

**Testing:** Run the benchmark script. Review the printed table. If any benchmark exceeds the target p95, investigate the bottleneck:
- FK link resolution slow → check OpenSearch term query performance, verify `.keyword` field is indexed.
- Search Around slow → check Phase 1 source PK collection, verify batch size.
- M2M slow → check CSV parsing time (consider caching the parsed result).
- Link count slow → verify using `_count` API, not `_search`.
