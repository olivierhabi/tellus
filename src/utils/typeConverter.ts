// ---------------------------------------------------------------------------
// Type Converter Utility (Saturday Tasks)
//
// Higher-level type conversion utilities for the Saturday batch pipeline.
// Handles locale-specific data formats common in Rwandan/East African
// datasets:
//   - European decimals ("1234,56" → 1234.56)
//   - DD/MM/YYYY dates (Rwanda default)
//   - Unix timestamps (seconds and milliseconds)
//   - Geopoint strings ("lat,lon" or "lat lon")
//   - Pipe-delimited arrays
//   - Boolean strings (yes/no, 1/0, yego/oya in Kinyarwanda)
//
// This module complements (not replaces) the indexing pipeline's
// typeConverter at src/services/indexing/typeConverter.ts. That converter
// operates on PropertyInput objects within the indexing pipeline. This
// utility provides standalone conversion functions for general use.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for convertValue(). */
export interface ConvertOptions {
  /** Locale hint for number parsing. 'rw' uses comma as decimal separator. */
  locale?: string;
  /** Date format hint: 'dmy' (Rwanda default), 'mdy' (US), 'ymd' (ISO). */
  dateFormat?: "dmy" | "mdy" | "ymd";
  /** Array delimiter. Default: '|'. */
  arrayDelimiter?: string;
  /** Whether to attempt coercion (lenient mode). Default: true. */
  coerce?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Truthy string values. */
const TRUTHY = new Set([
  "true", "1", "yes", "y", "on",
  "yego",  // Kinyarwanda: "yes"
]);

/** Falsy string values. */
const FALSY = new Set([
  "false", "0", "no", "n", "off",
  "oya",   // Kinyarwanda: "no"
]);

/** Month abbreviation lookup (case-insensitive). */
const MONTH_ABBREVS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  // Full names and the two common irregular abbreviations. The month regexes
  // below used to be hardcoded to exactly three letters, so "30 March 2025"
  // and "Sept 30, 2025" failed while "30-Mar-2025" worked — an arbitrary
  // distinction from the user's point of view, and the kind of gap that only
  // surfaces when a new source file happens to spell the month out.
  january: 1, february: 2, march: 3, april: 4, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  sept: 9,
};

/** Currency symbols and codes to strip before numeric parsing. */
const CURRENCY_RE =
  /^[\$\u20AC\u00A3\u00A5]|^(RWF|USD|EUR|GBP|JPY|KES|UGX|TZS|BIF|FRW)\s*/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a date (year, month, day) is a valid calendar date.
 */
function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Format a date as YYYY-MM-DD.
 */
function formatDate(year: number, month: number, day: number): string {
  const yy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Strip currency symbols/codes and thousands separators from a numeric string.
 * Handles both comma-as-thousands (1,000,000) and dot-as-thousands (1.000.000).
 */
function stripCurrency(raw: string): string {
  return raw.replace(CURRENCY_RE, "").trim();
}

/**
 * Parse a number from a string, handling European decimal format.
 * European: "1.234,56" → 1234.56  (dot=thousands, comma=decimal)
 * US/default: "1,234.56" → 1234.56 (comma=thousands, dot=decimal)
 */
function parseNumber(raw: string, locale?: string): number {
  let s = stripCurrency(raw);

  // Detect European format: if the string has comma but no dot, or
  // the last separator is a comma (e.g. "1234,56" or "1.234,56")
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  // Auto-detect European format:
  // European uses comma as decimal (1.234,56 or 1234,56).
  // Key heuristic: if there's a dot BEFORE a comma, it's European (1.234,56).
  // If there's only a comma with 1-2 digits after it, it's likely decimal (1234,56).
  // If comma is followed by exactly 3 digits (1,000 or 1,000,000), it's US thousands.
  const looksLikeEuropeanDecimal =
    lastComma !== -1 &&
    (lastDot !== -1 && lastDot < lastComma) || // dot before comma: 1.234,56
    (lastComma !== -1 && lastDot === -1 && !/,\d{3}(?:\D|$)/.test(s)); // comma not followed by 3 digits

  const isEuropean =
    locale === "rw" ||
    locale === "de" ||
    locale === "fr" ||
    locale === "eu" ||
    (looksLikeEuropeanDecimal && !locale);

  if (isEuropean && lastComma !== -1) {
    // European: dots are thousands separators, comma is decimal
    s = s.replace(/\./g, "");    // remove thousands dots
    s = s.replace(",", ".");     // replace decimal comma with dot
  } else {
    // US/default: commas are thousands separators
    s = s.replace(/,(?=\d{3}(?:\D|$))/g, "");
  }

  // Remove any remaining whitespace
  s = s.trim();

  // Percent handling
  if (s.endsWith("%")) {
    s = s.slice(0, -1).trim();
    const n = parseFloat(s);
    if (isNaN(n) || !isFinite(n)) return NaN;
    return n / 100;
  }

  return parseFloat(s);
}

// ---------------------------------------------------------------------------
// convertValue()
// ---------------------------------------------------------------------------

/**
 * Convert a raw value to the specified base type with locale-aware parsing.
 *
 * @param rawValue - The value to convert (string, number, boolean, null, etc.)
 * @param baseType - The target Ontology base type.
 * @param options  - Optional conversion options (locale, dateFormat, etc.)
 * @returns The converted value, or null for empty/null inputs.
 * @throws Error if the value cannot be converted.
 */
export function convertValue(
  rawValue: any,
  baseType: string,
  options?: ConvertOptions
): any {
  const locale = options?.locale;
  const dateFormat = options?.dateFormat ?? "dmy";
  const arrayDelimiter = options?.arrayDelimiter ?? "|";

  // Null/undefined/empty handling
  if (rawValue === null || rawValue === undefined) return null;

  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "n/a") {
      return null;
    }
  }

  const raw = typeof rawValue === "string" ? rawValue.trim() : rawValue;

  switch (baseType) {
    // -----------------------------------------------------------------
    // String
    // -----------------------------------------------------------------
    case "string":
      return String(raw);

    // -----------------------------------------------------------------
    // Boolean
    // -----------------------------------------------------------------
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "number") return raw !== 0;
      const lower = String(raw).toLowerCase().trim();
      if (TRUTHY.has(lower)) return true;
      if (FALSY.has(lower)) return false;
      throw new Error(`Cannot convert '${rawValue}' to boolean`);
    }

    // -----------------------------------------------------------------
    // Integer types
    // -----------------------------------------------------------------
    case "integer":
    case "long":
    case "short":
    case "byte": {
      if (typeof raw === "number") {
        if (!Number.isInteger(raw)) {
          throw new Error(`Cannot convert ${raw} to ${baseType}: not an integer`);
        }
        return validateIntRange(raw, baseType);
      }
      const n = parseNumber(String(raw), locale);
      if (isNaN(n)) throw new Error(`Cannot convert '${rawValue}' to ${baseType}`);
      const int = Math.trunc(n);
      return validateIntRange(int, baseType);
    }

    // -----------------------------------------------------------------
    // Floating-point types
    // -----------------------------------------------------------------
    case "double":
    case "float":
    case "decimal": {
      if (typeof raw === "number") {
        if (!isFinite(raw)) throw new Error(`Cannot convert ${raw} to ${baseType}`);
        return raw;
      }
      const n = parseNumber(String(raw), locale);
      if (isNaN(n) || !isFinite(n)) {
        throw new Error(`Cannot convert '${rawValue}' to ${baseType}`);
      }
      return n;
    }

    // -----------------------------------------------------------------
    // Date
    // -----------------------------------------------------------------
    case "date": {
      if (typeof raw !== "string") {
        throw new Error(`Cannot convert ${typeof raw} to date`);
      }
      return convertDate(raw, dateFormat);
    }

    // -----------------------------------------------------------------
    // Timestamp
    // -----------------------------------------------------------------
    case "timestamp": {
      if (typeof raw !== "string" && typeof raw !== "number") {
        throw new Error(`Cannot convert ${typeof raw} to timestamp`);
      }
      // A timestamp target must accept everything a date target does — the
      // compatibility table below says so (`timestamp: {timestamp, date}`), and
      // widening a date to midnight is lossless. `dateFormat` has to be passed
      // through: without it, "Cast to Timestamp" on a column of "7/30/23"
      // failed on every row while "Cast to Date" on the same column succeeded.
      return convertTimestamp(String(raw), dateFormat);
    }

    // -----------------------------------------------------------------
    // Geopoint
    // -----------------------------------------------------------------
    case "geopoint": {
      return convertGeopoint(raw);
    }

    // -----------------------------------------------------------------
    // Array types
    // -----------------------------------------------------------------
    case "string_array":
    case "integer_array":
    case "double_array":
    case "boolean_array":
    case "timestamp_array": {
      const elementType = baseType.replace(/_array$/, "");
      return convertArray(raw, elementType, arrayDelimiter, options);
    }

    // -----------------------------------------------------------------
    // Struct / Geoshape — pass through
    // -----------------------------------------------------------------
    case "struct":
    case "geoshape": {
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw);
        } catch {
          throw new Error(`Cannot parse '${rawValue}' as JSON for ${baseType}`);
        }
      }
      return raw;
    }

    default:
      // Unknown type — return as string
      return String(raw);
  }
}

// ---------------------------------------------------------------------------
// Integer range validation
// ---------------------------------------------------------------------------

const INT_RANGES: Record<string, [number, number]> = {
  byte: [-128, 127],
  short: [-32768, 32767],
  integer: [-2147483648, 2147483647],
  long: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

function validateIntRange(n: number, type: string): number {
  const range = INT_RANGES[type];
  if (range && (n < range[0] || n > range[1])) {
    throw new Error(
      `Value ${n} is outside the ${type} range (${range[0]} to ${range[1]})`
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// Date conversion (DD/MM/YYYY default)
// ---------------------------------------------------------------------------

function convertDate(raw: string, dateFormat: "dmy" | "mdy" | "ymd"): string {
  const s = raw.trim();

  // 1. ISO format: YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    if (isValidDate(y, m, d)) return formatDate(y, m, d);
    throw new Error(`Invalid calendar date: '${s}'`);
  }

  // 2. Slash-separated: interpret based on dateFormat preference
  const slashMatch = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (slashMatch) {
    const p1 = parseInt(slashMatch[1], 10);
    const p2 = parseInt(slashMatch[2], 10);
    const year = parseInt(slashMatch[3], 10);

    let day: number, month: number;

    if (dateFormat === "dmy") {
      // DD/MM/YYYY (Rwanda default)
      // But if p1 > 31, something is wrong; if p2 > 12, swap
      if (p1 > 31) throw new Error(`Invalid day: ${p1} in '${s}'`);
      if (p2 > 12 && p1 <= 12) {
        // Looks like MDY was intended
        month = p1;
        day = p2;
      } else {
        day = p1;
        month = p2;
      }
    } else if (dateFormat === "mdy") {
      // MM/DD/YYYY (US format)
      if (p1 > 12 && p2 <= 12) {
        // Looks like DMY
        day = p1;
        month = p2;
      } else {
        month = p1;
        day = p2;
      }
    } else {
      // ymd shouldn't have this format, but handle gracefully
      day = p2;
      month = p1;
    }

    if (isValidDate(year, month, day)) return formatDate(year, month, day);
    throw new Error(`Invalid calendar date: '${s}'`);
  }

  // 2b. Slash-separated with a 2-digit year: D/M/YY or M/D/YY ("7/30/23").
  //     Spreadsheet exports emit this constantly. The century pivot follows
  //     the POSIX/strptime %y convention used by Excel, Python and Java:
  //     00-68 → 2000s, 69-99 → 1900s.
  const slash2Match = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);
  if (slash2Match) {
    const p1 = parseInt(slash2Match[1], 10);
    const p2 = parseInt(slash2Match[2], 10);
    const yy = parseInt(slash2Match[3], 10);
    const year = yy <= 68 ? 2000 + yy : 1900 + yy;

    let day: number, month: number;
    if (dateFormat === "mdy") {
      // Unambiguous DMY (p1 > 12) still wins over the hint.
      if (p1 > 12 && p2 <= 12) {
        day = p1;
        month = p2;
      } else {
        month = p1;
        day = p2;
      }
    } else {
      // dmy (default) and ymd — ymd cannot express a 2-digit-year leading
      // field unambiguously, so treat it as dmy.
      if (p1 > 31) throw new Error(`Invalid day: ${p1} in '${s}'`);
      if (p2 > 12 && p1 <= 12) {
        // Unambiguous MDY overrides the dmy hint.
        month = p1;
        day = p2;
      } else {
        day = p1;
        month = p2;
      }
    }

    if (isValidDate(year, month, day)) return formatDate(year, month, day);
    throw new Error(`Invalid calendar date: '${s}'`);
  }

  // 3. YYYY/MM/DD
  const ymdSlashMatch = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (ymdSlashMatch) {
    const y = parseInt(ymdSlashMatch[1], 10);
    const m = parseInt(ymdSlashMatch[2], 10);
    const d = parseInt(ymdSlashMatch[3], 10);
    if (isValidDate(y, m, d)) return formatDate(y, m, d);
    throw new Error(`Invalid calendar date: '${s}'`);
  }

  // 4. DD-Mon-YYYY (e.g., "11-Mar-2025", "30 March 2025", "11 Sept 2025").
  //    Dash or whitespace, abbreviated or spelled out — all the same date, so
  //    accepting only the dashed 3-letter form was an arbitrary restriction.
  const dMonYMatch = s.match(/^(\d{1,2})[-\s]+([A-Za-z]{3,9})[-\s,]+(\d{4})$/);
  if (dMonYMatch) {
    const month = MONTH_ABBREVS[dMonYMatch[2].toLowerCase()];
    if (month !== undefined) {
      const d = parseInt(dMonYMatch[1], 10);
      const y = parseInt(dMonYMatch[3], 10);
      if (isValidDate(y, month, d)) return formatDate(y, month, d);
    }
    throw new Error(`Invalid calendar date: '${s}'`);
  }

  // 5. Mon DD, YYYY (e.g., "Mar 11, 2025", "March 11 2025", "Mar-11-2025")
  const monDYMatch = s.match(/^([A-Za-z]{3,9})[-\s]+(\d{1,2}),?[-\s]*(\d{4})$/);
  if (monDYMatch) {
    const month = MONTH_ABBREVS[monDYMatch[1].toLowerCase()];
    if (month !== undefined) {
      const d = parseInt(monDYMatch[2], 10);
      const y = parseInt(monDYMatch[3], 10);
      if (isValidDate(y, month, d)) return formatDate(y, month, d);
    }
    throw new Error(`Invalid calendar date: '${s}'`);
  }

  // 6. Compact ISO basic format YYYYMMDD (e.g. "20230730"). Emitted by many
  //    warehouse exports and by Excel when a date column is stored as a number.
  //    Deliberately exactly 8 digits and validated as a calendar date, so it
  //    cannot collide with the 10- and 13-digit epoch forms handled in
  //    convertTimestamp, and a non-date like "20231345" still fails loudly
  //    rather than being coerced into something plausible.
  const basicMatch = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (basicMatch) {
    const y = parseInt(basicMatch[1], 10);
    const m = parseInt(basicMatch[2], 10);
    const d = parseInt(basicMatch[3], 10);
    if (isValidDate(y, m, d)) return formatDate(y, m, d);
    throw new Error(`Invalid calendar date: '${s}'`);
  }

  throw new Error(
    `Cannot convert '${raw}' to date. Accepted: YYYY-MM-DD, YYYYMMDD, DD/MM/YYYY, MM/DD/YYYY, DD/MM/YY, MM/DD/YY, DD-Mon-YYYY, Mon DD YYYY`
  );
}

// ---------------------------------------------------------------------------
// Date-format inference
// ---------------------------------------------------------------------------

/**
 * Infer whether a column of slash/dot/dash-separated dates is day-first or
 * month-first by looking for values that can only be read one way.
 *
 * Ambiguous values like "7/6/23" carry no signal, but a single "7/30/23" in
 * the same column proves the whole column is month-first. Without this, a
 * US-formatted column parsed under the "dmy" default silently produces the
 * wrong month for every ambiguous row — worse than a loud cast failure.
 *
 * @returns "mdy" or "dmy" when the sample contains decisive evidence,
 *          otherwise null (caller keeps its own default).
 */
export function inferDateFormat(
  samples: Array<unknown>
): "dmy" | "mdy" | null {
  let mdyEvidence = 0;
  let dmyEvidence = 0;

  for (const sample of samples) {
    if (typeof sample !== "string") continue;
    const m = sample
      .trim()
      .match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
    if (!m) continue;
    const p1 = parseInt(m[1], 10);
    const p2 = parseInt(m[2], 10);
    // Only one field can exceed 12, and it must be the day.
    if (p1 > 12 && p2 <= 12) dmyEvidence++;
    else if (p2 > 12 && p1 <= 12) mdyEvidence++;
  }

  if (mdyEvidence === 0 && dmyEvidence === 0) return null;
  // Mixed evidence means the column is genuinely inconsistent; go with the
  // majority rather than throwing, since lenient cast already nulls the
  // rows that fail either way.
  if (mdyEvidence === dmyEvidence) return null;
  return mdyEvidence > dmyEvidence ? "mdy" : "dmy";
}

// ---------------------------------------------------------------------------
// Timestamp conversion
// ---------------------------------------------------------------------------

function convertTimestamp(
  raw: string,
  dateFormat: "dmy" | "mdy" | "ymd" = "dmy",
): string {
  const s = raw.trim();

  // Unix epoch milliseconds (13 digits)
  if (/^\d{13}$/.test(s)) {
    const ms = parseInt(s, 10);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString();
    throw new Error(`Invalid epoch milliseconds: '${s}'`);
  }

  // Unix epoch seconds (10 digits)
  if (/^\d{10}$/.test(s)) {
    const sec = parseInt(s, 10);
    const d = new Date(sec * 1000);
    if (!isNaN(d.getTime())) return d.toISOString();
    throw new Error(`Invalid epoch seconds: '${s}'`);
  }

  // "YYYY-MM-DD HH:mm:ss" → convert space to T
  const spaceTs = s.replace(
    /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/,
    "$1T$2"
  );

  // STRICT: only accept ISO-8601-shaped strings. Passing anything else to
  // `new Date()` would fall into JS's lenient, implementation- and
  // timezone-dependent parsing (e.g. "7/30/23" parses as mid might local
  // time — which converted wrongly across server timezones and silently
  // disagreed with the strict `convertDate` rules above).
  const isoShape = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(spaceTs);
  if (!isoShape) {
    // Not a timestamp shape. Before failing, try the date-only grammar:
    // "7/30/23", "30-Mar-2025", "2023/07/30" and friends are all legitimate
    // inputs for a timestamp column, widened to midnight.
    //
    // This delegates rather than re-implementing, so the two targets can never
    // disagree about what a date *means* — including the day/month inference
    // and the %y century pivot. Crucially it stays strict: convertDate throws
    // on anything it does not recognise, so we never reach the lenient
    // `new Date()` parsing that the comment above warns about.
    const dateOnly = convertDate(s, dateFormat); // throws if not a date either
    return new Date(`${dateOnly}T00:00:00.000Z`).toISOString();
  }

  // A timestamp with no zone designator is *naive*: the source data says
  // "14:05" and means 14:05, not "14:05 wherever this server happens to be".
  // `new Date("2023-07-30T14:05:00")` applies the host offset, so the same CSV
  // produced 12:05Z on a +02:00 box and 14:05Z on a UTC one — and disagreed
  // with the DuckDB engine, whose TIMESTAMP is timezone-naive and keeps 14:05.
  // Anchoring to UTC makes the two engines agree and makes the result
  // independent of where the process runs. An explicit Z or ±HH:MM is honoured
  // as written, since there the source did state a zone.
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(spaceTs);
  const d = new Date(hasZone ? spaceTs : `${spaceTs}Z`);
  if (!isNaN(d.getTime())) return d.toISOString();

  throw new Error(
    `Cannot convert '${raw}' to timestamp. Accepted: ISO 8601, YYYY-MM-DD HH:mm:ss, epoch ms/s`
  );
}

// ---------------------------------------------------------------------------
// Geopoint conversion
// ---------------------------------------------------------------------------

function convertGeopoint(raw: any): { lat: number; lon: number } {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    if (typeof raw.lat === "number" && typeof raw.lon === "number") {
      validateGeoRange(raw.lat, raw.lon);
      return { lat: raw.lat, lon: raw.lon };
    }
  }

  if (Array.isArray(raw)) {
    if (raw.length === 2 && typeof raw[0] === "number" && typeof raw[1] === "number") {
      // GeoJSON order: [lon, lat]
      validateGeoRange(raw[1], raw[0]);
      return { lat: raw[1], lon: raw[0] };
    }
  }

  if (typeof raw === "string") {
    const s = raw.trim();

    // JSON parse attempt
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        return convertGeopoint(parsed);
      } catch {
        throw new Error(`Cannot parse geopoint JSON: '${raw}'`);
      }
    }

    // "lat,lon" or "lat lon" (space-separated)
    const parts = s.includes(",")
      ? s.split(",")
      : s.split(/\s+/);

    if (parts.length === 2) {
      const lat = parseFloat(parts[0].trim());
      const lon = parseFloat(parts[1].trim());
      if (!isNaN(lat) && !isNaN(lon)) {
        validateGeoRange(lat, lon);
        return { lat, lon };
      }
    }
  }

  throw new Error(
    `Cannot convert '${JSON.stringify(raw)}' to geopoint. Accepted: "lat,lon", {lat,lon}, [lon,lat]`
  );
}

function validateGeoRange(lat: number, lon: number): void {
  if (lat < -90 || lat > 90) {
    throw new Error(`Geopoint latitude ${lat} is outside range -90 to 90`);
  }
  if (lon < -180 || lon > 180) {
    throw new Error(`Geopoint longitude ${lon} is outside range -180 to 180`);
  }
}

// ---------------------------------------------------------------------------
// Array conversion
// ---------------------------------------------------------------------------

function convertArray(
  raw: any,
  elementType: string,
  delimiter: string,
  options?: ConvertOptions
): any[] {
  let elements: any[];

  if (Array.isArray(raw)) {
    elements = raw;
  } else if (typeof raw === "string") {
    const s = raw.trim();

    // Try JSON array first
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) {
          elements = parsed;
        } else {
          throw new Error("not an array");
        }
      } catch {
        // Fall through to string splitting
        elements = splitArray(s, delimiter);
      }
    } else {
      elements = splitArray(s, delimiter);
    }
  } else {
    // Single value → wrap in array
    elements = [raw];
  }

  // Convert each element
  return elements
    .map((el) => {
      if (el === null || el === undefined) return null;
      const strEl = typeof el === "string" ? el.trim() : el;
      if (typeof strEl === "string" && strEl === "") return null;
      return convertValue(strEl, elementType, options);
    })
    .filter((el) => el !== null);
}

function splitArray(s: string, delimiter: string): string[] {
  // Use the provided delimiter, but also detect pipe/semicolon if delimiter not found
  if (s.includes(delimiter)) return s.split(delimiter);
  if (delimiter !== "|" && s.includes("|")) return s.split("|");
  if (delimiter !== ";" && s.includes(";")) return s.split(";");
  return s.split(",");
}

// ---------------------------------------------------------------------------
// isTypeCompatible()
// ---------------------------------------------------------------------------

/**
 * Check if a Palantir property type is compatible with a detected column type.
 * "Compatible" means the values can be stored without any conversion.
 *
 * @param palantirType - The property's base type.
 * @param detectedType - The detected/inferred type from file scanning.
 * @returns true if types are directly compatible.
 */
export function isTypeCompatible(
  palantirType: string,
  detectedType: string
): boolean {
  if (palantirType === detectedType) return true;

  const compatMap: Record<string, Set<string>> = {
    string: new Set(["string"]),
    boolean: new Set(["boolean"]),
    integer: new Set(["integer"]),
    long: new Set(["integer", "long"]),
    double: new Set(["integer", "double", "long"]),
    float: new Set(["integer", "float"]),
    decimal: new Set(["integer", "double", "decimal"]),
    date: new Set(["date"]),
    timestamp: new Set(["timestamp", "date"]),
    byte: new Set(["integer", "byte"]),
    short: new Set(["integer", "short"]),
    geopoint: new Set(["geopoint"]),
    geoshape: new Set(["geoshape"]),
    struct: new Set(["struct"]),
    string_array: new Set(["string_array", "string"]),
    integer_array: new Set(["integer_array", "integer"]),
    double_array: new Set(["double_array", "double"]),
    boolean_array: new Set(["boolean_array", "boolean"]),
    timestamp_array: new Set(["timestamp_array", "timestamp"]),
  };

  const compat = compatMap[palantirType];
  return compat ? compat.has(detectedType) : false;
}

// ---------------------------------------------------------------------------
// isTypeCoercible()
// ---------------------------------------------------------------------------

/**
 * Check if a detected column type can be coerced into a Palantir property type.
 * "Coercible" means conversion is possible but may involve transformation
 * (e.g., string → integer via parseInt).
 *
 * @param palantirType - The property's base type.
 * @param detectedType - The detected/inferred type from file scanning.
 * @returns true if coercion is possible.
 */
export function isTypeCoercible(
  palantirType: string,
  detectedType: string
): boolean {
  // Everything is compatible with itself
  if (palantirType === detectedType) return true;

  // String can be coerced to anything (with potential failure at runtime)
  if (detectedType === "string") return true;

  // Number types can be coerced between each other
  const numericTypes = new Set([
    "integer", "long", "double", "float", "decimal", "byte", "short",
  ]);
  if (numericTypes.has(palantirType) && numericTypes.has(detectedType)) {
    return true;
  }

  // Date/timestamp interop
  if (
    (palantirType === "date" && detectedType === "timestamp") ||
    (palantirType === "timestamp" && detectedType === "date") ||
    (palantirType === "timestamp" && detectedType === "integer") // epoch
  ) {
    return true;
  }

  // Integer can become boolean (0/1)
  if (palantirType === "boolean" && detectedType === "integer") return true;

  // Any scalar can become a string
  if (palantirType === "string") return true;

  // Array types: element type must be coercible
  if (palantirType.endsWith("_array") && !detectedType.endsWith("_array")) {
    const elementType = palantirType.replace(/_array$/, "");
    return isTypeCoercible(elementType, detectedType);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { convertValue, isTypeCompatible, isTypeCoercible };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/utils/typeConverter.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
      /* v8 ignore next 2 */
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  function assertThrows(fn: () => void, label: string): void {
    try {
      fn();
      /* v8 ignore next 2 */
      failed++;
      console.error(`  FAIL (expected throw): ${label}`);
    } catch {
      passed++;
    }
  }

  function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
    if (Math.abs(actual - expected) <= tolerance) {
      passed++;
    } else {
      /* v8 ignore next 2 */
      failed++;
      console.error(`  FAIL: ${label} (expected ~${expected}, got ${actual})`);
    }
  }

  console.log("Running typeConverter (utils) self-tests...\n");

  // =====================================================================
  // convertValue — null/empty handling
  // =====================================================================
  console.log("--- null/empty handling ---");

  assert(convertValue(null, "string") === null, "null → null");
  assert(convertValue(undefined, "string") === null, "undefined → null");
  assert(convertValue("", "integer") === null, "empty string → null");
  assert(convertValue("  ", "double") === null, "whitespace → null");
  assert(convertValue("null", "string") === null, "'null' string → null");
  assert(convertValue("N/A", "integer") === null, "'N/A' → null");
  assert(convertValue("NULL", "boolean") === null, "'NULL' → null");

  // =====================================================================
  // convertValue — string
  // =====================================================================
  console.log("\n--- string ---");

  assert(convertValue("hello", "string") === "hello", "string: simple");
  assert(convertValue("  spaces  ", "string") === "spaces", "string: trimmed");
  assert(convertValue(42, "string") === "42", "string: from number");

  // =====================================================================
  // convertValue — boolean
  // =====================================================================
  console.log("\n--- boolean ---");

  assert(convertValue("true", "boolean") === true, "bool: 'true'");
  assert(convertValue("false", "boolean") === false, "bool: 'false'");
  assert(convertValue("yes", "boolean") === true, "bool: 'yes'");
  assert(convertValue("no", "boolean") === false, "bool: 'no'");
  assert(convertValue("1", "boolean") === true, "bool: '1'");
  assert(convertValue("0", "boolean") === false, "bool: '0'");
  assert(convertValue("on", "boolean") === true, "bool: 'on'");
  assert(convertValue("off", "boolean") === false, "bool: 'off'");
  assert(convertValue("yego", "boolean") === true, "bool: 'yego' (Kinyarwanda yes)");
  assert(convertValue("oya", "boolean") === false, "bool: 'oya' (Kinyarwanda no)");
  assert(convertValue(true, "boolean") === true, "bool: true literal");
  assert(convertValue(false, "boolean") === false, "bool: false literal");
  assert(convertValue(1, "boolean") === true, "bool: 1 literal");
  assert(convertValue(0, "boolean") === false, "bool: 0 literal");
  assertThrows(() => convertValue("maybe", "boolean"), "bool: 'maybe' throws");

  // =====================================================================
  // convertValue — integer
  // =====================================================================
  console.log("\n--- integer ---");

  assert(convertValue("42", "integer") === 42, "int: '42'");
  assert(convertValue("-100", "integer") === -100, "int: '-100'");
  assert(convertValue("1,000,000", "integer") === 1000000, "int: thousands separator");
  assert(convertValue("$1,500", "integer") === 1500, "int: currency + thousands");
  assert(convertValue("RWF 50000", "integer") === 50000, "int: RWF currency");
  assert(convertValue(42, "integer") === 42, "int: number literal");
  assertThrows(() => convertValue("abc", "integer"), "int: 'abc' throws");
  assertThrows(() => convertValue("3000000000", "integer"), "int: overflow throws");
  assertThrows(() => convertValue(3.14, "integer"), "int: float literal throws");

  // =====================================================================
  // convertValue — European decimals
  // =====================================================================
  console.log("\n--- European decimals ---");

  assertClose(
    convertValue("1234,56", "double", { locale: "rw" }),
    1234.56, 0.001,
    "eu decimal: '1234,56' → 1234.56"
  );
  assertClose(
    convertValue("1.234,56", "double", { locale: "rw" }),
    1234.56, 0.001,
    "eu decimal: '1.234,56' → 1234.56"
  );
  assertClose(
    convertValue("1.234.567,89", "double", { locale: "eu" }),
    1234567.89, 0.01,
    "eu decimal: '1.234.567,89' → 1234567.89"
  );

  // US format (default)
  assertClose(
    convertValue("1,234.56", "double"),
    1234.56, 0.001,
    "us decimal: '1,234.56' → 1234.56"
  );

  // Auto-detect European (comma after dot)
  assertClose(
    convertValue("1.234,56", "double"),
    1234.56, 0.001,
    "auto-detect eu: '1.234,56' → 1234.56"
  );

  // =====================================================================
  // convertValue — date (DD/MM/YYYY Rwanda default)
  // =====================================================================
  console.log("\n--- date (DD/MM/YYYY) ---");

  assert(convertValue("2025-03-11", "date") === "2025-03-11", "date: ISO");
  assert(convertValue("15/03/2025", "date") === "2025-03-15", "date: DD/MM/YYYY");
  assert(
    convertValue("03/11/2025", "date") === "2025-11-03",
    "date: DD/MM/YYYY ambiguous → day=3, month=11"
  );
  assert(
    convertValue("03/11/2025", "date", { dateFormat: "mdy" }) === "2025-03-11",
    "date: MM/DD/YYYY with mdy hint"
  );
  assert(convertValue("25/12/2025", "date") === "2025-12-25", "date: unambiguous DD/MM");
  assert(convertValue("11-Mar-2025", "date") === "2025-03-11", "date: DD-Mon-YYYY");
  assert(convertValue("Mar 11, 2025", "date") === "2025-03-11", "date: Mon DD, YYYY");
  assertThrows(() => convertValue("not-a-date", "date"), "date: invalid throws");
  assertThrows(() => convertValue("2025-02-30", "date"), "date: Feb 30 throws");

  // Dot-separated dates (common in some EU formats)
  assert(convertValue("15.03.2025", "date") === "2025-03-15", "date: DD.MM.YYYY (dot)");

  // =====================================================================
  // convertValue — 2-digit years (spreadsheet exports)
  // =====================================================================
  console.log("\n--- date (2-digit year) ---");

  assert(
    convertValue("7/30/23", "date") === "2023-07-30",
    "date2y: '7/30/23' unambiguous MDY overrides dmy default"
  );
  assert(
    convertValue("30/7/23", "date") === "2023-07-30",
    "date2y: '30/7/23' unambiguous DMY"
  );
  assert(
    convertValue("7/6/23", "date") === "2023-06-07",
    "date2y: ambiguous under dmy default → day=7 month=6"
  );
  assert(
    convertValue("7/6/23", "date", { dateFormat: "mdy" }) === "2023-07-06",
    "date2y: ambiguous with mdy hint → month=7 day=6"
  );
  assert(
    convertValue("30/7/23", "date", { dateFormat: "mdy" }) === "2023-07-30",
    "date2y: unambiguous DMY wins over mdy hint"
  );
  // Century pivot at the strptime %y boundary.
  assert(convertValue("1/1/68", "date") === "2068-01-01", "date2y: 68 → 2068");
  assert(convertValue("1/1/69", "date") === "1969-01-01", "date2y: 69 → 1969");
  assert(convertValue("1/1/99", "date") === "1999-01-01", "date2y: 99 → 1999");
  assert(convertValue("1/1/00", "date") === "2000-01-01", "date2y: 00 → 2000");
  // Dash and dot separators with 2-digit years.
  assert(convertValue("30-7-23", "date") === "2023-07-30", "date2y: dash separator");
  assert(convertValue("30.7.23", "date") === "2023-07-30", "date2y: dot separator");
  // 4-digit-year behaviour must not regress.
  assert(convertValue("15/03/2025", "date") === "2025-03-15", "date2y: 4-digit still works");
  assertThrows(() => convertValue("13/13/23", "date"), "date2y: month 13 both ways throws");
  assertThrows(() => convertValue("2/30/23", "date"), "date2y: Feb 30 throws");

  // =====================================================================
  // inferDateFormat
  // =====================================================================
  console.log("\n--- inferDateFormat ---");

  assert(
    inferDateFormat(["7/6/23", "7/30/23", "6/2/23"]) === "mdy",
    "infer: one month>12-in-p2 value proves mdy"
  );
  assert(
    inferDateFormat(["7/6/23", "30/7/23", "2/6/23"]) === "dmy",
    "infer: one day-first value proves dmy"
  );
  assert(
    inferDateFormat(["7/6/23", "1/2/23"]) === null,
    "infer: all-ambiguous → null (no opinion)"
  );
  assert(inferDateFormat([]) === null, "infer: empty → null");
  assert(
    inferDateFormat(["2025-03-11", "not-a-date", null, 42]) === null,
    "infer: non-slash / non-string values ignored"
  );
  assert(
    inferDateFormat(["7/30/23", "30/7/23"]) === null,
    "infer: tied conflicting evidence → null"
  );
  assert(
    inferDateFormat(["7/30/23", "8/31/23", "30/7/23"]) === "mdy",
    "infer: majority wins on mixed evidence"
  );
  assert(
    inferDateFormat(["03/11/2025", "12/25/2025"]) === "mdy",
    "infer: works with 4-digit years too"
  );

  // =====================================================================
  // convertValue — timestamp
  // =====================================================================
  console.log("\n--- timestamp ---");

  assert(
    convertValue("2025-03-11T10:30:00.000Z", "timestamp") === "2025-03-11T10:30:00.000Z",
    "ts: full ISO"
  );
  {
    const ts = convertValue("2025-03-11 10:30:00", "timestamp");
    assert(typeof ts === "string" && ts.includes("2025-03-11"), "ts: space separator");
  }
  {
    const ts = convertValue("1741651800000", "timestamp");
    assert(typeof ts === "string" && ts.includes("T"), "ts: epoch ms → ISO");
  }
  {
    const ts = convertValue("1741651800", "timestamp");
    assert(typeof ts === "string" && ts.includes("T"), "ts: epoch sec → ISO");
  }
  assertThrows(() => convertValue("not-a-timestamp", "timestamp"), "ts: invalid throws");

  // =====================================================================
  // convertValue — geopoint
  // =====================================================================
  console.log("\n--- geopoint ---");

  {
    const gp = convertValue("-1.9403,29.8739", "geopoint");
    assert(gp.lat === -1.9403 && gp.lon === 29.8739, "geo: comma-separated");
  }
  {
    const gp = convertValue("-1.9403 29.8739", "geopoint");
    assert(gp.lat === -1.9403 && gp.lon === 29.8739, "geo: space-separated");
  }
  {
    const gp = convertValue({ lat: -1.9403, lon: 29.8739 }, "geopoint");
    assert(gp.lat === -1.9403, "geo: object");
  }
  {
    const gp = convertValue("[29.8739,-1.9403]", "geopoint");
    assert(gp.lat === -1.9403 && gp.lon === 29.8739, "geo: GeoJSON array [lon,lat]");
  }
  assertThrows(() => convertValue("91,0", "geopoint"), "geo: lat out of range");
  assertThrows(() => convertValue("0,181", "geopoint"), "geo: lon out of range");

  // =====================================================================
  // convertValue — arrays (pipe-delimited)
  // =====================================================================
  console.log("\n--- arrays ---");

  {
    const arr = convertValue("python|java|sql", "string_array");
    assert(
      Array.isArray(arr) && arr.length === 3 && arr[0] === "python",
      "arr: pipe-delimited strings"
    );
  }
  {
    const arr = convertValue("1|2|3", "integer_array");
    assert(
      Array.isArray(arr) && arr.length === 3 && arr[0] === 1,
      "arr: pipe-delimited integers"
    );
  }
  {
    const arr = convertValue('["a","b","c"]', "string_array");
    assert(
      Array.isArray(arr) && arr.length === 3 && arr[0] === "a",
      "arr: JSON array"
    );
  }
  {
    const arr = convertValue("true|false|yes", "boolean_array");
    assert(
      Array.isArray(arr) && arr[0] === true && arr[1] === false && arr[2] === true,
      "arr: boolean array"
    );
  }
  {
    // Custom delimiter
    const arr = convertValue("a;b;c", "string_array", { arrayDelimiter: ";" });
    assert(Array.isArray(arr) && arr.length === 3, "arr: custom delimiter");
  }

  // =====================================================================
  // convertValue — struct/geoshape passthrough
  // =====================================================================
  console.log("\n--- struct/geoshape ---");

  {
    const s = convertValue('{"street":"123 Main","zip":"12345"}', "struct");
    assert(s.street === "123 Main", "struct: JSON string parsed");
  }
  {
    const s = convertValue({ street: "123 Main" }, "struct");
    assert(s.street === "123 Main", "struct: object passthrough");
  }
  assertThrows(() => convertValue("not json", "struct"), "struct: invalid JSON throws");

  // =====================================================================
  // isTypeCompatible
  // =====================================================================
  console.log("\n--- isTypeCompatible ---");

  assert(isTypeCompatible("string", "string") === true, "compat: same type");
  assert(isTypeCompatible("long", "integer") === true, "compat: long ← integer");
  assert(isTypeCompatible("double", "integer") === true, "compat: double ← integer");
  assert(isTypeCompatible("timestamp", "date") === true, "compat: timestamp ← date");
  assert(isTypeCompatible("integer", "string") === false, "compat: integer ← string = false");
  assert(isTypeCompatible("boolean", "integer") === false, "compat: boolean ← integer = false");
  assert(isTypeCompatible("date", "timestamp") === false, "compat: date ← timestamp = false");
  assert(isTypeCompatible("string_array", "string") === true, "compat: string_array ← string");

  // =====================================================================
  // isTypeCoercible
  // =====================================================================
  console.log("\n--- isTypeCoercible ---");

  assert(isTypeCoercible("string", "string") === true, "coerce: same type");
  assert(isTypeCoercible("integer", "string") === true, "coerce: integer ← string");
  assert(isTypeCoercible("date", "string") === true, "coerce: date ← string");
  assert(isTypeCoercible("double", "integer") === true, "coerce: double ← integer");
  assert(isTypeCoercible("integer", "double") === true, "coerce: integer ← double");
  assert(isTypeCoercible("boolean", "integer") === true, "coerce: boolean ← integer");
  assert(isTypeCoercible("timestamp", "date") === true, "coerce: timestamp ← date");
  assert(isTypeCoercible("date", "timestamp") === true, "coerce: date ← timestamp");
  assert(isTypeCoercible("string", "integer") === true, "coerce: string ← anything");
  assert(isTypeCoercible("timestamp", "integer") === true, "coerce: timestamp ← integer (epoch)");
  assert(isTypeCoercible("geopoint", "integer") === false, "coerce: geopoint ← integer = false");
  assert(isTypeCoercible("boolean", "date") === false, "coerce: boolean ← date = false");
  assert(isTypeCoercible("integer_array", "integer") === true, "coerce: int_array ← integer");
  assert(isTypeCoercible("string_array", "double") === true, "coerce: str_array ← double (element coercible)");

  // =====================================================================
  // Edge cases
  // =====================================================================
  console.log("\n--- edge cases ---");

  // Percentage parsing
  assertClose(convertValue("50%", "double"), 0.5, 0.001, "pct: '50%' → 0.5");
  assertClose(convertValue("100%", "double"), 1.0, 0.001, "pct: '100%' → 1.0");

  // FRW currency (alternative Rwandan Franc abbreviation)
  assert(convertValue("FRW 5000", "integer") === 5000, "currency: FRW");

  // Long type
  assert(convertValue("9007199254740991", "long") === 9007199254740991, "long: MAX_SAFE_INTEGER");

  // Byte range
  assert(convertValue("127", "byte") === 127, "byte: max");
  assert(convertValue("-128", "byte") === -128, "byte: min");
  assertThrows(() => convertValue("200", "byte"), "byte: overflow");

  // Short range
  assert(convertValue("32767", "short") === 32767, "short: max");
  assertThrows(() => convertValue("40000", "short"), "short: overflow");

  // Unknown type falls back to string
  assert(convertValue("hello", "custom_type") === "hello", "unknown type: string fallback");

  // =====================================================================
  // Summary
  // =====================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll typeConverter (utils) tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests().catch((err) => {
    console.error("Self-test error:", err);
    /* v8 ignore next */
    process.exit(1);
  });
}
/* v8 ignore stop */
