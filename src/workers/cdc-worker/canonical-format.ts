// ---------------------------------------------------------------------------
// B7 — Canonical changelog JSON format (spec §B7 line 354).
//
// Emits the v1 changelog JSON byte-for-byte. The shape matches Debezium-
// flavoured envelopes that Foundry's Magritte emits, so downstream consumers
// (Funnel B9, downstream OS readers) need no migration to swap to Tellus.
//
// Envelope:
//   {
//     "source": { "schema": "...", "table": "..." },
//     "op": "c" | "u" | "d",
//     "before": null | { ... },
//     "after":  null | { ... },
//     "pk":     { "id": 1 },
//     "lsn":    "0/12345AB",
//     "tsMs":   1737301200123,
//     "txid":   42
//   }
//
// Decimals must be strings, times millisecond strings, deletes carry
// `before` (requires REPLICA IDENTITY FULL on the table).
// ---------------------------------------------------------------------------

export interface SourceRef {
  schema: string;
  table: string;
}

export interface CanonicalEvent {
  source: SourceRef;
  op: "c" | "u" | "d" | "b" | "e";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  pk?: Record<string, unknown>;
  lsn?: string;
  tsMs: number;
  txid?: number;
}

/** Normalize a raw pgoutput row to the canonical shape. */
export function toCanonical(
  source: SourceRef,
  op: CanonicalEvent["op"],
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  pkColumns: string[],
  lsn?: string,
  tsMs?: number,
  txid?: number,
): CanonicalEvent {
  const pkSource = after ?? before ?? {};
  const pk: Record<string, unknown> = {};
  for (const c of pkColumns) pk[c] = pkSource[c];
  return {
    source,
    op,
    before: normalizeValues(before),
    after: normalizeValues(after),
    pk: pkColumns.length ? pk : undefined,
    lsn,
    tsMs: tsMs ?? Date.now(),
    txid,
  };
}

function normalizeValues(
  obj: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!obj) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v instanceof Date) {
      out[k] = String(v.getTime());
    } else if (typeof v === "bigint") {
      out[k] = v.toString();
    } else if (Buffer.isBuffer(v)) {
      out[k] = v.toString("base64");
    } else {
      out[k] = v;
    }
  }
  return out;
}
