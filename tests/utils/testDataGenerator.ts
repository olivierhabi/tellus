// ---------------------------------------------------------------------------
// Test Data Generator (Task 27)
//
// Generates realistic test data in CSV, JSON, and JSON Lines formats with
// configurable columns, types, null rates, and duplicate PK injection.
//
// Includes Rwandan-specific data (names, locations, sectors) for realistic
// RRA (Rwanda Revenue Authority) test data generation.
//
// Run self-tests:  npx tsx tests/utils/testDataGenerator.ts
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";
import seedrandom from "seedrandom";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColumnConfig {
  name: string;
  type:
    | "sequence"
    | "fullName"
    | "email"
    | "enum"
    | "integer"
    | "float"
    | "date"
    | "timestamp"
    | "boolean"
    | "geopoint"
    | "foreignKey"
    | "uuid"
    | "static";
  options?: Record<string, any>;
}

export interface GeneratorConfig {
  rowCount: number;
  columns: ColumnConfig[];
  nullRate?: number;
  duplicatePkRate?: number;
  seed?: string;
}

// ---------------------------------------------------------------------------
// Rwandan-specific data
// ---------------------------------------------------------------------------

const RWANDAN_FIRST_NAMES = [
  "Uwimana", "Habimana", "Mugisha", "Ishimwe", "Kayitesi",
  "Ndayisaba", "Mukamana", "Bizimungu", "Ingabire", "Nsengimana",
  "Uwase", "Kamanzi", "Mutoni", "Rugamba", "Gasana",
  "Uwineza", "Tuyishime", "Dushime", "Niyonzima", "Hakizimana",
  "Iradukunda", "Nshimiyimana", "Munyangabe", "Umuhoza", "Mukiza",
  "Uwera", "Bayisenge", "Izabayo", "Shyaka", "Gahima",
  "Mugabo", "Kalisa", "Munyaneza", "Nyiraneza", "Mukamusoni",
] as const;

const RWANDAN_LAST_NAMES = [
  "Jean", "Pierre", "Marie", "Claude", "Emmanuel",
  "Patrick", "Alice", "Grace", "David", "Sophie",
  "Eric", "Diane", "Samuel", "Claudine", "Robert",
  "Amina", "James", "Yvonne", "Joseph", "Fatima",
  "Olivier", "Gentille", "Kevin", "Consolate", "Bosco",
] as const;

const RWANDAN_PROVINCES = [
  "Kigali", "Eastern", "Western", "Northern", "Southern",
] as const;

const RWANDAN_DISTRICTS = [
  "Nyarugenge", "Kicukiro", "Gasabo",
  "Butare", "Gisenyi", "Ruhengeri",
  "Gitarama", "Kibuye", "Byumba",
  "Cyangugu", "Kibungo", "Nyanza",
  "Gikongoro", "Umutara", "Muhanga",
  "Musanze", "Rubavu", "Huye",
  "Rusizi", "Karongi", "Rwamagana",
  "Ngoma", "Bugesera", "Kayonza",
] as const;

const RWANDAN_SECTORS = [
  "Nyarugenge", "Kicukiro", "Kimironko", "Remera", "Gisozi",
  "Nyamirambo", "Muhima", "Kimisagara", "Kanombe", "Masaka",
  "Gikondo", "Niboye", "Kacyiru", "Rusororo", "Jabana",
  "Bumbogo", "Ndera", "Gikomero", "Nduba", "Rutunga",
] as const;

const BUSINESS_TYPES = [
  "SARL", "SA", "Cooperative", "Individual Enterprise",
  "NGO", "Branch Office", "Partnership", "Sole Proprietor",
] as const;

const TAX_STATUSES = [
  "Active", "Suspended", "Closed", "Pending Registration",
] as const;

const BUSINESS_SECTORS = [
  "Agriculture", "Manufacturing", "Technology", "Financial Services",
  "Education", "Healthcare", "Construction", "Mining",
  "Tourism & Hospitality", "Telecommunications", "Transport",
  "Retail", "Real Estate", "Energy", "Media",
] as const;

// Rwanda geographic bounds
const RWANDA_LAT_MIN = -2.84;
const RWANDA_LAT_MAX = -1.05;
const RWANDA_LON_MIN = 28.86;
const RWANDA_LON_MAX = 30.90;

// ---------------------------------------------------------------------------
// PRNG helpers
// ---------------------------------------------------------------------------

type RNG = () => number;

function createRng(seed?: string): RNG {
  return seed ? seedrandom(seed) : seedrandom();
}

function pick<T>(rng: RNG, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng: RNG, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randFloat(rng: RNG, min: number, max: number, decimals: number = 2): number {
  const val = min + rng() * (max - min);
  return parseFloat(val.toFixed(decimals));
}

function normalRandom(rng: RNG, mean: number, stddev: number): number {
  let u1 = rng();
  let u2 = rng();
  while (u1 === 0) u1 = rng();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * stddev;
}

function normalClamped(rng: RNG, mean: number, stddev: number, min: number, max: number): number {
  for (let attempt = 0; attempt < 100; attempt++) {
    const v = normalRandom(rng, mean, stddev);
    if (v >= min && v <= max) return v;
  }
  return mean;
}

function generateUUID(rng: RNG): string {
  const hex = "0123456789abcdef";
  let uuid = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      uuid += "-";
    } else if (i === 14) {
      uuid += "4";
    } else if (i === 19) {
      uuid += hex[Math.floor(rng() * 4) + 8];
    } else {
      uuid += hex[Math.floor(rng() * 16)];
    }
  }
  return uuid;
}

function generateRwandanName(rng: RNG): string {
  return `${pick(rng, RWANDAN_FIRST_NAMES)} ${pick(rng, RWANDAN_LAST_NAMES)}`;
}

function generateEmail(rng: RNG, firstName: string, lastName: string, domain: string): string {
  const formats = [
    () => `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${domain}`,
    () => `${firstName.toLowerCase()}${lastName.toLowerCase()}@${domain}`,
    () => `${firstName.toLowerCase().charAt(0)}.${lastName.toLowerCase()}@${domain}`,
    () => `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randInt(rng, 1, 99)}@${domain}`,
  ];
  return pick(rng, formats)();
}

function generateDate(rng: RNG, minYear: number = 2015, maxYear: number = 2025): string {
  const year = randInt(rng, minYear, maxYear);
  const month = randInt(rng, 1, 12);
  const day = randInt(rng, 1, 28);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function generateTimestamp(rng: RNG, minYear: number = 2015, maxYear: number = 2025): string {
  const date = generateDate(rng, minYear, maxYear);
  const hour = randInt(rng, 0, 23);
  const minute = randInt(rng, 0, 59);
  const second = randInt(rng, 0, 59);
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`;
}

function generateGeopoint(rng: RNG): string {
  const lat = randFloat(rng, RWANDA_LAT_MIN, RWANDA_LAT_MAX, 4);
  const lon = randFloat(rng, RWANDA_LON_MIN, RWANDA_LON_MAX, 4);
  return `${lat},${lon}`;
}

// ---------------------------------------------------------------------------
// Column value generator
// ---------------------------------------------------------------------------

function generateValue(
  col: ColumnConfig,
  rowIndex: number,
  rng: RNG,
  nullRate: number
): string | null {
  // Check null rate (never null for sequence/static/pk columns)
  if (
    nullRate > 0 &&
    col.type !== "sequence" &&
    col.type !== "static" &&
    rng() < nullRate
  ) {
    return null;
  }

  const opts = col.options || {};

  switch (col.type) {
    case "sequence": {
      const prefix = opts.prefix || "";
      const start = opts.start ?? 1;
      const padLength = opts.padLength ?? String(start + 10000).length;
      return `${prefix}${String(start + rowIndex).padStart(padLength, "0")}`;
    }

    case "fullName":
      return generateRwandanName(rng);

    case "email": {
      const name = generateRwandanName(rng);
      const parts = name.split(" ");
      const domain = opts.domain || "rra.gov.rw";
      return generateEmail(rng, parts[0], parts[1] || "user", domain);
    }

    case "enum": {
      const values = opts.values || ["A", "B", "C"];
      if (opts.weights) {
        const r = rng();
        let cum = 0;
        for (let i = 0; i < opts.weights.length; i++) {
          cum += opts.weights[i];
          if (r < cum) return values[i];
        }
        return values[values.length - 1];
      }
      return pick(rng, values);
    }

    case "integer": {
      const min = opts.min ?? 0;
      const max = opts.max ?? 1000000;
      if (opts.distribution === "normal") {
        const mean = opts.mean ?? (min + max) / 2;
        const stddev = opts.stddev ?? (max - min) / 6;
        return String(Math.round(normalClamped(rng, mean, stddev, min, max)));
      }
      return String(randInt(rng, min, max));
    }

    case "float": {
      const min = opts.min ?? 0;
      const max = opts.max ?? 1000000;
      const decimals = opts.decimals ?? 2;
      if (opts.distribution === "normal") {
        const mean = opts.mean ?? (min + max) / 2;
        const stddev = opts.stddev ?? (max - min) / 6;
        return normalClamped(rng, mean, stddev, min, max).toFixed(decimals);
      }
      return randFloat(rng, min, max, decimals).toString();
    }

    case "date":
      return generateDate(rng, opts.minYear ?? 2015, opts.maxYear ?? 2025);

    case "timestamp":
      return generateTimestamp(rng, opts.minYear ?? 2015, opts.maxYear ?? 2025);

    case "boolean": {
      const trueRate = opts.trueRate ?? 0.5;
      return rng() < trueRate ? "true" : "false";
    }

    case "geopoint":
      return generateGeopoint(rng);

    case "foreignKey": {
      const prefix = opts.prefix || "FK-";
      const maxId = opts.maxId ?? 100;
      const padLength = opts.padLength ?? String(maxId).length;
      return `${prefix}${String(randInt(rng, 1, maxId)).padStart(padLength, "0")}`;
    }

    case "uuid":
      return generateUUID(rng);

    case "static":
      return opts.value ?? "";

    default:
      return `value_${rowIndex}`;
  }
}

// ---------------------------------------------------------------------------
// CSV quoting
// ---------------------------------------------------------------------------

function csvQuote(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Row generator
// ---------------------------------------------------------------------------

function generateRows(config: GeneratorConfig): string[][] {
  const rng = createRng(config.seed);
  const nullRate = config.nullRate ?? 0;
  const duplicatePkRate = config.duplicatePkRate ?? 0;
  const rows: string[][] = [];

  // Track first PK value for duplicate injection
  let firstPkValue: string | null = null;
  const pkCol = config.columns.find((c) => c.type === "sequence");

  for (let i = 0; i < config.rowCount; i++) {
    const row: string[] = [];
    for (const col of config.columns) {
      const val = generateValue(col, i, rng, nullRate);
      row.push(val ?? "");
    }

    // Capture first PK
    if (i === 0 && pkCol) {
      const pkIdx = config.columns.indexOf(pkCol);
      firstPkValue = row[pkIdx];
    }

    // Duplicate PK injection
    if (
      duplicatePkRate > 0 &&
      i > 0 &&
      firstPkValue !== null &&
      pkCol &&
      rng() < duplicatePkRate
    ) {
      const pkIdx = config.columns.indexOf(pkCol);
      row[pkIdx] = firstPkValue;
    }

    rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Export functions
// ---------------------------------------------------------------------------

export async function generateCsv(
  config: GeneratorConfig,
  outputPath: string
): Promise<string> {
  const rows = generateRows(config);
  const header = config.columns.map((c) => c.name).join(",");
  const lines = [header];

  for (const row of rows) {
    lines.push(row.map((v) => csvQuote(v)).join(","));
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join("\n") + "\n", "utf-8");
  return outputPath;
}

export async function generateJson(
  config: GeneratorConfig,
  outputPath: string
): Promise<string> {
  const rows = generateRows(config);
  const objects: Record<string, string>[] = [];

  for (const row of rows) {
    const obj: Record<string, string> = {};
    for (let i = 0; i < config.columns.length; i++) {
      obj[config.columns[i].name] = row[i];
    }
    objects.push(obj);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(objects, null, 2), "utf-8");
  return outputPath;
}

export async function generateJsonLines(
  config: GeneratorConfig,
  outputPath: string
): Promise<string> {
  const rows = generateRows(config);
  const lines: string[] = [];

  for (const row of rows) {
    const obj: Record<string, string> = {};
    for (let i = 0; i < config.columns.length; i++) {
      obj[config.columns[i].name] = row[i];
    }
    lines.push(JSON.stringify(obj));
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join("\n") + "\n", "utf-8");
  return outputPath;
}

// ---------------------------------------------------------------------------
// RRA-specific generators
// ---------------------------------------------------------------------------

export async function generateRraEmployees(
  rowCount: number,
  outputPath: string
): Promise<string> {
  const config: GeneratorConfig = {
    rowCount,
    seed: "rra-employees",
    columns: [
      { name: "employee_id", type: "sequence", options: { prefix: "RRA-EMP-", padLength: 5 } },
      { name: "full_name", type: "fullName" },
      { name: "email", type: "email", options: { domain: "rra.gov.rw" } },
      { name: "department", type: "enum", options: {
        values: ["Tax Administration", "Customs", "Legal", "IT", "Finance", "HR", "Audit", "Enforcement"],
        weights: [0.30, 0.20, 0.10, 0.15, 0.10, 0.05, 0.05, 0.05],
      }},
      { name: "position", type: "enum", options: {
        values: ["Officer", "Senior Officer", "Supervisor", "Manager", "Director", "Commissioner"],
        weights: [0.40, 0.25, 0.15, 0.10, 0.07, 0.03],
      }},
      { name: "salary", type: "float", options: { min: 300000, max: 5000000, distribution: "normal", mean: 1200000, stddev: 600000, decimals: 0 } },
      { name: "hire_date", type: "date", options: { minYear: 2005, maxYear: 2025 } },
      { name: "is_active", type: "boolean", options: { trueRate: 0.92 } },
      { name: "office_location", type: "enum", options: {
        values: ["Kigali HQ", "Butare Branch", "Gisenyi Branch", "Ruhengeri Branch", "Gitarama Branch", "Cyangugu Branch"],
        weights: [0.50, 0.12, 0.10, 0.10, 0.10, 0.08],
      }},
      { name: "district", type: "enum", options: { values: [...RWANDAN_DISTRICTS] } },
    ],
    nullRate: 0.02,
  };

  return generateCsv(config, outputPath);
}

export async function generateRraTaxpayers(
  rowCount: number,
  outputPath: string
): Promise<string> {
  const config: GeneratorConfig = {
    rowCount,
    seed: "rra-taxpayers",
    columns: [
      { name: "tin", type: "sequence", options: { prefix: "", start: 100000000, padLength: 9 } },
      { name: "taxpayer_name", type: "fullName" },
      { name: "national_id", type: "sequence", options: { prefix: "1", start: 197000000000000, padLength: 16 } },
      { name: "email", type: "email", options: { domain: "gmail.com" } },
      { name: "phone", type: "sequence", options: { prefix: "+2507", start: 80000000, padLength: 8 } },
      { name: "province", type: "enum", options: { values: [...RWANDAN_PROVINCES], weights: [0.45, 0.15, 0.15, 0.12, 0.13] } },
      { name: "district", type: "enum", options: { values: [...RWANDAN_DISTRICTS] } },
      { name: "sector", type: "enum", options: { values: [...RWANDAN_SECTORS] } },
      { name: "tax_status", type: "enum", options: {
        values: [...TAX_STATUSES],
        weights: [0.75, 0.10, 0.10, 0.05],
      }},
      { name: "registration_date", type: "date", options: { minYear: 2001, maxYear: 2025 } },
      { name: "annual_income", type: "float", options: { min: 100000, max: 50000000, distribution: "normal", mean: 5000000, stddev: 8000000, decimals: 0 } },
      { name: "tax_type", type: "enum", options: {
        values: ["PIT", "VAT", "CIT", "PAYE", "Withholding"],
        weights: [0.35, 0.25, 0.20, 0.12, 0.08],
      }},
      { name: "last_filing_date", type: "date", options: { minYear: 2020, maxYear: 2025 } },
      { name: "is_compliant", type: "boolean", options: { trueRate: 0.82 } },
      { name: "location", type: "geopoint" },
    ],
    nullRate: 0.03,
  };

  return generateCsv(config, outputPath);
}

export async function generateRraBusinesses(
  rowCount: number,
  outputPath: string
): Promise<string> {
  const BUSINESS_NAME_PREFIXES = [
    "Ineza", "Ubumwe", "Urumuri", "Amahoro", "Ihirwe",
    "Intego", "Imbuto", "Icyerekezo", "Ubutwari", "Ishema",
    "Igihango", "Ubuzima", "Isoko", "Imena", "Umuco",
  ];
  const BUSINESS_NAME_SUFFIXES = [
    "Ltd", "Trading Co", "Services", "Solutions", "Group",
    "Enterprises", "Holdings", "Rwanda", "Partners", "Associates",
    "Industries", "Consult", "Global", "Tech", "Corp",
  ];

  const rng = createRng("rra-businesses-names");
  const businessNames: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    businessNames.push(
      `${pick(rng, BUSINESS_NAME_PREFIXES)} ${pick(rng, BUSINESS_NAME_SUFFIXES)}`
    );
  }

  const config: GeneratorConfig = {
    rowCount,
    seed: "rra-businesses",
    columns: [
      { name: "business_tin", type: "sequence", options: { prefix: "", start: 200000000, padLength: 9 } },
      { name: "business_name", type: "enum", options: { values: businessNames } },
      { name: "business_type", type: "enum", options: { values: [...BUSINESS_TYPES], weights: [0.30, 0.15, 0.10, 0.20, 0.05, 0.05, 0.10, 0.05] } },
      { name: "sector", type: "enum", options: { values: [...BUSINESS_SECTORS] } },
      { name: "registration_date", type: "date", options: { minYear: 2000, maxYear: 2025 } },
      { name: "province", type: "enum", options: { values: [...RWANDAN_PROVINCES], weights: [0.55, 0.12, 0.13, 0.10, 0.10] } },
      { name: "district", type: "enum", options: { values: [...RWANDAN_DISTRICTS] } },
      { name: "annual_turnover", type: "float", options: { min: 500000, max: 500000000, distribution: "normal", mean: 50000000, stddev: 80000000, decimals: 0 } },
      { name: "employee_count", type: "integer", options: { min: 1, max: 500, distribution: "normal", mean: 25, stddev: 50 } },
      { name: "tax_status", type: "enum", options: {
        values: [...TAX_STATUSES],
        weights: [0.70, 0.12, 0.12, 0.06],
      }},
      { name: "vat_registered", type: "boolean", options: { trueRate: 0.65 } },
      { name: "last_audit_date", type: "date", options: { minYear: 2018, maxYear: 2025 } },
      { name: "compliance_score", type: "float", options: { min: 0, max: 100, distribution: "normal", mean: 72, stddev: 18, decimals: 1 } },
      { name: "location", type: "geopoint" },
      { name: "contact_email", type: "email", options: { domain: "business.rw" } },
    ],
    nullRate: 0.04,
  };

  return generateCsv(config, outputPath);
}

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx tests/utils/testDataGenerator.ts)
// ---------------------------------------------------------------------------

async function runSelfTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  }

  console.log("Running testDataGenerator self-tests...\n");

  const tmpDir = path.resolve(__dirname, "..", "..", "data", "test-gen");
  fs.mkdirSync(tmpDir, { recursive: true });

  // =========================================================================
  // Test 1: generateCsv basic
  // =========================================================================
  console.log("=== 1. generateCsv basic ===");
  {
    const outPath = path.join(tmpDir, "basic.csv");
    await generateCsv(
      {
        rowCount: 50,
        seed: "test-csv",
        columns: [
          { name: "id", type: "sequence", options: { prefix: "ID-", padLength: 3 } },
          { name: "name", type: "fullName" },
          { name: "age", type: "integer", options: { min: 20, max: 65 } },
        ],
      },
      outPath
    );

    assert(fs.existsSync(outPath), "File created");
    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n");
    assert(lines.length === 51, `51 lines (header + 50), got ${lines.length}`);
    assert(lines[0] === "id,name,age", "Header correct");
    assert(lines[1].startsWith("ID-001,"), "First row starts with ID-001");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 2: generateJson
  // =========================================================================
  console.log("\n=== 2. generateJson ===");
  {
    const outPath = path.join(tmpDir, "data.json");
    await generateJson(
      {
        rowCount: 10,
        seed: "test-json",
        columns: [
          { name: "id", type: "uuid" },
          { name: "value", type: "integer", options: { min: 1, max: 100 } },
        ],
      },
      outPath
    );

    assert(fs.existsSync(outPath), "File created");
    const data = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    assert(Array.isArray(data), "Is array");
    assert(data.length === 10, `10 objects, got ${data.length}`);
    assert("id" in data[0], "Has id field");
    assert("value" in data[0], "Has value field");
    assert(data[0].id.includes("-"), "UUID has dashes");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 3: generateJsonLines
  // =========================================================================
  console.log("\n=== 3. generateJsonLines ===");
  {
    const outPath = path.join(tmpDir, "data.jsonl");
    await generateJsonLines(
      {
        rowCount: 5,
        seed: "test-jsonl",
        columns: [
          { name: "seq", type: "sequence" },
          { name: "flag", type: "boolean", options: { trueRate: 0.5 } },
        ],
      },
      outPath
    );

    assert(fs.existsSync(outPath), "File created");
    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n");
    assert(lines.length === 5, `5 lines, got ${lines.length}`);
    const parsed = JSON.parse(lines[0]);
    assert("seq" in parsed, "Has seq field");
    assert("flag" in parsed, "Has flag field");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 4: Rwandan names
  // =========================================================================
  console.log("\n=== 4. Rwandan names ===");
  {
    const outPath = path.join(tmpDir, "names.csv");
    await generateCsv(
      {
        rowCount: 100,
        seed: "rw-names",
        columns: [
          { name: "id", type: "sequence" },
          { name: "name", type: "fullName" },
        ],
      },
      outPath
    );

    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n").slice(1);
    const firstNames = new Set(RWANDAN_FIRST_NAMES);
    const lastNames = new Set(RWANDAN_LAST_NAMES);
    let allValid = true;

    for (const line of lines) {
      const name = line.split(",")[1];
      const parts = name.split(" ");
      if (parts.length < 2 || !firstNames.has(parts[0] as any) || !lastNames.has(parts[1] as any)) {
        allValid = false;
        break;
      }
    }
    assert(allValid, "All names are Rwandan");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 5: Null rate
  // =========================================================================
  console.log("\n=== 5. Null rate ===");
  {
    const outPath = path.join(tmpDir, "nulls.csv");
    await generateCsv(
      {
        rowCount: 1000,
        seed: "null-test",
        nullRate: 0.2,
        columns: [
          { name: "id", type: "sequence" },
          { name: "value", type: "integer", options: { min: 1, max: 100 } },
        ],
      },
      outPath
    );

    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n").slice(1);
    let nullCount = 0;
    for (const line of lines) {
      const val = line.split(",")[1];
      if (val === "") nullCount++;
    }
    const nullPct = nullCount / 1000;
    assert(nullPct > 0.10 && nullPct < 0.30, `~20% nulls: ${(nullPct * 100).toFixed(1)}%`);
    // Sequence should never be null
    let seqNulls = 0;
    for (const line of lines) {
      if (line.split(",")[0] === "") seqNulls++;
    }
    assert(seqNulls === 0, "Sequence column never null");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 6: Enum type
  // =========================================================================
  console.log("\n=== 6. Enum type ===");
  {
    const outPath = path.join(tmpDir, "enum.csv");
    await generateCsv(
      {
        rowCount: 500,
        seed: "enum-test",
        columns: [
          { name: "id", type: "sequence" },
          { name: "status", type: "enum", options: { values: ["A", "B", "C"] } },
        ],
      },
      outPath
    );

    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n").slice(1);
    const values = new Set(lines.map((l) => l.split(",")[1]));
    assert(values.size <= 3, "Only enum values present");
    assert(values.has("A") && values.has("B") && values.has("C"), "All enum values used");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 7: Geopoint within Rwanda
  // =========================================================================
  console.log("\n=== 7. Geopoint bounds ===");
  {
    const outPath = path.join(tmpDir, "geo.csv");
    await generateCsv(
      {
        rowCount: 200,
        seed: "geo-test",
        columns: [
          { name: "id", type: "sequence" },
          { name: "location", type: "geopoint" },
        ],
      },
      outPath
    );

    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n").slice(1);
    let allInBounds = true;
    for (const line of lines) {
      const loc = line.split(",").slice(1).join(",").replace(/"/g, "");
      const parts = loc.split(",");
      const lat = parseFloat(parts[0]);
      const lon = parseFloat(parts[1]);
      if (lat < RWANDA_LAT_MIN || lat > RWANDA_LAT_MAX ||
          lon < RWANDA_LON_MIN || lon > RWANDA_LON_MAX) {
        allInBounds = false;
      }
    }
    assert(allInBounds, "All geopoints within Rwanda bounds");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 8: UUID format
  // =========================================================================
  console.log("\n=== 8. UUID format ===");
  {
    const outPath = path.join(tmpDir, "uuid.csv");
    await generateCsv(
      {
        rowCount: 50,
        seed: "uuid-test",
        columns: [
          { name: "id", type: "uuid" },
        ],
      },
      outPath
    );

    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n").slice(1);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    let allValid = true;
    for (const line of lines) {
      if (!uuidRegex.test(line.trim())) allValid = false;
    }
    assert(allValid, "All UUIDs are valid v4 format");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 9: Deterministic output
  // =========================================================================
  console.log("\n=== 9. Determinism ===");
  {
    const config: GeneratorConfig = {
      rowCount: 100,
      seed: "determinism",
      columns: [
        { name: "id", type: "sequence" },
        { name: "name", type: "fullName" },
        { name: "salary", type: "float", options: { min: 1000, max: 100000 } },
      ],
    };
    const path1 = path.join(tmpDir, "det1.csv");
    const path2 = path.join(tmpDir, "det2.csv");
    await generateCsv(config, path1);
    await generateCsv(config, path2);

    const content1 = fs.readFileSync(path1, "utf-8");
    const content2 = fs.readFileSync(path2, "utf-8");
    assert(content1 === content2, "Same seed produces identical output");
    fs.unlinkSync(path1);
    fs.unlinkSync(path2);
  }

  // =========================================================================
  // Test 10: RRA Employees
  // =========================================================================
  console.log("\n=== 10. RRA Employees ===");
  {
    const outPath = path.join(tmpDir, "rra-emp.csv");
    await generateRraEmployees(100, outPath);

    assert(fs.existsSync(outPath), "File created");
    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n");
    assert(lines.length === 101, `101 lines, got ${lines.length}`);
    assert(lines[0].includes("employee_id"), "Has employee_id column");
    assert(lines[0].includes("department"), "Has department column");
    assert(lines[0].includes("salary"), "Has salary column");
    assert(lines[1].startsWith("RRA-EMP-"), "First row starts with RRA-EMP-");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 11: RRA Taxpayers
  // =========================================================================
  console.log("\n=== 11. RRA Taxpayers ===");
  {
    const outPath = path.join(tmpDir, "rra-tax.csv");
    await generateRraTaxpayers(100, outPath);

    assert(fs.existsSync(outPath), "File created");
    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n");
    assert(lines.length === 101, `101 lines, got ${lines.length}`);
    assert(lines[0].includes("tin"), "Has tin column");
    assert(lines[0].includes("province"), "Has province column");
    assert(lines[0].includes("tax_status"), "Has tax_status column");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 12: RRA Businesses
  // =========================================================================
  console.log("\n=== 12. RRA Businesses ===");
  {
    const outPath = path.join(tmpDir, "rra-biz.csv");
    await generateRraBusinesses(100, outPath);

    assert(fs.existsSync(outPath), "File created");
    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n");
    assert(lines.length === 101, `101 lines, got ${lines.length}`);
    assert(lines[0].includes("business_tin"), "Has business_tin column");
    assert(lines[0].includes("business_type"), "Has business_type column");
    assert(lines[0].includes("compliance_score"), "Has compliance_score column");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 13: Date/Timestamp ranges
  // =========================================================================
  console.log("\n=== 13. Date/Timestamp ranges ===");
  {
    const outPath = path.join(tmpDir, "dates.csv");
    await generateCsv(
      {
        rowCount: 200,
        seed: "date-test",
        columns: [
          { name: "id", type: "sequence" },
          { name: "dt", type: "date", options: { minYear: 2020, maxYear: 2022 } },
          { name: "ts", type: "timestamp", options: { minYear: 2020, maxYear: 2022 } },
        ],
      },
      outPath
    );

    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n").slice(1);
    let allDatesValid = true;
    let allTimestampsValid = true;

    for (const line of lines) {
      const parts = line.split(",");
      const dt = parts[1];
      const ts = parts[2];
      const year = parseInt(dt.split("-")[0], 10);
      if (year < 2020 || year > 2022) allDatesValid = false;

      if (!ts.includes("T") || !ts.endsWith("Z")) allTimestampsValid = false;
      const tsYear = parseInt(ts.split("-")[0], 10);
      if (tsYear < 2020 || tsYear > 2022) allTimestampsValid = false;
    }
    assert(allDatesValid, "All dates within 2020-2022");
    assert(allTimestampsValid, "All timestamps valid ISO 8601");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 14: Foreign key format
  // =========================================================================
  console.log("\n=== 14. Foreign key ===");
  {
    const outPath = path.join(tmpDir, "fk.csv");
    await generateCsv(
      {
        rowCount: 50,
        seed: "fk-test",
        columns: [
          { name: "id", type: "sequence" },
          { name: "company_id", type: "foreignKey", options: { prefix: "CO-", maxId: 10, padLength: 3 } },
        ],
      },
      outPath
    );

    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n").slice(1);
    let allValid = true;
    for (const line of lines) {
      const fk = line.split(",")[1];
      if (!fk.startsWith("CO-")) allValid = false;
      const num = parseInt(fk.replace("CO-", ""), 10);
      if (num < 1 || num > 10) allValid = false;
    }
    assert(allValid, "All foreign keys valid format and range");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 15: Static type
  // =========================================================================
  console.log("\n=== 15. Static type ===");
  {
    const outPath = path.join(tmpDir, "static.csv");
    await generateCsv(
      {
        rowCount: 10,
        seed: "static-test",
        columns: [
          { name: "id", type: "sequence" },
          { name: "country", type: "static", options: { value: "Rwanda" } },
        ],
      },
      outPath
    );

    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n").slice(1);
    let allRwanda = true;
    for (const line of lines) {
      if (line.split(",")[1] !== "Rwanda") allRwanda = false;
    }
    assert(allRwanda, "All static values are Rwanda");
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Test 16: Normal distribution integers
  // =========================================================================
  console.log("\n=== 16. Normal distribution ===");
  {
    const outPath = path.join(tmpDir, "normal.csv");
    await generateCsv(
      {
        rowCount: 1000,
        seed: "normal-test",
        columns: [
          { name: "id", type: "sequence" },
          { name: "salary", type: "integer", options: { min: 50000, max: 200000, distribution: "normal", mean: 120000, stddev: 30000 } },
        ],
      },
      outPath
    );

    const content = fs.readFileSync(outPath, "utf-8").trim();
    const lines = content.split("\n").slice(1);
    let sum = 0;
    let count = 0;
    let allInRange = true;
    for (const line of lines) {
      const val = parseInt(line.split(",")[1], 10);
      if (isNaN(val)) continue;
      if (val < 50000 || val > 200000) allInRange = false;
      sum += val;
      count++;
    }
    const avg = sum / count;
    assert(allInRange, "All values in range");
    assert(avg > 100000 && avg < 140000, `Average near 120k: ${avg.toFixed(0)}`);
    fs.unlinkSync(outPath);
  }

  // =========================================================================
  // Cleanup
  // =========================================================================
  try {
    fs.rmdirSync(tmpDir, { recursive: true } as any);
  } catch {
    // ignore
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll testDataGenerator tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
