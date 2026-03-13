## TASK 29: Build the Run-All-Tests Script

### Context
There are now 8 integration tests and 1 performance benchmark. We need a single command that runs everything in the correct order, handles setup/teardown, and produces a consolidated report. This is what the human will run at the end of Saturday to verify everything works.

### Exact Specification

Create `/tests/runAll.js`:

**Execution order:**
1. Check prerequisites: PostgreSQL is reachable (`SELECT 1` with 5-second timeout) and OpenSearch is reachable (`GET /` with 5-second timeout). If either check fails, print which service is unreachable and exit immediately with code 2 (distinct from code 1 = test failures). Do NOT proceed to migrations or tests.
2. Run database migrations (execute the migration runner from Task 1)
3. Clean any stale test data:
   - Drop all OpenSearch indices matching the pattern `ontology_*` (these are object type indices)
   - Truncate PostgreSQL tables in this order (respecting foreign keys): `ontology_edit`, `funnel_state`, `reindex_history`, `backing_datasource`, `object_type_property`, `object_type`, `link_type`, `action_type_parameter`, `action_type`, `interface`, `ontology`, `dataset_transaction`, `dataset`
4. Run integration tests in order:
   - test01_upload_to_query.js
   - test02_edit_preservation.js
   - test03_multi_transaction.js
   - test04_link_traversal.js
   - test05_bulk_actions_audit.js
   - test06_dataset_versioning.js
   - test07_mapping_suggestions.js
   - test08_error_handling.js
5. Run performance benchmark (optional — skip with --skip-perf flag)
6. Clean up all test data (same truncation + index drop as step 3, runs even if tests fail — wrap steps 4-5 in try/finally)
7. Print consolidated report and exit with code 0 if all tests passed, code 1 if any test failed

**Report format:**
```
╔══════════════════════════════════════════════════════════╗
║       ONTOLOGY ENGINE — DAY 6 TEST REPORT               ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  Test Suite 1: Upload to Query Pipeline      11/11 PASS  ║
║  Test Suite 2: Edit Preservation             17/17 PASS  ║
║  Test Suite 3: Multi-Transaction Merge       13/13 PASS  ║
║  Test Suite 4: Link Traversal After Reindex   7/7  PASS  ║
║  Test Suite 5: Bulk Actions & Audit          8/8  PASS   ║
║  Test Suite 6: Dataset Versioning            13/13 PASS  ║
║  Test Suite 7: Mapping Suggestions            6/6  PASS  ║
║  Test Suite 8: Error Handling                15/15 PASS  ║
║  Performance Benchmark:                       5/5  PASS  ║
║                                                          ║
║  TOTAL: {passed}/{total} tests passed                     ║
║  Total duration: 48.3 seconds                            ║
║                                                          ║
║  ✅ ALL TESTS PASSED — Ontology Engine Day 6 Complete    ║
╚══════════════════════════════════════════════════════════╝
```

If any tests fail:
```
║  ❌ FAILURES DETECTED                                    ║
║                                                          ║
║  Test 2.7: SALARY PRESERVED AFTER REINDEX                ║
║    Expected: salary === 999999                           ║
║    Actual:   salary === 100000                           ║
║    → Edit was overwritten during reindex!                 ║
```

**Command:**
```bash
node tests/runAll.js           # Run all tests including performance
node tests/runAll.js --skip-perf  # Skip performance benchmark
node tests/runAll.js --suite 2    # Run only test suite 2
node tests/runAll.js --verbose    # Show full API responses for debugging
```

**Test count convention:** Each test file exports a `tests` array (or the runner counts the number of test functions executed). The `{passed}/{total}` counts in the report are computed dynamically at runtime — do NOT hardcode 95. Each test file must export or report how many individual tests it contains so the runner can compute the total.

### Validation Criteria
- All test suites run in correct order
- Failed tests show clear diagnostic information (test name, expected value, actual value, descriptive message)
- --skip-perf flag works (skips benchmark, does not count benchmark tests in total)
- --suite N flag works (runs only the specified suite number, still does setup/teardown)
- Test data is cleaned up after run (even if tests fail)
- Total run time is under 2 minutes (excluding performance tests)
- Exit code 0 on all pass, 1 on any failure, 2 on prerequisite failure
- The `{passed}/{total}` counts are dynamically computed, never hardcoded
