// ---------------------------------------------------------------------------
// F-P4-23 / F-P4-24 / F-P4-25 / F-P4-26 — Fail-closed env-var reader.
//
// The hardcoded fallbacks `|| 'tellus123'`, `|| 'minioadmin'`, and
// `|| 'tellus'` that used to live in src/config/foundryDb.ts,
// src/config/foundryEnv.ts, src/services/duckdb/pool.ts,
// src/services/funnel/icebergMetadataEmitter.ts,
// src/services/funnel/lakekeeperBootstrap.ts, src/middleware/globalAuth.ts,
// src/middleware/keycloakAuth.ts, src/auth/tellusAuth.ts, and
// src/middleware/patSecurityGate.ts were a production credential-leak
// vector: any misconfigured env var shipped the well-known MinIO or
// Postgres default credential straight to prod.
//
// This module replaces those fallbacks with a fail-closed accessor:
//
//   - `requireEnv(name)`           — throws at read time if unset/empty.
//   - `requireSecret(name)`        — identical semantics; name is a hint
//                                    to the audit log that the value is
//                                    sensitive, so no logging policy
//                                    accidentally prints it.
//   - `envWithDefault(name, def)`  — for non-secret, non-security-
//                                    sensitive knobs (e.g. PGHOST in dev
//                                    where 'localhost' is a safe default).
//
// Rule of thumb: if the value authenticates, encrypts, or identifies a
// principal, use `requireSecret`. Never use `envWithDefault` for a value
// that names a tenant, realm, bucket, or credential.
// ---------------------------------------------------------------------------

export class MissingEnvError extends Error {
  public readonly code = "MISSING_ENV";
  public readonly name = "MissingEnvError";
  public readonly envVar: string;
  constructor(envVar: string, hint?: string) {
    super(
      `Required environment variable ${envVar} is not set.${hint ? ` ${hint}` : ""} ` +
        `Set it in your Kubernetes Secret / deployment manifest. Startup aborted.`
    );
    this.envVar = envVar;
  }
}

/**
 * Read a required environment variable. Throws `MissingEnvError` if the
 * variable is absent or empty after trimming. No fallback; no default.
 */
export function requireEnv(name: string, hint?: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new MissingEnvError(name, hint);
  }
  return String(raw);
}

/**
 * Identical to `requireEnv` but semantically hints that the value is
 * sensitive so loggers and error formatters treat it as such.
 * The audit pipeline must never include the value itself in a log line;
 * only the env-var name is safe to record.
 */
export function requireSecret(name: string, hint?: string): string {
  return requireEnv(name, hint);
}

/**
 * Non-security env-var with a default. Use only for values that are safe
 * in code — hosts, ports, bucket names, timeouts — never credentials or
 * realm identifiers.
 */
export function envWithDefault(name: string, defaultValue: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }
  return String(raw);
}

/**
 * Assert at boot that every entry in `names` is present. Used by
 * src/server.ts to abort startup before accepting traffic if any
 * required secret is missing. Collects all missing names into one error
 * so an operator can fix them in a single deploy cycle.
 */
export function assertRequiredEnv(names: readonly string[]): void {
  const missing: string[] = [];
  for (const n of names) {
    const raw = process.env[n];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      missing.push(n);
    }
  }
  if (missing.length > 0) {
    throw new MissingEnvError(
      missing.join(", "),
      `${missing.length} required variable(s) missing.`
    );
  }
}
