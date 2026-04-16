## TASK 28: Build Performance Benchmark Test

### Context
Before declaring the Ontology Engine "done" for week 1, we need to verify it performs acceptably with realistic data volumes. RRA has hundreds of thousands of registered taxpayers, millions of EBM receipts per month, and thousands of customs declarations per day. The system must handle at least 100K objects per type and respond to queries within acceptable latency.

### Exact Specification

Create `/tests/performance/benchmark.js`:

**Setup (runs before all benchmarks):**
The benchmark must be fully self-contained. Before any benchmark runs:
1. Create a temporary ontology: `POST /api/v1/ontology` with name `"Benchmark Ontology"`
2. Create an object type: `POST /api/v1/ontology/{id}/objectTypes` with apiName `"BenchEmployee"`, properties:
   - `emp_id` (string, required, primaryKey)
   - `full_name` (string)
   - `department` (string)
   - `annual_salary` (integer)
   - `start_date` (date)
   - `is_active` (boolean)
3. Generate a 10,000-row CSV using `generateRraEmployees(10000, '/tmp/bench_employees.csv')` from Task 27
4. Upload as dataset: `POST /api/v1/datasets/upload`
5. Register as backing datasource with column mapping: `{ emp_id: 'emp_id', full_name: 'full_name', department: 'department', annual_salary: 'annual_salary', start_date: 'start_date', is_active: 'is_active' }`
6. For Benchmark 3: create a `BenchCompany` object type (company_id PK, company_name string), upload 50 companies, register + reindex, then create a link type `BenchEmployedBy` from `BenchEmployee` to `BenchCompany` using `company_id` as the foreign key
7. For Benchmarks 4-5: create an action type `BenchUpdateSalary` with parameters `employeeRef` (string, required) and `newSalary` (integer, required), logic: `UPDATE_OBJECT`

**Teardown (runs after all benchmarks):**
Delete all benchmark datasets, object types, link types, action types, and the benchmark ontology. Drop all OpenSearch indices created during benchmarks.

**Benchmark 1: Indexing throughput**
```
Trigger reindex: POST /api/v1/ontology/{id}/objectTypes/BenchEmployee/reindex
Poll status until complete
Time the reindex operation from request to completion
Target: < 10 seconds for 10K rows
Print: rows/second indexing throughput
```

**Benchmark 2: Query latency**
```
With 10,000 BenchEmployee objects indexed, run each query type 100 times and record latency per request:

- Simple filter: POST /api/v1/objects/BenchEmployee/search
  Body: { "where": { "type": "eq", "field": "department", "value": "Audit" } }

- Compound filter: POST /api/v1/objects/BenchEmployee/search
  Body: { "where": { "type": "and", "value": [
    { "type": "eq", "field": "department", "value": "Audit" },
    { "type": "gte", "field": "annual_salary", "value": 1000000 },
    { "type": "eq", "field": "is_active", "value": true }
  ] } }

- Full-text search: POST /api/v1/objects/BenchEmployee/searchFullText
  Body: { "query": "Habimana" }

- Aggregation: POST /api/v1/objects/BenchEmployee/aggregate
  Body: { "aggregations": [
    { "type": "avg", "field": "annual_salary", "name": "avgSalary" },
    { "type": "min", "field": "annual_salary", "name": "minSalary" },
    { "type": "max", "field": "annual_salary", "name": "maxSalary" },
    { "type": "count", "name": "totalCount" },
    { "type": "sum", "field": "annual_salary", "name": "totalSalary" }
  ], "groupBy": [{ "field": "department" }] }

Measure p50, p95, p99 latency for each.
Target: p95 < 200ms for all query types
```

**Benchmark 3: Search Around latency**
```
With 10,000 BenchEmployee objects linked to 50 BenchCompany objects via BenchEmployedBy:
- For each of 50 companies, traverse: GET /api/v1/objects/BenchCompany/{company_id}/links/BenchEmployedBy
- Repeat the full 50-company traversal twice (100 total requests) and measure latency per request
Target: p95 < 500ms
```

**Benchmark 4: Action throughput**
```
Execute 100 individual BenchUpdateSalary actions in sequence:
  POST /api/v1/actions/BenchUpdateSalary/apply
  Body: { "parameters": { "employeeRef": "EMP-000001", "newSalary": 999999 } }
  (Use employee PKs EMP-000001 through EMP-000100)
Time total duration
Target: < 10 seconds for 100 actions (100ms per action)
```

**Benchmark 5: Bulk action throughput**
```
Execute 1 bulk action request with 500 items:
  POST /api/v1/actions/BenchUpdateSalary/applyBulk
  Body: { "requests": [ { "parameters": { "employeeRef": "EMP-000001", "newSalary": 888888 } }, ... ], "options": { "autoIndex": true } }
  (Use employee PKs EMP-000001 through EMP-000500)
Time total duration including autoIndex reindex
Target: < 15 seconds including reindex
```

**Output format:**
```
=== Performance Benchmark Results ===

INDEXING:
  10,000 rows:     4.2s (2,380 rows/sec)
  Target:          < 10s ✅

QUERY LATENCY (10K objects, 100 iterations):
  Simple filter:   p50=12ms  p95=45ms  p99=78ms  Target p95<200ms ✅
  Compound filter: p50=18ms  p95=65ms  p99=120ms Target p95<200ms ✅
  Full-text:       p50=25ms  p95=89ms  p99=150ms Target p95<200ms ✅
  Aggregation:     p50=35ms  p95=110ms p99=180ms Target p95<200ms ✅

SEARCH AROUND:
  Company→Employees: p50=45ms  p95=180ms  Target p95<500ms ✅

ACTIONS:
  100 sequential:  6.8s (68ms avg)  Target <10s ✅
  500 bulk:        8.2s             Target <15s ✅

All benchmarks PASSED.
```

### Validation Criteria
- All benchmarks pass their target thresholds
- Results are reproducible: the benchmark script runs all 5 benchmarks 3 times automatically and reports the median result. If any benchmark's max result exceeds 1.3× its min result (i.e., variance > 30%), print a warning `⚠ HIGH VARIANCE` next to that benchmark but do NOT fail the overall run
- Memory usage doesn't exceed 500MB during any benchmark (check `process.memoryUsage().rss` before and after each benchmark)
- No errors during benchmark execution
- Setup and teardown complete successfully (no leftover test data)
- The benchmark script exits with code 0 if all targets pass, code 1 if any target fails
