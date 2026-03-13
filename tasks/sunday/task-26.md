# TASK 26: Seed Data Script — RRA Tax Example

## Objective
Create a script at `/src/seeds/rra_example.js` that populates the system with a complete Rwanda Revenue Authority tax example. This script creates the full Ontology with realistic object types, properties, link types, action types, and interfaces that demonstrate the system's capabilities for the RRA use case.

## Exact Specification

The script must create ALL of the following via API calls (not direct database inserts — this verifies the API works end-to-end):

**Object Types:**
1. **Taxpayer** — TIN (string, PK), fullName (string, title), taxpayerType (string: individual/corporate), province (string), registrationDate (date), riskScore (double), complianceStatus (string), annualDeclaredIncome (double)
2. **Business** — businessId (string, PK), tradeName (string, title), sector (string), registrationDate (date), annualRevenue (double), vatRegistered (boolean), ebmDeviceCount (integer), employeeCount (integer), ownerTin (string, used as link key to Taxpayer.TIN via link type)
3. **TaxReturn** — returnId (string, PK), taxType (string: VAT/CIT/PIT/PAYE), period (string), declaredRevenue (double), declaredTax (double), filingDate (date), status (string), auditFlag (boolean), taxpayerTin (string, used as link key to Taxpayer.TIN via link type)
4. **CustomsDeclaration** — declarationId (string, PK), hsCode (string), declaredValueUsd (double), originCountry (string), quantity (integer), dutyPaidRwf (double), declarationDate (date), importerBusinessId (string, used as link key to Business.businessId via link type)
5. **BankAccount** — accountId (string, PK), bankName (string, title), accountType (string), monthlyAvgTurnover (double), suspiciousFlag (boolean), holderTin (string, used as link key to Taxpayer.TIN via link type)
6. **Property** — propertyId (string, PK), locationType (string: residential/commercial/land), registeredValue (double), marketEstimate (double), district (string), latitude (double), longitude (double), ownerTin (string, used as link key to Taxpayer.TIN via link type)
7. **AuditCase** — caseId (string, PK), taxpayerTin (string, used as link key to Taxpayer.TIN via link type), status (string: open/investigating/closed), riskScore (double), assignedOffice (string), openedDate (date), evidence (string)

**Link Types:**
- Taxpayer → Business (ONE_TO_MANY via Business.ownerTin)
- Taxpayer → TaxReturn (ONE_TO_MANY via TaxReturn.taxpayerTin)
- Taxpayer → BankAccount (ONE_TO_MANY via BankAccount.holderTin)
- Taxpayer → Property (ONE_TO_MANY via Property.ownerTin)
- Business → CustomsDeclaration (ONE_TO_MANY via CustomsDeclaration.importerBusinessId)
- Taxpayer → AuditCase (ONE_TO_MANY via AuditCase.taxpayerTin)

**Action Types:**
- initiateAudit: Creates an AuditCase linked to a Taxpayer
- updateRiskScore: Modifies a Taxpayer's riskScore
- flagSuspiciousAccount: Modifies a BankAccount's suspiciousFlag
- closeAuditCase: Modifies an AuditCase's status to 'closed'

**Interfaces:**
- HasLocation: latitude (double), longitude (double) — implemented by Property
- Auditable: openedDate (date), status (string) — implemented by AuditCase

**Sample Data (via CSV upload + indexing):**
- 100 Taxpayers (mix of individual and corporate)
- 80 Businesses (linked to taxpayers, some taxpayers own multiple)
- 200 TaxReturns (multiple per taxpayer, different tax types and periods)
- 150 CustomsDeclarations (linked to businesses)
- 120 BankAccounts (some taxpayers have multiple)
- 90 Properties (various types and locations across Rwanda)
- 15 AuditCases (some open, some closed)

Generate the CSV data with realistic Rwandan names, Kigali-area coordinates (latitude between -2.5 and -1.3, longitude between 28.8 and 30.9), realistic RWF amounts (salaries 500,000-50,000,000 RWF range), and TIN format matching `/^\d{9}$/` (9-digit numeric strings). Include deliberate anomalies in the data that a tax auditor would want to investigate:
- 3 taxpayers with bank turnover 5x their declared income
- 2 businesses with customs declarations showing under-invoicing (declared value < 30% of market average for the HS code)
- 5 taxpayers who own 3+ properties but declare low income

The script should be runnable with: `node src/seeds/rra_example.js`
It should log progress to the console (e.g., 'Created Taxpayer object type...', 'Indexed 100 taxpayers...').

## Verification
1. Run the seed script → verify all object types, link types, action types, and interfaces are created
2. Query each object type → verify correct row counts
3. Test Search Around: Taxpayer → Businesses → CustomsDeclarations → verify the chain works
4. Execute the initiateAudit action → verify AuditCase is created and linked
5. Query the anomalies: search for taxpayers where `(monthlyAvgTurnover * 12) / annualDeclaredIncome > 5` → verify exactly 3 results are returned (the 3 planted anomalies)
