// ---------------------------------------------------------------------------
// B7 — Shared changelog format for Funnel (spec §B7 line 357, B9 dependency).
//
// Funnel (B9) consumes either:
//   (a) the Kafka topic directly (low-latency path), or
//   (b) the Iceberg `changes_v1` stream view (replayable path).
//
// Both consumers parse the canonical envelope defined here. This file is the
// single source of truth for the schema; B7 emits it, B9 ingests it.
// ---------------------------------------------------------------------------

import { z } from "zod";

export const ChangelogEnvelope = z.object({
  source: z.object({
    schema: z.string(),
    table: z.string(),
  }),
  op: z.enum(["c", "u", "d", "b", "e"]),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  pk: z.record(z.string(), z.unknown()).optional(),
  lsn: z.string().optional(),
  tsMs: z.number().int(),
  txid: z.number().int().optional(),
});
export type ChangelogEnvelopeT = z.infer<typeof ChangelogEnvelope>;

/** Parse a Kafka value (Buffer | string | object) into a typed envelope. */
export function decodeEnvelope(raw: unknown): ChangelogEnvelopeT {
  if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
  if (typeof raw === "string") raw = JSON.parse(raw);
  return ChangelogEnvelope.parse(raw);
}

/**
 * Canonical changelog record type alias. Funnel's batch / streaming extractors
 * consume records of this shape from Iceberg or Kafka.
 */
export type ChangelogRecord = ChangelogEnvelopeT;
