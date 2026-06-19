// ---------------------------------------------------------------------------
// B3 — PostgreSQL connector config (spec §B3 line 136).
//
// Re-exports the canonical PostgresConfig from the shared contracts module
// (defined in B1) and adds B3-specific narrow types: `PgPoolOptions` which
// is the typed pg.PoolConfig shape we hand to `new Pool()`, and
// `assemblePgPoolOptions(cfg, creds, ca, clientCert, clientKey)` which is
// the single point that translates Tellus config + unwrapped credentials
// into a pg-driver configuration.
//
// The function is invoked from `pool.ts`; isolated here so unit tests can
// pin its TLS-mode behaviour without spinning up Postgres.
// ---------------------------------------------------------------------------

import type { PoolConfig } from "pg";
import { PostgresConfig } from "../../contracts";

export { PostgresConfig };
export type PostgresConfigT = ReturnType<typeof PostgresConfig.parse>;

export interface PgCredentialMaterial {
  /** SQL username (resolved from the credential vault). */
  user: string;
  /** SQL password (plaintext, in-process only). */
  password: string;
  /** Optional client cert PEM (mTLS). */
  clientCertPem?: string;
  /** Optional client key PEM (mTLS). */
  clientKeyPem?: string;
  /** Optional server CA bundle PEM (verify-ca / verify-full). */
  serverCaPem?: string;
}

export function assemblePgPoolOptions(
  cfg: PostgresConfigT,
  creds: PgCredentialMaterial,
): PoolConfig {
  const baseTimeouts = {
    connectionTimeoutMillis: cfg.connectTimeoutMs ?? 10_000,
    statement_timeout: cfg.socketTimeoutMs ?? 60_000,
    idle_in_transaction_session_timeout: cfg.socketTimeoutMs ?? 60_000,
    query_timeout: cfg.socketTimeoutMs ?? 60_000,
  };

  let ssl: PoolConfig["ssl"];
  switch (cfg.tlsMode) {
    case "disable":
      ssl = false;
      break;
    case "require":
      // Encrypt only; no validation.
      ssl = { rejectUnauthorized: false };
      break;
    case "verify-ca":
      ssl = {
        ca: creds.serverCaPem,
        cert: creds.clientCertPem,
        key: creds.clientKeyPem,
        rejectUnauthorized: true,
        // verify-ca = chain valid, hostname NOT checked.
        checkServerIdentity: () => undefined,
      };
      break;
    case "verify-full":
    default:
      ssl = {
        ca: creds.serverCaPem,
        cert: creds.clientCertPem,
        key: creds.clientKeyPem,
        rejectUnauthorized: true,
        // Default checkServerIdentity validates hostname (verify-full).
      };
      break;
  }

  const startupOptions = renderStartupOptions(cfg.extraParams);

  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: creds.user,
    password: creds.password,
    ssl,
    application_name: cfg.applicationName ?? "tellus-connectivity",
    max: cfg.poolMax ?? 4,
    ...(startupOptions ? { options: startupOptions } : {}),
    ...baseTimeouts,
  };
}

/**
 * Render `extraParams` into a libpq `options` startup string (`-c key=value`),
 * which pg forwards verbatim to the server. Keys must be valid GUC identifiers;
 * values are backslash-escaped so a value containing whitespace cannot smuggle
 * in an additional `-c` directive (option injection). Returns undefined when no
 * params are set so the field is omitted entirely.
 */
function renderStartupOptions(
  extra: Record<string, string> | undefined,
): string | undefined {
  const entries = Object.entries(extra ?? {});
  if (entries.length === 0) return undefined;
  const parts: string[] = [];
  for (const [rawKey, rawVal] of entries) {
    const key = rawKey.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
      throw new Error(`invalid extraParams key: ${JSON.stringify(rawKey)}`);
    }
    // Escape backslashes first, then any whitespace, per libpq option quoting.
    const val = String(rawVal)
      .replace(/\\/g, "\\\\")
      .replace(/\s/g, (c) => `\\${c}`);
    parts.push(`-c ${key}=${val}`);
  }
  return parts.join(" ");
}
