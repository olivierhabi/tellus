// ---------------------------------------------------------------------------
// B3 — pg-types parser overrides for Foundry parity (spec §B3 line 140).
//
// pg's default parsers turn `bytea` into Node Buffer (we want that), `numeric`
// into a string (we keep, since precision can exceed JS double), `interval`
// into an object (we serialize to ISO-8601 string), and `tstzrange` into a
// string (we parse to a Tellus-canonical `{lower, upper, lowerInc, upperInc}`
// object so downstream consumers don't re-parse).
//
// installPgTypeParsers() is idempotent — calling it twice is a no-op.
// Call it once at process boot (server.ts) before any pool is created.
// ---------------------------------------------------------------------------

import { types } from "pg";

// PostgreSQL OIDs (stable since 7.x). Source: src/include/catalog/pg_type.dat
const OID = {
  bytea: 17,
  numeric: 1700,
  interval: 1186,
  tstzrange: 3910,
  // Array OIDs are out of scope for parser override — pg handles them via
  // arrayParser composition on the element parser.
} as const;

let installed = false;

export function installPgTypeParsers(): void {
  if (installed) return;
  installed = true;

  // bytea -> Buffer (pg default already does this; we re-install for clarity).
  types.setTypeParser(OID.bytea, (val: string) => {
    if (val.startsWith("\\x")) {
      return Buffer.from(val.slice(2), "hex");
    }
    return Buffer.from(val, "binary");
  });

  // numeric -> string (default), preserved here for explicit contract.
  types.setTypeParser(OID.numeric, (val: string) => val);

  // interval -> ISO-8601 duration string (Tellus canonical).
  types.setTypeParser(OID.interval, (val: string) => pgIntervalToIso(val));

  // tstzrange -> structured object.
  // The pg-types `TypeId` enum doesn't surface range OIDs; cast through unknown
  // because the runtime accepts any positive OID.
  types.setTypeParser(
    OID.tstzrange as unknown as Parameters<typeof types.setTypeParser>[0],
    (val: string) => parseTstzRange(val),
  );
}

/** Reset for tests. Re-call installPgTypeParsers() after. */
export function _resetForTests(): void {
  installed = false;
}

// ---------------------------------------------------------------------------
// Interval parser. pg sends e.g. "1 year 2 mons 3 days 04:05:06.789".
// We render ISO-8601: P1Y2M3DT4H5M6.789S.
// ---------------------------------------------------------------------------
const intervalRe =
  /^(?:(-?\d+) years? ?)?(?:(-?\d+) mons? ?)?(?:(-?\d+) days? ?)?(?:(-?\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?))?$/;

export function pgIntervalToIso(val: string): string {
  const m = intervalRe.exec(val.trim());
  if (!m) return val; // pass-through; caller may keep raw.
  const [, y, mo, d, h, mi, s] = m;
  const date = [
    y ? `${y}Y` : "",
    mo ? `${mo}M` : "",
    d ? `${d}D` : "",
  ].join("");
  const time = [
    h ? `${parseInt(h, 10)}H` : "",
    mi ? `${parseInt(mi, 10)}M` : "",
    s ? `${parseFloat(s)}S` : "",
  ].join("");
  if (!date && !time) return "PT0S";
  return time ? `P${date}T${time}` : `P${date}`;
}

// ---------------------------------------------------------------------------
// tstzrange parser. pg sends e.g. '["2024-01-01 00:00:00+00","2024-02-01 00:00:00+00")'.
// ---------------------------------------------------------------------------
export interface TstzRange {
  lower: string | null;
  upper: string | null;
  lowerInc: boolean;
  upperInc: boolean;
}

export function parseTstzRange(val: string): TstzRange {
  if (val === "empty") {
    return { lower: null, upper: null, lowerInc: false, upperInc: false };
  }
  const lowerInc = val.startsWith("[");
  const upperInc = val.endsWith("]");
  const inner = val.slice(1, -1);
  const [lRaw, uRaw] = splitOutsideQuotes(inner);
  return {
    lower: unquote(lRaw) || null,
    upper: unquote(uRaw) || null,
    lowerInc,
    upperInc,
  };
}

function splitOutsideQuotes(s: string): [string, string] {
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== "\\") inQuote = !inQuote;
    if (c === "," && !inQuote) return [s.slice(0, i), s.slice(i + 1)];
  }
  return [s, ""];
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}
