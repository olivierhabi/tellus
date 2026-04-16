// ---------------------------------------------------------------------------
// piiScanner.ts — regex-based PII detection (Ontology Platform spec Task 30)
// ---------------------------------------------------------------------------
// Detects:
//   • email        → /\S+@\S+\.\S+/
//   • SSN          → /\d{3}-\d{2}-\d{4}/
//   • phone        → /\+?1?\d{10,14}/
//   • credit card  → Luhn-check on /\d{13,19}/
//
// Results are stored in the `pii_scan_result` table. The service does NOT
// auto-apply a marking — it records a suggestion that an admin must
// confirm (per spec rationale: avoid false-positive lockouts).
// ---------------------------------------------------------------------------

import { query } from "../db";

export interface PiiMatch {
  propertyApiName: string;
  detectedType: "email" | "ssn" | "phone" | "credit_card";
  sampleCount: number;
}

const EMAIL_RE = /\b[\w+.-]+@[\w.-]+\.\w{2,}\b/;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const PHONE_RE = /\+?1?\d{10,14}/;
const CARD_RE = /\b\d{13,19}\b/;

/** Luhn check for credit-card candidates. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function detectPii(value: unknown): PiiMatch["detectedType"] | null {
  if (typeof value !== "string") return null;
  if (EMAIL_RE.test(value)) return "email";
  if (SSN_RE.test(value)) return "ssn";
  const cardMatch = value.match(CARD_RE);
  if (cardMatch && luhn(cardMatch[0])) return "credit_card";
  if (PHONE_RE.test(value.replace(/[^\d+]/g, ""))) return "phone";
  return null;
}

/**
 * Scan a sample of property values for an object type and persist any PII
 * hits as suggestions in `pii_scan_result`.
 */
export async function scanObjectType(
  objectTypeId: string,
  samples: Array<Record<string, unknown>>
): Promise<PiiMatch[]> {
  const counts: Record<string, Record<string, number>> = {};

  for (const row of samples) {
    for (const [prop, value] of Object.entries(row)) {
      const detected = detectPii(value);
      if (!detected) continue;
      counts[prop] ??= {};
      counts[prop][detected] = (counts[prop][detected] || 0) + 1;
    }
  }

  const matches: PiiMatch[] = [];
  for (const [propertyApiName, types] of Object.entries(counts)) {
    for (const [detectedType, sampleCount] of Object.entries(types)) {
      matches.push({
        propertyApiName,
        detectedType: detectedType as PiiMatch["detectedType"],
        sampleCount,
      });
      await query(
        `INSERT INTO pii_scan_result
           (object_type_id, property_api_name, detected_type, sample_count)
         VALUES ($1, $2, $3, $4)`,
        [objectTypeId, propertyApiName, detectedType, sampleCount]
      );
    }
  }

  return matches;
}
