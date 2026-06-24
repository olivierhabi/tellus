// ---------------------------------------------------------------------------
// T-03 — Furnace SQL constants.
//
// Centralised so tests can override timeouts and the route layer can quote
// stable values in error messages. Every constant has an envelope test in
// tests/unit/object-explorer/furnaceSql-T03-unit.test.ts asserting the
// exact value the spec calls for.
// ---------------------------------------------------------------------------

/**
 * Per-statement DuckDB execution budget. Keep it under the express
 * default request timeout (60s) by an order of magnitude so the SQL
 * surface stays a fast-failing read endpoint, not a long-poll.
 */
export const SQL_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * In-memory DuckDB cache TTL. After this many ms, the next query for a
 * `(ontologyId, branchId, securityFingerprint)` triple rebuilds the
 * snapshot from OpenSearch via `applyContextToBody`.
 */
export const SQL_CACHE_TTL_MS = 30_000;

/**
 * Hard ceiling on rows returned to the user from a single query. The
 * service injects/rewrites a `LIMIT` clause; this is the value used.
 */
export const SQL_ROW_LIMIT = 1_000;

/**
 * Maximum number of `object_instances` rows materialised per object
 * type when building a fresh DuckDB snapshot from OpenSearch. The spec
 * (§T-03.3.3) preserves the historical 5000-row sample as an explicit,
 * documented limitation. Operators can override by setting
 * `FURNACE_SAMPLE_LIMIT` to an integer in [1000, 50000].
 */
export const SQL_DEFAULT_SAMPLE_LIMIT = 5_000;
export const SQL_SAMPLE_LIMIT_MIN = 1_000;
export const SQL_SAMPLE_LIMIT_MAX = 50_000;

/**
 * Resolve `FURNACE_SAMPLE_LIMIT` (env override) or fall back to the
 * default. Out-of-range values silently clamp to the [min, max] window
 * — fail-loud is the wrong default here because the env value is
 * operator-set and the request that triggered the resolution should
 * not 500 on a typo.
 */
export function resolveSampleLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FURNACE_SAMPLE_LIMIT;
  if (typeof raw !== "string" || raw.length === 0) return SQL_DEFAULT_SAMPLE_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return SQL_DEFAULT_SAMPLE_LIMIT;
  if (n < SQL_SAMPLE_LIMIT_MIN) return SQL_SAMPLE_LIMIT_MIN;
  if (n > SQL_SAMPLE_LIMIT_MAX) return SQL_SAMPLE_LIMIT_MAX;
  return n;
}

/**
 * Allowed leading SQL keywords. T-03 drops `pragma` (operators must
 * not be able to flip session flags). `SQL_DISALLOWED_KEYWORD` is
 * raised for `pragma`, `set`, `reset`, `attach`, etc.
 */
export const ALLOWED_LEADING_KEYWORDS = Object.freeze(
  new Set(["select", "with", "describe", "desc", "show", "explain"]),
);

/**
 * Forbidden leading keywords that the service must reject *before*
 * touching DuckDB. Distinct from `ALLOWED_LEADING_KEYWORDS` only so a
 * keyword neither in nor out of the allowlist (e.g. a typo) yields a
 * different error envelope than a clearly-disallowed write.
 */
export const FORBIDDEN_LEADING_KEYWORDS = Object.freeze(
  new Set([
    "insert", "update", "delete", "merge", "upsert",
    "create", "alter", "drop", "truncate", "rename", "comment",
    "grant", "revoke", "attach", "detach", "import", "export",
    "copy", "load", "call", "begin", "commit", "rollback", "savepoint",
    "vacuum", "analyze", "install", "set", "reset", "use", "pragma",
  ]),
);

/**
 * Maximum SQL string length accepted at the route boundary. Longer
 * inputs short-circuit with `QUERY_VALIDATION_ERROR` to avoid the
 * pathological-parser DoS class.
 */
export const SQL_MAX_QUERY_LENGTH = 10_000;
