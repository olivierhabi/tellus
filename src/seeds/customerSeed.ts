// ---------------------------------------------------------------------------
// Customer Demo Seed
//
// Promotes the FE-side Customer fixture (previously gated behind `?demo=1`)
// into a real, persisted ontology so the live BE serves it. The Customer
// object type is pinned to UUID `117cb384-ab99-4064-b789-aafa87ffc23c` so
// the existing FE route `/object-explorer/object-type/<that uuid>` keeps
// working without the demo flag, and shareable links survive.
//
// What this seed creates:
//   - 1 Ontology         "Customer Demo"
//   - 4 Object Types     Customer (pinned UUID), Order, Employee, Product
//   - 8 Customer props   matching the FE fixture exactly (customerId,
//                        fullName, segment, region, isActive,
//                        lifetimeValue, orderCount, joinedAt)
//   - 3 Link Types       customerOrders (1:N → Order),
//                        customerAccountManager (N:1 → Employee),
//                        customerProducts (N:N ↔ Product)
//   - 50 Customer rows   deterministic — same algorithm as the FE fixture
//
// Idempotent: deletes the existing "Customer Demo" ontology and its CSV
// dataset on every run, so re-running the seed always yields the same
// terminal state.
//
// Usage:
//   npx tsx src/seeds/customerSeed.ts
//   # or via the package script:
//   npm run seed:customer
// ---------------------------------------------------------------------------

import "dotenv/config";
import fs from "fs";
import path from "path";
import seedrandom from "seedrandom";
import { query, getClient } from "../db";
import { resetEnterpriseOntologyForSeed } from "./seedOntology";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONTOLOGY_NAME = "Customer Demo";
const DATA_DIR = path.resolve(__dirname, "..", "..", "data", "seed");

// Synthetic data volume. 500 customers gives chart histograms enough
// shape to look real (vs 50 which produces obviously-uniform bars), and
// stays well under BE-T09's 1000-row search cap so the FE renders
// everything without pagination. Linked-OT counts are sized to the
// cardinality semantics: many orders per customer (1:N), few employees
// acting as account managers (N:1), a small product catalog (N:N).
const CUSTOMER_COUNT = 500;
const ORDER_COUNT = 1500;   // ~3 orders per customer on average
const EMPLOYEE_COUNT = 25;  // ~20 customers per account manager
const PRODUCT_COUNT = 40;   // realistic SaaS catalog size

// Deterministic PRNG — seeded so re-runs produce byte-identical CSVs.
// Critical for replayable seeds, screenshot-stable test fixtures, and
// reproducible regression debugging. Seed string is arbitrary but stable.
const rng = seedrandom("customer-demo-v1");

// Owner attribution. Every row inserted by this seed (ontology, object
// types, etc.) records `created_by = OWNER_EMAIL` so the user shows up
// as the author in audit columns and any future ownership-scoped query.
// Override at runtime via SEED_OWNER env var if you want to seed under a
// different account without editing the source. The fallback is the
// developer who scoped this seed; switching it doesn't affect the data
// shape, only the audit attribution.
const OWNER_EMAIL = process.env.SEED_OWNER ?? "habimanaolivier6@gmail.com";

// Pinned UUID for the Customer object type. The frontend route
// /object-explorer/object-type/<uuid> was historically wired to this exact
// id when ?demo=1 served fixture data; pinning here preserves every
// shareable link, screenshot reference, and Cypress spec that hard-codes
// it. Postgres' `UUID PRIMARY KEY DEFAULT gen_random_uuid()` accepts
// explicit values via INSERT, so this is safe.
const CUSTOMER_OBJECT_TYPE_ID = "117cb384-ab99-4064-b789-aafa87ffc23c";

// ---------------------------------------------------------------------------
// Customer-domain data constants (mirror the FE fixture exactly)
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  "Olivia", "Noah", "Emma", "Liam", "Ava", "Mason", "Sophia", "Lucas",
  "Isabella", "Ethan", "Mia", "Logan", "Charlotte", "Aiden", "Amelia",
  "Henry", "Harper", "Sebastian", "Evelyn", "Jackson",
];
const LAST_NAMES = [
  "Anderson", "Bauer", "Carter", "Davies", "Espinoza", "Fournier",
  "Gomez", "Hassan", "Iverson", "Johansson", "Kowalski", "Liu",
  "Müller", "Nguyen", "Okafor", "Park", "Quintero", "Romero",
  "Singh", "Tanaka",
];

// Curated single-word business names — same shape as the user's example
// ("Officegoods"). These read as believable SaaS customer accounts and
// give Listograms a recognisable B2B feel without slipping into
// trademarked brand names.
const BUSINESS_SINGLE_NAMES = [
  "Officegoods", "Brightline", "Northwind", "Coastline", "Stormcloud",
  "Sunrise Logistics", "Lakehouse", "Roundpeak", "Valley Forge",
  "Truelane", "Westmark", "Skylight", "Greenroot", "Peakridge",
  "Cobblestone", "Bluewave", "Ironclad", "Silverleaf", "Highmark",
  "Riverbend", "Oakmont", "Brassgate", "Copperhill", "Foxglove",
  "Hawthorn", "Maplewood", "Pinegrove", "Cedar & Co",
];

// Compound business names — prefix + suffix combinations for variety.
// Suffixes carry the legal-form signal (Inc, LLC, GmbH, SARL) so the data
// reads as a multi-region B2B customer base.
const BUSINESS_PREFIXES = [
  "Acme", "Apex", "Vanguard", "Helios", "Meridian", "Polaris", "Atlas",
  "Beacon", "Cipher", "Dynamo", "Empire", "Fortress", "Granite",
  "Horizon", "Lattice", "Magnolia", "Pioneer", "Quantum", "Sentinel",
  "Tempo", "Vector", "Zenith",
];
const BUSINESS_SUFFIXES = [
  "Industries", "Holdings", "Group", "Partners", "Systems", "Solutions",
  "Logistics", "Networks", "Dynamics", "Labs", "Works", "Ventures",
  "Inc", "LLC", "Corp", "GmbH", "SARL", "Pty Ltd", "AG", "K.K.",
];

// Per-segment business-vs-person mix. Strategic and Enterprise are
// 100% B2B; Consumer is 100% B2C; SMB is mixed (most small businesses
// register under a trade name but some are sole-proprietor individuals).
const BUSINESS_NAME_PROBABILITY: Record<string, number> = {
  Strategic:  1.00, // every Strategic account is a named business
  Enterprise: 1.00,
  SMB:        0.70, // most SMBs are businesses, ~30% sole-proprietor
  Consumer:   0.00, // Consumer is always individual
};
// Weighted segment / region distributions — reflect realistic SaaS
// customer mix rather than uniform sampling. Charts surface this skew
// (segment Listogram shows SMB dominance; region map shows NA + EMEA
// strength) which is what real product analytics screens look like.
const SEGMENT_WEIGHTS: Array<[string, number]> = [
  ["SMB",         0.55], // most accounts
  ["Enterprise",  0.30],
  ["Consumer",    0.10],
  ["Strategic",   0.05], // small but high-value tier
];
const REGION_WEIGHTS: Array<[string, number]> = [
  ["NA",     0.40],
  ["EMEA",   0.30],
  ["APAC",   0.20],
  ["LATAM",  0.10],
];

// Per-segment LTV distribution parameters. Strategic and Enterprise
// customers cluster around higher mean lifetime value with wider spread;
// Consumer is tight and low. Models real SaaS revenue stratification.
const LTV_BY_SEGMENT: Record<string, { min: number; max: number; skew: number }> = {
  Strategic:  { min: 50000, max: 500000, skew: 1.6 },
  Enterprise: { min: 10000, max: 150000, skew: 1.4 },
  SMB:        { min:   500, max:  20000, skew: 1.2 },
  Consumer:   { min:    50, max:   2000, skew: 1.0 },
};

// ---------------------------------------------------------------------------
// Synthetic helpers — all use the seeded `rng` so every call is reproducible.
// ---------------------------------------------------------------------------

// Generate a customer-display name conditioned on the segment. Strategic
// and Enterprise always get business names; Consumer always gets person
// names; SMB is a weighted mix. Business names alternate between
// curated single-word picks ("Officegoods") and compound
// prefix+suffix forms ("Acme Industries") so the resulting list has
// natural variety.
function generateCustomerName(segment: string): string {
  const businessProb = BUSINESS_NAME_PROBABILITY[segment] ?? 0;
  const useBusiness = rng() < businessProb;
  if (useBusiness) {
    // 60% single-word curated names, 40% compound for variety.
    if (rng() < 0.6) return pick(BUSINESS_SINGLE_NAMES);
    return `${pick(BUSINESS_PREFIXES)} ${pick(BUSINESS_SUFFIXES)}`;
  }
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}

function pickWeighted<T>(weights: Array<[T, number]>): T {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  for (const [v, w] of weights) {
    roll -= w;
    if (roll <= 0) return v;
  }
  return weights[weights.length - 1][0];
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

// Power-law sample over [min, max]. `skew` > 1 pushes mass toward the
// low end (long-tail to the high end); `skew` = 1 is uniform. Standard
// inverse-CDF transform for a Pareto-like distribution.
function randSkewed(min: number, max: number, skew: number): number {
  const u = rng();
  const t = Math.pow(u, skew);
  return Math.round((min + (max - min) * t) * 100) / 100;
}

// Date in [startYear, endYear], biased toward `endYear` to model
// onboarding curves where recent years dominate.
function randSkewedDate(startYear: number, endYear: number): string {
  const yearSpan = endYear - startYear;
  // Quadratic skew toward endYear: u^0.5 pulls mass toward 1.
  const yearOffset = Math.floor(Math.pow(rng(), 0.5) * (yearSpan + 1));
  const year = startYear + yearOffset;
  const month = randInt(1, 12);
  const day = randInt(1, 28);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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
  rows: (string | number | boolean)[][],
): void {
  const lines = [toCsvRow(headers), ...rows.map(toCsvRow)];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Customer rows — deterministic, mirrors the FE fixture's buildRows()
// ---------------------------------------------------------------------------

interface CustomerRow {
  customer_id: string;
  full_name: string;
  segment: string;
  region: string;
  is_active: boolean;
  lifetime_value: number;
  order_count: number;
  joined_at: string;
  // Denormalized FK to Employee. Wires the customerAccountManager link
  // (Customer →N:1→ Employee) to real data so traversal lands on a real
  // Employee row. Region-affinity weighted: an account manager covering
  // EMEA tends to manage EMEA customers, etc.
  account_manager_id: string;
}

function buildCustomerRows(employees: EmployeeRow[]): CustomerRow[] {
  const rows: CustomerRow[] = [];
  // Group employees by region so account-manager assignment respects
  // geographic affinity (matches how SaaS sales orgs actually slice).
  const employeesByRegion = new Map<string, EmployeeRow[]>();
  for (const emp of employees) {
    const list = employeesByRegion.get(emp.region) ?? [];
    list.push(emp);
    employeesByRegion.set(emp.region, list);
  }
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const id = String(10000 + i);
    const segment = pickWeighted(SEGMENT_WEIGHTS);
    // Name is segment-aware: B2B accounts get business names
    // ("Officegoods", "Acme Industries"), B2C accounts get person names
    // ("Olivia Anderson"). Matches real SaaS customer-table shape.
    const fullName = generateCustomerName(segment);
    const region = pickWeighted(REGION_WEIGHTS);
    const ltvParams = LTV_BY_SEGMENT[segment];
    const lifetimeValue = randSkewed(ltvParams.min, ltvParams.max, ltvParams.skew);
    // orderCount correlated with lifetimeValue: higher LTV → more orders
    // on average, with realistic noise. Standard ~1 order per ~$200 of
    // LTV with ±50% jitter so the correlation is visible but not
    // synthetic-looking. Capped at 500 to avoid pathological outliers.
    const orderBase = Math.floor(lifetimeValue / 200);
    const orderJitter = Math.floor((rng() - 0.5) * orderBase);
    const orderCount = Math.min(500, Math.max(0, orderBase + orderJitter));
    // Pick an account manager from the same region with 80% probability
    // (geographic affinity), else pick a random one. Falls back to any
    // employee if a region has no coverage (shouldn't happen at 25
    // employees over 4 regions, but defensive).
    const regional = employeesByRegion.get(region);
    const manager = regional && regional.length > 0 && rng() < 0.8
      ? regional[Math.floor(rng() * regional.length)]
      : employees[Math.floor(rng() * employees.length)];
    rows.push({
      customer_id: `CUST-${id}`,
      full_name: fullName,
      segment,
      region,
      // 85% active — realistic churn rate for healthy SaaS, leaves a
      // visible "inactive" slice in boolean charts without dominating.
      is_active: rng() < 0.85,
      lifetime_value: lifetimeValue,
      order_count: orderCount,
      // Onboarding skewed toward 2024-2026 to model a growing product.
      joined_at: randSkewedDate(2020, 2026),
      account_manager_id: manager.employee_id,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Linked-OT synthetic data — small realistic catalogs so link-type pivots
// land on populated tables rather than empty stubs.
// ---------------------------------------------------------------------------

interface OrderRow {
  order_id: string;
  placed_at: string;
  customer_id: string;
  // Denormalized customer fields — copied off the parent Customer row at
  // generation time so each Order self-describes who placed it. This is
  // the standard ETL-into-warehouse pattern: pivoting from a Customer to
  // their Orders shows "Officegoods" / "Brightline" / "Olivia Anderson"
  // directly on each row instead of opaque CUST-XXXXX ids, and pivoting
  // the other direction (browsing Orders globally) lets the user filter
  // / chart by customer segment without a join.
  customer_name: string;
  customer_segment: string;
  amount_usd: number;
}

function buildOrderRows(customers: CustomerRow[]): OrderRow[] {
  const rows: OrderRow[] = [];
  for (let i = 0; i < ORDER_COUNT; i++) {
    // Bias toward higher-LTV customers so order-per-customer counts
    // roughly track the synthetic correlation.
    const owner = customers[Math.floor(Math.pow(rng(), 0.7) * customers.length)];
    rows.push({
      order_id: `ORD-${String(100000 + i).padStart(7, "0")}`,
      placed_at: randSkewedDate(2023, 2026),
      customer_id: owner.customer_id,
      customer_name: owner.full_name,
      customer_segment: owner.segment,
      amount_usd: randSkewed(15, 5000, 1.8),
    });
  }
  return rows;
}

interface EmployeeRow {
  employee_id: string;
  full_name: string;
  region: string;
  // Aggregation column populated AFTER customer rows are generated.
  // Counts how many customers list this employee as their account
  // manager. Surfaces book-of-business size on the Employee tile in
  // the FE chart grid; lets sales-ops users sort/filter Employees by
  // customer load without a join.
  managed_customer_count: number;
}

function buildEmployeeRows(): EmployeeRow[] {
  const rows: EmployeeRow[] = [];
  for (let i = 0; i < EMPLOYEE_COUNT; i++) {
    rows.push({
      employee_id: `EMP-${String(2000 + i).padStart(4, "0")}`,
      full_name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
      region: pickWeighted(REGION_WEIGHTS),
      managed_customer_count: 0,  // backfilled in step below
    });
  }
  return rows;
}

// Post-process pass: walk the customer set and tally how many list each
// employee as their account manager. Done after both row sets exist so
// the count reflects real assignments, not a synthetic guess. Mutates
// the employee rows in place.
function backfillEmployeeCustomerCounts(
  employees: EmployeeRow[],
  customers: CustomerRow[],
): void {
  const tally = new Map<string, number>();
  for (const c of customers) {
    tally.set(c.account_manager_id, (tally.get(c.account_manager_id) ?? 0) + 1);
  }
  for (const emp of employees) {
    emp.managed_customer_count = tally.get(emp.employee_id) ?? 0;
  }
}

const PRODUCT_PREFIXES = [
  "Atlas", "Lumen", "Pulse", "Vertex", "Forge", "Nimbus", "Quanta",
  "Cipher", "Beacon", "Helix", "Spark", "Echo", "Cobalt", "Aurora",
];
const PRODUCT_SUFFIXES = [
  "Cloud", "Pro", "Enterprise", "Suite", "Studio", "Engine", "Platform",
  "Workspace", "Insights", "Analytics", "Connect", "Sync",
];

interface ProductRow {
  product_id: string;
  display_name: string;
  monthly_price_usd: number;
  // Synthetic subscriber count. Models the customerProducts N:N link
  // without materialising every (customer, product) pair (which would
  // bloat the seed by ~5,000 rows for a feature the FE doesn't yet
  // surface). Power-law shape — a handful of products dominate adoption,
  // most have a long tail of subscribers — matches real SaaS catalogs.
  subscriber_count: number;
}

function buildProductRows(): ProductRow[] {
  const rows: ProductRow[] = [];
  // Product IDs are content-derived so the same seed always produces
  // the same {id → name} mapping. Useful for cross-table joins in tests.
  for (let i = 0; i < PRODUCT_COUNT; i++) {
    const name = `${pick(PRODUCT_PREFIXES)} ${pick(PRODUCT_SUFFIXES)}`;
    rows.push({
      product_id: `PROD-${String(500 + i).padStart(4, "0")}`,
      display_name: name,
      monthly_price_usd: randSkewed(9, 999, 1.5),
      // Skew=2.2 produces a steep long tail: a few products at 200+
      // subscribers, most under 50. Caps at the customer pool size.
      subscriber_count: Math.min(
        CUSTOMER_COUNT,
        Math.floor(randSkewed(3, CUSTOMER_COUNT * 0.6, 2.2)),
      ),
    });
  }
  return rows;
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
  // Optional — when present, INSERTed verbatim as object_type_id; otherwise
  // Postgres' DEFAULT gen_random_uuid() picks a fresh id.
  pinnedId?: string;
  apiName: string;
  displayName: string;
  description: string;
  icon: string;
  iconColor: string;
  properties: PropertyDef[];
  primaryKey: string;
  titleProperty: string;
  // CSV registration is optional — every OT in this seed ships rows so
  // link-type pivots land on populated tables, but future stub OTs added
  // for schema-shape testing can omit it.
  csv?: {
    file: string;
    headers: string[];
    rows: (string | number | boolean)[][];
    columnMapping: Record<string, string>;
  };
}

const customerCsvHeaders = [
  "customer_id", "full_name", "segment", "region", "is_active",
  "lifetime_value", "order_count", "joined_at", "account_manager_id",
];

// Build synthetic rows in dependency order:
//   1. Employees first (no dependencies).
//   2. Customers next, referencing employees as account managers.
//   3. Orders, denormalising customer name + segment.
//   4. Products (independent).
//   5. Backfill: walk customers and update each employee's
//      managed_customer_count from the real assignment counts.
//
// Order is load-bearing because the PRNG state is shared across all
// builders — reordering changes every output. Don't shuffle without
// updating the seed string (`customer-demo-v2`) so existing test
// baselines re-baseline cleanly.
const employeeRows = buildEmployeeRows();
const customerRows = buildCustomerRows(employeeRows);
const orderRows = buildOrderRows(customerRows);
const productRows = buildProductRows();
backfillEmployeeCustomerCounts(employeeRows, customerRows);

const customerCsvRows = customerRows.map((r) => [
  r.customer_id, r.full_name, r.segment, r.region, r.is_active,
  r.lifetime_value, r.order_count, r.joined_at, r.account_manager_id,
]);
const orderCsvHeaders = [
  "order_id", "placed_at", "customer_id", "customer_name",
  "customer_segment", "amount_usd",
];
const orderCsvRows = orderRows.map((r) => [
  r.order_id, r.placed_at, r.customer_id, r.customer_name,
  r.customer_segment, r.amount_usd,
]);
const employeeCsvHeaders = [
  "employee_id", "full_name", "region", "managed_customer_count",
];
const employeeCsvRows = employeeRows.map((r) => [
  r.employee_id, r.full_name, r.region, r.managed_customer_count,
]);
const productCsvHeaders = [
  "product_id", "display_name", "monthly_price_usd", "subscriber_count",
];
const productCsvRows = productRows.map((r) => [
  r.product_id, r.display_name, r.monthly_price_usd, r.subscriber_count,
]);

const OBJECT_TYPES: ObjectTypeDef[] = [
  {
    pinnedId: CUSTOMER_OBJECT_TYPE_ID,
    apiName: "Customer",
    displayName: "Customer",
    description: "Customer of record. Promoted from the FE demo fixture.",
    icon: "person",
    iconColor: "#7c5cff",
    primaryKey: "customerId",
    titleProperty: "fullName",
    properties: [
      { apiName: "customerId",       displayName: "Customer ID",       baseType: "string",  isRequired: true  },
      { apiName: "fullName",         displayName: "Full Name",         baseType: "string",  isRequired: true  },
      { apiName: "segment",          displayName: "Segment",           baseType: "string",  isRequired: false },
      { apiName: "region",           displayName: "Region",            baseType: "string",  isRequired: false },
      { apiName: "isActive",         displayName: "Active",            baseType: "boolean", isRequired: false },
      { apiName: "lifetimeValue",    displayName: "Lifetime Value",    baseType: "double",  isRequired: false },
      { apiName: "orderCount",       displayName: "Order Count",       baseType: "integer", isRequired: false },
      { apiName: "joinedAt",         displayName: "Joined",            baseType: "date",    isRequired: false },
      { apiName: "accountManagerId", displayName: "Account Manager ID", baseType: "string",  isRequired: false },
    ],
    csv: {
      file: "customer-demo.csv",
      headers: customerCsvHeaders,
      rows: customerCsvRows,
      columnMapping: {
        customerId: "customer_id",
        fullName: "full_name",
        segment: "segment",
        region: "region",
        isActive: "is_active",
        lifetimeValue: "lifetime_value",
        orderCount: "order_count",
        joinedAt: "joined_at",
        accountManagerId: "account_manager_id",
      },
    },
  },
  // Linked OTs — each ships a populated CSV so link-type pivots land on a
  // real table rather than an empty stub. Properties model the synthetic
  // generators above so the FE chart-grid + ResultsRail render naturally.
  {
    apiName: "Order",
    displayName: "Order",
    description: "Order placed by a Customer. Customer name + segment are\ndenormalized onto each row so traversal from Customer\nlands on rows that self-describe (\"Officegoods · ORD-0100042\").",
    icon: "shopping-cart",
    iconColor: "#15b371",
    primaryKey: "orderId",
    // titleProperty = customerName so the FE result-row title and
    // LinkedObjectsPanel preview surface "Officegoods" / "Brightline" /
    // "Olivia Anderson" instead of opaque ORD-0100042. Order id is
    // still queryable as a regular property; only the row's display
    // label changes.
    titleProperty: "customerName",
    properties: [
      { apiName: "orderId",         displayName: "Order ID",        baseType: "string", isRequired: true  },
      { apiName: "placedAt",        displayName: "Placed At",       baseType: "date",   isRequired: false },
      { apiName: "customerId",      displayName: "Customer ID",     baseType: "string", isRequired: false },
      { apiName: "customerName",    displayName: "Customer",        baseType: "string", isRequired: false },
      { apiName: "customerSegment", displayName: "Customer Segment", baseType: "string", isRequired: false },
      { apiName: "amountUsd",       displayName: "Amount (USD)",    baseType: "double", isRequired: false },
    ],
    csv: {
      file: "order-demo.csv",
      headers: orderCsvHeaders,
      rows: orderCsvRows,
      columnMapping: {
        orderId: "order_id",
        placedAt: "placed_at",
        customerId: "customer_id",
        customerName: "customer_name",
        customerSegment: "customer_segment",
        amountUsd: "amount_usd",
      },
    },
  },
  {
    apiName: "Employee",
    displayName: "Employee",
    description: "Employee — used as a Customer's Account Manager. Each row\ncarries its actual book-of-business size (managedCustomerCount).",
    icon: "person",
    iconColor: "#1565c0",
    primaryKey: "employeeId",
    titleProperty: "fullName",
    properties: [
      { apiName: "employeeId",            displayName: "Employee ID",       baseType: "string",  isRequired: true  },
      { apiName: "fullName",              displayName: "Full Name",         baseType: "string",  isRequired: true  },
      { apiName: "region",                displayName: "Region",            baseType: "string",  isRequired: false },
      { apiName: "managedCustomerCount",  displayName: "Customers Managed", baseType: "integer", isRequired: false },
    ],
    csv: {
      file: "employee-demo.csv",
      headers: employeeCsvHeaders,
      rows: employeeCsvRows,
      columnMapping: {
        employeeId: "employee_id",
        fullName: "full_name",
        region: "region",
        managedCustomerCount: "managed_customer_count",
      },
    },
  },
  {
    apiName: "Product",
    displayName: "Product",
    description: "Product subscribed to by a Customer. Each row carries a\nsynthetic subscriber count modeling the customerProducts N:N\nlink without materialising every (customer, product) pair.",
    icon: "cube",
    iconColor: "#d9822b",
    primaryKey: "productId",
    titleProperty: "displayName",
    properties: [
      { apiName: "productId",       displayName: "Product ID",         baseType: "string",  isRequired: true  },
      { apiName: "displayName",     displayName: "Display Name",       baseType: "string",  isRequired: true  },
      { apiName: "monthlyPriceUsd", displayName: "Monthly Price (USD)", baseType: "double",  isRequired: false },
      { apiName: "subscriberCount", displayName: "Subscribers",         baseType: "integer", isRequired: false },
    ],
    csv: {
      file: "product-demo.csv",
      headers: productCsvHeaders,
      rows: productCsvRows,
      columnMapping: {
        productId: "product_id",
        displayName: "display_name",
        monthlyPriceUsd: "monthly_price_usd",
        subscriberCount: "subscriber_count",
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Link type definitions — mirror the FE fixture's DEMO_LINK_TYPES
// ---------------------------------------------------------------------------

interface LinkTypeDef {
  apiName: string;
  displayName: string;
  description: string;
  sourceObjectType: string;
  targetObjectType: string;
  cardinality: "ONE_TO_ONE" | "ONE_TO_MANY" | "MANY_TO_ONE" | "MANY_TO_MANY";
}

const LINK_TYPES: LinkTypeDef[] = [
  {
    apiName: "customerOrders",
    displayName: "Orders",
    description: "Orders placed by this customer",
    sourceObjectType: "Customer",
    targetObjectType: "Order",
    cardinality: "ONE_TO_MANY",
  },
  {
    apiName: "customerAccountManager",
    displayName: "Account Manager",
    description: "Assigned account manager",
    sourceObjectType: "Customer",
    targetObjectType: "Employee",
    cardinality: "MANY_TO_ONE",
  },
  {
    apiName: "customerProducts",
    displayName: "Products",
    description: "Products this customer subscribes to",
    sourceObjectType: "Customer",
    targetObjectType: "Product",
    cardinality: "MANY_TO_MANY",
  },
];

// ---------------------------------------------------------------------------
// Seed runner
// ---------------------------------------------------------------------------

async function customerSeed(): Promise<void> {
  console.log(`=== Customer Demo Seed ===\n`);

  // -----------------------------------------------------------------------
  // Step 0+1: "One Enterprise, One Ontology" — populate THE enterprise
  // ontology. Ensure it exists and reset its content for idempotency (this
  // also drops any prior holder of the pinned Customer object_type UUID, since
  // all content now lives under the one ontology). The ontology row + `main`
  // branch are preserved.
  // -----------------------------------------------------------------------
  const ontologyId: string = await resetEnterpriseOntologyForSeed();
  console.log(`Seeding "${ONTOLOGY_NAME}" content into enterprise ontology (${ontologyId})`);
  console.log(`Owner:    ${OWNER_EMAIL}`);

  // -----------------------------------------------------------------------
  // Step 2: Ensure data directory exists for any CSVs we register
  // -----------------------------------------------------------------------
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // -----------------------------------------------------------------------
  // Step 3: Object types + properties + (optional) CSV + datasource
  //
  // Track apiName → object_type_id so step 4 can resolve link_type's
  // source/target FK columns (which are uuid-typed) from the apiName-keyed
  // LINK_TYPES table at the top of this file. Building the map inline
  // avoids a second SELECT round-trip per link.
  // -----------------------------------------------------------------------
  const objectTypeIdByApiName = new Map<string, string>();
  for (const otDef of OBJECT_TYPES) {
    let objectTypeId: string;

    // Pinned-UUID path uses a 6-arg INSERT; default-UUID path uses 5-arg
    // and lets gen_random_uuid() pick the value. Two separate code paths
    // is clearer than ternary'ing a parameterized query.
    if (otDef.pinnedId) {
      const otRes = await query(
        `INSERT INTO object_type
           (object_type_id, ontology_id, api_name, display_name, description, icon, icon_color, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING object_type_id`,
        [
          otDef.pinnedId,
          ontologyId,
          otDef.apiName,
          otDef.displayName,
          otDef.description,
          otDef.icon,
          otDef.iconColor,
          OWNER_EMAIL,
        ],
      );
      objectTypeId = otRes.rows[0].object_type_id;
    } else {
      const otRes = await query(
        `INSERT INTO object_type
           (ontology_id, api_name, display_name, description, icon, icon_color, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING object_type_id`,
        [
          ontologyId,
          otDef.apiName,
          otDef.displayName,
          otDef.description,
          otDef.icon,
          otDef.iconColor,
          OWNER_EMAIL,
        ],
      );
      objectTypeId = otRes.rows[0].object_type_id;
    }
    objectTypeIdByApiName.set(otDef.apiName, objectTypeId);

    // Properties
    for (let i = 0; i < otDef.properties.length; i++) {
      const p = otDef.properties[i];
      await query(
        `INSERT INTO property
           (object_type_id, api_name, display_name, base_type, is_required, ordinal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          objectTypeId,
          p.apiName,
          p.displayName,
          p.baseType,
          p.isRequired,
          i,
        ],
      );
    }

    // Wire primary key + title property pointers
    const pk = await query(
      "SELECT property_id FROM property WHERE object_type_id = $1 AND api_name = $2",
      [objectTypeId, otDef.primaryKey],
    );
    if (pk.rows.length > 0) {
      await query(
        "UPDATE object_type SET primary_key_property_id = $1 WHERE object_type_id = $2",
        [pk.rows[0].property_id, objectTypeId],
      );
    }
    const title = await query(
      "SELECT property_id FROM property WHERE object_type_id = $1 AND api_name = $2",
      [objectTypeId, otDef.titleProperty],
    );
    if (title.rows.length > 0) {
      await query(
        "UPDATE object_type SET title_property_id = $1 WHERE object_type_id = $2",
        [title.rows[0].property_id, objectTypeId],
      );
    }

    // CSV + backing datasource (Customer only — Order / Employee / Product
    // are stubs whose only purpose is to satisfy link_type targets).
    if (otDef.csv) {
      const csvPath = path.join(DATA_DIR, otDef.csv.file);
      writeCsv(csvPath, otDef.csv.headers, otDef.csv.rows);
      // primary_key_column is NOT NULL on backing_datasource. Resolve via
      // columnMapping[primaryKey] to translate the OT's apiName-style
      // primary key (e.g. "customerId") into the CSV header it maps to
      // ("customer_id"). The mapping is required to be exhaustive for the
      // primary key, which it is — caught at construction time if missing.
      const pkCsvColumn = otDef.csv.columnMapping[otDef.primaryKey];
      if (!pkCsvColumn) {
        throw new Error(
          `Object type "${otDef.apiName}" csv.columnMapping is missing an entry for primaryKey "${otDef.primaryKey}". Update OBJECT_TYPES so the mapping covers the primary key.`,
        );
      }
      await query(
        `INSERT INTO backing_datasource
           (object_type_id, dataset_name, file_path, file_format,
            column_mapping, primary_key_column, row_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          objectTypeId,
          `${otDef.displayName} (Demo)`,
          csvPath,
          "csv",
          JSON.stringify(otDef.csv.columnMapping),
          pkCsvColumn,
          otDef.csv.rows.length,
        ],
      );
      console.log(
        `  Created: ${otDef.displayName} (${otDef.properties.length} props, ${otDef.csv.rows.length} rows)`,
      );
    } else {
      console.log(
        `  Created: ${otDef.displayName} (${otDef.properties.length} props, no rows — stub)`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Step 4: Link types
  // -----------------------------------------------------------------------
  console.log("\nCreating link types...");
  for (const lt of LINK_TYPES) {
    // link_type.source_object_type and target_object_type are uuid columns
    // (FKs into object_type.object_type_id). LINK_TYPES is authored with
    // apiNames for readability, so resolve via the map populated during
    // OT creation. A missing entry indicates a typo in LINK_TYPES (or a
    // forgotten OT) — fail loud so the seed surfaces the broken link.
    const sourceId = objectTypeIdByApiName.get(lt.sourceObjectType);
    const targetId = objectTypeIdByApiName.get(lt.targetObjectType);
    if (!sourceId || !targetId) {
      throw new Error(
        `Link "${lt.apiName}" references unknown object type(s): source="${lt.sourceObjectType}" → ${sourceId ?? "(missing)"}, target="${lt.targetObjectType}" → ${targetId ?? "(missing)"}. Add the OT to OBJECT_TYPES or fix the typo.`,
      );
    }
    await query(
      `INSERT INTO link_type
         (ontology_id, api_name, display_name, source_object_type, target_object_type, cardinality)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        ontologyId,
        lt.apiName,
        lt.displayName,
        sourceId,
        targetId,
        lt.cardinality,
      ],
    );
    console.log(
      `  Created link: ${lt.displayName} (${lt.sourceObjectType} -> ${lt.targetObjectType}, ${lt.cardinality})`,
    );
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log("Customer demo seed complete:");
  console.log(`  Ontology:     ${ONTOLOGY_NAME} (${ontologyId})`);
  console.log(`  Customer OT:  ${CUSTOMER_OBJECT_TYPE_ID} (pinned)`);
  console.log(`  Owner:        ${OWNER_EMAIL}`);
  console.log(`  Object Types: ${OBJECT_TYPES.length}`);
  console.log(`  Link Types:   ${LINK_TYPES.length}`);
  console.log("  Synthetic rows:");
  console.log(`    Customer:  ${customerCsvRows.length}`);
  console.log(`    Order:     ${orderCsvRows.length}`);
  console.log(`    Employee:  ${employeeCsvRows.length}`);
  console.log(`    Product:   ${productCsvRows.length}`);
  console.log("=".repeat(60));
  console.log(
    `\nVisit: http://localhost:3001/object-explorer/object-type/${CUSTOMER_OBJECT_TYPE_ID}`,
  );
}

// ---------------------------------------------------------------------------
// Entry point — releases the pool client on exit so the process terminates
// cleanly even when run via `tsx` (which keeps the event loop alive while
// pg connections are open).
// ---------------------------------------------------------------------------

customerSeed()
  .then(async () => {
    // Best-effort drain — release any idle clients before exit so
    // tsx terminates immediately. Non-fatal if it errors.
    try {
      const c = await getClient();
      c.release();
    } catch {
      /* ignore */
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error("Customer demo seed failed:", err);
    process.exit(1);
  });
