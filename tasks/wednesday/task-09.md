# TASK 9: Create the Full-Text Search Service

**File to create:** `/src/services/fullTextSearchService.js`

**Dependencies:** Task 1 (PropertyResolver for resolving text properties and boost targets).

**Purpose:** The full-text search endpoint (`/searchFullText`) searches across ALL text properties of an object type simultaneously, using a single search query string. This is the "search box" experience — the user types "melissa chang engineering" and the system finds objects where those terms appear in ANY text property (fullName, email, department, notes, etc.). This is different from the `contains` filter in the `search` endpoint, which searches within a single specific property.

**How Palantir implements this:** The Object Set Service builds an OpenSearch `multi_match` query that targets all text-typed properties of the object type. The query string is analyzed (tokenized, lowercased) and matched against all target fields.

**This service builds query components only. It does NOT format responses.** Response formatting (including `__highlights`) is handled by the Object Set Response Formatter (Task 7).

**Implementation details:**

1. **`buildFullTextSearchQuery(queryString, objectTypeApiName, propertyResolver)`** — Takes the user's search string and the object type, resolves all properties, identifies which ones are text-searchable (base type = `string`), and builds a `multi_match` query AND a `highlight` clause. Returns `{ query, highlight }`.

   Step 1: Validate the query string:
   - If the query string is empty or whitespace-only, throw `QueryValidationError` with message: `"Search query must be a non-empty string."`
   - If the query string exceeds 1,000 characters, throw `QueryValidationError` with message: `"Search query exceeds maximum length of 1000 characters."`

   Step 2: Call `propertyResolver.resolveAllProperties(objectTypeApiName)` to get all properties.

   Step 3: Filter to only `string` and `string_array` types — these are the only types that have analyzed text fields in OpenSearch. Collect their API names (these are the OpenSearch field names for the text fields, WITHOUT `.keyword`).

   Step 4: Determine boost values by querying PostgreSQL for the primary key and title property:

   ```sql
   SELECT primary_key_property_api_name, title_property_api_name FROM object_type WHERE api_name = $1
   ```

   Boost rules:
   - Primary key property field: `^5` (highest boost — if the user types an ID, they almost certainly want that exact object)
   - Title property field: `^3` (second highest — the display name is the most natural search field)
   - All other string properties: no explicit boost suffix (default boost of 1)

   Step 5: Build the OpenSearch `multi_match` query:

   ```json
   {
     "multi_match": {
       "query": "melissa chang engineering",
       "fields": ["employeeId^5", "fullName^3", "email", "department", "bio", "notes"],
       "type": "cross_fields",
       "operator": "and",
       "fuzziness": "AUTO"
     }
   }
   ```

   Explanation of parameters:
   - `"type": "cross_fields"` — Treats all target fields as though they were one big field. If the user searches "melissa chang", OpenSearch will match even if "melissa" appears in the `fullName` field and "chang" appears in a different field.
   - `"operator": "and"` — All search terms must be present (across any combination of fields).
   - `"fuzziness": "AUTO"` — For terms of 1-2 characters, no fuzziness; for 3-5 characters, edit distance 1; for 6+ characters, edit distance 2. This handles common typos.

   Step 6: Build the OpenSearch `highlight` clause:

   ```json
   {
     "highlight": {
       "fields": {
         "fullName": {},
         "email": {},
         "department": {},
         "bio": { "fragment_size": 150, "number_of_fragments": 3 },
         "notes": { "fragment_size": 150, "number_of_fragments": 3 }
       },
       "pre_tags": ["<mark>"],
       "post_tags": ["</mark>"]
     }
   }
   ```

   Rules for highlight field configuration:
   - For short fields (field names that are likely names, emails, departments — i.e., any field where the typical value is under 200 characters): use `{}` (return the full field highlighted)
   - For long fields (bio, notes, description — i.e., fields with `fragment_size` hints from the property metadata, or fields whose names suggest long-form text): use `{ "fragment_size": 150, "number_of_fragments": 3 }`
   - Heuristic: if a property name contains "bio", "notes", "description", "summary", "comment", or "body", treat it as a long field. All other string properties are treated as short fields.
   - Use `<mark>` tags for HTML semantic correctness.

   Step 7: Return `{ query: multiMatchQuery, highlight: highlightClause }`.

2. **Handling special characters:** If the user's query string contains OpenSearch special characters, escape the following characters by prepending a backslash: `\`, `"`, and any control characters. Do NOT escape all special characters aggressively — that would break legitimate queries like searching for email addresses (which contain `@` and `.`).

3. **Combining full-text search with filters:** The caller (route handler or query builder) is responsible for combining the `multi_match` query with an optional `where` clause. The combination strategy is:

   ```json
   {
     "bool": {
       "must": [
         { "multi_match": { ... } }
       ],
       "filter": [
         { "term": { "department.keyword": "Engineering" } }
       ]
     }
   }
   ```

   The `multi_match` goes in `must` (not `filter`) because we want relevance scoring from the text search. The `where` clause goes in `filter` because filters don't affect scoring and are cached for performance. This combination logic lives in the opensearchQueryBuilder (Task 17), not in this service.

**Export:** `{ buildFullTextSearchQuery }`

**Acceptance criteria:**
1. `buildFullTextSearchQuery("melissa chang", "Employee", resolver)` returns `{ query, highlight }` where `query` is a `multi_match` with `type: "cross_fields"` and `operator: "and"`.
2. The `fields` array in the returned query contains the primary key field with `^5` boost and the title field with `^3` boost.
3. The returned `highlight` object uses `<mark>` pre/post tags.
4. Empty string input throws `QueryValidationError` with message `"Search query must be a non-empty string."`.
5. 1001-character string throws `QueryValidationError` with message `"Search query exceeds maximum length of 1000 characters."`.
6. Query containing `"hello \"world\""` properly escapes the inner quotes.
7. The function does NOT build any `bool` query — combining with `where` is the caller's responsibility.
