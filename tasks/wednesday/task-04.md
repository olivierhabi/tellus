# TASK 4: Create the Filter Translator — Compound Operators (and, or, not)

**File to modify:** `/src/services/queryTranslator.js` (add to the file from Task 3)

**Purpose:** Compound operators combine multiple filters into complex boolean expressions. These are the most powerful part of the query DSL because they allow arbitrary nesting. A query like "Find all employees in Engineering OR Sales who started after 2023 AND have salary greater than 100K" requires nested compound operators. The translation to OpenSearch's `bool` query must be exactly correct, including the handling of deeply nested expressions.

**How compound operators map to OpenSearch bool queries:**

OpenSearch's `bool` query has four clauses: `must` (AND), `should` (OR), `must_not` (NOT), and `filter` (AND without scoring). Since we're doing exact filtering (not relevance scoring), we should use `filter` context for `and` and `must_not` for `not`. However, for `or`, we must use `should` with `minimum_should_match: 1` inside a `filter` context.

**Translation rules for `and`:**

The `and` operator takes an array of sub-filters. ALL sub-filters must match. Translation:

Input:
```json
{
  "type": "and",
  "value": [
    { "type": "eq", "field": "department", "value": "Engineering" },
    { "type": "gt", "field": "salary", "value": 100000 }
  ]
}
```

Output (OpenSearch):
```json
{
  "bool": {
    "filter": [
      { "term": { "department.keyword": "Engineering" } },
      { "range": { "salary": { "gt": 100000 } } }
    ]
  }
}
```

The `filter` context is used instead of `must` because we don't need relevance scoring — we only care about whether the document matches or not. Using `filter` is more efficient because OpenSearch can cache filter results.

Each element in the `value` array must be recursively translated using the same `translateFilter` function. This is where the recursive nature of the translator comes in — a sub-filter could itself be another `and`, `or`, or `not` compound, or it could be a leaf filter (eq, gt, etc.).

**Translation rules for `or`:**

The `or` operator takes an array of sub-filters. AT LEAST ONE sub-filter must match. Translation:

Input:
```json
{
  "type": "or",
  "value": [
    { "type": "eq", "field": "department", "value": "Engineering" },
    { "type": "eq", "field": "department", "value": "Sales" }
  ]
}
```

Output (OpenSearch):
```json
{
  "bool": {
    "should": [
      { "term": { "department.keyword": "Engineering" } },
      { "term": { "department.keyword": "Sales" } }
    ],
    "minimum_should_match": 1
  }
}
```

The `minimum_should_match: 1` is CRITICAL. Without it, OpenSearch treats `should` clauses as optional boosting factors, and documents can match even if NONE of the should clauses match (if there are other must/filter clauses in the same bool query). Setting `minimum_should_match: 1` forces at least one `should` clause to match, which gives us true OR semantics.

**Translation rules for `not`:**

The `not` operator takes an array with EXACTLY ONE sub-filter. The sub-filter must NOT match. Translation:

Input:
```json
{
  "type": "not",
  "value": [
    { "type": "eq", "field": "status", "value": "terminated" }
  ]
}
```

Output (OpenSearch):
```json
{
  "bool": {
    "must_not": [
      { "term": { "status.keyword": "terminated" } }
    ]
  }
}
```

**Deeply nested compound expressions:**

The translator must handle arbitrary nesting up to 10 levels (as validated by Task 2). For example, a query like "Find employees who are (in Engineering AND have salary > 100K) OR (in Sales AND started after 2024)" translates to:

Input:
```json
{
  "type": "or",
  "value": [
    {
      "type": "and",
      "value": [
        { "type": "eq", "field": "department", "value": "Engineering" },
        { "type": "gt", "field": "salary", "value": 100000 }
      ]
    },
    {
      "type": "and",
      "value": [
        { "type": "eq", "field": "department", "value": "Sales" },
        { "type": "gt", "field": "startDate", "value": "2024-01-01" }
      ]
    }
  ]
}
```

Output (OpenSearch):
```json
{
  "bool": {
    "should": [
      {
        "bool": {
          "filter": [
            { "term": { "department.keyword": "Engineering" } },
            { "range": { "salary": { "gt": 100000 } } }
          ]
        }
      },
      {
        "bool": {
          "filter": [
            { "term": { "department.keyword": "Sales" } },
            { "range": { "startDate": { "gt": "2024-01-01", "format": "yyyy-MM-dd" } } }
          ]
        }
      }
    ],
    "minimum_should_match": 1
  }
}
```

**Implementation:**

Add three new handler functions to the `translateFilter` switch statement:

```javascript
case 'and': return translateAnd(filter, objectTypeApiName, propertyResolver);
case 'or': return translateOr(filter, objectTypeApiName, propertyResolver);
case 'not': return translateNot(filter, objectTypeApiName, propertyResolver);
```

Each handler must:
1. Extract the `value` array from the filter
2. Recursively call `translateFilter` for each sub-filter in the array (using `Promise.all` for parallel resolution since each sub-filter might need to resolve property metadata from PostgreSQL)
3. Wrap the translated sub-filters in the appropriate OpenSearch bool clause

**Optimization for single-element arrays:** If an `and` or `or` has only one element in its `value` array, don't wrap it in a bool query — just return the single translated sub-filter directly. This avoids unnecessary nesting in the OpenSearch query, which improves readability and slightly improves performance.

**Optimization for nested bools:** If an `and` contains another `and` as a sub-filter, the inner `and`'s filter clauses can be flattened into the outer `and`'s filter array. For example, `and([and([A, B]), C])` can be simplified to `and([A, B, C])`. This is called "bool query flattening" and is an important optimization for complex queries. Implement this for `and` (flatten nested ands) and `or` (flatten nested ors), but NOT for `not` (a not inside an and cannot be flattened).

**Edge cases:**
- Empty `value` array: Should have been caught by validation (Task 2), but as a safety net, an empty `and` should match everything (return `{ "match_all": {} }`) and an empty `or` should match nothing (return `{ "match_none": {} }`).
- `not` with a compound sub-filter: `not(and([A, B]))` means "not (A and B)", which is equivalent to "not A or not B" (De Morgan's law). However, do NOT apply De Morgan's law — just translate literally as `{ "bool": { "must_not": [translated_and_query] } }`. OpenSearch handles the logic correctly.
