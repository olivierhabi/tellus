# TASK 10: Interface System Integration Tests

**Depends on:** Tasks 1-9 must be complete and all endpoints functional.

## Objective
Write a comprehensive integration test suite that tests the entire Interface system end-to-end, from creation through polymorphic queries. These tests serve as the source of truth for whether the Interface implementation is correct and as regression protection for future changes.

## Exact Specification

Create a test file at `/src/tests/interfaces.test.js` that uses the `node:test` module (built into Node.js 18+) and the `node:assert` module. Each test should make real HTTP requests to the running server (integration tests, not unit tests) using the built-in `fetch` API (available in Node.js 18+, no additional dependencies needed).

The test file must contain the following test cases, organized into describe blocks:

**Describe Block 1: "Interface CRUD"**

Test 1.1: "should create an Interface with valid properties"
- POST a new Interface "HasLocation" with 3 properties (latitude double required, longitude double required, locationName string optional)
- Assert: HTTP 201
- Assert: Response contains interfaceId (UUID format)
- Assert: Response contains all 3 properties with correct types
- Assert: implementingObjectTypes is empty array
- Assert: createdAt and updatedAt are valid ISO timestamps

Test 1.2: "should reject duplicate Interface apiName"
- POST another Interface with apiName "HasLocation"
- Assert: HTTP 409
- Assert: error.code === "ALREADY_EXISTS"

Test 1.3: "should reject invalid apiName format"
- POST with apiName "has-location" (contains hyphen)
- Assert: HTTP 400
- Assert: error.code === "INVALID_FORMAT"

Test 1.4: "should reject Interface with empty properties array"
- POST with properties: []
- Assert: HTTP 400
- Assert: error.code === "INVALID_PARAMETER"

Test 1.5: "should reject property with invalid baseType"
- POST with a property that has baseType "varchar"
- Assert: HTTP 400

Test 1.6: "should list all Interfaces in an Ontology"
- Create 3 Interfaces: HasLocation, Auditable, Schedulable
- GET /interfaces
- Assert: totalCount === 3
- Assert: All 3 appear with correct property counts

Test 1.7: "should get a single Interface by apiName"
- GET /interfaces/HasLocation
- Assert: HTTP 200
- Assert: Correct properties and metadata

Test 1.8: "should return 404 for non-existent Interface"
- GET /interfaces/DoesNotExist
- Assert: HTTP 404

Test 1.9: "should update Interface display name and description"
- PUT /interfaces/HasLocation with new displayName
- Assert: HTTP 200
- Assert: displayName changed
- Assert: updatedAt changed (different from createdAt)

Test 1.10: "should add a new property to Interface via PUT"
- PUT HasLocation with latitude, longitude, locationName, AND a new property "altitude" (double, optional)
- Assert: HTTP 200
- Assert: 4 properties in response

Test 1.11: "should delete Interface with no implementations"
- Create Interface "Temporary"
- DELETE /interfaces/Temporary
- Assert: HTTP 204
- GET /interfaces/Temporary → 404

**Describe Block 2: "Interface Implementation"**

Test 2.1: "should allow Object Type to implement Interface"
- Create Object Type Airport with properties airportLat (double), airportLng (double), airportName (string)
- POST implements HasLocation with mapping { latitude: "airportLat", longitude: "airportLng", locationName: "airportName" }
- Assert: HTTP 201

Test 2.2: "should reject implementation with missing required mapping"
- Create Object Type Warehouse with properties warehouseLat (double)
- POST implements HasLocation with mapping { latitude: "warehouseLat" } (missing longitude)
- Assert: HTTP 400
- Assert: error.code === "MISSING_REQUIRED_MAPPING"

Test 2.3: "should reject implementation with type mismatch"
- Create Object Type BadMapping with properties locationText (string)
- POST implements HasLocation with mapping { latitude: "locationText" } (string != double)
- Assert: HTTP 400
- Assert: error.code === "TYPE_MISMATCH"

Test 2.4: "should reject duplicate implementation"
- POST implements HasLocation on Airport again
- Assert: HTTP 409

Test 2.5: "should list Object Type's Interface implementations"
- GET /objectTypes/Airport/implements
- Assert: HasLocation appears

Test 2.6: "should prevent deleting Interface with implementations"
- DELETE /interfaces/HasLocation
- Assert: HTTP 409
- Assert: error.code === "INTERFACE_IN_USE"

Test 2.7: "should prevent removing mapped property from Interface"
- PUT HasLocation WITHOUT the locationName property (while Airport still maps it)
- Assert: HTTP 409
- Assert: error.code === "PROPERTY_IN_USE"

Test 2.8: "should remove Interface implementation"
- DELETE /objectTypes/Airport/implements/HasLocation
- Assert: HTTP 204

**Describe Block 3: "Polymorphic Queries"**

(Setup: Create HasLocation Interface, implement with Airport and Warehouse, index 5 airports and 5 warehouses with known lat/lng values)

Test 3.1: "should search across all implementing Object Types"
- POST /interfaces/HasLocation/search with no filter
- Assert: 10 total results (5 airports + 5 warehouses)
- Assert: all results have Interface property names (latitude, longitude)

Test 3.2: "should filter using Interface property names"
- POST search with latitude > -1.5
- Assert: only objects with latitude > -1.5 returned
- Assert: results may include both airports and warehouses

Test 3.3: "should handle unmapped optional properties in filter"
- POST search with locationName = "Kigali"
- Assert: only Airport results returned (Warehouse doesn't map locationName)

Test 3.4: "should sort across Object Types"
- POST search with $orderBy latitude ascending
- Assert: results are sorted by latitude regardless of Object Type

Test 3.5: "should paginate merged results"
- POST search with $pageSize = 3
- Assert: 3 results returned
- Assert: nextPageToken is not null
- Use nextPageToken → get next 3 results
- Continue until all 10 objects retrieved

Test 3.6: "should aggregate count across Object Types"
- POST aggregate with count
- Assert: totalCount === 10

Test 3.7: "should aggregate avg using weighted average"
- POST aggregate with avg(latitude)
- Manually compute the correct weighted average from known data
- Assert: result matches within floating point tolerance (0.0001)

Test 3.8: "should aggregate terms by __objectType"
- POST aggregate with terms(__objectType)
- Assert: two buckets: Airport=5, Warehouse=5

**Test cleanup:** After all tests, delete all test data (Interfaces, Object Types, OpenSearch indexes) to leave the system clean.

Tests in this file run in the order specified. Each describe block depends on data created by previous tests. Use a `before()` hook in each describe block to verify preconditions. Implement a global `after()` hook that deletes all test data regardless of test outcomes (wrap cleanup in try/catch to ensure it runs even after failures).

Add this comment at the top of the test file: `// Tests run in sequential order. Each describe block depends on data from previous blocks.`

Run the tests with: `node --test src/tests/interfaces.test.js`

## Verification
All 27 test cases pass. Zero failures. Zero skipped tests.
