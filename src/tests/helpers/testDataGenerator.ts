// ---------------------------------------------------------------------------
// Test Data Generator
//
// Generates realistic test CSV files with configurable row counts and
// intentional edge cases. Used by the indexing test suite (Task 28) and
// for manual testing.
//
// Run self-tests:  npx tsx src/tests/helpers/testDataGenerator.ts
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import seedrandom from "seedrandom";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateEmployeeOptions {
  /** Number of duplicate PK rows to append at the end. Default: 0. */
  duplicateKeyCount?: number;
  /** Number of rows with empty fullName to append at the end. Default: 0. */
  nullRequiredCount?: number;
  /** Number of rows with salary = "INVALID" to append at the end. Default: 0. */
  badTypeCount?: number;
  /** Number of completely empty rows to append at the end. Default: 0. */
  emptyRowCount?: number;
  /** Seed for the PRNG. If provided, output is deterministic across runs. */
  seed?: string;
}

export interface GenerateResult {
  filePath: string;
  totalRows: number;
  validRows: number;
  edgeCaseRows: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIRST_NAMES: readonly string[] = [
  "Melissa", "Jean-Pierre", "Alice", "Omar", "Fatima",
  "David", "Grace", "Emmanuel", "Sophie", "Patrick",
  "Diane", "Samuel", "Claudine", "Eric", "Marie",
  "Joseph", "Yvonne", "Robert", "Amina", "James",
] as const;

const LAST_NAMES: readonly string[] = [
  "Chang", "Habimana", "Uwimana", "Nkurunziza", "Mugisha",
  "Ishimwe", "Kayitesi", "Ndayisaba", "Mukamana", "Bizimungu",
  "Ingabire", "Nsengimana", "Uwase", "Kamanzi", "Mutoni",
  "Rugamba", "Gasana", "Uwineza", "Tuyishime", "Dushime",
] as const;

const DEPARTMENTS: readonly string[] = [
  "Engineering", "Finance", "Marketing", "Operations", "HR",
] as const;

/**
 * Cumulative weights for department selection.
 * Engineering: 40%, Finance: 20%, Marketing: 15%, Operations: 15%, HR: 10%
 */
const DEPARTMENT_CUM_WEIGHTS: readonly number[] = [0.40, 0.60, 0.75, 0.90, 1.00] as const;

const SKILLS: readonly string[] = [
  "python", "java", "sql", "javascript", "typescript",
  "react", "node", "docker", "kubernetes", "aws",
  "gcp", "azure", "machine-learning", "data-analysis", "project-management",
  "agile", "communication", "leadership", "excel", "tableau",
] as const;

// Rwanda geographic bounds
const RWANDA_LAT_MIN = -3.0;
const RWANDA_LAT_MAX = -1.0;
const RWANDA_LON_MIN = 28.5;
const RWANDA_LON_MAX = 30.9;

// Salary normal distribution parameters
const SALARY_MEAN = 120_000;
const SALARY_STDDEV = 40_000;
const SALARY_MIN = 40_000;
const SALARY_MAX = 250_000;

// Age normal distribution parameters
const AGE_MEAN = 35;
const AGE_STDDEV = 10;
const AGE_MIN = 22;
const AGE_MAX = 65;

// Start date range
const START_DATE_MIN = new Date("2015-01-01").getTime();
const START_DATE_MAX = new Date("2025-03-11").getTime();

// ---------------------------------------------------------------------------
// PRNG helpers
// ---------------------------------------------------------------------------

type RNG = () => number;

function createRng(seed?: string): RNG {
  return seed ? seedrandom(seed) : seedrandom();
}

/** Pick a random element from an array. */
function pick<T>(rng: RNG, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Random integer in [min, max] inclusive. */
function randInt(rng: RNG, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** Random float in [min, max). */
function randFloat(rng: RNG, min: number, max: number): number {
  return min + rng() * (max - min);
}

/**
 * Box-Muller transform: generate a normally distributed random value.
 * Returns a single value from N(mean, stddev).
 */
function normalRandom(rng: RNG, mean: number, stddev: number): number {
  let u1 = rng();
  let u2 = rng();
  // Avoid log(0)
  while (u1 === 0) u1 = rng();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * stddev;
}

/**
 * Generate a normally distributed value, resampling if outside [min, max].
 * Guaranteed to terminate because the bulk of the distribution lies within
 * a few standard deviations. Safety cap at 100 attempts (falls back to mean).
 */
function normalClamped(
  rng: RNG,
  mean: number,
  stddev: number,
  min: number,
  max: number
): number {
  for (let attempt = 0; attempt < 100; attempt++) {
    const v = normalRandom(rng, mean, stddev);
    if (v >= min && v <= max) return v;
  }
  return mean; // safety fallback — should never happen in practice
}

/**
 * Weighted random pick using cumulative weights.
 */
function weightedPick<T>(
  rng: RNG,
  items: readonly T[],
  cumWeights: readonly number[]
): T {
  const r = rng();
  for (let i = 0; i < cumWeights.length; i++) {
    if (r < cumWeights[i]) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Pick `count` unique random items from an array (Fisher-Yates partial shuffle).
 */
function pickN<T>(rng: RNG, arr: readonly T[], count: number): T[] {
  const copy = [...arr];
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// ---------------------------------------------------------------------------
// CSV quoting
// ---------------------------------------------------------------------------

/** Quote a field if it contains commas, double quotes, or newlines. */
function csvQuote(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Employee ID formatting
// ---------------------------------------------------------------------------

/**
 * Format employee ID with zero-padding. Uses at least 3 digits, but
 * expands to fit the total number of rows.
 */
function formatEmpId(index: number, totalRows: number): string {
  const digits = Math.max(3, String(totalRows).length);
  return `EMP-${String(index).padStart(digits, "0")}`;
}

// ---------------------------------------------------------------------------
// generateEmployeeCSV
// ---------------------------------------------------------------------------

/**
 * Generate a realistic employee CSV file with configurable row counts and
 * intentional edge cases.
 *
 * Edge case rows are always appended after all valid rows, not interspersed.
 *
 * @param filePath  - Absolute or relative path for the output CSV file.
 * @param rowCount  - Number of valid data rows to generate.
 * @param options   - Edge case injection and PRNG seed options.
 * @returns Metadata about the generated file.
 */
export function generateEmployeeCSV(
  filePath: string,
  rowCount: number,
  options: GenerateEmployeeOptions = {}
): GenerateResult {
  const {
    duplicateKeyCount = 0,
    nullRequiredCount = 0,
    badTypeCount = 0,
    emptyRowCount = 0,
    seed,
  } = options;

  const rng = createRng(seed);
  const edgeCaseTotal = duplicateKeyCount + nullRequiredCount + badTypeCount + emptyRowCount;
  const totalRows = rowCount + edgeCaseTotal;

  const header = "emp_id,full_name,email,salary,start_date,is_active,skills,location,department,age";
  const lines: string[] = [header];

  // Store the first employee ID for duplicate key injection
  const firstEmpId = formatEmpId(1, totalRows);

  // -----------------------------------------------------------------------
  // Generate valid rows
  // -----------------------------------------------------------------------
  for (let i = 1; i <= rowCount; i++) {
    const empId = formatEmpId(i, totalRows);
    const firstName = pick(rng, FIRST_NAMES);
    const lastName = pick(rng, LAST_NAMES);
    const fullName = `${firstName} ${lastName}`;
    const email = `${firstName.toLowerCase().replace(/-/g, "")}.${lastName.toLowerCase()}@company.com`;

    // Salary: normal distribution, resampled if out of range
    const salary = normalClamped(rng, SALARY_MEAN, SALARY_STDDEV, SALARY_MIN, SALARY_MAX);
    const salaryStr = salary.toFixed(2);

    // Start date: uniform random between 2015-01-01 and 2025-03-11
    const dateMs = START_DATE_MIN + rng() * (START_DATE_MAX - START_DATE_MIN);
    const d = new Date(dateMs);
    const startDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

    // Department: weighted distribution
    const department = weightedPick(rng, DEPARTMENTS, DEPARTMENT_CUM_WEIGHTS);

    // isActive: 90% true, 10% false
    const isActive = rng() < 0.9 ? "true" : "false";

    // Skills: 1-5 unique skills from the list
    const skillCount = randInt(rng, 1, 5);
    const skillList = pickN(rng, SKILLS, skillCount);
    const skillsStr = csvQuote(skillList.join(","));

    // Location: random geopoint within Rwanda
    const lat = randFloat(rng, RWANDA_LAT_MIN, RWANDA_LAT_MAX);
    const lon = randFloat(rng, RWANDA_LON_MIN, RWANDA_LON_MAX);
    const locationStr = csvQuote(`${lat.toFixed(4)},${lon.toFixed(4)}`);

    // Age: normal distribution, resampled if out of range
    const age = Math.round(normalClamped(rng, AGE_MEAN, AGE_STDDEV, AGE_MIN, AGE_MAX));

    lines.push(
      `${empId},${fullName},${email},${salaryStr},${startDate},${isActive},${skillsStr},${locationStr},${department},${age}`
    );
  }

  // -----------------------------------------------------------------------
  // Append edge case rows (always at end, after all valid rows)
  // -----------------------------------------------------------------------

  // Duplicate PK rows: copy the first row's PK
  for (let i = 0; i < duplicateKeyCount; i++) {
    const idx = rowCount + 1 + i;
    const firstName = pick(rng, FIRST_NAMES);
    const lastName = pick(rng, LAST_NAMES);
    const email = `${firstName.toLowerCase().replace(/-/g, "")}.${lastName.toLowerCase()}@company.com`;
    const salary = normalClamped(rng, SALARY_MEAN, SALARY_STDDEV, SALARY_MIN, SALARY_MAX).toFixed(2);
    const dateMs = START_DATE_MIN + rng() * (START_DATE_MAX - START_DATE_MIN);
    const d = new Date(dateMs);
    const startDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const department = weightedPick(rng, DEPARTMENTS, DEPARTMENT_CUM_WEIGHTS);
    const isActive = rng() < 0.9 ? "true" : "false";
    const skillCount = randInt(rng, 1, 5);
    const skillsStr = csvQuote(pickN(rng, SKILLS, skillCount).join(","));
    const lat = randFloat(rng, RWANDA_LAT_MIN, RWANDA_LAT_MAX);
    const lon = randFloat(rng, RWANDA_LON_MIN, RWANDA_LON_MAX);
    const locationStr = csvQuote(`${lat.toFixed(4)},${lon.toFixed(4)}`);
    const age = Math.round(normalClamped(rng, AGE_MEAN, AGE_STDDEV, AGE_MIN, AGE_MAX));

    lines.push(
      `${firstEmpId},${firstName} ${lastName},${email},${salary},${startDate},${isActive},${skillsStr},${locationStr},${department},${age}`
    );
  }

  // Null required rows: fullName is empty string
  for (let i = 0; i < nullRequiredCount; i++) {
    const idx = rowCount + duplicateKeyCount + 1 + i;
    const empId = formatEmpId(idx, totalRows);
    const email = `null.required${i}@company.com`;
    const salary = normalClamped(rng, SALARY_MEAN, SALARY_STDDEV, SALARY_MIN, SALARY_MAX).toFixed(2);
    const dateMs = START_DATE_MIN + rng() * (START_DATE_MAX - START_DATE_MIN);
    const d = new Date(dateMs);
    const startDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const department = weightedPick(rng, DEPARTMENTS, DEPARTMENT_CUM_WEIGHTS);
    const isActive = rng() < 0.9 ? "true" : "false";
    const skillCount = randInt(rng, 1, 5);
    const skillsStr = csvQuote(pickN(rng, SKILLS, skillCount).join(","));
    const lat = randFloat(rng, RWANDA_LAT_MIN, RWANDA_LAT_MAX);
    const lon = randFloat(rng, RWANDA_LON_MIN, RWANDA_LON_MAX);
    const locationStr = csvQuote(`${lat.toFixed(4)},${lon.toFixed(4)}`);
    const age = Math.round(normalClamped(rng, AGE_MEAN, AGE_STDDEV, AGE_MIN, AGE_MAX));

    lines.push(
      `${empId},,${email},${salary},${startDate},${isActive},${skillsStr},${locationStr},${department},${age}`
    );
  }

  // Bad type rows: salary is "INVALID"
  for (let i = 0; i < badTypeCount; i++) {
    const idx = rowCount + duplicateKeyCount + nullRequiredCount + 1 + i;
    const empId = formatEmpId(idx, totalRows);
    const firstName = pick(rng, FIRST_NAMES);
    const lastName = pick(rng, LAST_NAMES);
    const email = `${firstName.toLowerCase().replace(/-/g, "")}.${lastName.toLowerCase()}@company.com`;
    const dateMs = START_DATE_MIN + rng() * (START_DATE_MAX - START_DATE_MIN);
    const d = new Date(dateMs);
    const startDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const department = weightedPick(rng, DEPARTMENTS, DEPARTMENT_CUM_WEIGHTS);
    const isActive = rng() < 0.9 ? "true" : "false";
    const skillCount = randInt(rng, 1, 5);
    const skillsStr = csvQuote(pickN(rng, SKILLS, skillCount).join(","));
    const lat = randFloat(rng, RWANDA_LAT_MIN, RWANDA_LAT_MAX);
    const lon = randFloat(rng, RWANDA_LON_MIN, RWANDA_LON_MAX);
    const locationStr = csvQuote(`${lat.toFixed(4)},${lon.toFixed(4)}`);
    const age = Math.round(normalClamped(rng, AGE_MEAN, AGE_STDDEV, AGE_MIN, AGE_MAX));

    lines.push(
      `${empId},${firstName} ${lastName},${email},INVALID,${startDate},${isActive},${skillsStr},${locationStr},${department},${age}`
    );
  }

  // Empty rows
  for (let i = 0; i < emptyRowCount; i++) {
    lines.push(",,,,,,,,,");
  }

  // -----------------------------------------------------------------------
  // Write file
  // -----------------------------------------------------------------------
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

  return {
    filePath,
    totalRows,
    validRows: rowCount,
    edgeCaseRows: edgeCaseTotal,
  };
}

// ---------------------------------------------------------------------------
// Stubs for Day 4
// ---------------------------------------------------------------------------

/**
 * Generate a company CSV file. Not yet implemented.
 * @throws Error with message directing to Day 4 task specifications.
 */
export function generateCompanyCSV(
  _filePath: string,
  _rowCount: number
): never {
  throw new Error("Not implemented — see Day 4 task specifications");
}

/**
 * Generate a ticket CSV file. Not yet implemented.
 * @throws Error with message directing to Day 4 task specifications.
 */
export function generateTicketCSV(
  _filePath: string,
  _rowCount: number,
  _employeeIds: string[]
): never {
  throw new Error("Not implemented — see Day 4 task specifications");
}

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/tests/helpers/testDataGenerator.ts)
// ---------------------------------------------------------------------------

function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
      console.log(`  PASS: ${label}`);
    } else {
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  console.log("Running testDataGenerator self-tests...\n");

  const tmpDir = path.join(__dirname, "..", "..", "..", "data");

  // =========================================================================
  // Test 1: Basic generation — 100 rows, seeded
  // =========================================================================
  console.log("=== 1. Basic generation (100 rows, seeded) ===");
  {
    const filePath = path.join(tmpDir, "test-gen-basic.csv");
    const result = generateEmployeeCSV(filePath, 100, { seed: "test" });

    assert(fs.existsSync(filePath), "File created");
    assert(result.totalRows === 100, `totalRows = 100 (got ${result.totalRows})`);
    assert(result.validRows === 100, `validRows = 100 (got ${result.validRows})`);
    assert(result.edgeCaseRows === 0, `edgeCaseRows = 0 (got ${result.edgeCaseRows})`);

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");
    assert(lines.length === 101, `101 lines (header + 100 rows), got ${lines.length}`);

    // Verify header
    assert(
      lines[0] === "emp_id,full_name,email,salary,start_date,is_active,skills,location,department,age",
      "Header matches expected columns"
    );

    // Verify first data row starts with EMP-001
    assert(lines[1].startsWith("EMP-001,"), `First row starts with EMP-001 (got "${lines[1].substring(0, 10)}")`);

    // Verify last row starts with EMP-100
    assert(lines[100].startsWith("EMP-100,"), `Last row starts with EMP-100 (got "${lines[100].substring(0, 10)}")`);

    fs.unlinkSync(filePath);
  }

  // =========================================================================
  // Test 2: Determinism — same seed produces identical output
  // =========================================================================
  console.log("\n=== 2. Determinism ===");
  {
    const path1 = path.join(tmpDir, "test-gen-det1.csv");
    const path2 = path.join(tmpDir, "test-gen-det2.csv");

    generateEmployeeCSV(path1, 100, { seed: "test" });
    generateEmployeeCSV(path2, 100, { seed: "test" });

    const content1 = fs.readFileSync(path1, "utf-8");
    const content2 = fs.readFileSync(path2, "utf-8");

    assert(content1 === content2, "Same seed produces identical output");

    fs.unlinkSync(path1);
    fs.unlinkSync(path2);
  }

  // =========================================================================
  // Test 3: Different seeds produce different output
  // =========================================================================
  console.log("\n=== 3. Different seeds ===");
  {
    const pathA = path.join(tmpDir, "test-gen-seedA.csv");
    const pathB = path.join(tmpDir, "test-gen-seedB.csv");

    generateEmployeeCSV(pathA, 50, { seed: "alpha" });
    generateEmployeeCSV(pathB, 50, { seed: "beta" });

    const contentA = fs.readFileSync(pathA, "utf-8");
    const contentB = fs.readFileSync(pathB, "utf-8");

    assert(contentA !== contentB, "Different seeds produce different output");

    fs.unlinkSync(pathA);
    fs.unlinkSync(pathB);
  }

  // =========================================================================
  // Test 4: Edge cases — duplicateKeyCount, nullRequiredCount, badTypeCount
  // =========================================================================
  console.log("\n=== 4. Edge cases ===");
  {
    const filePath = path.join(tmpDir, "test-gen-edges.csv");
    const result = generateEmployeeCSV(filePath, 10, {
      seed: "edge-test",
      duplicateKeyCount: 2,
      nullRequiredCount: 1,
      badTypeCount: 3,
      emptyRowCount: 1,
    });

    assert(result.totalRows === 17, `totalRows = 17 (got ${result.totalRows})`);
    assert(result.validRows === 10, `validRows = 10 (got ${result.validRows})`);
    assert(result.edgeCaseRows === 7, `edgeCaseRows = 7 (got ${result.edgeCaseRows})`);

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");
    assert(lines.length === 18, `18 lines (header + 17 rows), got ${lines.length}`);

    // Rows 1-10 are valid (indices 1-10 in lines array)
    // Rows 11-12 are duplicate PKs (should start with EMP-001)
    assert(lines[11].startsWith("EMP-001,"), `Row 11 is duplicate PK (starts with EMP-001): "${lines[11].substring(0, 10)}"`);
    assert(lines[12].startsWith("EMP-001,"), `Row 12 is duplicate PK (starts with EMP-001): "${lines[12].substring(0, 10)}"`);

    // Row 13 is null required (fullName is empty — second field is empty)
    const row13Fields = lines[13].split(",");
    assert(row13Fields[1] === "", `Row 13 has empty fullName: field[1] = "${row13Fields[1]}"`);

    // Rows 14-16 have salary = "INVALID"
    assert(lines[14].includes(",INVALID,"), `Row 14 has INVALID salary: "${lines[14].substring(0, 60)}"`);
    assert(lines[15].includes(",INVALID,"), `Row 15 has INVALID salary`);
    assert(lines[16].includes(",INVALID,"), `Row 16 has INVALID salary`);

    // Row 17 is empty
    assert(lines[17] === ",,,,,,,,,", `Row 17 is empty row: "${lines[17]}"`);

    fs.unlinkSync(filePath);
  }

  // =========================================================================
  // Test 5: Name lists — verify names come from the specified lists
  // =========================================================================
  console.log("\n=== 5. Name validation ===");
  {
    const filePath = path.join(tmpDir, "test-gen-names.csv");
    generateEmployeeCSV(filePath, 200, { seed: "name-test" });

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");

    let allNamesValid = true;
    const firstNameSet = new Set(FIRST_NAMES);
    const lastNameSet = new Set(LAST_NAMES);

    for (let i = 1; i <= 200; i++) {
      // Parse carefully: emp_id is field 0, full_name is field 1
      // But skills and location are quoted with commas. We need smarter parsing.
      // Since emp_id never has commas and full_name never has commas, we can
      // grab the second comma-separated field.
      const match = lines[i].match(/^[^,]+,([^,]*),/);
      if (!match) { allNamesValid = false; break; }
      const fullName = match[1];
      const parts = fullName.split(" ");
      if (parts.length < 2) { allNamesValid = false; break; }
      // Handle hyphenated first names like "Jean-Pierre"
      if (!firstNameSet.has(parts[0])) { allNamesValid = false; break; }
      if (!lastNameSet.has(parts.slice(1).join(" "))) { allNamesValid = false; break; }
    }

    assert(allNamesValid, "All names come from the specified first/last name lists");
    fs.unlinkSync(filePath);
  }

  // =========================================================================
  // Test 6: Email format
  // =========================================================================
  console.log("\n=== 6. Email format ===");
  {
    const filePath = path.join(tmpDir, "test-gen-email.csv");
    generateEmployeeCSV(filePath, 50, { seed: "email-test" });

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");

    let allEmailsValid = true;
    for (let i = 1; i <= 50; i++) {
      const match = lines[i].match(/^[^,]+,[^,]+,([^,]+),/);
      if (!match) { allEmailsValid = false; break; }
      const email = match[1];
      if (!email.endsWith("@company.com")) { allEmailsValid = false; break; }
      if (email.includes(" ")) { allEmailsValid = false; break; }
      // Verify lowercase
      if (email !== email.toLowerCase()) { allEmailsValid = false; break; }
    }

    assert(allEmailsValid, "All emails are lowercase, end with @company.com, no spaces");
    fs.unlinkSync(filePath);
  }

  // =========================================================================
  // Test 7: Salary distribution — within [40000, 250000]
  // =========================================================================
  console.log("\n=== 7. Salary distribution ===");
  {
    const filePath = path.join(tmpDir, "test-gen-salary.csv");
    generateEmployeeCSV(filePath, 1000, { seed: "salary-test" });

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");

    let salarySum = 0;
    let salaryCount = 0;
    let allInRange = true;

    for (let i = 1; i <= 1000; i++) {
      // salary is the 4th field (index 3)
      const match = lines[i].match(/^[^,]+,[^,]+,[^,]+,([^,]+),/);
      if (!match) continue;
      const salary = parseFloat(match[1]);
      if (isNaN(salary)) continue;
      if (salary < SALARY_MIN || salary > SALARY_MAX) {
        allInRange = false;
      }
      salarySum += salary;
      salaryCount++;
    }

    const avgSalary = salarySum / salaryCount;

    assert(allInRange, "All salaries within [40000, 250000]");
    assert(
      avgSalary > 100000 && avgSalary < 140000,
      `Average salary near 120k: ${avgSalary.toFixed(0)} (expected ~120000)`
    );

    fs.unlinkSync(filePath);
  }

  // =========================================================================
  // Test 8: Department weighted distribution
  // =========================================================================
  console.log("\n=== 8. Department distribution ===");
  {
    const filePath = path.join(tmpDir, "test-gen-dept.csv");
    generateEmployeeCSV(filePath, 2000, { seed: "dept-test" });

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");

    const deptCounts: Record<string, number> = {};

    for (let i = 1; i <= 2000; i++) {
      // Department is the 9th field (index 8). But fields 7 and 8 (skills, location)
      // are quoted and contain commas. We need to parse more carefully.
      // Strategy: count unquoted commas or use a regex that handles quoted fields.
      const fields = parseCSVLine(lines[i]);
      if (fields.length < 9) continue;
      const dept = fields[8]; // 0-indexed: department is column 9
      deptCounts[dept] = (deptCounts[dept] || 0) + 1;
    }

    const engPct = ((deptCounts["Engineering"] || 0) / 2000) * 100;
    const finPct = ((deptCounts["Finance"] || 0) / 2000) * 100;
    const hrPct = ((deptCounts["HR"] || 0) / 2000) * 100;

    assert(engPct > 30 && engPct < 50, `Engineering ~40%: ${engPct.toFixed(1)}%`);
    assert(finPct > 13 && finPct < 27, `Finance ~20%: ${finPct.toFixed(1)}%`);
    assert(hrPct > 5 && hrPct < 18, `HR ~10%: ${hrPct.toFixed(1)}%`);

    fs.unlinkSync(filePath);
  }

  // =========================================================================
  // Test 9: isActive distribution — ~90% true
  // =========================================================================
  console.log("\n=== 9. isActive distribution ===");
  {
    const filePath = path.join(tmpDir, "test-gen-active.csv");
    generateEmployeeCSV(filePath, 1000, { seed: "active-test" });

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");

    let trueCount = 0;
    for (let i = 1; i <= 1000; i++) {
      // isActive is 6th field (index 5)
      const match = lines[i].match(/^[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,([^,]+),/);
      if (!match) continue;
      if (match[1] === "true") trueCount++;
    }

    const truePct = (trueCount / 1000) * 100;
    assert(truePct > 82 && truePct < 97, `~90% true: ${truePct.toFixed(1)}%`);

    fs.unlinkSync(filePath);
  }

  // =========================================================================
  // Test 10: Age distribution — within [22, 65], mean ~35
  // =========================================================================
  console.log("\n=== 10. Age distribution ===");
  {
    const filePath = path.join(tmpDir, "test-gen-age.csv");
    generateEmployeeCSV(filePath, 1000, { seed: "age-test" });

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");

    let ageSum = 0;
    let ageCount = 0;
    let allInRange = true;

    for (let i = 1; i <= 1000; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length < 10) continue;
      const age = parseInt(fields[9], 10);
      if (isNaN(age)) continue;
      if (age < AGE_MIN || age > AGE_MAX) allInRange = false;
      ageSum += age;
      ageCount++;
    }

    const avgAge = ageSum / ageCount;

    assert(allInRange, "All ages within [22, 65]");
    assert(
      avgAge > 30 && avgAge < 40,
      `Average age near 35: ${avgAge.toFixed(1)} (expected ~35)`
    );

    fs.unlinkSync(filePath);
  }

  // =========================================================================
  // Test 11: Location within Rwanda bounds
  // =========================================================================
  console.log("\n=== 11. Location bounds ===");
  {
    const filePath = path.join(tmpDir, "test-gen-loc.csv");
    generateEmployeeCSV(filePath, 200, { seed: "loc-test" });

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");

    let allInBounds = true;
    for (let i = 1; i <= 200; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length < 8) { allInBounds = false; continue; }
      const locParts = fields[7].split(",");
      if (locParts.length !== 2) { allInBounds = false; continue; }
      const lat = parseFloat(locParts[0]);
      const lon = parseFloat(locParts[1]);
      if (lat < RWANDA_LAT_MIN || lat > RWANDA_LAT_MAX) allInBounds = false;
      if (lon < RWANDA_LON_MIN || lon > RWANDA_LON_MAX) allInBounds = false;
    }

    assert(allInBounds, "All locations within Rwanda bounds (lat:-3 to -1, lon:28.5 to 30.9)");
    fs.unlinkSync(filePath);
  }

  // =========================================================================
  // Test 12: Skills — 1 to 5 unique skills per row
  // =========================================================================
  console.log("\n=== 12. Skills validation ===");
  {
    const filePath = path.join(tmpDir, "test-gen-skills.csv");
    generateEmployeeCSV(filePath, 200, { seed: "skills-test" });

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");

    const skillSet = new Set(SKILLS);
    let allValid = true;

    for (let i = 1; i <= 200; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length < 7) { allValid = false; continue; }
      const skills = fields[6].split(",");
      if (skills.length < 1 || skills.length > 5) { allValid = false; continue; }
      // Check uniqueness
      if (new Set(skills).size !== skills.length) { allValid = false; continue; }
      // Check all are from the allowed list
      for (const s of skills) {
        if (!skillSet.has(s)) { allValid = false; break; }
      }
    }

    assert(allValid, "All skill lists have 1-5 unique skills from the allowed set");
    fs.unlinkSync(filePath);
  }

  // =========================================================================
  // Test 13: Start dates in range
  // =========================================================================
  console.log("\n=== 13. Start date range ===");
  {
    const filePath = path.join(tmpDir, "test-gen-dates.csv");
    generateEmployeeCSV(filePath, 500, { seed: "date-test" });

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");

    let allInRange = true;
    for (let i = 1; i <= 500; i++) {
      const match = lines[i].match(/^[^,]+,[^,]+,[^,]+,[^,]+,(\d{4}-\d{2}-\d{2}),/);
      if (!match) { allInRange = false; continue; }
      const date = new Date(match[1]);
      if (date.getTime() < START_DATE_MIN || date.getTime() > START_DATE_MAX) {
        allInRange = false;
      }
    }

    assert(allInRange, "All start dates between 2015-01-01 and 2025-03-11");
    fs.unlinkSync(filePath);
  }

  // =========================================================================
  // Test 14: Employee ID format — zero-padded, expands for large counts
  // =========================================================================
  console.log("\n=== 14. Employee ID format ===");
  {
    assert(formatEmpId(1, 100) === "EMP-001", `formatEmpId(1, 100) = "EMP-001"`);
    assert(formatEmpId(99, 100) === "EMP-099", `formatEmpId(99, 100) = "EMP-099"`);
    assert(formatEmpId(100, 100) === "EMP-100", `formatEmpId(100, 100) = "EMP-100"`);
    assert(formatEmpId(1, 1000) === "EMP-0001", `formatEmpId(1, 1000) = "EMP-0001"`);
    assert(formatEmpId(1, 10000) === "EMP-00001", `formatEmpId(1, 10000) = "EMP-00001"`);
    assert(formatEmpId(5, 50) === "EMP-005", `formatEmpId(5, 50) = "EMP-005" (min 3 digits)`);
  }

  // =========================================================================
  // Test 15: Stubs throw
  // =========================================================================
  console.log("\n=== 15. Stubs throw ===");
  {
    let threwCompany = false;
    try { generateCompanyCSV("/dev/null", 10); } catch (e: any) {
      threwCompany = e.message.includes("Not implemented");
    }
    assert(threwCompany, "generateCompanyCSV throws 'Not implemented'");

    let threwTicket = false;
    try { generateTicketCSV("/dev/null", 10, []); } catch (e: any) {
      threwTicket = e.message.includes("Not implemented");
    }
    assert(threwTicket, "generateTicketCSV throws 'Not implemented'");
  }

  // =========================================================================
  // Test 16: Edge case count = 0 produces clean file
  // =========================================================================
  console.log("\n=== 16. Clean file (zero edge cases) ===");
  {
    const filePath = path.join(tmpDir, "test-gen-clean.csv");
    const result = generateEmployeeCSV(filePath, 50, {
      seed: "clean",
      duplicateKeyCount: 0,
      nullRequiredCount: 0,
      badTypeCount: 0,
      emptyRowCount: 0,
    });

    assert(result.edgeCaseRows === 0, "Zero edge case rows");
    assert(result.totalRows === 50, "Total = 50");

    const content = fs.readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n");

    // Verify no INVALID salary
    let hasInvalid = false;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].includes(",INVALID,")) hasInvalid = true;
    }
    assert(!hasInvalid, "No INVALID salary in clean file");

    // Verify no empty fullName (second field after first comma)
    let hasEmptyName = false;
    for (let i = 1; i < lines.length; i++) {
      const match = lines[i].match(/^[^,]+,([^,]*),/);
      if (match && match[1] === "") hasEmptyName = true;
    }
    assert(!hasEmptyName, "No empty fullName in clean file");

    // Verify no duplicate PKs
    const pks = new Set<string>();
    let hasDup = false;
    for (let i = 1; i < lines.length; i++) {
      const pk = lines[i].split(",")[0];
      if (pks.has(pk)) hasDup = true;
      pks.add(pk);
    }
    assert(!hasDup, "No duplicate PKs in clean file");

    fs.unlinkSync(filePath);
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

// ---------------------------------------------------------------------------
// CSV line parser (handles quoted fields with embedded commas)
// ---------------------------------------------------------------------------

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runSelfTests();
}
