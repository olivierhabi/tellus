// Workshop B01 / G-02 — ETag computation.
//
// Per spec §0.2: `ETag: W/"<sha256(definition_jsonb || updated_at_micros)>"`.
// Decision D-08: canonicalize JSON via RFC 8785 (JCS) at the application
// layer so the hash is reproducible from the wire response and not coupled
// to Postgres's binary jsonb representation.
//
// "Weak" ETag (`W/"..."`) is intentional — Workshop module documents are
// semantically equal under different byte orderings, and §0.2 specifies the
// `W/` prefix.

import { createHash } from "node:crypto";

/**
 * RFC 8785 JSON Canonicalization Scheme — minimal subset sufficient for our
 * domain (no NaN/±Infinity, no non-string object keys). Sort object keys
 * lexicographically; arrays preserve order; numbers go through a strict
 * I-JSON-compatible serializer.
 *
 * We re-implement this rather than pull a dep so the canonicalization is
 * inspectable and audit-friendly.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error("canonicalizeJson: non-finite numbers are not allowed");
    }
    // I-JSON: prefer integer literal when possible; otherwise standard JSON
    // number. JCS spec is more elaborate; this subset is sufficient for the
    // values we hash (object IDs, integers, ISO timestamps as strings).
    return Number.isInteger(v) ? v.toString() : JSON.stringify(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map((x) => canonicalize(x)).join(",") + "]";
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
        .join(",") +
      "}"
    );
  }
  // undefined and functions are not valid JSON values; reject loudly.
  throw new Error(
    `canonicalizeJson: unsupported value of type ${typeof v}`,
  );
}

/**
 * Compute a Workshop ETag from a definition document and an "updated at"
 * timestamp in microseconds since the Unix epoch.
 *
 *   ETag = W/"<sha256(canonicalize(definition) || ":" || updated_at_micros)>"
 *
 * The `:` separator is included to prevent hash collisions across the
 * boundary between document content and timestamp suffix.
 */
export function computeEtag(
  definition: unknown,
  updatedAtMicros: bigint | number,
): string {
  const canonical = canonicalizeJson(definition);
  const micros =
    typeof updatedAtMicros === "bigint"
      ? updatedAtMicros.toString()
      : String(Math.trunc(updatedAtMicros));
  const digest = createHash("sha256")
    .update(canonical, "utf8")
    .update(":", "utf8")
    .update(micros, "utf8")
    .digest("hex");
  return `W/"${digest}"`;
}

/**
 * Convert a Postgres TIMESTAMPTZ (returned as ISO string by db.ts type
 * parser at OID 1184) into microseconds since epoch.
 */
export function isoToMicros(iso: string): bigint {
  // Accepts both:
  //   - JS-style ISO: `2026-05-03T14:25:36.123456Z` / `+02:00`
  //   - Postgres wire format: `2026-05-03 14:25:36.123456+00`
  // Postgres preserves up to 6 fractional digits and emits a space
  // separator + truncated offset (`+00`, not `+00:00`) when minutes are
  // zero. Both forms must be parseable since the production OID-1184
  // type-parser hands them to us as raw strings.
  const match = iso.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/,
  );
  if (!match) {
    throw new Error(`isoToMicros: unparseable timestamp ${iso}`);
  }
  const [, y, mo, d, h, mi, s, frac = "", tz = "Z"] = match;
  const ms = Date.UTC(
    parseInt(y, 10),
    parseInt(mo, 10) - 1,
    parseInt(d, 10),
    parseInt(h, 10),
    parseInt(mi, 10),
    parseInt(s, 10),
  );
  // tz offset — supports `+HH`, `+HHMM`, `+HH:MM`.
  let offsetMin = 0;
  if (tz !== "Z") {
    const m = tz.match(/^([+-])(\d{2})(?::?(\d{2}))?$/);
    if (!m) throw new Error(`isoToMicros: bad tz ${tz}`);
    const hours = parseInt(m[2], 10);
    const mins = m[3] ? parseInt(m[3], 10) : 0;
    offsetMin = (m[1] === "+" ? 1 : -1) * (hours * 60 + mins);
  }
  const adjustedMs = ms - offsetMin * 60_000;
  // Pad fractional seconds to 6 digits, then append.
  const fracPadded = (frac + "000000").slice(0, 6);
  return BigInt(adjustedMs) * 1000n + BigInt(parseInt(fracPadded, 10));
}

/**
 * Parse an ETag header value (with or without `W/` prefix) into the bare
 * digest. Returns null if the header is missing or malformed.
 */
export function parseEtag(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = header.match(/^(?:W\/)?"([0-9a-f]{64})"$/i);
  return m ? m[1].toLowerCase() : null;
}
