// ─── CSV Serialization (RFC 4180) ───────────────────────────────────────────
//
// Extracted from services/deploymentService.ts (god-file breakup). Pure
// functions — no I/O, no env reads — so the wire format of deploy CSV
// artifacts is unit-testable in isolation.

export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function rowsToCsvBuffer(
  columns: Array<{ name: string; type: string }>,
  rows: Array<Record<string, unknown>>,
): Buffer {
  const header = columns.map((c) => escapeCsvField(c.name)).join(',');
  const lines = [header];
  for (const row of rows) {
    const line = columns.map((c) => escapeCsvField(row[c.name])).join(',');
    lines.push(line);
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf-8');
}
