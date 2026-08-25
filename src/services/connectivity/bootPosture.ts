// ---------------------------------------------------------------------------
// Production posture assertion for connectivity.
//
// The reserved-range egress guard is the SSRF boundary: it stops an
// authenticated principal from aiming a connection probe at loopback,
// RFC-1918 space, or the cloud metadata endpoint (169.254.169.254). Local
// development legitimately needs to reach a loopback Postgres, so the guard has
// an opt-out — CONNECTIVITY_EGRESS_ALLOW_RESERVED — which a dev `.env` sets to
// `localhost,127.0.0.1/8,::1`.
//
// That is exactly the kind of variable that leaks from a dev `.env` into a
// production ConfigMap and disables the boundary with no visible symptom: every
// probe still succeeds, and nothing logs the fact that SSRF protection is off.
// Boot-time fail-closed converts a silent security regression into a loud,
// obvious startup failure.
//
// Follows the fail-closed pattern established in boot/cacheAndRateLimit.ts:
// refuse to start rather than degrade silently, with an explicit escape hatch
// for the operator who really means it.
// ---------------------------------------------------------------------------

export interface PostureIssue {
  severity: "fatal" | "warn";
  message: string;
}

/**
 * Pure posture evaluation — returns the issues rather than throwing, so it is
 * directly unit-testable against a synthetic env.
 */
export function evaluateConnectivityPosture(
  env: Record<string, string | undefined>,
): PostureIssue[] {
  const issues: PostureIssue[] = [];
  const isProduction = env.NODE_ENV === "production";
  const allowReserved = (env.CONNECTIVITY_EGRESS_ALLOW_RESERVED ?? "").trim();

  if (isProduction && allowReserved !== "") {
    if (env.CONNECTIVITY_ALLOW_RESERVED_IN_PRODUCTION === "1") {
      issues.push({
        severity: "warn",
        message:
          "connectivity: reserved-range egress guard is DISABLED in production " +
          `for [${allowReserved}] via CONNECTIVITY_ALLOW_RESERVED_IN_PRODUCTION=1. ` +
          "The connector can be aimed at internal address space (SSRF). This " +
          "override should be temporary and scoped to specific CIDRs.",
      });
    } else {
      issues.push({
        severity: "fatal",
        message:
          "Production start refused: CONNECTIVITY_EGRESS_ALLOW_RESERVED is set " +
          `to [${allowReserved}], which disables the reserved-range SSRF guard ` +
          "for those targets. This is a development-only setting — a dev .env " +
          "value has most likely leaked into the production config. Unset it, " +
          "or, if reaching a reserved-range database really is intended (e.g. a " +
          "VPC-internal host), narrow it to the exact CIDR and opt in " +
          "explicitly with CONNECTIVITY_ALLOW_RESERVED_IN_PRODUCTION=1.",
      });
    }
  }

  // Leader election guards the prober and rotation worker. Bypassing it is
  // correct for a single-replica deployment and wrong for any other, and the
  // failure mode (duplicate rewraps burning credential versions) is silent.
  if (isProduction && env.TELLUS_CONNECTIVITY_WORKER_LEASE === "0") {
    issues.push({
      severity: "warn",
      message:
        "connectivity: background-worker leader election is DISABLED " +
        "(TELLUS_CONNECTIVITY_WORKER_LEASE=0). Safe ONLY at one replica; with " +
        "more, every replica probes every source and rotates every credential " +
        "each tick.",
    });
  }

  return issues;
}

/**
 * Assert the production posture. Throws on any fatal issue (refusing boot);
 * logs warnings otherwise. Call during startup, before serving traffic.
 */
export function assertConnectivityPosture(
  env: Record<string, string | undefined> = process.env,
): void {
  const issues = evaluateConnectivityPosture(env);
  for (const issue of issues.filter((i) => i.severity === "warn")) {
    // eslint-disable-next-line no-console
    console.warn(`[boot] WARNING ${issue.message}`);
  }
  const fatal = issues.find((i) => i.severity === "fatal");
  if (fatal) throw new Error(fatal.message);
  if (issues.length === 0 && env.NODE_ENV === "production") {
    // eslint-disable-next-line no-console
    console.log("[boot] connectivity posture OK (egress guard armed)");
  }
}
