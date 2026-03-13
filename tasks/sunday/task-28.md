# TASK 28: Performance Benchmarks Script

## Objective
Create `/src/benchmarks/run.js` that measures the performance of critical operations and outputs a report. This establishes baseline performance numbers for the system and helps identify bottlenecks.

## Exact Specification

**Data Setup:** The benchmark script must create its own test ontology, object types, and data before running benchmarks, and clean up after completion. It must NOT depend on the seed script (Task 26) or any external data.

Benchmark these operations:
1. Indexing: Time to index 1,000, 10,000, and 100,000 objects from CSV
2. Search: Average query latency for simple filter (single `eq` on a string property), complex filter (`and` of 3 conditions: `eq` on string + `gt` on double + `contains` on string), and full-text search (2-word phrase query)
3. Aggregation: Average latency for count, terms, and date_histogram aggregations
4. Search Around: Average latency for traversing 1 link, 2 links (chain)
5. Action execution: Average time for create, modify, delete actions
6. Object View: Average time for single Object View with 3 link types
7. Batch Object View: Average time for 50 objects
8. Polymorphic search: Average time across 3 implementing types

**Iteration counts:** Run 100 iterations for search, aggregation, action, Object View, and polymorphic search benchmarks. Run 3 iterations for indexing benchmarks (1K, 10K, 100K rows) since they are inherently long-running.

For each benchmark, report: min, max, avg, p50, p95, p99 latencies.

Output format: JSON report + human-readable console table.

Target benchmarks (based on Palantir's documented capabilities):
- Simple search: <50ms
- Complex search: <200ms
- Aggregation: <100ms
- Action execution: <500ms
- Indexing 10K objects: <10 seconds

**Pass/fail behavior:** The script exits with code 0 if all benchmarks meet targets, code 1 if any benchmark exceeds its target. Both the JSON report and console table are written regardless of pass/fail.

**Output:** Write JSON report to `/benchmarks/report.json`. Print a formatted table to the console showing all 8 benchmark categories with min, max, avg, p50, p95, p99 columns.

## Verification
1. Run `npm run benchmark` → verify JSON report is written to `/benchmarks/report.json`
2. Verify console output shows a formatted table with all 8 benchmark categories
3. Verify each category shows min, max, avg, p50, p95, p99 columns
4. Verify the script creates and cleans up its own test data
