# TASK 16: Validate the Aggregate Request Body

**File to modify:** `/src/services/queryValidator.js` (add the `validateAggregateQuery` function)

**Purpose:** The aggregate endpoint has a different request body structure from the search endpoint. While the `where` clause validation is identical, the `aggregations` array has its own validation rules that must be enforced before the query reaches OpenSearch. This task adds the `validateAggregateQuery` function to the existing query validator service from Task 2.

**What must be validated in the `aggregations` array:**

1. The `aggregations` field must be present and must be a non-empty array. Error if missing: `"The 'aggregations' field is required and must be a non-empty array."`.

2. Maximum of 25 aggregations per request. This prevents absurdly expensive queries. Error: `"Maximum of 25 aggregations per request. Got: ${count}."`.

3. Each aggregation must be an object with a `type` field (string) and a `name` field (string). The `name` must be a valid JavaScript identifier (letters, digits, underscores, starting with a letter or underscore) because it becomes a key in the response JSON.

4. Valid aggregation types are: `count`, `avg`, `sum`, `min`, `max`, `terms`, `date_histogram`, `range`, `cardinality`. Any other type must be rejected.

5. All aggregation types except `count` require a `field` property that references a valid property on the object type. `count` does NOT take a `field` property — it counts all matching objects regardless of any specific field.

6. Type compatibility (must use PropertyResolver to check):
   - `avg`, `sum`: field must be numeric (`integer`, `long`, `double`, `float`, `byte`, `short`, `decimal`)
   - `min`, `max`: field must be numeric OR `date` OR `timestamp`
   - `terms`: field can be any type except `geopoint`, `geoshape`, `struct`
   - `date_histogram`: field must be `date` or `timestamp`
   - `range`: field must be numeric
   - `cardinality`: field can be any type except `struct`

7. `terms` aggregation: optional `size` parameter. If present, must be a positive integer, minimum 1, maximum 1000. Default: 10.

8. `date_histogram` aggregation: requires `interval` parameter. Must be one of: `"year"`, `"quarter"`, `"month"`, `"week"`, `"day"`, `"hour"`, `"minute"`. Any other value → error.

9. `range` aggregation: requires `ranges` parameter. Must be a non-empty array of objects. Each object must have at least one of `from` (number) or `to` (number). If both are present, `from` must be less than `to`. At least 2 ranges are recommended but 1 is allowed.

10. Aggregation names must be unique. If two aggregations have the same `name`, reject with: `"Duplicate aggregation name '${name}'. Each aggregation must have a unique name."`.

11. The `where` clause, if present, uses the exact same validation as the search endpoint (reuse `validateSearchQuery`'s where-clause validation logic).

**Return value:** A cleaned/normalized version of the request body where all defaults have been filled in (e.g., `terms.size` defaults to 10 if not provided, `$pageSize` has no meaning for aggregation but should not cause an error if accidentally included).
