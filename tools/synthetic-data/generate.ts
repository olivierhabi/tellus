#!/usr/bin/env tsx
/**
 * Deterministic Rwanda operational-data-platform QA fixture generator.
 *
 * Usage:
 *   npx tsx tools/synthetic-data/generate.ts --tier functional --seed 4242 --out /tmp/tellus-rwanda-qa
 *   npx tsx tools/synthetic-data/generate.ts --tier scale --seed 4242 --out /tmp/tellus-rwanda-scale
 *
 * The output is intentionally CSV-only plus a manifest. It is suitable for
 * the normal pipeline ingestion path; it never calls an API or writes
 * ontology objects directly. Re-running with the same arguments produces
 * byte-identical files and manifest checksums.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { rwandaFunctionsV2, type RwandaFunctionName } from "../../src/qa/rwanda/functionsV2";

type Tier = "functional" | "scale";
type Args = { tier: Tier; seed: number; out: string };

const GENERATOR_VERSION = "1.0.0";
const RUN_PREFIX = "QA-RW";

function parseArgs(argv: string[]): Args {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const tier = value("--tier") ?? "functional";
  if (tier !== "functional" && tier !== "scale") {
    throw new Error("--tier must be functional or scale");
  }
  const rawSeed = value("--seed") ?? "4242";
  const seed = Number(rawSeed);
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be an integer");
  const out = value("--out");
  if (!out) throw new Error("--out is required");
  return { tier, seed, out: resolve(out) };
}

/** Stable, dependency-free PRNG so Node/runtime upgrades do not alter rows. */
class Random {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  choose<T>(values: readonly T[]): T {
    return values[this.int(0, values.length - 1)]!;
  }
}

function csv(value: unknown): string {
  const raw = String(value ?? "");
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

async function writeCsv(
  root: string,
  relative: string,
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): Promise<{ file: string; rows: number; sha256: string }> {
  const body = `${headers.join(",")}\n${rows.map((row) => row.map(csv).join(",")).join("\n")}\n`;
  const target = join(root, relative);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, body, "utf8");
  return {
    file: relative,
    rows: rows.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function isLuhnValid(value: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let position = value.length - 1; position >= 0; position -= 1) {
    let digit = Number(value[position]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function syntheticNationalId(index: number): string {
  // Reserved test namespace. The final digit is a deterministic check digit,
  // not a government identifier and does not map to a real person.
  const body = `999${String(index).padStart(12, "0")}`;
  let check = [...body].reduce((sum, digit, position) => sum + Number(digit) * (position + 3), 0) % 10;
  // IDs are deliberately valid only for the reserved synthetic scheme, not
  // for Luhn. That keeps PCI scans mechanically unambiguous.
  while (isLuhnValid(`${body}${check}`)) check = (check + 1) % 10;
  return `${body}${check}`;
}

function luhn(numberWithoutCheck: string): string {
  let sum = 0;
  let doubleDigit = true;
  for (let index = numberWithoutCheck.length - 1; index >= 0; index -= 1) {
    let digit = Number(numberWithoutCheck[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return `${numberWithoutCheck}${(10 - (sum % 10)) % 10}`;
}

function token(value: string): string {
  return `tok_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

const now = "2026-08-10T08:00:00.000Z";
const iso = (offsetMinutes: number) => new Date(Date.parse(now) - offsetMinutes * 60_000).toISOString();

export const FUNCTION_FIXTURE_INPUTS: Record<RwandaFunctionName, Record<string, unknown>> = {
  calculateCreditRiskV2: { score: 92 },
  validateCreditLimitV2: { requestedLimit: 500_000, policyCeiling: 1_000_000 },
  detectAffordabilityExceptionV2: { monthlyIncome: 100_000, monthlyCommitment: 50_000, maxRatio: 0.4 },
  validateRraTaxClearanceV2: { clearanceId: "QA-RW-IR-T-0000001", status: "VALID", expiresAt: "2026-09-01T00:00:00Z", syncedAt: "2026-08-10T06:00:00Z", freshnessSlaMinutes: 360, now },
  verifyNationalIdMatchV2: { nationalId: "9990000000000012", recordNationalId: "9990000000000012" },
  detectLandTitleConflictV2: { titleStatus: "CONFLICT", exceptionType: "TITLE_CONFLICT" },
  classifyIso8583FailureV2: { responseCode: "91" },
  isReconciliationEligibleV2: { status: "FAILED", reconciliationEligibility: "ELIGIBLE" },
  calculateTransactionSlaV2: { createdAt: "2026-08-10T03:00:00Z", now, breachMinutes: 240 },
  buildBulkReconciliationResultV2: { transactions: [{ transactionId: "QA-RW-RS-TX-00000001", status: "FAILED", reconciliationEligibility: "ELIGIBLE" }] },
  calculateCarrierHealthV2: { p95Latency: 1_200, errorRate: 0.01, sampleAt: "2026-08-10T07:59:00Z", now, threshold: 1_000 },
  recommendFailoverRouteV2: { routes: [{ routeId: "fallback-a", state: "HEALTHY", capacity: 100, currentLoad: 10 }, { routeId: "fallback-b", state: "HEALTHY", capacity: 50, currentLoad: 10 }] },
  validateRouteSwitchV2: { route: { state: "UNHEALTHY" }, target: { state: "HEALTHY", capacity: 100, currentLoad: 10 }, policy: { killSwitch: true } },
};

export function expectedFunctionRows(): unknown[][] {
  return (Object.keys(rwandaFunctionsV2) as RwandaFunctionName[]).map((functionName) => {
    const input = FUNCTION_FIXTURE_INPUTS[functionName];
    return [functionName, JSON.stringify(input), JSON.stringify(rwandaFunctionsV2[functionName](input as never))];
  });
}

async function functionExpectedOutputs(root: string) {
  return Promise.all(
    ["a-bk", "b-irembo", "c-rswitch", "d-pindo"].map((scenario) =>
      writeCsv(root, `${scenario}/expected_outputs.csv`, ["functionName", "inputJson", "expectedOutputJson"], expectedFunctionRows()),
    ),
  );
}

async function generateBankOfKigali(root: string, random: Random, scale: number) {
  const customers: unknown[][] = [];
  const accounts: unknown[][] = [];
  const applications: unknown[][] = [];
  const assessments: unknown[][] = [];
  const collateral: unknown[][] = [];
  const decisions: unknown[][] = [];
  const count = scale;
  for (let index = 1; index <= count; index += 1) {
    const id = `${RUN_PREFIX}-BK-C-${String(index).padStart(7, "0")}`;
    const highRisk = index % 10 === 0;
    const canary = index === 1 ? "CANARY-CREDITRISK-000123" : "";
    customers.push([id, syntheticNationalId(index), `Synthetic Customer ${index}`, index % 3 === 0 ? "SME" : "RETAIL", highRisk ? canary || "HIGH" : "STANDARD"]);
    accounts.push([`${RUN_PREFIX}-BK-A-${String(index).padStart(7, "0")}`, id, (10_000 + random.int(0, 900_000)).toFixed(2), index % 2 ? "CURRENT" : "SAVINGS", index % 2 ? "KIGALI" : "HUYE", "ACTIVE"]);
    const app = `${RUN_PREFIX}-BK-L-${String(index).padStart(7, "0")}`;
    applications.push([app, id, (50_000 + random.int(0, 950_000)).toFixed(2), index % 7 === 0 ? "UNDER_REVIEW" : "SUBMITTED", iso(index * 30), `analyst-${index % 12}`, highRisk ? "BREACH" : "ON_TRACK", 1]);
    assessments.push([`${RUN_PREFIX}-BK-R-${String(index).padStart(7, "0")}`, app, highRisk ? 92 : random.int(15, 74), highRisk ? "HIGH" : "LOW", iso(index * 25), "credit-risk-v2.1.0"]);
    collateral.push([`${RUN_PREFIX}-BK-COL-${String(index).padStart(7, "0")}`, app, "PROPERTY", (100_000 + random.int(0, 1_500_000)).toFixed(2), "2026-07-01"]);
    if (index % 7 === 0) decisions.push([`${RUN_PREFIX}-BK-D-${String(index).padStart(7, "0")}`, app, "PENDING", "", "", ""]);
  }
  return Promise.all([
    writeCsv(root, "a-bk/customers.csv", ["customerId", "nationalId", "name", "segment", "riskClass"], customers),
    writeCsv(root, "a-bk/customer_accounts.csv", ["accountId", "customerId", "balance", "product", "branch", "status"], accounts),
    writeCsv(root, "a-bk/loan_applications.csv", ["applicationId", "customerId", "requestedLimit", "status", "submittedAt", "assignedAnalyst", "sla", "versionToken"], applications),
    writeCsv(root, "a-bk/risk_assessments.csv", ["assessmentId", "applicationId", "score", "band", "assessedAt", "modelVersion"], assessments),
    writeCsv(root, "a-bk/collateral.csv", ["collateralId", "applicationId", "type", "value", "valuationDate"], collateral),
    writeCsv(root, "a-bk/credit_decisions.csv", ["decisionId", "applicationId", "decision", "approvedLimit", "rationale", "approver"], decisions),
    writeCsv(root, "a-bk/scenario_expected_outputs.csv", ["applicationId", "expectedScore", "expectedBand", "explanation"], applications.slice(0, Math.min(100, applications.length)).map((row, i) => [row[0], assessments[i]![2], assessments[i]![3], Number(assessments[i]![2]) >= 90 ? "High synthetic risk" : "Within policy"])),
  ]);
}

async function generateIrembo(root: string, random: Random, count: number) {
  const citizens: unknown[][] = [];
  const clearances: unknown[][] = [];
  const parcels: unknown[][] = [];
  const cases: unknown[][] = [];
  const verifications: unknown[][] = [];
  for (let index = 1; index <= count; index += 1) {
    const citizenId = `${RUN_PREFIX}-IR-C-${String(index).padStart(7, "0")}`;
    const clearanceId = `${RUN_PREFIX}-IR-T-${String(index).padStart(7, "0")}`;
    const stale = index % 8 === 0;
    citizens.push([citizenId, syntheticNationalId(100_000 + index), `Synthetic Citizen ${index}`, "ACTIVE", "NIDA", `nida-${index}`, "nida-v1"]);
    // Expiry and source freshness are separate failure dimensions. Keeping
    // them independent lets the override prove that a fresh re-sync resolves
    // staleness without silently bypassing an expired clearance.
    const expiredClearance = index % 10 === 0;
    clearances.push([clearanceId, citizenId, expiredClearance ? "EXPIRED" : "VALID", `TAX-${index}`, "RRA", `rra-${index}`, expiredClearance ? iso(60 * 24 * 90) : iso(60 * 12), "rra-sync-v2"]);
    parcels.push([`${RUN_PREFIX}-IR-P-${String(index).padStart(7, "0")}`, index % 2 ? "KIGALI" : "EASTERN", (100 + random.int(0, 900)).toFixed(1), "CLEAR", "LAND_AUTHORITY", `parcel-${index}`, "land-v3"]);
    // Keep the source-snapshot timestamp independent from row position so the
    // freshness gate is deterministic: every normal row is inside the six-hour
    // SLA and every deliberately stale row is outside it.
    const sourceAgeMinutes = stale ? 480 + (index % 6) * 15 : (index % 6) * 45;
    cases.push([`${RUN_PREFIX}-IR-LTC-${String(index).padStart(7, "0")}`, citizenId, clearanceId, `${RUN_PREFIX}-IR-P-${String(index).padStart(7, "0")}`, stale ? "APPROVAL_PENDING" : "TITLE_REVIEWED", iso(sourceAgeMinutes), index % 11 === 0 ? "TITLE_CONFLICT" : "", stale ? "STALE_SOURCE" : "ON_TRACK", 1]);
    verifications.push([`${RUN_PREFIX}-IR-V-${String(index).padStart(7, "0")}`, `${RUN_PREFIX}-IR-LTC-${String(index).padStart(7, "0")}`, stale ? "STALE" : "VERIFIED", iso(index * 15), "RRA", `verify-${index}`, "source-event-v2"]);
  }
  return Promise.all([
    writeCsv(root, "b-irembo/citizens.csv", ["citizenId", "nationalId", "name", "status", "sourceSystem", "sourceIdentifier", "pipelineVersion"], citizens),
    writeCsv(root, "b-irembo/tax_clearances.csv", ["clearanceId", "citizenId", "status", "taxpayerId", "sourceSystem", "sourceIdentifier", "ingestedAt", "pipelineVersion"], clearances),
    writeCsv(root, "b-irembo/land_parcels.csv", ["parcelId", "district", "size", "titleStatus", "sourceSystem", "sourceIdentifier", "pipelineVersion"], parcels),
    writeCsv(root, "b-irembo/land_transfer_cases.csv", ["caseId", "citizenId", "clearanceId", "parcelId", "status", "submittedAt", "exceptionType", "sla", "versionToken"], cases),
    writeCsv(root, "b-irembo/agency_verifications.csv", ["verificationId", "caseId", "result", "verifiedAt", "agency", "requestId", "pipelineVersion"], verifications),
  ]);
}

async function generateRSwitch(root: string, random: Random, count: number) {
  const transactions: unknown[][] = [];
  const messages: unknown[][] = [];
  const disputes: unknown[][] = [];
  const batches: unknown[][] = [];
  const rawIso8583: unknown[][] = [];
  for (let index = 1; index <= count; index += 1) {
    const transactionId = `${RUN_PREFIX}-RS-TX-${String(index).padStart(8, "0")}`;
    const pan = luhn(`411111${String(index).padStart(9, "0")}`);
    const settled = index % 11 === 0;
    const duplicate = index % 13 === 0;
    transactions.push([transactionId, (1_000 + random.int(0, 9_999_999)).toFixed(2), "RWF", settled ? "00" : "91", settled ? "SETTLED" : "FAILED", iso(index % 4_000), index % 2 ? "BK" : "EQTY", index % 9 === 0 ? "HIGH" : "NORMAL", index % 10 === 0 ? "BREACH" : "ON_TRACK", duplicate ? "DUPLICATE" : "ELIGIBLE", 1]);
    messages.push([`${RUN_PREFIX}-RS-MSG-${String(index).padStart(8, "0")}`, transactionId, "0210", token(pan), `${pan.slice(0, 6)}${"*".repeat(6)}${pan.slice(-4)}`, iso(index % 4_000)]);
    // Deliberately raw, synthetic PAN fixture for the ingestion boundary
    // only. It must be tokenized before any ontology/index/export/log output.
    rawIso8583.push([transactionId, pan, "0210", iso(index % 4_000)]);
    if (index % 17 === 0) disputes.push([`${RUN_PREFIX}-RS-D-${String(index).padStart(8, "0")}`, transactionId, "TIMEOUT", "OPEN", `owner-${index % 6}`, "BREACH"]);
    if (index % 100 === 1) batches.push([`${RUN_PREFIX}-RS-B-${String(index).padStart(7, "0")}`, index % 2 ? "BK" : "EQTY", (1_000_000 + random.int(0, 100_000_000)).toFixed(2), "OPEN", "2026-08-10T18:00:00.000Z"]);
  }
  return Promise.all([
    writeCsv(root, "c-rswitch/payment_transactions.csv", ["transactionId", "amount", "currency", "responseCode", "status", "createdAt", "bank", "riskTier", "slaSeverity", "reconciliationEligibility", "versionToken"], transactions),
    writeCsv(root, "c-rswitch/message_envelopes.csv", ["messageId", "transactionId", "mti", "panToken", "maskedPan", "receivedAt"], messages),
    writeCsv(root, "c-rswitch/dispute_cases.csv", ["disputeId", "transactionId", "reason", "status", "owner", "sla"], disputes),
    writeCsv(root, "c-rswitch/settlement_batches.csv", ["batchId", "bank", "value", "status", "cutoff"], batches),
    writeCsv(root, "c-rswitch/ingestion-inputs/raw_iso8583.csv", ["transactionId", "field2Pan", "mti", "receivedAt"], rawIso8583),
    writeCsv(root, "c-rswitch/scenario_expected_outputs.csv", ["transactionId", "expectedEligibility", "expectedReason"], transactions.slice(0, Math.min(500, transactions.length)).map((row) => [row[0], row[9] === "ELIGIBLE" ? "true" : "false", row[9]])),
  ]);
}

async function generatePindo(root: string, random: Random, routeCount: number, sampleCount: number) {
  const routes: unknown[][] = [];
  const samples: unknown[][] = [];
  const policies: unknown[][] = [];
  for (let index = 1; index <= routeCount; index += 1) {
    const unhealthy = index % 10 === 0;
    const routeId = `${RUN_PREFIX}-PI-R-${String(index).padStart(7, "0")}`;
    routes.push([routeId, index % 2 ? "MTN" : "AIRTEL", index % 3 ? "KIGALI" : "EASTERN", unhealthy ? "UNHEALTHY" : "HEALTHY", 10_000, unhealthy ? 5_000 : 220, unhealthy ? 0.25 : 0.002, 1]);
    policies.push([`${RUN_PREFIX}-PI-P-${String(index).padStart(7, "0")}`, routeId, 1_000, 300, 600, 1, "fallback-healthy", "true"]);
  }
  for (let index = 1; index <= sampleCount; index += 1) {
    const routeIndex = ((index - 1) % routeCount) + 1;
    const unhealthy = routeIndex % 10 === 0;
    samples.push([`${RUN_PREFIX}-PI-S-${String(index).padStart(8, "0")}`, `${RUN_PREFIX}-PI-R-${String(routeIndex).padStart(7, "0")}`, iso(index), unhealthy ? 4_000 + random.int(0, 2_000) : 150 + random.int(0, 120), unhealthy ? "TIMEOUT" : ""]);
  }
  return Promise.all([
    writeCsv(root, "d-pindo/carrier_routes.csv", ["routeId", "carrier", "region", "state", "capacity", "p95Latency", "errorRate", "versionToken"], routes),
    writeCsv(root, "d-pindo/latency_samples.csv", ["sampleId", "routeId", "measuredAt", "latencyMs", "errorCode"], samples),
    writeCsv(root, "d-pindo/failover_policies.csv", ["policyId", "routeId", "threshold", "breachHoldDown", "recoveryHoldDown", "maxFailoversPerWindow", "targetConstraints", "killSwitch"], policies),
    writeCsv(root, "d-pindo/scenario_expected_outputs.csv", ["routeId", "expectedHealth", "expectedRecommendation"], routes.slice(0, Math.min(100, routes.length)).map((row) => [row[0], row[3] === "UNHEALTHY" ? "DEGRADED" : "HEALTHY", "fallback-healthy"])),
  ]);
}

async function dirtyFixtures(root: string) {
  return Promise.all([
    writeCsv(root, "a-bk/dirty_loan_applications.csv", ["applicationId", "customerId", "requestedLimit", "status"], [["", "missing-key", "100", "SUBMITTED"], ["QA-RW-BK-L-0000001", "missing-customer", "not-a-number", "SUBMITTED"], ["QA-RW-BK-L-0000001", "QA-RW-BK-C-0000001", "5000", "BAD_STATUS"]]),
    writeCsv(root, "b-irembo/dirty_tax_clearances.csv", ["clearanceId", "citizenId", "status", "ingestedAt"], [["", "QA-RW-IR-C-0000001", "VALID", "2026-14-99"], ["QA-RW-IR-T-0000001", "", "VALID", ""], ["QA-RW-IR-T-0000001", "QA-RW-IR-C-0000001", "INVALID_STATUS", now]]),
    writeCsv(root, "c-rswitch/dirty_payment_transactions.csv", ["transactionId", "amount", "currency", "createdAt"], [["", "10", "RWF", now], ["QA-RW-RS-TX-00000001", "-1", "RWF", "not-a-date"], ["QA-RW-RS-TX-00000001", "1e999", "RWF", now]]),
    writeCsv(root, "d-pindo/dirty_latency_samples.csv", ["sampleId", "routeId", "measuredAt", "latencyMs"], [["", "QA-RW-PI-R-0000001", now, "-2"], ["QA-RW-PI-S-00000001", "", "future", "20"], ["QA-RW-PI-S-00000001", "QA-RW-PI-R-0000001", now, "not-a-number"]]),
  ]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Start from an empty run directory so the manifest proves exactly what was
  // generated. The target is explicit and supplied by the caller.
  await rm(args.out, { recursive: true, force: true });
  await mkdir(args.out, { recursive: true });
  const random = new Random(args.seed);
  const sizes = args.tier === "functional"
    ? { bk: 100, ir: 50, rs: 500, routes: 100, samples: 10_000 }
    : { bk: 250_000, ir: 100_000, rs: 5_000_000, routes: 100_000, samples: 5_000_000 };
  const outputs = (await Promise.all([
    generateBankOfKigali(args.out, random, sizes.bk),
    generateIrembo(args.out, random, sizes.ir),
    generateRSwitch(args.out, random, sizes.rs),
    generatePindo(args.out, random, sizes.routes, sizes.samples),
    dirtyFixtures(args.out),
    functionExpectedOutputs(args.out),
  ])).flat();
  const manifest = {
    generatorVersion: GENERATOR_VERSION,
    seed: args.seed,
    tier: args.tier,
    generatedAt: "deterministic:2026-08-10T08:00:00.000Z",
    namespacePrefix: RUN_PREFIX,
    files: outputs.sort((a, b) => a.file.localeCompare(b.file)),
  };
  await writeFile(join(args.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const verification = createHash("sha256").update(await readFile(join(args.out, "manifest.json"))).digest("hex");
  process.stdout.write(`${JSON.stringify({ output: args.out, files: outputs.length, manifestSha256: verification })}\n`);
}

if (require.main === module) void main();
