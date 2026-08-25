// ---------------------------------------------------------------------------
// Deterministic redaction library for evidence hygiene (audit #5/#6/#9).
//
// Pure functions — no I/O, safe to import from both CLIs and the pure-unit
// vitest lane. Redaction is:
//   - deterministic: same input always yields the same output;
//   - idempotent: redact(redact(x)) === redact(x) — running it twice is a no-op;
//   - shape-preserving in redactObject: keys are kept, values are replaced by
//     typed placeholders so evidence remains machine-checkable.
// ---------------------------------------------------------------------------

export const REDACTED_TOKEN = "<REDACTED>";

/** Additional literal values that must never appear in committed evidence
 * (e.g. customerId-style PII values discovered during an incident). */
export interface RedactOptions {
  valueDenylist?: string[];
}

const PLACEHOLDER_RE = /^(?:<REDACTED(?::[A-Za-z_]+)?>|<redacted:[a-z]+>)$/;

function isAlreadyRedacted(value: string): boolean {
  return PLACEHOLDER_RE.test(value.trim());
}

// --- Ordered pattern rules. Order matters: PEM blocks and connection strings
// are replaced before the generic key/value rules run, and each replacement
// output uses the <REDACTED…> shape so re-application is a no-op. -----------

const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

const CREDENTIAL_URL_RE =
  /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^/\s:@]+:[^@\s]+@/gi;

const AUTH_HEADER_RE = /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s"',\n]+/gi;

const BEARER_TOKEN_RE = /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

const COOKIE_HEADER_RE = /((?:set-)?cookie\s*[:=]\s*)[^\n"']+/gi;

const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;

/** JSON-ish `"password": "value"` / `password=value` / `password: value`. */
const SENSITIVE_KV_RE =
  /((?:"|')?(?:password|passwd|secret|api[_-]?key|session(?:_id)?|token|private[_-]?key)(?:"|')?\s*[:=]\s*)("([^"]*)"|'([^']*)'|[^\s,}\]'"&]+)/gi;

export function redactSensitive(input: string, options: RedactOptions = {}): string {
  let out = input;

  out = out.replace(PEM_BLOCK_RE, "<REDACTED:PRIVATE_KEY>");
  out = out.replace(JWT_RE, "<REDACTED:JWT>");
  out = out.replace(CREDENTIAL_URL_RE, (_m, scheme: string) => `${scheme}://<REDACTED>@`);
  out = out.replace(AUTH_HEADER_RE, (_m, prefix: string) => `${prefix}${REDACTED_TOKEN}`);
  out = out.replace(BEARER_TOKEN_RE, (_m, prefix: string) => `${prefix}${REDACTED_TOKEN}`);
  out = out.replace(COOKIE_HEADER_RE, (_m, prefix: string) => `${prefix}${REDACTED_TOKEN}`);
  out = out.replace(AWS_ACCESS_KEY_RE, "<REDACTED:AWS_ACCESS_KEY>");
  out = out.replace(SENSITIVE_KV_RE, (whole, prefix: string, raw: string) => {
    const bare = raw.replace(/^["']|["']$/g, "");
    if (isAlreadyRedacted(bare)) return whole;
    const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : "";
    return `${prefix}${quote}${REDACTED_TOKEN}${quote}`;
  });

  for (const literal of options.valueDenylist ?? []) {
    if (!literal) continue;
    out = out.split(literal).join("<REDACTED:DENYLISTED_VALUE>");
  }

  return out;
}

/** Sensitive object keys whose values are replaced wholesale (any depth). */
const SENSITIVE_KEY_RE =
  /^(password|passwd|secret|api[_-]?key|authorization|cookie|set-cookie|session(?:_?id)?|token|access[_-]?token|refresh[_-]?token|private[_-]?key|connection[_-]?string)$/i;

export function redactObject<T>(obj: T, options: RedactOptions = {}): T {
  return walk(obj) as T;

  function walk(value: unknown): unknown {
    if (typeof value === "string") {
      if (isAlreadyRedacted(value)) return value;
      return redactSensitive(value, options);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEY_RE.test(key)) {
          result[key] = REDACTED_TOKEN;
        } else {
          result[key] = walk(v);
        }
      }
      return result;
    }
    return value;
  }
}
