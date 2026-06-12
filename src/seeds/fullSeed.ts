// ---------------------------------------------------------------------------
// Enhanced Seed Data (Task 26)
//
// Comprehensive seed script that creates a complete demo environment:
//   - 1 Ontology ("Rwanda Revenue Authority")
//   - 8 Object Types (Employee, Taxpayer, Business, TaxDeclaration, Property,
//     CustomsDeclaration, BankAccount, AuditCase)
//   - 6-15 properties per object type
//   - 6 Link Types
//   - 2 Interfaces (HasLocation, Auditable) with implementations
//   - CSV data files for each object type (100 rows each with Rwandan data)
//   - Idempotent execution
//
// Usage: npx tsx src/seeds/fullSeed.ts
// ---------------------------------------------------------------------------

import "dotenv/config";
import fs from "fs";
import path from "path";
import { query, pool, getClient } from "../db";
import { resetEnterpriseOntologyForSeed } from "./seedOntology";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve(__dirname, "..", "..", "data", "seed");
const ONTOLOGY_NAME = "Rwanda Revenue Authority";

// ---------------------------------------------------------------------------
// Rwandan data constants
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  "Jean", "Marie", "Pierre", "Claudine", "Emmanuel", "Diane", "Patrick",
  "Aimee", "Bosco", "Grace", "Olivier", "Jeanne", "Eric", "Alice", "David",
  "Solange", "Samuel", "Chantal", "Innocent", "Jacqueline",
];

const LAST_NAMES = [
  "Mugisha", "Uwimana", "Habimana", "Mukamana", "Niyonzima", "Ishimwe",
  "Ndayisaba", "Mutoni", "Ngabo", "Uwase", "Hakizimana", "Ingabire",
  "Bizimana", "Umutoni", "Nsengimana", "Nirere", "Tuyishime", "Mukiza",
  "Rugamba", "Byiringiro",
];

const DISTRICTS = [
  "Kicukiro", "Gasabo", "Nyarugenge", "Muhanga", "Huye", "Rubavu",
  "Musanze", "Rusizi", "Kamonyi", "Rwamagana",
];

const PROVINCES = ["Kigali", "Southern", "Northern", "Eastern", "Western"];

const SECTORS = [
  "Agriculture", "Mining", "Manufacturing", "Construction", "Trade",
  "Transport", "Finance", "Education", "Health", "Technology",
];

const DEPARTMENTS = [
  "Tax Administration", "Customs", "Legal", "Audit", "IT",
  "Human Resources", "Finance", "Customer Service", "Research", "Compliance",
];

const BUSINESS_PREFIXES = [
  "Kigali", "Rwanda", "Intore", "Urumuri", "Ubumwe", "Irembo",
  "Inganzo", "Umucyo", "Agaciro", "Inyange",
];

const BUSINESS_SUFFIXES = [
  "Trading Ltd", "Coffee Exports", "Construction Co", "Tech Solutions",
  "Mining Corp", "Agri-Business", "Transport SARL", "Finance Group",
  "Ceramics Ltd", "Dairy Co",
];

const TAX_TYPES = ["VAT", "CIT", "PIT", "PAYE", "Excise", "WHT"];
const COMPLIANCE_STATUSES = ["compliant", "non_compliant", "under_review", "pending"];
const PROPERTY_TYPES = ["residential", "commercial", "land", "industrial", "agricultural"];
const ZONES = ["Zone A", "Zone B", "Zone C", "Zone D"];
const EMPLOYEE_STATUSES = ["active", "on_leave", "terminated", "probation"];

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
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
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

function randGeoLat(): number {
  return randDouble(-2.8, -1.0, 6);
}

function randGeoLon(): number {
  return randDouble(28.8, 30.9, 6);
}

function randPhone(): string {
  return `+2507${randInt(20000000, 89999999)}`;
}

function randEmail(firstName: string, lastName: string): string {
  const domain = pick(["gmail.com", "yahoo.com", "rra.gov.rw", "outlook.com"]);
  return `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${domain}`;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function toCsvRow(values: (string | number | boolean)[]): string {
  return values
    .map((v) => {
      const s = String(v);
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

function generateEmployees(): { headers: string[]; rows: (string | number | boolean)[][] } {
  const headers = [
    "employee_id", "first_name", "last_name", "email", "phone",
    "department", "title", "hire_date", "salary", "status",
    "district", "province", "latitude", "longitude", "last_audit_date",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 100; i++) {
    const fn = pick(FIRST_NAMES);
    const ln = pick(LAST_NAMES);
    rows.push([
      `EMP${String(i + 1).padStart(5, "0")}`,
      fn,
      ln,
      randEmail(fn, ln),
      randPhone(),
      pick(DEPARTMENTS),
      pick(["Officer", "Senior Officer", "Manager", "Director", "Analyst", "Specialist"]),
      randDate(2010, 2025),
      randInt(300000, 5000000),
      pick(EMPLOYEE_STATUSES),
      pick(DISTRICTS),
      pick(PROVINCES),
      randGeoLat(),
      randGeoLon(),
      randDate(2023, 2026),
    ]);
  }
  return { headers, rows };
}

function generateTaxpayers(): { headers: string[]; rows: (string | number | boolean)[][] } {
  const headers = [
    "tin", "full_name", "taxpayer_type", "registration_date", "province",
    "district", "sector", "risk_score", "compliance_status", "phone",
    "email", "latitude", "longitude", "last_audit_date",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 100; i++) {
    const fn = pick(FIRST_NAMES);
    const ln = pick(LAST_NAMES);
    const isCorp = i % 5 === 0;
    rows.push([
      randTin(),
      isCorp ? `${pick(BUSINESS_PREFIXES)} ${pick(BUSINESS_SUFFIXES)}` : `${fn} ${ln}`,
      isCorp ? "corporate" : "individual",
      randDate(2008, 2025),
      pick(PROVINCES),
      pick(DISTRICTS),
      pick(SECTORS),
      randDouble(0, 100),
      pick(COMPLIANCE_STATUSES),
      randPhone(),
      isCorp ? `info@${pick(BUSINESS_PREFIXES).toLowerCase()}.rw` : randEmail(fn, ln),
      randGeoLat(),
      randGeoLon(),
      randDate(2022, 2026),
    ]);
  }
  return { headers, rows };
}

function generateBusinesses(): { headers: string[]; rows: (string | number | boolean)[][] } {
  const headers = [
    "business_id", "trade_name", "sector", "registration_date",
    "annual_revenue", "is_vat_registered", "ebm_device_count",
    "employee_count", "district", "province", "latitude", "longitude",
    "compliance_status", "last_audit_date",
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
      pick(DISTRICTS),
      pick(PROVINCES),
      randGeoLat(),
      randGeoLon(),
      pick(COMPLIANCE_STATUSES),
      randDate(2022, 2026),
    ]);
  }
  return { headers, rows };
}

function generateTaxReturns(): { headers: string[]; rows: (string | number | boolean)[][] } {
  const headers = [
    "return_id", "tax_type", "period", "declared_revenue",
    "declared_tax", "filing_date", "status", "audit_flag",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 100; i++) {
    const year = randInt(2020, 2025);
    const quarter = `Q${randInt(1, 4)}`;
    const revenue = randInt(1000000, 500000000);
    const taxRate = pick([0.18, 0.3, 0.15, 0.05]);
    rows.push([
      `RET${String(i + 1).padStart(6, "0")}`,
      pick(TAX_TYPES),
      `${year}-${quarter}`,
      revenue,
      Math.round(revenue * taxRate),
      randDate(2020, 2025),
      pick(["filed", "assessed", "audited", "amended", "closed"]),
      randBool(),
    ]);
  }
  return { headers, rows };
}

function generateTaxDeclarations(): { headers: string[]; rows: (string | number | boolean)[][] } {
  const headers = [
    "declaration_id", "tax_type", "period", "declared_revenue",
    "declared_tax", "filing_date", "status", "taxpayer_tin",
    "audit_flag", "penalty_amount", "assessor_id", "last_audit_date",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 100; i++) {
    const year = randInt(2020, 2025);
    const quarter = `Q${randInt(1, 4)}`;
    const revenue = randInt(1000000, 500000000);
    const taxRate = pick([0.18, 0.3, 0.15, 0.05]);
    rows.push([
      `DEC${String(i + 1).padStart(6, "0")}`,
      pick(TAX_TYPES),
      `${year}-${quarter}`,
      revenue,
      Math.round(revenue * taxRate),
      randDate(2020, 2025),
      pick(["filed", "assessed", "audited", "amended"]),
      randTin(),
      randBool(),
      randBool() ? randInt(10000, 5000000) : 0,
      `EMP${String(randInt(1, 100)).padStart(5, "0")}`,
      randDate(2022, 2026),
    ]);
  }
  return { headers, rows };
}

function generateProperties(): { headers: string[]; rows: (string | number | boolean)[][] } {
  const headers = [
    "property_id", "property_type", "registered_value", "district",
    "province", "zone", "owner_tin", "registration_date", "area_sqm",
    "is_taxed", "tax_amount", "latitude", "longitude", "last_audit_date",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 100; i++) {
    const value = randInt(5000000, 1000000000);
    rows.push([
      `PROP${String(i + 1).padStart(6, "0")}`,
      pick(PROPERTY_TYPES),
      value,
      pick(DISTRICTS),
      pick(PROVINCES),
      pick(ZONES),
      randTin(),
      randDate(2000, 2025),
      randInt(50, 50000),
      randBool(),
      Math.round(value * 0.001),
      randGeoLat(),
      randGeoLon(),
      randDate(2022, 2026),
    ]);
  }
  return { headers, rows };
}

const ORIGIN_COUNTRIES = [
  "China", "India", "UAE", "Kenya", "Uganda", "Tanzania", "DRC",
  "Turkey", "Japan", "South Africa", "Germany", "USA", "UK", "Belgium",
];
const HS_CODES = [
  "8471.30", "2709.00", "8517.12", "6203.42", "0901.11",
  "8703.23", "2523.29", "8443.32", "0402.21", "7210.49",
];
const BANKS = [
  "Bank of Kigali", "I&M Bank", "BPR Atlas Mara", "Equity Bank",
  "COGEBANQUE", "Access Bank", "Ecobank", "GT Bank",
];
const ACCOUNT_TYPES = ["current", "savings", "business", "forex"];
const AUDIT_STATUSES = ["open", "investigating", "closed"];
const OFFICES = [
  "Kigali Head Office", "Nyarugenge Branch", "Gasabo Branch",
  "Huye Branch", "Rubavu Branch", "Musanze Branch",
];

function generateCustomsDeclarations(): { headers: string[]; rows: (string | number | boolean)[][] } {
  const headers = [
    "declaration_id", "hs_code", "declared_value_usd", "origin_country",
    "quantity", "duty_paid_rwf", "declaration_date", "importer_business_id",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 150; i++) {
    const declaredValue = randInt(500, 500000);
    rows.push([
      `CD${String(i + 1).padStart(6, "0")}`,
      pick(HS_CODES),
      declaredValue,
      pick(ORIGIN_COUNTRIES),
      randInt(1, 10000),
      Math.round(declaredValue * 1300 * 0.25), // ~25% duty on CIF in RWF
      randDate(2022, 2026),
      `BIZ${String(randInt(1, 80)).padStart(6, "0")}`,
    ]);
  }
  // Plant 2 under-invoicing anomalies (declared value < 30% of average)
  rows[10][2] = 100; // very low declared value
  rows[25][2] = 50;  // very low declared value
  return { headers, rows };
}

function generateBankAccounts(): { headers: string[]; rows: (string | number | boolean)[][] } {
  const headers = [
    "account_id", "bank_name", "account_type", "monthly_avg_turnover",
    "suspicious_flag", "holder_tin",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 120; i++) {
    rows.push([
      `ACCT${String(i + 1).padStart(6, "0")}`,
      pick(BANKS),
      pick(ACCOUNT_TYPES),
      randInt(100000, 50000000),
      false,
      randTin(),
    ]);
  }
  // Plant 3 suspicious accounts: turnover 5x declared income
  rows[5][3] = 200000000;  // very high turnover
  rows[5][4] = true;
  rows[20][3] = 180000000;
  rows[20][4] = true;
  rows[45][3] = 250000000;
  rows[45][4] = true;
  return { headers, rows };
}

function generateAuditCases(): { headers: string[]; rows: (string | number | boolean)[][] } {
  const headers = [
    "case_id", "taxpayer_tin", "status", "risk_score",
    "assigned_office", "opened_date", "evidence",
  ];
  const rows: (string | number | boolean)[][] = [];
  for (let i = 0; i < 15; i++) {
    rows.push([
      `AUDIT${String(i + 1).padStart(4, "0")}`,
      randTin(),
      pick(AUDIT_STATUSES),
      Math.round(Math.random() * 100 * 100) / 100,
      pick(OFFICES),
      randDate(2023, 2026),
      `Evidence for case ${i + 1}: ${pick(["Income discrepancy", "Under-invoicing", "Undeclared properties", "Shell company", "Tax evasion"])}`,
    ]);
  }
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// Object Type Definitions
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
  columnMapping: Record<string, string>;
  generateData: () => { headers: string[]; rows: (string | number | boolean)[][] };
}

const OBJECT_TYPES: ObjectTypeDef[] = [
  {
    apiName: "Employee",
    displayName: "Employee",
    icon: "person",
    iconColor: "#1565C0",
    properties: [
      { apiName: "employeeId", displayName: "Employee ID", baseType: "string", isRequired: true },
      { apiName: "firstName", displayName: "First Name", baseType: "string", isRequired: true },
      { apiName: "lastName", displayName: "Last Name", baseType: "string", isRequired: true },
      { apiName: "email", displayName: "Email", baseType: "string", isRequired: false },
      { apiName: "phone", displayName: "Phone", baseType: "string", isRequired: false },
      { apiName: "department", displayName: "Department", baseType: "string", isRequired: false },
      { apiName: "title", displayName: "Job Title", baseType: "string", isRequired: false },
      { apiName: "hireDate", displayName: "Hire Date", baseType: "date", isRequired: false },
      { apiName: "salary", displayName: "Salary (RWF)", baseType: "double", isRequired: false },
      { apiName: "status", displayName: "Status", baseType: "string", isRequired: false },
      { apiName: "district", displayName: "District", baseType: "string", isRequired: false },
      { apiName: "province", displayName: "Province", baseType: "string", isRequired: false },
      { apiName: "latitude", displayName: "Latitude", baseType: "double", isRequired: false },
      { apiName: "longitude", displayName: "Longitude", baseType: "double", isRequired: false },
      { apiName: "lastAuditDate", displayName: "Last Audit Date", baseType: "date", isRequired: false },
    ],
    primaryKey: "employeeId",
    titleProperty: "firstName",
    csvFile: "employees.csv",
    columnMapping: {
      employeeId: "employee_id", firstName: "first_name", lastName: "last_name",
      email: "email", phone: "phone", department: "department", title: "title",
      hireDate: "hire_date", salary: "salary", status: "status",
      district: "district", province: "province", latitude: "latitude",
      longitude: "longitude", lastAuditDate: "last_audit_date",
    },
    generateData: generateEmployees,
  },
  {
    apiName: "Taxpayer",
    displayName: "Taxpayer",
    icon: "badge",
    iconColor: "#2E7D32",
    properties: [
      { apiName: "tin", displayName: "TIN", baseType: "string", isRequired: true },
      { apiName: "fullName", displayName: "Full Name", baseType: "string", isRequired: true },
      { apiName: "taxpayerType", displayName: "Taxpayer Type", baseType: "string", isRequired: false },
      { apiName: "registrationDate", displayName: "Registration Date", baseType: "date", isRequired: false },
      { apiName: "province", displayName: "Province", baseType: "string", isRequired: false },
      { apiName: "district", displayName: "District", baseType: "string", isRequired: false },
      { apiName: "sector", displayName: "Sector", baseType: "string", isRequired: false },
      { apiName: "riskScore", displayName: "Risk Score", baseType: "double", isRequired: false },
      { apiName: "complianceStatus", displayName: "Compliance Status", baseType: "string", isRequired: false },
      { apiName: "phone", displayName: "Phone", baseType: "string", isRequired: false },
      { apiName: "email", displayName: "Email", baseType: "string", isRequired: false },
      { apiName: "latitude", displayName: "Latitude", baseType: "double", isRequired: false },
      { apiName: "longitude", displayName: "Longitude", baseType: "double", isRequired: false },
      { apiName: "lastAuditDate", displayName: "Last Audit Date", baseType: "date", isRequired: false },
    ],
    primaryKey: "tin",
    titleProperty: "fullName",
    csvFile: "taxpayers.csv",
    columnMapping: {
      tin: "tin", fullName: "full_name", taxpayerType: "taxpayer_type",
      registrationDate: "registration_date", province: "province", district: "district",
      sector: "sector", riskScore: "risk_score", complianceStatus: "compliance_status",
      phone: "phone", email: "email", latitude: "latitude", longitude: "longitude",
      lastAuditDate: "last_audit_date",
    },
    generateData: generateTaxpayers,
  },
  {
    apiName: "Business",
    displayName: "Business",
    icon: "building",
    iconColor: "#E65100",
    properties: [
      { apiName: "businessId", displayName: "Business ID", baseType: "string", isRequired: true },
      { apiName: "tradeName", displayName: "Trade Name", baseType: "string", isRequired: true },
      { apiName: "sector", displayName: "Sector", baseType: "string", isRequired: false },
      { apiName: "registrationDate", displayName: "Registration Date", baseType: "date", isRequired: false },
      { apiName: "annualRevenue", displayName: "Annual Revenue", baseType: "double", isRequired: false },
      { apiName: "isVatRegistered", displayName: "VAT Registered", baseType: "boolean", isRequired: false },
      { apiName: "ebmDeviceCount", displayName: "EBM Device Count", baseType: "integer", isRequired: false },
      { apiName: "employeeCount", displayName: "Employee Count", baseType: "integer", isRequired: false },
      { apiName: "district", displayName: "District", baseType: "string", isRequired: false },
      { apiName: "province", displayName: "Province", baseType: "string", isRequired: false },
      { apiName: "latitude", displayName: "Latitude", baseType: "double", isRequired: false },
      { apiName: "longitude", displayName: "Longitude", baseType: "double", isRequired: false },
      { apiName: "complianceStatus", displayName: "Compliance Status", baseType: "string", isRequired: false },
      { apiName: "lastAuditDate", displayName: "Last Audit Date", baseType: "date", isRequired: false },
    ],
    primaryKey: "businessId",
    titleProperty: "tradeName",
    csvFile: "businesses.csv",
    columnMapping: {
      businessId: "business_id", tradeName: "trade_name", sector: "sector",
      registrationDate: "registration_date", annualRevenue: "annual_revenue",
      isVatRegistered: "is_vat_registered", ebmDeviceCount: "ebm_device_count",
      employeeCount: "employee_count", district: "district", province: "province",
      latitude: "latitude", longitude: "longitude", complianceStatus: "compliance_status",
      lastAuditDate: "last_audit_date",
    },
    generateData: generateBusinesses,
  },
  {
    apiName: "TaxReturn",
    displayName: "Tax Return",
    icon: "file-text",
    iconColor: "#6A1B9A",
    properties: [
      { apiName: "returnId", displayName: "Return ID", baseType: "string", isRequired: true },
      { apiName: "taxType", displayName: "Tax Type", baseType: "string", isRequired: false },
      { apiName: "period", displayName: "Tax Period", baseType: "string", isRequired: false },
      { apiName: "declaredRevenue", displayName: "Declared Revenue", baseType: "double", isRequired: false },
      { apiName: "declaredTax", displayName: "Declared Tax", baseType: "double", isRequired: false },
      { apiName: "filingDate", displayName: "Filing Date", baseType: "date", isRequired: false },
      { apiName: "status", displayName: "Status", baseType: "string", isRequired: false },
      { apiName: "auditFlag", displayName: "Audit Flag", baseType: "boolean", isRequired: false },
    ],
    primaryKey: "returnId",
    titleProperty: "returnId",
    csvFile: "tax_returns.csv",
    columnMapping: {
      returnId: "return_id", taxType: "tax_type", period: "period",
      declaredRevenue: "declared_revenue", declaredTax: "declared_tax",
      filingDate: "filing_date", status: "status", auditFlag: "audit_flag",
    },
    generateData: generateTaxReturns,
  },
  {
    apiName: "TaxDeclaration",
    displayName: "Tax Declaration",
    icon: "document",
    iconColor: "#4527A0",
    properties: [
      { apiName: "declarationId", displayName: "Declaration ID", baseType: "string", isRequired: true },
      { apiName: "taxType", displayName: "Tax Type", baseType: "string", isRequired: false },
      { apiName: "period", displayName: "Period", baseType: "string", isRequired: false },
      { apiName: "declaredRevenue", displayName: "Declared Revenue", baseType: "double", isRequired: false },
      { apiName: "declaredTax", displayName: "Declared Tax", baseType: "double", isRequired: false },
      { apiName: "filingDate", displayName: "Filing Date", baseType: "date", isRequired: true },
      { apiName: "status", displayName: "Status", baseType: "string", isRequired: false },
      { apiName: "taxpayerTin", displayName: "Taxpayer TIN", baseType: "string", isRequired: false },
      { apiName: "auditFlag", displayName: "Audit Flag", baseType: "boolean", isRequired: false },
      { apiName: "penaltyAmount", displayName: "Penalty Amount", baseType: "double", isRequired: false },
      { apiName: "assessorId", displayName: "Assessor ID", baseType: "string", isRequired: false },
      { apiName: "lastAuditDate", displayName: "Last Audit Date", baseType: "date", isRequired: false },
    ],
    primaryKey: "declarationId",
    titleProperty: "declarationId",
    csvFile: "tax-declarations.csv",
    columnMapping: {
      declarationId: "declaration_id", taxType: "tax_type", period: "period",
      declaredRevenue: "declared_revenue", declaredTax: "declared_tax",
      filingDate: "filing_date", status: "status", taxpayerTin: "taxpayer_tin",
      auditFlag: "audit_flag", penaltyAmount: "penalty_amount",
      assessorId: "assessor_id", lastAuditDate: "last_audit_date",
    },
    generateData: generateTaxDeclarations,
  },
  {
    apiName: "Property",
    displayName: "Property",
    icon: "globe",
    iconColor: "#00695C",
    properties: [
      { apiName: "propertyId", displayName: "Property ID", baseType: "string", isRequired: true },
      { apiName: "propertyType", displayName: "Property Type", baseType: "string", isRequired: false },
      { apiName: "registeredValue", displayName: "Registered Value", baseType: "double", isRequired: false },
      { apiName: "district", displayName: "District", baseType: "string", isRequired: false },
      { apiName: "province", displayName: "Province", baseType: "string", isRequired: false },
      { apiName: "zone", displayName: "Zone", baseType: "string", isRequired: false },
      { apiName: "ownerTin", displayName: "Owner TIN", baseType: "string", isRequired: false },
      { apiName: "registrationDate", displayName: "Registration Date", baseType: "date", isRequired: false },
      { apiName: "areaSqm", displayName: "Area (sqm)", baseType: "double", isRequired: false },
      { apiName: "isTaxed", displayName: "Is Taxed", baseType: "boolean", isRequired: false },
      { apiName: "taxAmount", displayName: "Tax Amount", baseType: "double", isRequired: false },
      { apiName: "latitude", displayName: "Latitude", baseType: "double", isRequired: false },
      { apiName: "longitude", displayName: "Longitude", baseType: "double", isRequired: false },
      { apiName: "lastAuditDate", displayName: "Last Audit Date", baseType: "date", isRequired: false },
    ],
    primaryKey: "propertyId",
    titleProperty: "propertyId",
    csvFile: "properties.csv",
    columnMapping: {
      propertyId: "property_id", propertyType: "property_type",
      registeredValue: "registered_value", district: "district", province: "province",
      zone: "zone", ownerTin: "owner_tin", registrationDate: "registration_date",
      areaSqm: "area_sqm", isTaxed: "is_taxed", taxAmount: "tax_amount",
      latitude: "latitude", longitude: "longitude", lastAuditDate: "last_audit_date",
    },
    generateData: generateProperties,
  },
  {
    apiName: "CustomsDeclaration",
    displayName: "Customs Declaration",
    icon: "box",
    iconColor: "#E65100",
    properties: [
      { apiName: "declarationId", displayName: "Declaration ID", baseType: "string", isRequired: true },
      { apiName: "hsCode", displayName: "HS Code", baseType: "string", isRequired: false },
      { apiName: "declaredValueUsd", displayName: "Declared Value (USD)", baseType: "double", isRequired: false },
      { apiName: "originCountry", displayName: "Origin Country", baseType: "string", isRequired: false },
      { apiName: "quantity", displayName: "Quantity", baseType: "integer", isRequired: false },
      { apiName: "dutyPaidRwf", displayName: "Duty Paid (RWF)", baseType: "double", isRequired: false },
      { apiName: "declarationDate", displayName: "Declaration Date", baseType: "date", isRequired: false },
      { apiName: "importerBusinessId", displayName: "Importer Business ID", baseType: "string", isRequired: false },
    ],
    primaryKey: "declarationId",
    titleProperty: "declarationId",
    csvFile: "customs_declarations.csv",
    columnMapping: {
      declarationId: "declaration_id", hsCode: "hs_code",
      declaredValueUsd: "declared_value_usd", originCountry: "origin_country",
      quantity: "quantity", dutyPaidRwf: "duty_paid_rwf",
      declarationDate: "declaration_date", importerBusinessId: "importer_business_id",
    },
    generateData: generateCustomsDeclarations,
  },
  {
    apiName: "BankAccount",
    displayName: "Bank Account",
    icon: "credit-card",
    iconColor: "#1565C0",
    properties: [
      { apiName: "accountId", displayName: "Account ID", baseType: "string", isRequired: true },
      { apiName: "bankName", displayName: "Bank Name", baseType: "string", isRequired: false },
      { apiName: "accountType", displayName: "Account Type", baseType: "string", isRequired: false },
      { apiName: "monthlyAvgTurnover", displayName: "Monthly Avg Turnover", baseType: "double", isRequired: false },
      { apiName: "suspiciousFlag", displayName: "Suspicious Flag", baseType: "boolean", isRequired: false },
      { apiName: "holderTin", displayName: "Holder TIN", baseType: "string", isRequired: false },
    ],
    primaryKey: "accountId",
    titleProperty: "bankName",
    csvFile: "bank_accounts.csv",
    columnMapping: {
      accountId: "account_id", bankName: "bank_name",
      accountType: "account_type", monthlyAvgTurnover: "monthly_avg_turnover",
      suspiciousFlag: "suspicious_flag", holderTin: "holder_tin",
    },
    generateData: generateBankAccounts,
  },
  {
    apiName: "AuditCase",
    displayName: "Audit Case",
    icon: "search",
    iconColor: "#B71C1C",
    properties: [
      { apiName: "caseId", displayName: "Case ID", baseType: "string", isRequired: true },
      { apiName: "taxpayerTin", displayName: "Taxpayer TIN", baseType: "string", isRequired: false },
      { apiName: "status", displayName: "Status", baseType: "string", isRequired: false },
      { apiName: "riskScore", displayName: "Risk Score", baseType: "double", isRequired: false },
      { apiName: "assignedOffice", displayName: "Assigned Office", baseType: "string", isRequired: false },
      { apiName: "openedDate", displayName: "Opened Date", baseType: "date", isRequired: false },
      { apiName: "evidence", displayName: "Evidence", baseType: "string", isRequired: false },
    ],
    primaryKey: "caseId",
    titleProperty: "caseId",
    csvFile: "audit_cases.csv",
    columnMapping: {
      caseId: "case_id", taxpayerTin: "taxpayer_tin",
      status: "status", riskScore: "risk_score",
      assignedOffice: "assigned_office", openedDate: "opened_date",
      evidence: "evidence",
    },
    generateData: generateAuditCases,
  },
];

// ---------------------------------------------------------------------------
// Link Type Definitions
// ---------------------------------------------------------------------------

interface LinkTypeDef {
  apiName: string;
  displayName: string;
  sourceObjectType: string;
  targetObjectType: string;
  cardinality: string;
}

const LINK_TYPES: LinkTypeDef[] = [
  {
    apiName: "managesTaxpayer",
    displayName: "Manages Taxpayer",
    sourceObjectType: "Employee",
    targetObjectType: "Taxpayer",
    cardinality: "MANY_TO_MANY",
  },
  {
    apiName: "ownsBusiness",
    displayName: "Owns Business",
    sourceObjectType: "Taxpayer",
    targetObjectType: "Business",
    cardinality: "ONE_TO_MANY",
  },
  {
    apiName: "filesDeclaration",
    displayName: "Files Declaration",
    sourceObjectType: "Business",
    targetObjectType: "TaxDeclaration",
    cardinality: "ONE_TO_MANY",
  },
  {
    apiName: "importsGoods",
    displayName: "Imports Goods",
    sourceObjectType: "Business",
    targetObjectType: "CustomsDeclaration",
    cardinality: "ONE_TO_MANY",
  },
  {
    apiName: "holdsBankAccount",
    displayName: "Holds Bank Account",
    sourceObjectType: "Taxpayer",
    targetObjectType: "BankAccount",
    cardinality: "ONE_TO_MANY",
  },
  {
    apiName: "hasAuditCase",
    displayName: "Has Audit Case",
    sourceObjectType: "Taxpayer",
    targetObjectType: "AuditCase",
    cardinality: "ONE_TO_MANY",
  },
];

// ---------------------------------------------------------------------------
// Interface Definitions
// ---------------------------------------------------------------------------

interface InterfaceDef {
  apiName: string;
  displayName: string;
  description: string;
  properties: Array<{
    apiName: string;
    displayName: string;
    baseType: string;
    isRequired: boolean;
  }>;
  implementations: Array<{
    objectTypeApiName: string;
    propertyMapping: Record<string, string>;
  }>;
}

const INTERFACES: InterfaceDef[] = [
  {
    apiName: "HasLocation",
    displayName: "Has Location",
    description: "Interface for entities that have a geographic location (latitude/longitude).",
    properties: [
      { apiName: "latitude", displayName: "Latitude", baseType: "double", isRequired: true },
      { apiName: "longitude", displayName: "Longitude", baseType: "double", isRequired: true },
      { apiName: "district", displayName: "District", baseType: "string", isRequired: false },
      { apiName: "province", displayName: "Province", baseType: "string", isRequired: false },
    ],
    implementations: [
      {
        objectTypeApiName: "Employee",
        propertyMapping: { latitude: "latitude", longitude: "longitude", district: "district", province: "province" },
      },
      {
        objectTypeApiName: "Taxpayer",
        propertyMapping: { latitude: "latitude", longitude: "longitude", district: "district", province: "province" },
      },
      {
        objectTypeApiName: "Business",
        propertyMapping: { latitude: "latitude", longitude: "longitude", district: "district", province: "province" },
      },
      {
        objectTypeApiName: "Property",
        propertyMapping: { latitude: "latitude", longitude: "longitude", district: "district", province: "province" },
      },
    ],
  },
  {
    apiName: "Auditable",
    displayName: "Auditable",
    description: "Interface for entities that undergo periodic auditing.",
    properties: [
      { apiName: "lastAuditDate", displayName: "Last Audit Date", baseType: "date", isRequired: false },
      { apiName: "complianceStatus", displayName: "Compliance Status", baseType: "string", isRequired: false },
    ],
    implementations: [
      {
        objectTypeApiName: "Taxpayer",
        propertyMapping: { lastAuditDate: "lastAuditDate", complianceStatus: "complianceStatus" },
      },
      {
        objectTypeApiName: "Business",
        propertyMapping: { lastAuditDate: "lastAuditDate", complianceStatus: "complianceStatus" },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

async function fullSeed(): Promise<void> {
  console.log("=== Full Seed: Rwanda Revenue Authority ===\n");

  // -----------------------------------------------------------------------
  // Step 0+1: "One Enterprise, One Ontology" — populate THE enterprise
  // ontology. Ensure it exists, reset its content for idempotency, and reuse
  // its id. The ontology row + `main` branch are preserved.
  // -----------------------------------------------------------------------
  const ontologyId = await resetEnterpriseOntologyForSeed();
  console.log(`Seeding "${ONTOLOGY_NAME}" content into enterprise ontology (${ontologyId})`);

  // -----------------------------------------------------------------------
  // Step 2: Create data directory
  // -----------------------------------------------------------------------
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`Data directory: ${DATA_DIR}\n`);

  // -----------------------------------------------------------------------
  // Step 3: Create object types, properties, CSV data, and datasources
  // -----------------------------------------------------------------------
  let totalProperties = 0;
  const objectTypeIds: Record<string, string> = {};

  for (const otDef of OBJECT_TYPES) {
    // Create object type
    const otResult = await query(
      `INSERT INTO object_type (ontology_id, api_name, display_name, icon, icon_color)
       VALUES ($1, $2, $3, $4, $5) RETURNING object_type_id`,
      [ontologyId, otDef.apiName, otDef.displayName, otDef.icon, otDef.iconColor]
    );
    const objectTypeId = otResult.rows[0].object_type_id;
    objectTypeIds[otDef.apiName] = objectTypeId;

    // Create properties
    for (let i = 0; i < otDef.properties.length; i++) {
      const prop = otDef.properties[i];
      await query(
        `INSERT INTO property (object_type_id, api_name, display_name, base_type, is_required, ordinal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [objectTypeId, prop.apiName, prop.displayName, prop.baseType, prop.isRequired, i]
      );
    }
    totalProperties += otDef.properties.length;

    // Set primary key
    const pkResult = await query(
      "SELECT property_id FROM property WHERE object_type_id = $1 AND api_name = $2",
      [objectTypeId, otDef.primaryKey]
    );
    if (pkResult.rows.length > 0) {
      await query(
        "UPDATE object_type SET primary_key_property_id = $1 WHERE object_type_id = $2",
        [pkResult.rows[0].property_id, objectTypeId]
      );
    }

    // Set title property
    const titleResult = await query(
      "SELECT property_id FROM property WHERE object_type_id = $1 AND api_name = $2",
      [objectTypeId, otDef.titleProperty]
    );
    if (titleResult.rows.length > 0) {
      await query(
        "UPDATE object_type SET title_property_id = $1 WHERE object_type_id = $2",
        [titleResult.rows[0].property_id, objectTypeId]
      );
    }

    // Generate CSV data
    const { headers, rows } = otDef.generateData();
    const csvPath = path.join(DATA_DIR, otDef.csvFile);
    writeCsv(csvPath, headers, rows);

    // Register backing datasource
    await query(
      `INSERT INTO backing_datasource (object_type_id, dataset_name, file_path, file_format, column_mapping, row_count)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        objectTypeId,
        `RRA ${otDef.displayName}`,
        csvPath,
        "csv",
        JSON.stringify(otDef.columnMapping),
        rows.length,
      ]
    );

    console.log(`  Created: ${otDef.displayName} (${otDef.properties.length} props, ${rows.length} rows)`);
  }

  console.log(`\n  Total: ${OBJECT_TYPES.length} object types, ${totalProperties} properties`);

  // -----------------------------------------------------------------------
  // Step 4: Create link types
  // -----------------------------------------------------------------------
  console.log("\nCreating link types...");
  for (const lt of LINK_TYPES) {
    await query(
      `INSERT INTO link_type (ontology_id, api_name, display_name, source_object_type, target_object_type, cardinality)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ontologyId, lt.apiName, lt.displayName, lt.sourceObjectType, lt.targetObjectType, lt.cardinality]
    );
    console.log(`  Created link: ${lt.displayName} (${lt.sourceObjectType} -> ${lt.targetObjectType})`);
  }

  // -----------------------------------------------------------------------
  // Step 5: Create interfaces and implementations
  // -----------------------------------------------------------------------
  console.log("\nCreating interfaces...");
  for (const ifDef of INTERFACES) {
    const client = await getClient();
    try {
      await client.query("BEGIN");

      // Insert interface
      const ifResult = await client.query(
        `INSERT INTO interface (ontology_id, api_name, display_name, description)
         VALUES ($1, $2, $3, $4) RETURNING interface_id`,
        [ontologyId, ifDef.apiName, ifDef.displayName, ifDef.description]
      );
      const interfaceId = ifResult.rows[0].interface_id;

      // Insert interface properties
      for (let i = 0; i < ifDef.properties.length; i++) {
        const prop = ifDef.properties[i];
        await client.query(
          `INSERT INTO interface_property (interface_id, api_name, display_name, base_type, is_required, ordinal)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [interfaceId, prop.apiName, prop.displayName, prop.baseType, prop.isRequired, i]
        );
      }

      // Insert implementations
      for (const impl of ifDef.implementations) {
        const otId = objectTypeIds[impl.objectTypeApiName];
        if (otId) {
          await client.query(
            `INSERT INTO object_type_interface (object_type_id, interface_id, property_mapping)
             VALUES ($1, $2, $3)`,
            [otId, interfaceId, JSON.stringify(impl.propertyMapping)]
          );
        }
      }

      await client.query("COMMIT");

      console.log(
        `  Created interface: ${ifDef.displayName} (${ifDef.properties.length} props, ${ifDef.implementations.length} implementations)`
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log("Full seed complete:");
  console.log(`  1 Ontology: ${ONTOLOGY_NAME}`);
  console.log(`  ${OBJECT_TYPES.length} Object Types`);
  console.log(`  ${totalProperties} Properties`);
  console.log(`  ${LINK_TYPES.length} Link Types`);
  console.log(`  ${INTERFACES.length} Interfaces`);
  console.log(`  ${OBJECT_TYPES.length * 100} CSV rows`);
  console.log(`  Data directory: ${DATA_DIR}`);
  console.log("=".repeat(60));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

fullSeed()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Full seed failed:", err);
    process.exit(1);
  });
