/**
 * Rwanda QA ingestion boundary.  These functions are deliberately pure so
 * the same checks protect the fixture runner and are directly testable.  In
 * particular, diagnostics never echo a source row: raw ISO-8583 PANs must
 * not escape into an upload name, report, or application log.
 */
import { createHash } from "node:crypto";

export type QuarantineRecord = {
  sourceFile: string;
  rowNumber: number;
  reasonCode: string;
  reason: string;
};

export type CsvTable = { headers: string[]; rows: string[][] };

function parseCsvRow(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(value); value = "";
    } else value += char;
  }
  if (quoted) throw new Error("Malformed CSV: unterminated quoted field");
  values.push(value);
  return values;
}

export function parseCsv(csv: string): CsvTable {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("CSV has no header row");
  const headers = parseCsvRow(lines[0]!).map((header) => header.trim());
  if (!headers.every(Boolean)) throw new Error("CSV contains an empty header");
  return { headers, rows: lines.slice(1).map(parseCsvRow) };
}

function escape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function serializeCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return `${headers.map(escape).join(",")}\n${rows.map((row) => row.map(escape).join(",")).join("\n")}\n`;
}

function luhn(value: string): boolean {
  if (!/^\d{13,19}$/.test(value)) return false;
  let sum = 0; let alternate = false;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    let digit = Number(value[i]);
    if (alternate && (digit *= 2) > 9) digit -= 9;
    sum += digit; alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** Converts raw ISO-8583 field 2 to irreversible token + allowed mask. */
export function sanitizeIso8583Csv(csv: string): string {
  const table = parseCsv(csv);
  const panIndex = table.headers.indexOf("field2Pan");
  if (panIndex < 0) throw new Error("ISO-8583 input is missing field2Pan");
  const headers = table.headers.flatMap((header) => header === "field2Pan" ? ["panToken", "maskedPan"] : [header]);
  const rows = table.rows.map((row, rowIndex) => {
    const pan = row[panIndex] ?? "";
    if (!luhn(pan)) throw new Error(`ISO-8583 row ${rowIndex + 2} has invalid field2Pan`);
    const replacement = [
      `tok_${createHash("sha256").update(pan).digest("hex").slice(0, 24)}`,
      `${pan.slice(0, 6)}******${pan.slice(-4)}`,
    ];
    return row.flatMap((value, index) => index === panIndex ? replacement : [value]);
  });
  return serializeCsv(headers, rows);
}

function iso(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function positive(value: string): boolean { const number = Number(value); return Number.isFinite(number) && number > 0; }

/** Returns only safe reason codes/messages; never copies a rejected value. */
export function quarantineDirtyCsv(sourceFile: string, csv: string): QuarantineRecord[] {
  const { headers, rows } = parseCsv(csv);
  const lookup = (row: string[], name: string) => row[headers.indexOf(name)] ?? "";
  return rows.map((row, index) => {
    const missingKey = !row[0]?.trim();
    let reasonCode = missingKey ? "MISSING_PRIMARY_KEY" : "INVALID_ROW";
    if (!missingKey && sourceFile.includes("loan_applications")) {
      reasonCode = !positive(lookup(row, "requestedLimit")) ? "INVALID_REQUESTED_LIMIT" :
        !["SUBMITTED", "APPROVED", "REJECTED", "ESCALATED"].includes(lookup(row, "status")) ? "INVALID_STATUS" : "INVALID_ROW";
    } else if (!missingKey && sourceFile.includes("tax_clearances")) {
      reasonCode = !lookup(row, "citizenId") ? "MISSING_CITIZEN_ID" :
        !["VALID", "EXPIRED", "REVOKED"].includes(lookup(row, "status")) ? "INVALID_CLEARANCE_STATUS" :
        !iso(lookup(row, "ingestedAt")) ? "INVALID_INGESTED_AT" : "INVALID_ROW";
    } else if (!missingKey && sourceFile.includes("payment_transactions")) {
      reasonCode = !positive(lookup(row, "amount")) ? "INVALID_AMOUNT" : !iso(lookup(row, "createdAt")) ? "INVALID_CREATED_AT" : "INVALID_ROW";
    } else if (!missingKey && sourceFile.includes("latency_samples")) {
      reasonCode = !lookup(row, "routeId") ? "MISSING_ROUTE_ID" : !iso(lookup(row, "measuredAt")) ? "INVALID_MEASURED_AT" :
        Number(lookup(row, "latencyMs")) < 0 || !Number.isFinite(Number(lookup(row, "latencyMs"))) ? "INVALID_LATENCY_MS" : "INVALID_ROW";
    }
    return { sourceFile, rowNumber: index + 2, reasonCode, reason: `Rejected by Rwanda ingestion validation: ${reasonCode}` };
  });
}
