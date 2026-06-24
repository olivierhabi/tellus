// ---------------------------------------------------------------------------
// Multipass workload-token issuer + verifier (B2 §113).
//
// Workload JWTs are short-lived (default 300s) tokens minted by the
// connectivity service for use by its own workers. They carry:
//   - sub: workload identity ("tellus-foundry-worker" / "tellus-cdc-worker")
//   - scopes: ["connectivity:credential-unwrap"]
//   - connection_rid: the SPECIFIC connection the bearer may unwrap creds for
//   - exp: short-lived (≤300s)
//
// Verification rejects:
//   - expired tokens (exp ≤ now)
//   - tokens whose connection_rid doesn't match the requested target
//   - tokens missing the connectivity:credential-unwrap scope
//
// Signing: HS256 with TELLUS_WORKLOAD_JWT_SECRET (defaults to a process-local
// random secret if unset, so tests work out-of-box; a warning is logged in
// production if the env var is unset). Production deployments swap to RS256
// via the existing Keycloak issuer if desired; this module's signature
// algorithm is configurable per call.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import jwt, { type SignOptions, type VerifyOptions } from "jsonwebtoken";

const DEFAULT_TTL_S = 300;
const DEFAULT_ALG: jwt.Algorithm = "HS256";

let cachedSecret: string | null = null;
function getSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.TELLUS_WORKLOAD_JWT_SECRET;
  if (fromEnv && fromEnv.length >= 32) {
    cachedSecret = fromEnv;
  } else {
    if (process.env.NODE_ENV === "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[multipass.tokens] TELLUS_WORKLOAD_JWT_SECRET not set or <32 chars; using random per-process secret",
      );
    }
    cachedSecret = randomBytes(32).toString("base64");
  }
  return cachedSecret;
}

export interface WorkloadClaims {
  sub: string;
  scopes: string[];
  connection_rid: string;
  tenant: string;
  iat?: number;
  exp?: number;
}

export interface IssueOptions {
  subject: string;
  connectionRid: string;
  tenant: string;
  scopes?: string[]; // default ['connectivity:credential-unwrap']
  ttlSeconds?: number; // default 300
  algorithm?: jwt.Algorithm; // default HS256
}

export function issueWorkloadToken(opts: IssueOptions): string {
  const payload: WorkloadClaims = {
    sub: opts.subject,
    scopes: opts.scopes ?? ["connectivity:credential-unwrap"],
    connection_rid: opts.connectionRid,
    tenant: opts.tenant,
  };
  const signOpts: SignOptions = {
    algorithm: opts.algorithm ?? DEFAULT_ALG,
    expiresIn: opts.ttlSeconds ?? DEFAULT_TTL_S,
    issuer: "tellus:multipass:workload",
    audience: "tellus:connectivity",
  };
  return jwt.sign(payload, getSecret(), signOpts);
}

export interface VerifyResult {
  ok: boolean;
  claims?: WorkloadClaims;
  reason?: string;
}

/**
 * Verify a workload token. Returns ok=true with parsed claims, or ok=false
 * with a short reason string (never include token contents in logs/audit;
 * the reason is operator-safe).
 *
 * Always check `claims.connection_rid === expectedConnectionRid` after a
 * successful verify; this module enforces signature + expiry + scope, but
 * the connection_rid scoping is callsite-specific.
 */
export function verifyWorkloadToken(
  token: string,
  expected: { connectionRid: string; scope: string },
): VerifyResult {
  const verifyOpts: VerifyOptions = {
    algorithms: ["HS256", "RS256"],
    issuer: "tellus:multipass:workload",
    audience: "tellus:connectivity",
  };
  try {
    const decoded = jwt.verify(token, getSecret(), verifyOpts) as WorkloadClaims;
    if (!decoded.scopes || !decoded.scopes.includes(expected.scope)) {
      return { ok: false, reason: "missing_scope" };
    }
    if (decoded.connection_rid !== expected.connectionRid) {
      return { ok: false, reason: "connection_rid_mismatch" };
    }
    return { ok: true, claims: decoded };
  } catch (e) {
    const err = e as Error;
    if (err.name === "TokenExpiredError") {
      return { ok: false, reason: "expired" };
    }
    if (err.name === "JsonWebTokenError") {
      return { ok: false, reason: "signature_invalid" };
    }
    return { ok: false, reason: "verify_failed" };
  }
}

/** Test helper: clears the cached secret so changing env mid-test takes effect. */
export function _resetSecretForTest(): void {
  cachedSecret = null;
}
