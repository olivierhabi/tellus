// ---------------------------------------------------------------------------
// One-time deterministic redaction of the raw OpenSearch sample captured
// during the FUNN-ISO 2026-07-31 incident (audit #5/#6/#9).
//
// The captured hits contain real data-row values (orderId, itemName,
// customerId UUIDs, dates). Committed evidence must keep the SHAPE (index,
// _id presence, _source keys) but not the VALUES. Each value is replaced by
// a stable typed placeholder: <redacted:uuid> | <redacted:date> |
// <redacted:number> | <redacted:string>. A top-level "_redacted": true marker
// is set. Idempotent: re-running on an already-redacted file is a no-op.
//
// CLI: tsx scripts/evidence/redact-sample.ts [path-to-sample.json]
// ---------------------------------------------------------------------------

import fs from "fs";

export const DEFAULT_SAMPLE_PATH =
  ".migration-evidence/olivierorder-20260731T191845Z/opensearch__olivierorder_sample.json";

const REDACTED_PLACEHOLDER_RE = /^<redacted:[a-z]+>$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/;
const SLASH_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return "<redacted:number>";
  }
  if (typeof value === "string") {
    if (REDACTED_PLACEHOLDER_RE.test(value)) return value;
    if (UUID_RE.test(value)) return "<redacted:uuid>";
    if (ISO_DATE_RE.test(value) || SLASH_DATE_RE.test(value)) return "<redacted:date>";
    if (NUMERIC_RE.test(value)) return "<redacted:number>";
    return "<redacted:string>";
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

export function redactSampleDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const hits = ((doc.hits as Record<string, unknown>)?.hits ?? []) as Array<Record<string, unknown>>;
  const redactedHits = hits.map((hit) => ({
    ...hit,
    // Keep _index and _score verbatim; _id embeds the row's composite primary
    // key, so its VALUE is redacted while its presence is preserved.
    _id: typeof hit._id === "string" && UUID_RE.test(hit._id) ? "<redacted:uuid>" : "<redacted:string>",
    _source: redactValue(hit._source),
  }));
  return {
    _redacted: true,
    ...doc,
    hits: { ...(doc.hits as Record<string, unknown>), hits: redactedHits },
  };
}

export function redactSampleFile(filePath: string): { changed: boolean } {
  const doc = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  if (doc._redacted === true) return { changed: false };
  const redacted = redactSampleDocument(doc);
  fs.writeFileSync(filePath, JSON.stringify(redacted, null, 2) + "\n");
  return { changed: true };
}

if (require.main === module) {
  const filePath = process.argv[2] ?? DEFAULT_SAMPLE_PATH;
  const { changed } = redactSampleFile(filePath);
  console.log(`redact-sample: ${filePath} ${changed ? "redacted" : "already redacted (no-op)"}`);
}
