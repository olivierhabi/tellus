# TASK 28: Create Integration Test — Aggregations

**File to create:** `/tests/query-aggregation.test.js`

**Purpose:** Verify that all 9 aggregation types return correct values when computed over real data.

**Test cases:**

1. `test_count` — Aggregate count over all employees → totalCount matches known count
2. `test_avg` — Aggregate avg salary → verify against manually calculated average from test data
3. `test_sum` — Aggregate sum salary → verify against manual sum
4. `test_min_max` — Aggregate min and max salary → verify against known min/max in test data
5. `test_terms` — Aggregate terms on department → verify each bucket count matches actual count per department
6. `test_date_histogram` — Aggregate date_histogram on startDate by year → verify counts per year
7. `test_range` — Aggregate range on salary with bands [0-50K, 50K-100K, 100K-200K, 200K+] → verify counts
8. `test_cardinality` — Aggregate cardinality on department → verify unique department count
9. `test_multiple_aggregations` — Request 5 aggregations in one call → all return correct values
10. `test_aggregation_with_filter` — Aggregate avg salary WHERE department eq "Engineering" → verify against filtered subset
11. `test_avg_on_string_field` — Aggregate avg on fullName → 400 error (incompatible type)
12. `test_date_histogram_on_number` — Aggregate date_histogram on salary → 400 error
