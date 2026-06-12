// ---------------------------------------------------------------------------
// Seed Script — Rwanda Revenue Authority Test Data
//
// Populates the database with a realistic RRA ontology containing 5 object
// types, 41 properties, 5 backing datasources, and 500 rows of test CSV data.
//
// Idempotent: deletes any existing "RRA Tax Ontology" before recreating.
// Uses service layers (not raw SQL) to ensure the same validation runs.
//
// Usage: npm run seed   (or: npx tsx src/seed.ts)
// ---------------------------------------------------------------------------

import "dotenv/config";
import fs from "fs";
import path from "path";
import { query, pool } from "./db";
import { resetEnterpriseOntologyForSeed } from "./seeds/seedOntology";
import objectTypeService from "./services/objectTypeService";
import propertyService from "./services/propertyService";
import datasourceService from "./services/datasourceService";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = "/tmp/ontology-testdata";

const DISTRICTS = [
  "Kicukiro",
  "Gasabo",
  "Nyarugenge",
  "Muhanga",
  "Huye",
  "Rubavu",
  "Musanze",
  "Rusizi",
];

const PROVINCES = ["Kigali", "Southern", "Northern", "Eastern", "Western"];

const SECTORS = [
  "Agriculture",
  "Mining",
  "Manufacturing",
  "Construction",
  "Trade",
  "Transport",
  "Finance",
  "Education",
  "Health",
  "Technology",
];

const FIRST_NAMES = [
  "Jean",
  "Marie",
  "Pierre",
  "Claudine",
  "Emmanuel",
  "Diane",
  "Patrick",
  "Aimee",
  "Bosco",
  "Grace",
  "Olivier",
  "Jeanne",
  "Eric",
  "Alice",
  "David",
  "Solange",
  "Samuel",
  "Chantal",
  "Innocent",
  "Jacqueline",
];

const LAST_NAMES = [
  "Mugisha",
  "Uwimana",
  "Habimana",
  "Mukamana",
  "Niyonzima",
  "Ishimwe",
  "Ndayisaba",
  "Mutoni",
  "Ngabo",
  "Uwase",
  "Hakizimana",
  "Ingabire",
  "Bizimana",
  "Umutoni",
  "Nsengimana",
  "Nirere",
  "Tuyishime",
  "Mukiza",
  "Rugamba",
  "Byiringiro",
];

const BUSINESS_PREFIXES = [
  "Kigali",
  "Rwanda",
  "Intore",
  "Urumuri",
  "Ubumwe",
  "Irembo",
  "Inganzo",
  "Umucyo",
  "Agaciro",
  "Inyange",
];

const BUSINESS_SUFFIXES = [
  "Trading Ltd",
  "Coffee Exports",
  "Construction Co",
  "Tech Solutions",
  "Mining Corp",
  "Agri-Business",
  "Transport SARL",
  "Finance Group",
  "Ceramics Ltd",
  "Dairy Co",
];

const TAX_TYPES = ["VAT", "CIT", "PIT", "PAYE"];
const RETURN_STATUSES = ["filed", "assessed", "audited"];
const COMPLIANCE_STATUSES = ["compliant", "non-compliant", "under_review"];
const PROPERTY_TYPES = ["residential", "commercial", "land"];

const ORIGIN_COUNTRIES = [
  "China",
  "India",
  "Kenya",
  "Uganda",
  "Tanzania",
  "UAE",
  "USA",
  "South Africa",
  "Belgium",
  "Turkey",
];

const HS_CODES = [
  "8471.30",
  "6403.99",
  "8703.23",
  "2710.19",
  "7308.90",
  "8517.12",
  "3004.90",
  "1006.30",
  "2523.29",
  "8544.49",
];

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randDouble(min: number, max: number, decimals = 2): number {
  const val = Math.random() * (max - min) + min;
  return parseFloat(val.toFixed(decimals));
}

function randDate(startYear: number, endYear: number): string {
  const year = randInt(startYear, endYear);
  const month = String(randInt(1, 12)).padStart(2, "0");
  const day = String(randInt(1, 28)).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function randBool(): boolean {
  return Math.random() > 0.5;
}

function randTin(): string {
  return "1" + String(randInt(0, 999999999)).padStart(9, "0");
}

function randGeopoint(): string {
  const lat = randDouble(-3.0, -1.0, 6);
  const lon = randDouble(28.5, 30.9, 6);
  return `${lat},${lon}`;
}

function randPhone(): string {
  return `+2507${randInt(20000000, 89999999)}`;
}

function randEmail(firstName: string, lastName: string): string {
  const domain = pick(["gmail.com", "yahoo.com", "rra.gov.rw", "outlook.com"]);
  return `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${domain}`;
}

// ---------------------------------------------------------------------------
// CSV generation
// ---------------------------------------------------------------------------

function toCsvRow(values: (string | number | boolean)[]): string {
  return values
    .map((v) => {
      const s = String(v);
      // Quote if contains comma, quote, or newline
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    })
    .join(",");
}

function writeCsv(
  filePath: string,
  headers: string[],
  rows: (string | number | boolean)[][]
): void {
  const lines = [toCsvRow(headers), ...rows.map(toCsvRow)];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Data generators (100 rows each)
// ---------------------------------------------------------------------------

function generateTaxpayers(): {
  headers: string[];
  rows: (string | number | boolean)[][];
} {
  const headers = [
    "tin",
    "full_name",
    "taxpayer_type",
    "registration_date",
    "province",
    "sector",
    "risk_score",
    "compliance_status",
    "phone_number",
    "email",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 100; i++) {
    const firstName = pick(FIRST_NAMES);
    const lastName = pick(LAST_NAMES);
    const isCorporate = i % 5 === 0;
    rows.push([
      randTin(),
      isCorporate
        ? `${pick(BUSINESS_PREFIXES)} ${pick(BUSINESS_SUFFIXES)}`
        : `${firstName} ${lastName}`,
      isCorporate ? "corporate" : "individual",
      randDate(2010, 2025),
      pick(PROVINCES),
      pick(SECTORS),
      randDouble(0, 100),
      pick(COMPLIANCE_STATUSES),
      randPhone(),
      isCorporate
        ? `info@${pick(BUSINESS_PREFIXES).toLowerCase()}.rw`
        : randEmail(firstName, lastName),
    ]);
  }
  return { headers, rows };
}

function generateBusinesses(): {
  headers: string[];
  rows: (string | number | boolean)[][];
} {
  const headers = [
    "business_id",
    "trade_name",
    "sector",
    "registration_date",
    "annual_revenue",
    "is_vat_registered",
    "ebm_device_count",
    "employee_count",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 100; i++) {
    rows.push([
      `BIZ${String(i + 1).padStart(6, "0")}`,
      `${pick(BUSINESS_PREFIXES)} ${pick(BUSINESS_SUFFIXES)}`,
      pick(SECTORS),
      randDate(2005, 2025),
      randInt(1000000, 500000000),
      randBool(),
      randInt(0, 20),
      randInt(1, 500),
    ]);
  }
  return { headers, rows };
}

function generateTaxReturns(): {
  headers: string[];
  rows: (string | number | boolean)[][];
} {
  const headers = [
    "return_id",
    "tax_type",
    "period",
    "declared_revenue",
    "declared_tax",
    "filing_date",
    "status",
    "audit_flag",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 100; i++) {
    const year = randInt(2020, 2025);
    const quarter = `Q${randInt(1, 4)}`;
    const revenue = randInt(1000000, 500000000);
    const taxRate = pick([0.18, 0.3, 0.15, 0.05]);
    rows.push([
      `RTN${String(i + 1).padStart(6, "0")}`,
      pick(TAX_TYPES),
      `${year}-${quarter}`,
      revenue,
      Math.round(revenue * taxRate),
      randDate(2020, 2025),
      pick(RETURN_STATUSES),
      randBool(),
    ]);
  }
  return { headers, rows };
}

function generateCustomsDeclarations(): {
  headers: string[];
  rows: (string | number | boolean)[][];
} {
  const headers = [
    "declaration_id",
    "hs_code",
    "declared_value",
    "origin_country",
    "import_date",
    "quantity",
    "duty_paid",
    "importer_tin",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 100; i++) {
    const value = randInt(500000, 200000000);
    const dutyRate = pick([0.0, 0.05, 0.1, 0.25]);
    rows.push([
      `CUS${String(i + 1).padStart(6, "0")}`,
      pick(HS_CODES),
      value,
      pick(ORIGIN_COUNTRIES),
      randDate(2020, 2025),
      randInt(1, 10000),
      Math.round(value * dutyRate),
      randTin(),
    ]);
  }
  return { headers, rows };
}

function generateRealEstate(): {
  headers: string[];
  rows: (string | number | boolean)[][];
} {
  const headers = [
    "property_id",
    "location",
    "property_type",
    "registered_value",
    "district",
    "owner_tin",
    "registration_date",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 100; i++) {
    rows.push([
      `PROP${String(i + 1).padStart(6, "0")}`,
      randGeopoint(),
      pick(PROPERTY_TYPES),
      randInt(5000000, 1000000000),
      pick(DISTRICTS),
      randTin(),
      randDate(2000, 2025),
    ]);
  }
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// Object type definitions
// ---------------------------------------------------------------------------

interface PropertyDef {
  apiName: string;
  displayName: string;
  baseType: string;
  isRequired: boolean;
}

interface ObjectTypeDef {
  apiName: string;
  displayName: string;
  icon: string;
  iconColor: string;
  properties: PropertyDef[];
  primaryKey: string;
  titleProperty: string;
  csvFile: string;
  datasetName: string;
  columnMapping: Record<string, string>;
  generateData: () => {
    headers: string[];
    rows: (string | number | boolean)[][];
  };
}

const OBJECT_TYPES: ObjectTypeDef[] = [
  {
    apiName: "Taxpayer",
    displayName: "Taxpayer",
    icon: "person",
    iconColor: "#1565C0",
    properties: [
      { apiName: "tin", displayName: "TIN", baseType: "string", isRequired: true },
      { apiName: "fullName", displayName: "Full Name", baseType: "string", isRequired: true },
      { apiName: "taxpayerType", displayName: "Taxpayer Type", baseType: "string", isRequired: false },
      { apiName: "registrationDate", displayName: "Registration Date", baseType: "date", isRequired: false },
      { apiName: "province", displayName: "Province", baseType: "string", isRequired: false },
      { apiName: "sector", displayName: "Sector", baseType: "string", isRequired: false },
      { apiName: "riskScore", displayName: "Risk Score", baseType: "double", isRequired: false },
      { apiName: "complianceStatus", displayName: "Compliance Status", baseType: "string", isRequired: false },
      { apiName: "phoneNumber", displayName: "Phone Number", baseType: "string", isRequired: false },
      { apiName: "email", displayName: "Email", baseType: "string", isRequired: false },
    ],
    primaryKey: "tin",
    titleProperty: "fullName",
    csvFile: "taxpayers.csv",
    datasetName: "RRA Taxpayer Registry",
    columnMapping: {
      tin: "tin",
      fullName: "full_name",
      taxpayerType: "taxpayer_type",
      registrationDate: "registration_date",
      province: "province",
      sector: "sector",
      riskScore: "risk_score",
      complianceStatus: "compliance_status",
      phoneNumber: "phone_number",
      email: "email",
    },
    generateData: generateTaxpayers,
  },
  {
    apiName: "Business",
    displayName: "Business",
    icon: "building",
    iconColor: "#2E7D32",
    properties: [
      { apiName: "businessId", displayName: "Business ID", baseType: "string", isRequired: true },
      { apiName: "tradeName", displayName: "Trade Name", baseType: "string", isRequired: true },
      { apiName: "sector", displayName: "Sector", baseType: "string", isRequired: false },
      { apiName: "registrationDate", displayName: "Registration Date", baseType: "date", isRequired: false },
      { apiName: "annualRevenue", displayName: "Annual Revenue", baseType: "double", isRequired: false },
      { apiName: "isVatRegistered", displayName: "VAT Registered", baseType: "boolean", isRequired: false },
      { apiName: "ebmDeviceCount", displayName: "EBM Device Count", baseType: "integer", isRequired: false },
      { apiName: "employeeCount", displayName: "Employee Count", baseType: "integer", isRequired: false },
    ],
    primaryKey: "businessId",
    titleProperty: "tradeName",
    csvFile: "businesses.csv",
    datasetName: "RRA Business Registry",
    columnMapping: {
      businessId: "business_id",
      tradeName: "trade_name",
      sector: "sector",
      registrationDate: "registration_date",
      annualRevenue: "annual_revenue",
      isVatRegistered: "is_vat_registered",
      ebmDeviceCount: "ebm_device_count",
      employeeCount: "employee_count",
    },
    generateData: generateBusinesses,
  },
  {
    apiName: "TaxReturn",
    displayName: "Tax Return",
    icon: "document",
    iconColor: "#E65100",
    properties: [
      { apiName: "returnId", displayName: "Return ID", baseType: "string", isRequired: true },
      { apiName: "taxType", displayName: "Tax Type", baseType: "string", isRequired: false },
      { apiName: "period", displayName: "Period", baseType: "string", isRequired: false },
      { apiName: "declaredRevenue", displayName: "Declared Revenue", baseType: "double", isRequired: false },
      { apiName: "declaredTax", displayName: "Declared Tax", baseType: "double", isRequired: false },
      { apiName: "filingDate", displayName: "Filing Date", baseType: "date", isRequired: true },
      { apiName: "status", displayName: "Status", baseType: "string", isRequired: false },
      { apiName: "auditFlag", displayName: "Audit Flag", baseType: "boolean", isRequired: false },
    ],
    primaryKey: "returnId",
    titleProperty: "returnId",
    csvFile: "tax-returns.csv",
    datasetName: "RRA Tax Returns",
    columnMapping: {
      returnId: "return_id",
      taxType: "tax_type",
      period: "period",
      declaredRevenue: "declared_revenue",
      declaredTax: "declared_tax",
      filingDate: "filing_date",
      status: "status",
      auditFlag: "audit_flag",
    },
    generateData: generateTaxReturns,
  },
  {
    apiName: "CustomsDeclaration",
    displayName: "Customs Declaration",
    icon: "truck",
    iconColor: "#4527A0",
    properties: [
      { apiName: "declarationId", displayName: "Declaration ID", baseType: "string", isRequired: true },
      { apiName: "hsCode", displayName: "HS Code", baseType: "string", isRequired: true },
      { apiName: "declaredValue", displayName: "Declared Value", baseType: "double", isRequired: false },
      { apiName: "originCountry", displayName: "Origin Country", baseType: "string", isRequired: false },
      { apiName: "importDate", displayName: "Import Date", baseType: "date", isRequired: false },
      { apiName: "quantity", displayName: "Quantity", baseType: "integer", isRequired: false },
      { apiName: "dutyPaid", displayName: "Duty Paid", baseType: "double", isRequired: false },
      { apiName: "importerTin", displayName: "Importer TIN", baseType: "string", isRequired: false },
    ],
    primaryKey: "declarationId",
    titleProperty: "declarationId",
    csvFile: "customs-declarations.csv",
    datasetName: "RRA Customs Declarations",
    columnMapping: {
      declarationId: "declaration_id",
      hsCode: "hs_code",
      declaredValue: "declared_value",
      originCountry: "origin_country",
      importDate: "import_date",
      quantity: "quantity",
      dutyPaid: "duty_paid",
      importerTin: "importer_tin",
    },
    generateData: generateCustomsDeclarations,
  },
  {
    apiName: "RealEstateProperty",
    displayName: "Real Estate Property",
    icon: "globe",
    iconColor: "#00695C",
    properties: [
      { apiName: "propertyId", displayName: "Property ID", baseType: "string", isRequired: true },
      { apiName: "location", displayName: "Location", baseType: "geopoint", isRequired: false },
      { apiName: "propertyType", displayName: "Property Type", baseType: "string", isRequired: false },
      { apiName: "registeredValue", displayName: "Registered Value", baseType: "double", isRequired: false },
      { apiName: "district", displayName: "District", baseType: "string", isRequired: false },
      { apiName: "ownerTin", displayName: "Owner TIN", baseType: "string", isRequired: false },
      { apiName: "registrationDate", displayName: "Registration Date", baseType: "date", isRequired: false },
    ],
    primaryKey: "propertyId",
    titleProperty: "propertyId",
    csvFile: "real-estate.csv",
    datasetName: "RRA Real Estate Registry",
    columnMapping: {
      propertyId: "property_id",
      location: "location",
      propertyType: "property_type",
      registeredValue: "registered_value",
      district: "district",
      ownerTin: "owner_tin",
      registrationDate: "registration_date",
    },
    generateData: generateRealEstate,
  },
];

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

async function seed(): Promise<void> {
  console.log("Starting RRA seed...\n");

  // Step 0+1: "One Enterprise, One Ontology" — populate THE enterprise ontology.
  // Ensure it exists and reset its content for idempotency (preserves the
  // ontology row + main branch; clears object types/links/instances).
  const ontologyId = await resetEnterpriseOntologyForSeed();
  console.log(`Seeding into enterprise ontology (${ontologyId})\n`);

  // Step 2: Create CSV data directory
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`Data directory: ${DATA_DIR}\n`);

  // Step 3: For each object type — create type, properties, CSV, datasource
  let totalProperties = 0;

  for (const otDef of OBJECT_TYPES) {
    // 3a. Create object type
    const otRow = await objectTypeService.create(ontologyId, {
      apiName: otDef.apiName,
      displayName: otDef.displayName,
      icon: otDef.icon,
      iconColor: otDef.iconColor,
    });
    const objectTypeId = otRow.object_type_id;

    // 3b. Create properties
    for (const propDef of otDef.properties) {
      await propertyService.create(objectTypeId, {
        apiName: propDef.apiName,
        displayName: propDef.displayName,
        baseType: propDef.baseType,
        isRequired: propDef.isRequired,
      });
    }
    totalProperties += otDef.properties.length;

    // 3c. Set primary key and title property
    await propertyService.setPrimaryKey(objectTypeId, otDef.primaryKey);
    await propertyService.setTitleProperty(objectTypeId, otDef.titleProperty);

    console.log(
      `Created object type: ${otDef.displayName} (${otDef.properties.length} properties)`
    );

    // 3d. Generate CSV data
    const { headers, rows } = otDef.generateData();
    const csvPath = path.join(DATA_DIR, otDef.csvFile);
    writeCsv(csvPath, headers, rows);

    // 3e. Register backing datasource
    await datasourceService.register(objectTypeId, {
      datasetName: otDef.datasetName,
      filePath: csvPath,
      fileFormat: "csv",
      columnMapping: otDef.columnMapping,
    });

    console.log(`  → Datasource: ${otDef.csvFile} (100 rows)\n`);
  }

  console.log(
    `Seed complete: 1 ontology, ${OBJECT_TYPES.length} object types, ${totalProperties} properties, ${OBJECT_TYPES.length} datasources, ${OBJECT_TYPES.length * 100} test data rows.`
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

seed()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
