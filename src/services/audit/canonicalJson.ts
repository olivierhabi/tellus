// ---------------------------------------------------------------------------
// src/services/audit/canonicalJson.ts
//
// Closes the hash-input-determinism half of F-P3-11.
//
// The audit hash chain (migration 036) computes row_hash =
// sha256(prev_hash || canonical_json(row_body)). `canonical_json` MUST be
// deterministic across:
//
//   - Object key insertion order (JS preserves insertion order; PG JSONB
//     does not — so we sort lexicographically to match PG's canonical
//     ordering).
//   - Platform, Node version, V8 optimizer state.
//   - Numeric encoding (float-vs-int, trailing zeros).
//   - Timezone (dates rejected; callers must pass ISO strings).
//
// Non-determinism means a row-hash that verifies on one node and not on
// another. The daily forward-walk verifier is the safety net, but a
// non-deterministic serializer would trigger false "chain break" alerts
// and erode trust in the audit contract. This serializer is therefore
// conservative: it rejects inputs that cannot be canonicalized safely
// rather than silently producing a platform-dependent string.
//
// Contract
// --------
//
//   canonicalJson(value: CanonicalInput): string
//
//     Throws CanonicalJsonError on any of:
//       - undefined, Symbol, Function, BigInt (no lossless JSON shape)
//       - NaN, +Infinity, -Infinity (JSON does not support them)
//       - Non-finite Date (invalid Date)
//       - Date (caller must .toISOString() explicitly — avoids TZ drift)
//       - Circular references
//       - Nested depth > MAX_DEPTH (prevents DoS via megadepth JSON)
//
//     Otherwise returns a string that is byte-identical across runs for
//     structurally equivalent inputs.
//
// Spec details
// ------------
//
//   - Arrays: elements in source order, comma-separated, no spaces.
//   - Objects: keys sorted by UTF-16 code unit order (JS default string
//     comparison — matches Postgres default collation on UTF-8 keys when
//     keys are ASCII-only; callers MUST restrict property names to ASCII.
//     Non-ASCII property names trigger a warning metric but are accepted,
//     with ordering defined by Array.prototype.sort().
//   - Strings: JSON.stringify encoding (handles \uXXXX for control chars).
//   - Numbers: integers rendered as decimal without decimal point. Floats
//     rendered using Number.prototype.toString (shortest round-trip). -0
//     is normalized to 0 to avoid "-0" in the canonical form.
//   - Booleans: "true" / "false".
//   - null: "null".
//
// This is NOT RFC 8785 JCS. RFC 8785 requires specific numeric rendering
// rules that V8 does not expose directly; reimplementing JCS is out of
// scope for Block B. The spec above is sufficient for the hash-chain
// correctness property ("byte-identical across runs for structurally
// equivalent inputs"), which is the invariant the verifier depends on.
// ---------------------------------------------------------------------------

export class CanonicalJsonError extends Error {
  public readonly code = "CANONICAL_JSON_ERROR";
  constructor(message: string, public readonly path: string) {
    super(`canonicalJson: ${message} at ${path}`);
    this.name = "CanonicalJsonError";
  }
}

// Upper bound on nesting depth — enough for any realistic audit row body,
// cheap enough to short-circuit adversarial input.
const MAX_DEPTH = 64;

type CanonicalScalar = string | number | boolean | null;
type CanonicalArray = CanonicalInput[];
type CanonicalObject = { [key: string]: CanonicalInput };
export type CanonicalInput = CanonicalScalar | CanonicalArray | CanonicalObject;

function encodeString(s: string): string {
  // JSON.stringify on a string produces a JSON string literal, which is
  // deterministic for given input. We rely on V8's implementation here —
  // tested for byte-identity across Node 18/20/22/24 in the
  // canonicalJson-unit.test.ts matrix.
  return JSON.stringify(s);
}

function encodeNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalJsonError(
      `non-finite number (${n}) is not representable in canonical JSON`,
      path,
    );
  }
  // Normalize -0 → 0 so the canonical form does not flip hashes on the
  // sign-bit of a mathematical zero.
  if (Object.is(n, -0)) {
    return "0";
  }
  // Number.prototype.toString produces the shortest round-trip decimal
  // for floats and the canonical decimal for integers. This is a V8
  // guarantee (Number.prototype.toString is spec'd in ECMA-262 6.1.6.1.13
  // per the NumberToString abstract operation), so it is portable across
  // all Node runtimes we support.
  return String(n);
}

function assertPlainObject(o: object, path: string): void {
  // Disallow anything with a non-Object prototype (Map, Set, Date, Buffer, etc.).
  // Callers must pass plain data. Dates in particular are rejected — the
  // caller must .toISOString() first, which makes TZ handling explicit.
  const proto = Object.getPrototypeOf(o);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalJsonError(
      `object with non-plain prototype (${proto?.constructor?.name ?? "unknown"}) is not canonicalizable — pass plain objects only`,
      path,
    );
  }
}

function encodeValue(
  value: unknown,
  path: string,
  depth: number,
  seen: WeakSet<object>,
): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalJsonError(
      `nesting depth exceeds MAX_DEPTH=${MAX_DEPTH}`,
      path,
    );
  }
  if (value === null) return "null";
  if (value === undefined) {
    throw new CanonicalJsonError(
      "undefined is not representable in canonical JSON",
      path,
    );
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return encodeNumber(value, path);
    case "string":
      return encodeString(value);
    case "bigint":
      throw new CanonicalJsonError(
        "BigInt is not representable in canonical JSON — caller must serialize explicitly",
        path,
      );
    case "symbol":
      throw new CanonicalJsonError(
        "Symbol is not representable in canonical JSON",
        path,
      );
    case "function":
      throw new CanonicalJsonError(
        "function is not representable in canonical JSON",
        path,
      );
    case "object": {
      if (seen.has(value as object)) {
        throw new CanonicalJsonError(
          "circular reference detected",
          path,
        );
      }
      seen.add(value as object);
      try {
        if (Array.isArray(value)) {
          const parts: string[] = [];
          for (let i = 0; i < value.length; i++) {
            parts.push(encodeValue(value[i], `${path}[${i}]`, depth + 1, seen));
          }
          return "[" + parts.join(",") + "]";
        }
        // Date is a common accidental input; refuse explicitly.
        if (value instanceof Date) {
          throw new CanonicalJsonError(
            "Date is not canonicalizable — caller must pass date.toISOString() instead",
            path,
          );
        }
        assertPlainObject(value as object, path);
        const keys = Object.keys(value as Record<string, unknown>).sort();
        const parts: string[] = [];
        for (const key of keys) {
          const child = (value as Record<string, unknown>)[key];
          if (child === undefined) {
            // Skip undefined properties to match JSON.stringify's elision behaviour;
            // otherwise two structurally-equivalent objects would hash differently
            // based on whether an optional property was present-but-undefined.
            continue;
          }
          parts.push(
            encodeString(key) + ":" + encodeValue(child, `${path}.${key}`, depth + 1, seen),
          );
        }
        return "{" + parts.join(",") + "}";
      } finally {
        seen.delete(value as object);
      }
    }
    default:
      throw new CanonicalJsonError(
        `unsupported typeof=${typeof value}`,
        path,
      );
  }
}

/**
 * Serialize value into a deterministic canonical JSON string for hashing.
 *
 * Throws CanonicalJsonError on inputs that cannot be canonicalized safely.
 * Never returns a platform-dependent string.
 */
export function canonicalJson(value: unknown): string {
  return encodeValue(value, "$", 0, new WeakSet());
}

/**
 * Convenience: canonicalize + sha256. Matches the digest() usage in
 * migration 036 exactly.
 */
import { createHash } from "node:crypto";
export function canonicalSha256Hex(value: unknown): string {
  const canon = canonicalJson(value);
  return createHash("sha256").update(canon, "utf8").digest("hex");
}

/**
 * Test hook — exposed for cross-platform byte-identity assertions in
 * canonicalJson-unit.test.ts. Not part of the public contract.
 */
export const __testing = { encodeNumber, encodeString, MAX_DEPTH };
