# TASK 20 OF 30: Seed Script with RRA Test Data

**Objective:** Create a seed script that populates the database with realistic Rwanda Revenue Authority test data — complete with an ontology, object types, properties, datasources, and sample CSV files. This script uses the service layers (NOT direct SQL) to ensure the same validation logic runs as for API requests.

**Step-by-step instructions:**

Create src/seed.js. The script must be idempotent: if run multiple times, it should first delete any existing "RRA Tax Ontology" (by display name) and then recreate everything from scratch. This ensures a clean state on every run.

**Step 1: Create the ontology**
Call `ontologyService.create({displayName: "RRA Tax Ontology", description: "Rwanda Revenue Authority tax collection digital twin."})`.

**Step 2: Create five object types with full property definitions**

For each object type below, use `objectTypeService.create(ontologyId, {...})` to create the type, then `propertyService.create(objectTypeId, {...})` for each property, then `propertyService.setPrimaryKey(objectTypeId, pkApiName)` and `propertyService.setTitleProperty(objectTypeId, titleApiName)`.

**(1) Taxpayer** — apiName: `"Taxpayer"`, displayName: `"Taxpayer"`, icon: `"person"`, iconColor: `"#1565C0"`
10 properties:
| apiName | displayName | baseType | isRequired | Notes |
|---|---|---|---|---|
| tin | TIN | string | true | PK |
| fullName | Full Name | string | true | Title |
| taxpayerType | Taxpayer Type | string | false | "individual" or "corporate" |
| registrationDate | Registration Date | date | false | |
| province | Province | string | false | |
| sector | Sector | string | false | |
| riskScore | Risk Score | double | false | |
| complianceStatus | Compliance Status | string | false | |
| phoneNumber | Phone Number | string | false | |
| email | Email | string | false | |

setPrimaryKey → `"tin"`, setTitleProperty → `"fullName"`

**(2) Business** — apiName: `"Business"`, displayName: `"Business"`, icon: `"building"`, iconColor: `"#2E7D32"`
8 properties:
| apiName | displayName | baseType | isRequired | Notes |
|---|---|---|---|---|
| businessId | Business ID | string | true | PK |
| tradeName | Trade Name | string | true | Title |
| sector | Sector | string | false | |
| registrationDate | Registration Date | date | false | |
| annualRevenue | Annual Revenue | double | false | |
| isVatRegistered | VAT Registered | boolean | false | |
| ebmDeviceCount | EBM Device Count | integer | false | |
| employeeCount | Employee Count | integer | false | |

setPrimaryKey → `"businessId"`, setTitleProperty → `"tradeName"`

**(3) TaxReturn** — apiName: `"TaxReturn"`, displayName: `"Tax Return"`, icon: `"document"`, iconColor: `"#E65100"`
8 properties:
| apiName | displayName | baseType | isRequired | Notes |
|---|---|---|---|---|
| returnId | Return ID | string | true | PK |
| taxType | Tax Type | string | false | "VAT"/"CIT"/"PIT"/"PAYE" |
| period | Period | string | false | |
| declaredRevenue | Declared Revenue | double | false | |
| declaredTax | Declared Tax | double | false | |
| filingDate | Filing Date | date | true | |
| status | Status | string | false | "filed"/"assessed"/"audited" |
| auditFlag | Audit Flag | boolean | false | |

setPrimaryKey → `"returnId"`, setTitleProperty → `"returnId"`

**(4) CustomsDeclaration** — apiName: `"CustomsDeclaration"`, displayName: `"Customs Declaration"`, icon: `"truck"`, iconColor: `"#4527A0"`
8 properties:
| apiName | displayName | baseType | isRequired | Notes |
|---|---|---|---|---|
| declarationId | Declaration ID | string | true | PK |
| hsCode | HS Code | string | true | |
| declaredValue | Declared Value | double | false | |
| originCountry | Origin Country | string | false | |
| importDate | Import Date | date | false | |
| quantity | Quantity | integer | false | |
| dutyPaid | Duty Paid | double | false | |
| importerTin | Importer TIN | string | false | |

setPrimaryKey → `"declarationId"`, setTitleProperty → `"declarationId"`

**(5) RealEstateProperty** — apiName: `"RealEstateProperty"`, displayName: `"Real Estate Property"`, icon: `"globe"`, iconColor: `"#00695C"`
7 properties:
| apiName | displayName | baseType | isRequired | Notes |
|---|---|---|---|---|
| propertyId | Property ID | string | true | PK |
| location | Location | geopoint | false | |
| propertyType | Property Type | string | false | "residential"/"commercial"/"land" |
| registeredValue | Registered Value | double | false | |
| district | District | string | false | |
| ownerTin | Owner TIN | string | false | |
| registrationDate | Registration Date | date | false | |

setPrimaryKey → `"propertyId"`, setTitleProperty → `"propertyId"`

**Step 3: Generate CSV test data files**

Create directory `/tmp/ontology-testdata/` (use `fs.mkdirSync` with `{recursive: true}`).

For each object type, generate a CSV file with **100 rows** of realistic Rwandan data:
- File paths: `/tmp/ontology-testdata/taxpayers.csv`, `/tmp/ontology-testdata/businesses.csv`, `/tmp/ontology-testdata/tax-returns.csv`, `/tmp/ontology-testdata/customs-declarations.csv`, `/tmp/ontology-testdata/real-estate.csv`
- Use realistic TIN formats: 10-digit numbers starting with "1" (e.g., "1000000001")
- Use Rwandan district names: Kicukiro, Gasabo, Nyarugenge, Muhanga, Huye, Rubavu, Musanze, Rusizi
- Use realistic company names (e.g., "Kigali Trading Ltd", "Rwanda Coffee Exports")
- Use proper date format: YYYY-MM-DD
- Use plausible financial amounts in RWF (e.g., revenue: 1000000–500000000)
- For geopoint columns, use the format `"lat,lon"` with coordinates in Rwanda (lat: -1.0 to -3.0, lon: 28.5 to 30.9)

**Step 4: Register each CSV as a backing datasource**

For each object type, call `datasourceService.register(objectTypeId, {datasetName, filePath, fileFormat: 'csv', columnMapping})`.

Column mappings (property apiName → CSV column header):
- Taxpayer: `{tin: "tin", fullName: "full_name", taxpayerType: "taxpayer_type", registrationDate: "registration_date", province: "province", sector: "sector", riskScore: "risk_score", complianceStatus: "compliance_status", phoneNumber: "phone_number", email: "email"}`
- Business: `{businessId: "business_id", tradeName: "trade_name", sector: "sector", registrationDate: "registration_date", annualRevenue: "annual_revenue", isVatRegistered: "is_vat_registered", ebmDeviceCount: "ebm_device_count", employeeCount: "employee_count"}`
- TaxReturn: `{returnId: "return_id", taxType: "tax_type", period: "period", declaredRevenue: "declared_revenue", declaredTax: "declared_tax", filingDate: "filing_date", status: "status", auditFlag: "audit_flag"}`
- CustomsDeclaration: `{declarationId: "declaration_id", hsCode: "hs_code", declaredValue: "declared_value", originCountry: "origin_country", importDate: "import_date", quantity: "quantity", dutyPaid: "duty_paid", importerTin: "importer_tin"}`
- RealEstateProperty: `{propertyId: "property_id", location: "location", propertyType: "property_type", registeredValue: "registered_value", district: "district", ownerTin: "owner_tin", registrationDate: "registration_date"}`

**Step 5: Log progress**

For each object type created, log: `"Created object type: {displayName} ({propertyCount} properties)"`.
At the end, log: `"Seed complete: 1 ontology, 5 object types, 41 properties, 5 datasources, 500 test data rows."`.

On any error, log the error and call `process.exit(1)`. On success, call `process.exit(0)`.

**Files to create:** src/seed.js, CSV files in /tmp/ontology-testdata/

**Verification:**
- `npm run seed` completes without errors
- `npm run seed` run a second time also completes without errors (idempotency)
- `GET /api/v1/ontology` returns 1 ontology with objectTypeCount: 5
- `GET /api/v1/ontology/:id/objectTypes` returns 5 types
- `GET /api/v1/ontology/:id/objectTypes/Taxpayer` returns 10 properties, a backing datasource with rowCount 100, and funnelState with status 'not_indexed'
- CSV files in `/tmp/ontology-testdata/` each have exactly 101 lines (1 header + 100 data rows)
