# TASK 28: Build Comprehensive Action Type Seed Data

**Objective:** Create a seed script that populates the system with realistic action types for the RRA (Rwanda Revenue Authority) tax use case. This seed data serves two purposes: (1) it verifies that the entire action system works with real-world action configurations, and (2) it provides ready-to-use action types for the demo/testing phase.

**Create the script** at `src/seeds/actionTypes.seed.js`.

The script must be idempotent — running it multiple times should not create duplicates (use ON CONFLICT DO NOTHING or check-before-insert).

**Action types to create (assumes the following object types exist: Taxpayer, TaxReturn, Business, Payment, AuditCase, Employee, Company). If any of these object types do not exist, the seed script should fail with a helpful error message listing which object types are missing.**

1. **registerTaxpayer**: Creates a new Taxpayer object with TIN, name, type (Individual/Corp), registration date, and province. Auto-sets status to "active" and createdAt to current timestamp.

2. **fileTaxReturn**: Creates a new TaxReturn object linked to a Taxpayer. Sets: returnId, taxType (VAT/CIT/PIT/PAYE), period, declaredRevenue, declaredTax, filingDate (current timestamp), status ("filed"), auditFlag (false).

3. **flagForAudit**: Takes two parameters: `returnRef` (type: `object_reference`, objectType: `TaxReturn`, required) and `auditReason` (type: `string`, required). Has TWO rules:
   - Rule 1: `modifyObject` on `TaxReturn` with `objectReference: { source: "parameter", param: "returnRef" }`, setting `auditFlag: { source: "static", value: true }` and `auditReason: { source: "parameter", param: "auditReason" }`.
   - Rule 2: `modifyObject` on `Taxpayer`. To identify the linked Taxpayer, add a third parameter `taxpayerRef` (type: `object_reference`, objectType: `Taxpayer`, required) — the caller must provide the Taxpayer TIN explicitly. Set `complianceStatus: { source: "static", value: "under_review" }`.

4. **updateTaxpayerRiskScore**: Modifies a Taxpayer's riskScore property. Includes constraint: riskScore must be between 0 and 100.

5. **closeTaxReturn**: Modifies a TaxReturn to set status="closed" and closedAt to current timestamp.

6. **registerBusiness**: Creates a Business object with BizID, tradeName, sector, registrationDate, and links it to its owning Taxpayer via an `addLink` rule using link type `taxpayerBusinesses` (a ONE_TO_MANY link where `Business.ownerTin` is the FK). Parameters: `bizId` (string, required), `tradeName` (string, required), `sector` (string, required), `ownerTin` (object_reference to Taxpayer, required). Rules: (1) `createObject` for Business, (2) `addLink` with linkType `taxpayerBusinesses`, source=bizId parameter, target=ownerTin parameter.

7. **recordPayment**: Creates a Payment object linked to a TaxReturn with: paymentId, amount, paymentDate, paymentMethod, referenceNumber.

8. **initiateAudit**: Creates an AuditCase object linked to a Taxpayer with: caseId, assignedTo (parameter), openedAt (current timestamp), status ("open"), priority (parameter).

For each action type, include: full parameter definitions with appropriate types, constraints, and required flags; complete rule definitions with proper source mappings; realistic display names and descriptions.

**The script should:**
1. Check if the ontology and required object types exist (fail with helpful message if not)
2. Create each action type using the createActionType function from Task 1
3. Log each creation: "Created action type: registerTaxpayer (Register New Taxpayer)"
4. **(Optional self-test)** After all are created, optionally execute a basic smoke test for each one. This is a convenience check, not a substitute for the integration test suite in Task 30. If any smoke test fails, log a warning but do NOT roll back the created action types — the action types are still valid even if the test data isn't set up correctly.
5. Print a summary: "8/8 action types created successfully"

**Test the seed script end-to-end:**
```bash
node src/seeds/actionTypes.seed.js
# Expected output:
# Created action type: registerTaxpayer (Register New Taxpayer) ✓
# Created action type: fileTaxReturn (File Tax Return) ✓
# ... (all 8)
# Verification: registerTaxpayer execution ✓
# Verification: fileTaxReturn execution ✓
# ... (all 8)
# Summary: 8/8 action types created and verified successfully
```
