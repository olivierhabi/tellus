# TASK 30: Create the Complete API Documentation

**File to create:** `/docs/QUERY_API.md`

**Purpose:** A comprehensive reference document for every query API endpoint. This document is what developers read when integrating with the API. It must include: every endpoint URL, every parameter, every possible response shape, every error code, and realistic examples. The documentation must be accurate to what was actually built — do NOT document features that don't exist.

**Sections to include:**

1. **Overview** — What the Object Set Service is, what it does, how it relates to the Ontology Engine.

2. **Authentication** — Note that week 1 has no authentication. Document the planned auth header format for future implementation: `Authorization: Bearer <token>`.

3. **Common Response Format** — The standard response shapes for success and error cases.

4. **Endpoints Reference** — For each of the 5 endpoints (list, get, search, aggregate, searchFullText):
   - URL and HTTP method
   - All parameters with types, defaults, and constraints
   - Complete request body schema (for POST endpoints)
   - Complete response body schema
   - 3+ realistic example requests and responses
   - All possible error responses with codes and messages

5. **Filter DSL Reference** — Complete specification of all 13 filter types with:
   - Syntax for each type
   - Which property types each filter supports
   - Example for each filter type on each compatible property type
   - How compound filters nest
   - Maximum nesting depth and array size limits

6. **Aggregation Reference** — Complete specification of all 9 aggregation types with examples.

7. **Pagination Reference** — How cursor-based pagination works, page token behavior, default sort order.

8. **Property Type Reference** — All 15+ supported base types and how they behave in queries, sorts, and aggregations.

9. **Error Code Reference** — Complete list of all error codes with descriptions and resolution steps.

10. **Limits and Constraints** — All limits in one table (max page size, max filter depth, max aggregations, etc.) with their values and Palantir documentation references.

The documentation must be written in Markdown with proper code blocks, tables, and cross-references. Total length should be approximately 3000–5000 words — thorough enough to be a standalone reference, but not so verbose that developers can't find what they need.
