export type JsonRecord = Record<string, unknown>;

const number = (value: unknown): number => Number(value);
const text = (value: unknown): string => String(value ?? "");

export const rwandaFunctionsV2 = {
  calculateCreditRiskV2(input: JsonRecord) {
    const score = input.score == null ? (text(input.riskTier) === "HIGH" ? 92 : 50) : number(input.score);
    const band = score >= 90 ? "HIGH" : score >= 70 ? "MEDIUM" : "LOW";
    return { score, band, explanation: score >= 90 ? "High synthetic risk" : score >= 70 ? "Manual review threshold" : "Within policy" };
  },
  validateCreditLimitV2(input: JsonRecord) {
    const requestedLimit = number(input.requestedLimit);
    const policyCeiling = number(input.policyCeiling ?? 1_000_000);
    const failures: string[] = [];
    if (!Number.isFinite(requestedLimit)) failures.push("requestedLimit is not numeric");
    else if (requestedLimit <= 0) failures.push("requestedLimit must be positive");
    if (Number.isFinite(requestedLimit) && requestedLimit > policyCeiling) failures.push(`requestedLimit exceeds policy ceiling ${policyCeiling}`);
    return { allowed: failures.length === 0, failures };
  },
  detectAffordabilityExceptionV2(input: JsonRecord) {
    const monthlyIncome = number(input.monthlyIncome ?? input.balance);
    const monthlyCommitment = number(input.monthlyCommitment ?? input.requestedLimit);
    const ratio = monthlyIncome > 0 ? monthlyCommitment / monthlyIncome : null;
    const flags = ratio === null ? ["INCOME_NOT_POSITIVE"] : ratio > number(input.maxRatio ?? 0.4) ? ["AFFORDABILITY_RATIO_HIGH"] : [];
    return { ratio, flags, exception: flags.length > 0 };
  },
  validateRraTaxClearanceV2(input: JsonRecord) {
    const failures: string[] = [];
    if (!text(input.clearanceId)) failures.push("clearanceId missing");
    if (text(input.status) !== "VALID") failures.push(`clearance status is ${text(input.status)}`);
    if (input.expiresAt && Date.parse(text(input.expiresAt)) <= Date.parse(text(input.now))) failures.push("clearance expired");
    if (input.citizenId && input.clearanceCitizenId && input.citizenId !== input.clearanceCitizenId) failures.push("clearance citizen mismatch");
    return { valid: failures.length === 0, failures };
  },
  verifyNationalIdMatchV2(input: JsonRecord) {
    return { match: text(input.nationalId) === text(input.recordNationalId), nationalId: input.nationalId };
  },
  detectLandTitleConflictV2(input: JsonRecord) {
    const conflict = text(input.titleStatus) !== "CLEAR" || text(input.exceptionType) === "TITLE_CONFLICT";
    return { conflict, evidence: conflict ? `titleStatus=${text(input.titleStatus)} exceptionType=${text(input.exceptionType)}` : "" };
  },
  classifyIso8583FailureV2(input: JsonRecord) {
    const responseCode = text(input.responseCode);
    const failureClass = responseCode === "00" ? "NONE" : responseCode === "91" ? "ISSUER_UNAVAILABLE" : responseCode === "68" ? "TIMEOUT" : responseCode === "51" ? "INSUFFICIENT_FUNDS" : "UNKNOWN";
    return { responseCode, failureClass };
  },
  isReconciliationEligibleV2(input: JsonRecord) {
    const status = text(input.status);
    const label = text(input.reconciliationEligibility);
    const reason = status === "SETTLED" ? "SETTLED" : label === "DUPLICATE" ? "DUPLICATE" : status !== "FAILED" ? "NOT_FAILED" : "ELIGIBLE";
    return { eligible: reason === "ELIGIBLE", reason };
  },
  calculateTransactionSlaV2(input: JsonRecord) {
    const ageMinutes = Math.floor((Date.parse(text(input.now)) - Date.parse(text(input.createdAt))) / 60_000);
    const breachMinutes = number(input.breachMinutes ?? 240);
    return { ageMinutes, severity: ageMinutes > breachMinutes ? "BREACH" : ageMinutes > breachMinutes * 0.75 ? "AT_RISK" : "ON_TRACK" };
  },
  buildBulkReconciliationResultV2(input: JsonRecord) {
    const transactions = Array.isArray(input.transactions) ? input.transactions as JsonRecord[] : [];
    const perRecordResults = transactions.map((transaction) => ({ transactionId: text(transaction.transactionId), ...rwandaFunctionsV2.isReconciliationEligibleV2(transaction) }));
    return { perRecordResults, outcome: perRecordResults.every((row) => row.eligible) ? "SUCCESS" : perRecordResults.some((row) => row.eligible) ? "PARTIAL_FAILURE" : "FAILED" };
  },
  calculateCarrierHealthV2(input: JsonRecord) {
    const p95Latency = number(input.p95Latency);
    const errorRate = number(input.errorRate ?? 0);
    const sampleAt = Date.parse(text(input.sampleAt ?? input.now));
    const now = Date.parse(text(input.now));
    const plausible = Number.isFinite(p95Latency) && p95Latency >= 0 && errorRate >= 0 && errorRate <= 1 && sampleAt <= now;
    if (!plausible) return { health: "UNKNOWN", reasons: ["implausible telemetry"], plausible: false };
    const degraded = p95Latency > number(input.threshold ?? 1_000) || errorRate > number(input.maxErrorRate ?? 0.05);
    return { health: degraded ? "DEGRADED" : "HEALTHY", reasons: degraded ? ["latency or error-rate threshold breached"] : [], plausible: true };
  },
  recommendFailoverRouteV2(input: JsonRecord) {
    const routes = Array.isArray(input.routes) ? input.routes as JsonRecord[] : [];
    const recommendations = routes.filter((route) => text(route.state) === "HEALTHY" && number(route.capacity) > number(route.currentLoad ?? 0)).sort((a, b) => number(b.capacity) - number(a.capacity)).map((route) => text(route.routeId));
    return { recommendations };
  },
  validateRouteSwitchV2(input: JsonRecord) {
    const route = (input.route ?? {}) as JsonRecord;
    const target = (input.target ?? {}) as JsonRecord;
    const policy = (input.policy ?? {}) as JsonRecord;
    if (policy.killSwitch === false || text(policy.killSwitch) === "false") return { allowed: false, reason: "kill switch engaged" };
    if (text(route.state) !== "UNHEALTHY") return { allowed: false, reason: "route is not UNHEALTHY" };
    if (text(target.state) !== "HEALTHY") return { allowed: false, reason: "target route unavailable" };
    if (number(target.capacity) <= number(target.currentLoad ?? 0)) return { allowed: false, reason: "target route over capacity" };
    return { allowed: true, reason: "ok" };
  },
} as const;

export type RwandaFunctionName = keyof typeof rwandaFunctionsV2;

/** Source persisted in the legacy inline Functions registry. */
export function inlineSource(name: RwandaFunctionName): string {
  const methods = Object.values(rwandaFunctionsV2)
    .map((fn) => fn.toString())
    .join(",\n");
  return `export default (input) => {
    const number = (value) => Number(value);
    const text = (value) => String(value ?? "");
    const rwandaFunctionsV2 = { ${methods} };
    return rwandaFunctionsV2[${JSON.stringify(name)}](input);
  }`;
}
