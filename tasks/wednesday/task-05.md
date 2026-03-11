# TASK 5: Create the Filter Translator — contains, startsWith, isNull, isNotNull, in

**File to modify:** `/src/services/queryTranslator.js` (add to the file from Tasks 3 and 4)

**Purpose:** These are the remaining leaf filter operators. Each has specific behavior that must exactly match how Palantir's Object Set Service handles them. The `contains` operator is particularly important because it's the operator that enables full-text search within a specific property (as opposed to the `searchFullText` endpoint which searches across ALL properties).

**Translation rules for `contains` (full-text match within a property):**

The `contains` filter performs a full-text search on a single property. It uses OpenSearch's `match` query, which tokenizes the search term and matches documents that contain the tokens. This is fundamentally different from `eq` — `contains` with value "John Smith" will match "John Paul Smith", "Smith, John", and any document where the tokens "john" and "smith" appear in the field (after analysis/lowercasing).

ONLY `string` properties support the `contains` filter. For non-string properties, the query validator (Task 2) should have already rejected the query.

Translation:
```json
// Input
{ "type": "contains", "field": "fullName", "value": "melissa chang" }

// Output (OpenSearch) — use the text field, NOT the keyword sub-field
{ "match": { "fullName": { "query": "melissa chang", "operator": "and" } } }
```

The `"operator": "and"` is important. By default, OpenSearch's `match` query uses the `or` operator, meaning a document matches if it contains ANY of the search tokens. With `"operator": "and"`, the document must contain ALL tokens. For the value "melissa chang", this means the document must contain both "melissa" AND "chang" in the `fullName` field. This is the expected behavior for a `contains` filter — the user expects all their search terms to be present.

If the search value is a single word, `operator` doesn't matter, but always include it for consistency.

**Translation rules for `startsWith`:**

The `startsWith` filter matches documents where the property value starts with the given prefix. It uses OpenSearch's `prefix` query on the `.keyword` sub-field (not the text field, because prefix matching on an analyzed text field would match individual tokens starting with the prefix, not the full value).

```json
// Input
{ "type": "startsWith", "field": "lastName", "value": "Cha" }

// Output — use keyword sub-field for prefix matching on the full value
{ "prefix": { "lastName.keyword": { "value": "Cha", "case_insensitive": true } } }
```

The `"case_insensitive": true` is included because users generally expect case-insensitive prefix matching. Note: this requires OpenSearch 2.x. If case sensitivity is needed, it can be made configurable later.

`startsWith` only works on `string` properties. For non-string types, throw an error.

**Translation rules for `isNull`:**

The `isNull` filter matches documents where the property has no value (the field is missing or explicitly null). It uses OpenSearch's `exists` query, negated.

```json
// Input
{ "type": "isNull", "field": "email" }

// Output — "does NOT exist" means null
{ "bool": { "must_not": [{ "exists": { "field": "email" } }] } }
```

Important: For string properties, use the base field name (not `.keyword`), because `exists` checks whether the field exists at all, not a specific sub-field. The field name from the PropertyResolver for `isNull`/`isNotNull` should always be the base field name without `.keyword`.

`isNull` works on ALL property types. No type restriction.

`isNull` does NOT take a `value` parameter. If a value is provided, the validator should have already rejected it.

**Translation rules for `isNotNull`:**

The inverse of `isNull`. Matches documents where the property has a value.

```json
// Input
{ "type": "isNotNull", "field": "email" }

// Output — "does exist" means not null
{ "exists": { "field": "email" } }
```

**Translation rules for `in`:**

The `in` filter matches documents where the property value equals ANY of the values in the provided array. It uses OpenSearch's `terms` query (plural, not `term`).

For `string` properties — use `.keyword` sub-field:
```json
// Input
{ "type": "in", "field": "department", "value": ["Engineering", "Sales", "Marketing"] }

// Output
{ "terms": { "department.keyword": ["Engineering", "Sales", "Marketing"] } }
```

For numeric properties — use field directly:
```json
// Input
{ "type": "in", "field": "age", "value": [25, 30, 35] }

// Output
{ "terms": { "age": [25, 30, 35] } }
```

For `boolean` properties:
```json
{ "terms": { "isActive": [true] } }
```

For `date`/`timestamp` properties:
```json
{ "terms": { "startDate": ["2024-01-01", "2024-06-01", "2025-01-01"] } }
```

**Performance consideration for `in` with large arrays:** OpenSearch handles `terms` queries efficiently up to about 65,536 values (the default `index.max_terms_count`). Our validator limits to 10,000 (Task 2), well within this limit. However, for arrays with more than 100 values, consider logging a warning — very large `in` clauses often indicate a design problem (the user should probably be using a join/link traversal instead).

**Implementation:** Add five new case handlers to the `translateFilter` switch:

```javascript
case 'contains': return translateContains(filter, objectTypeApiName, propertyResolver);
case 'startsWith': return translateStartsWith(filter, objectTypeApiName, propertyResolver);
case 'isNull': return translateIsNull(filter, objectTypeApiName, propertyResolver);
case 'isNotNull': return translateIsNotNull(filter, objectTypeApiName, propertyResolver);
case 'in': return translateIn(filter, objectTypeApiName, propertyResolver);
```

After this task, the `translateFilter` function is COMPLETE — it handles all 13 filter types (eq, gt, gte, lt, lte, contains, startsWith, isNull, isNotNull, in, and, or, not).
