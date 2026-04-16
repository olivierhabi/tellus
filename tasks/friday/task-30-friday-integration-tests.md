# TASK 30: Build the Complete Friday Integration Test Suite

**Objective:** Create a comprehensive end-to-end integration test that exercises every component built today (Tasks 1-29) in a single automated test run. This test suite is the final verification that the entire Action system works correctly as an integrated whole. It simulates a realistic RRA workflow: create taxpayers, register businesses, file tax returns, flag for audit, and verify the complete audit trail.

**Create the test file** at `src/tests/friday-integration.test.js`.

**The test must run against a live PostgreSQL and OpenSearch instance** (not mocks). It sets up its own test data and cleans up after itself.

**Test flow (execute in this exact order):**

```javascript
describe('Friday Integration: Complete Action System', () => {
    let ontologyId;
    
    before(async () => {
        // Create a fresh test ontology
        ontologyId = await createTestOntology();
        // Create object types: Taxpayer, Business, TaxReturn, AuditCase
        await createTestObjectTypes(ontologyId);
        // Upload and index test CSV data: 100 taxpayers, 50 businesses
        await loadTestData(ontologyId);
        // Create action types using the seed script (Task 28)
        await seedActionTypes(ontologyId);
    });

    after(async () => {
        // Clean up: delete test ontology and all associated data
        await cleanupTestOntology(ontologyId);
    });

    // TEST GROUP 1: Action Type CRUD
    it('should create a custom action type with full validation', async () => {
        // Create action type with all parameter types and constraints
        // Verify it's persisted correctly
    });

    it('should reject invalid action type definitions', async () => {
        // Missing required fields → 400
        // Invalid parameter type → 400
        // Non-existent object type reference → 400
        // Duplicate apiName → 409
    });

    it('should update action type and return migration warnings', async () => {
        // Update parameters (remove one, change type of another)
        // Verify migration warnings are returned
    });

    it('should clone action type with new name', async () => {
        // Clone and verify independence from original
    });

    // TEST GROUP 2: Action Execution — Happy Paths
    it('should create a taxpayer via action', async () => {
        const result = await executeAction(ontologyId, 'registerTaxpayer', {
            tin: 'TIN-001-TEST', name: 'Test Taxpayer', type: 'Individual', province: 'Kigali'
        }, { executedBy: 'test-user' });
        
        assert(result.success === true);
        
        // Verify object exists in OpenSearch
        const taxpayer = await fetchObject('Taxpayer', 'TIN-001-TEST');
        assert(taxpayer.name === 'Test Taxpayer');
        assert(taxpayer.status === 'active'); // from static rule
        
        // Verify audit log entry
        const audit = await getAuditEntry(result.executionId);
        assert(audit.result === 'success');
        assert(audit.executed_by === 'test-user');
    });

    it('should file a tax return linked to taxpayer', async () => {
        const result = await executeAction(ontologyId, 'fileTaxReturn', {
            returnId: 'RET-001', taxpayerTin: 'TIN-001-TEST', taxType: 'VAT',
            period: '2025-Q1', declaredRevenue: 50000000, declaredTax: 9000000
        }, { executedBy: 'test-user' });
        
        assert(result.success === true);
        
        // Verify the TaxReturn object
        const taxReturn = await fetchObject('TaxReturn', 'RET-001');
        assert(taxReturn.taxType === 'VAT');
        assert(taxReturn.auditFlag === false);
        
        // Verify the link to taxpayer
        const linked = await fetchLinkedObjects('TaxReturn', 'RET-001', 'returnTaxpayer');
        assert(linked.length === 1);
        assert(linked[0].__pk === 'TIN-001-TEST');
    });

    it('should flag tax return for audit (multi-object modification)', async () => {
        const result = await executeAction(ontologyId, 'flagForAudit', {
            returnRef: 'RET-001', auditReason: 'Income discrepancy detected'
        }, { executedBy: 'senior-auditor' });
        
        assert(result.success === true);
        assert(result.affectedObjects.length === 2); // TaxReturn + Taxpayer both modified
        
        // Verify TaxReturn was flagged
        const taxReturn = await fetchObject('TaxReturn', 'RET-001');
        assert(taxReturn.auditFlag === true);
        
        // Verify Taxpayer compliance status was updated
        const taxpayer = await fetchObject('Taxpayer', 'TIN-001-TEST');
        assert(taxpayer.complianceStatus === 'under_review');
    });

    // TEST GROUP 3: Action Execution — Error Cases
    it('should reject duplicate taxpayer creation', async () => {
        const result = await executeAction(ontologyId, 'registerTaxpayer', {
            tin: 'TIN-001-TEST', name: 'Duplicate', type: 'Individual', province: 'Kigali'
        }, { executedBy: 'test-user' });
        
        assert(result.success === false);
        assert(result.failureType === 'duplicate_primary_key');
        
        // Verify audit log recorded the failure
        const audit = await getAuditEntry(result.executionId);
        assert(audit.result === 'failed');
    });

    it('should reject modification of non-existent object', async () => {
        const result = await executeAction(ontologyId, 'updateTaxpayerRiskScore', {
            taxpayerRef: 'TIN-NONEXISTENT', riskScore: 85
        }, { executedBy: 'test-user' });
        
        assert(result.success === false);
        assert(result.failureType === 'object_not_found');
    });

    it('should reject invalid parameter values', async () => {
        const result = await executeAction(ontologyId, 'updateTaxpayerRiskScore', {
            taxpayerRef: 'TIN-001-TEST', riskScore: 150 // exceeds max of 100
        }, { executedBy: 'test-user' });
        
        assert(result.success === false);
        assert(result.failureType === 'invalid_parameter');
    });

    // TEST GROUP 4: Atomicity
    it('should roll back all changes if any rule fails in multi-rule action', async () => {
        // Save current state
        const before = await fetchObject('Taxpayer', 'TIN-001-TEST');
        
        // Execute action where rule 2 will fail (modifying non-existent object)
        // Rule 1: modify TIN-001-TEST (would succeed)
        // Rule 2: modify TIN-NONEXISTENT (will fail)
        // Expected: Rule 1's changes are NOT applied
        
        // Create a test action type with two modifyObject rules:
        // Rule 1 targets TIN-001-TEST (exists), Rule 2 targets TIN-NONEXISTENT (doesn't exist)
        await createActionType(ontologyId, {
            apiName: 'atomicRollbackTest',
            displayName: 'Atomicity Rollback Test',
            parameters: [
                { apiName: 'target1', type: 'string', required: true },
                { apiName: 'target2', type: 'string', required: true },
                { apiName: 'newScore', type: 'integer', required: true }
            ],
            rules: [
                { type: 'modifyObject', objectType: 'Taxpayer',
                  objectReference: { source: 'parameter', param: 'target1' },
                  properties: { riskScore: { source: 'parameter', param: 'newScore' } } },
                { type: 'modifyObject', objectType: 'Taxpayer',
                  objectReference: { source: 'parameter', param: 'target2' },
                  properties: { riskScore: { source: 'parameter', param: 'newScore' } } }
            ]
        });

        const result = await executeAction(ontologyId, 'atomicRollbackTest',
            { target1: 'TIN-001-TEST', target2: 'TIN-NONEXISTENT', newScore: 999 },
            { executedBy: 'system' });
        assert(result.success === false);
        
        // Verify state unchanged
        const after = await fetchObject('Taxpayer', 'TIN-001-TEST');
        assert(JSON.stringify(before) === JSON.stringify(after));
    });

    // TEST GROUP 5: Idempotency
    it('should return cached result on retry with same idempotency key', async () => {
        const key = 'test-idem-' + Date.now();
        
        const res1 = await executeActionWithKey(ontologyId, 'registerTaxpayer', {
            tin: 'TIN-IDEM-TEST', name: 'Idempotent', type: 'Individual', province: 'Kigali'
        }, key, { executedBy: 'test-user' });
        
        const res2 = await executeActionWithKey(ontologyId, 'registerTaxpayer', {
            tin: 'TIN-IDEM-TEST', name: 'Idempotent', type: 'Individual', province: 'Kigali'
        }, key, { executedBy: 'test-user' });
        
        assert(res1.executionId === res2.executionId);
    });

    // TEST GROUP 6: Concurrency
    it('should detect concurrent modification conflict', async () => {
        const obj = await fetchObject('Taxpayer', 'TIN-001-TEST');
        const version = obj.__version;
        
        // First update succeeds
        await executeActionWithVersion(ontologyId, 'updateTaxpayerRiskScore',
            { taxpayerRef: 'TIN-001-TEST', riskScore: 90 }, version, { executedBy: 'user-a' });
        
        // Second update with stale version fails
        const result = await executeActionWithVersion(ontologyId, 'updateTaxpayerRiskScore',
            { taxpayerRef: 'TIN-001-TEST', riskScore: 95 }, version, { executedBy: 'user-b' });
        assert(result.success === false);
    });

    // TEST GROUP 7: Validate (dry run)
    it('should validate without applying changes', async () => {
        const preview = await validateAction(ontologyId, 'registerTaxpayer', {
            tin: 'TIN-VALIDATE', name: 'Preview Only', type: 'Individual', province: 'Kigali'
        });
        
        assert(preview.valid === true);
        assert(preview.preview.affectedObjectCount === 1);
        
        // Verify NO object was created
        const obj = await fetchObject('Taxpayer', 'TIN-VALIDATE');
        assert(obj === null);
    });

    // TEST GROUP 8: Batch execution
    it('should execute batch action with mixed success/failure', async () => {
        const result = await executeBatchAction(ontologyId, 'updateTaxpayerRiskScore', [
            { taxpayerRef: 'TIN-001-TEST', riskScore: 50 },
            { taxpayerRef: 'TIN-NONEXISTENT', riskScore: 60 }, // will fail
        ]);
        
        assert(result.successCount === 1);
        assert(result.failedCount === 1);
    });

    // TEST GROUP 9: Audit log completeness
    it('should have complete audit trail for all actions executed in this test', async () => {
        const stats = await getAuditStats(ontologyId);
        
        // Every action execution (success and failure) should be in the audit log
        assert(stats.totalExecutions >= 10); // we executed at least 10 actions
        assert(stats.results.success >= 4);
        assert(stats.results.failed >= 3);
        
        // Check specific entries
        const entries = await getAuditLog({ executedBy: 'senior-auditor' });
        assert(entries.data.length >= 1);
        assert(entries.data[0].action_type_api_name === 'flagForAudit');
    });

    // TEST GROUP 10: Edit history
    it('should show complete edit history for TIN-001-TEST taxpayer', async () => {
        const history = await getEditHistory('Taxpayer', 'TIN-001-TEST');
        
        // This taxpayer was: created, then complianceStatus changed, then riskScore changed (possibly multiple times)
        assert(history.totalCount >= 3);
        assert(history.data[history.data.length - 1].operation === 'create'); // oldest = creation
    });

    // TEST GROUP 11: Reindex preserves edits
    it('should preserve action edits after reindex from backing datasource', async () => {
        // Modify a taxpayer via action
        await executeAction(ontologyId, 'updateTaxpayerRiskScore', {
            taxpayerRef: 'TIN-001-TEST', riskScore: 99
        }, { executedBy: 'test-user' });
        
        // Trigger reindex from backing CSV (which has riskScore=0 or null)
        await reindexObjectType(ontologyId, 'Taxpayer');
        
        // Verify: action edit (riskScore=99) persists over datasource value
        const obj = await fetchObject('Taxpayer', 'TIN-001-TEST');
        assert(obj.riskScore === 99); // NOT the CSV value
    });

    // TEST GROUP 12: Rate limiting
    it('should rate limit excessive action executions', async () => {
        // This test should be run last because it hammers the API
        let rateLimited = false;
        for (let i = 0; i < 150; i++) {
            const res = await fetch(`http://localhost:3000/api/v1/actions/updateTaxpayerRiskScore/apply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parameters: { taxpayerRef: 'TIN-001-TEST', riskScore: i } })
            });
            if (res.status === 429) { rateLimited = true; break; }
        }
        assert(rateLimited === true);
    });
});
```

**The test suite must:**
1. Run with a single command: `npm test` or `node src/tests/friday-integration.test.js`
2. Set up its own test data (don't rely on any pre-existing state)
3. Clean up after itself (delete test ontology and all associated data)
4. Print a clear pass/fail summary with timing for each test
5. Exit with code 0 if all pass, code 1 if any fail
6. Complete in under 60 seconds (action execution should be fast)

**Use `node:test`** (built into Node.js 18+) as the test runner — no additional dependencies needed. Import with `const { describe, it, before, after } = require('node:test')` and assertions with `const assert = require('node:assert')`.

**Helper functions:** Create all helper functions in the test file itself (or in `src/tests/helpers.js` if they are large). The following 16 helpers are referenced in the tests and must be implemented:
- `createTestOntology()` — creates a test ontology in PostgreSQL, returns its ID
- `createTestObjectTypes(ontologyId)` — creates Taxpayer, Business, TaxReturn, AuditCase object types with properties
- `loadTestData(ontologyId)` — uploads and indexes test CSV data into OpenSearch
- `seedActionTypes(ontologyId)` — calls the seed script from Task 28
- `executeAction(ontologyId, apiName, params, context)` — calls `POST /apply`
- `executeActionWithKey(ontologyId, apiName, params, key, context)` — calls `POST /apply` with `Idempotency-Key` header
- `executeActionWithVersion(ontologyId, apiName, params, version, context)` — calls `POST /apply` with `$expectedVersion`
- `validateAction(ontologyId, apiName, params)` — calls `POST /validate`
- `executeBatchAction(ontologyId, apiName, paramsList)` — calls `POST /applyBatch`
- `fetchObject(objectType, pk)` — calls `objectChecker.fetchObject` (Task 10) directly
- `fetchLinkedObjects(objectType, pk, linkType)` — queries link_edit table + OpenSearch
- `getAuditEntry(executionId)` — calls `getAuditEntry` from Task 3's module directly
- `getAuditStats(ontologyId)` — calls `getAuditStats` from Task 3's module
- `getAuditLog(filters)` — calls `getAuditLog` from Task 3's module
- `getEditHistory(objectType, pk)` — calls `GET /editHistory` endpoint (Task 17)
- `reindexObjectType(ontologyId, objectType)` — calls `reindexObjectType` from Task 16's module
- `cleanupTestOntology(ontologyId)` — deletes the test ontology and all associated data

**Audit log cleanup:** The `action_audit_log` table has UPDATE/DELETE revoked (Task 3). For test cleanup, use a separate PostgreSQL connection with superuser privileges to delete test audit entries, OR (preferred) design the test assertions to be resilient to pre-existing data by filtering on the test ontology's action types and using `>=` assertions instead of `===` for counts.

**Run instructions:**
```bash
# Ensure PostgreSQL and OpenSearch are running
# Run the full test suite
npm test

# Expected output:
# Friday Integration: Complete Action System
#   ✓ should create a custom action type with full validation (12ms)
#   ✓ should reject invalid action type definitions (8ms)
#   ... (all tests)
#   ✓ should rate limit excessive action executions (1200ms)
# 
# 20 passing (4.2s)
# 0 failing
```

---

# FINAL CHECKLIST FOR FRIDAY

After all 30 tasks are complete, verify these acceptance criteria:

- [ ] `action_type` table exists with all columns and constraints
- [ ] `ontology_edit` table exists with proper indexes for pending edit queries
- [ ] `action_audit_log` table exists and is truly immutable (UPDATE/DELETE revoked)
- [ ] `idempotency_key` table exists with TTL
- [ ] `link_edit` table exists for many-to-many link tracking
- [ ] Action type CRUD API: all 5 endpoints work (create, list, get, update, delete)
- [ ] Action type clone endpoint works
- [ ] Action type impact analysis endpoint works
- [ ] Parameter validation handles all 15+ types with constraints
- [ ] Rule compiler handles all 5 rule types (create, modify, delete, addLink, removeLink)
- [ ] Rule compiler merges multiple rules targeting the same object
- [ ] Property type validation works for all Palantir base types
- [ ] Edit applicator writes to both PostgreSQL and OpenSearch atomically
- [ ] createObject rule checks for duplicate primary keys
- [ ] modifyObject rule verifies target exists and rejects PK modification
- [ ] deleteObject rule verifies target exists
- [ ] addLink/removeLink work for many-to-many and one-to-many cardinalities
- [ ] Reindex merges datasource data with user edits (edits win)
- [ ] Action execution orchestrator runs all 6 stages in correct order
- [ ] Audit log records EVERY execution attempt (success AND failure)
- [ ] Audit log query API supports filtering and pagination
- [ ] Audit stats endpoint returns correct aggregates
- [ ] Validate (dry run) endpoint works without applying changes
- [ ] Edit history API returns chronological edit trail for any object
- [ ] Batch execution endpoint handles mixed success/failure correctly
- [ ] Idempotency protection prevents duplicate execution
- [ ] Optimistic concurrency control detects conflicting updates
- [ ] Rate limiter returns 429 when limits exceeded
- [ ] Error responses follow standardized format across all endpoints
- [ ] All error codes match Palantir's documented failure types
- [ ] OpenAPI spec covers all 15 endpoints with full schemas
- [ ] Swagger UI is accessible at /api/v1/docs
- [ ] RRA seed action types are created and verified
- [ ] Integration test suite passes completely
- [ ] Request logging middleware captures all requests with timing
