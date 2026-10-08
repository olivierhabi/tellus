import type { PoolClient, QueryResult } from "pg";
import { query } from "../db";
import { incCounter, observeHistogram } from "../services/funnel/metrics";

export interface GeneratedSequenceSource {
  readonly source: "generatedSequence";
  readonly sequenceKey: string;
  readonly prefix: string;
  readonly padLength: number;
  readonly startAt?: number;
}

type SequenceQuery = Pick<PoolClient, "query">;

const MAX_SAFE_SEQUENCE_VALUE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Save-time contract mirror (see validateGeneratedSequenceSource in
 * routes/actionTypes/shared.ts): padLength is an integer from 1 to 18.
 * Allocation clamps to that same range so a legacy or directly-written
 * action config can never mint an identifier the serving index cannot
 * store (OpenSearch caps document _id well below what padLength: 12026
 * produced — a 12k-char evidenceId that wedged the serving projector).
 * Clamping is observable (metric + warn), never silent.
 */
export const GENERATED_SEQUENCE_PAD_MIN = 1;
export const GENERATED_SEQUENCE_PAD_MAX = 18;

export function effectivePadLength(padLength: unknown, sequenceKey: string): number {
  const n =
    typeof padLength === "number" && Number.isInteger(padLength) ? padLength : NaN;
  const clamped = Number.isNaN(n)
    ? GENERATED_SEQUENCE_PAD_MAX
    : Math.min(Math.max(n, GENERATED_SEQUENCE_PAD_MIN), GENERATED_SEQUENCE_PAD_MAX);
  if (clamped !== padLength) {
    incCounter("tellus_action_generated_sequence_clamped_total", {
      sequence_key: sequenceKey,
    });
    console.warn(
      `[generatedSequence] '${sequenceKey}': padLength ${String(padLength)} outside ` +
        `${GENERATED_SEQUENCE_PAD_MIN}..${GENERATED_SEQUENCE_PAD_MAX} — clamped to ${clamped}`,
    );
  }
  return clamped;
}

/** Atomically reserves one number. Gaps are intentional: a value is never
 * reused after an attempt has started, which avoids duplicate business IDs. */
export async function allocateGeneratedSequence(
  ontologyId: string,
  source: GeneratedSequenceSource,
  transactionClient?: SequenceQuery,
): Promise<string> {
  const startAt = source.startAt ?? 1;
  const startedAt = performance.now();
  const runQuery = transactionClient
    ? (text: string, values: unknown[]) => transactionClient.query(text, values)
    : (text: string, values: unknown[]) => query(text, values);
  let result: QueryResult;
  try {
    result = await runQuery(
    `INSERT INTO action_generated_sequence (ontology_id, sequence_key, next_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (ontology_id, sequence_key)
     DO UPDATE SET next_value = action_generated_sequence.next_value + 1
     RETURNING next_value - 1 AS value`,
    [ontologyId, source.sequenceKey, startAt + 1],
    );
    incCounter("tellus_action_generated_sequence_allocations_total", {
      outcome: "success",
    });
  } catch (error) {
    incCounter("tellus_action_generated_sequence_allocations_total", {
      outcome: "failure",
    });
    throw error;
  } finally {
    observeHistogram(
      "tellus_action_generated_sequence_allocation_duration_seconds",
      (performance.now() - startedAt) / 1_000,
    );
  }

  const rawValue = (result.rows[0] as { value?: string | number } | undefined)?.value;
  if (rawValue === undefined) {
    throw new Error("Generated sequence allocation returned no value");
  }
  const numericValue = BigInt(rawValue);
  if (numericValue < 0n || numericValue > MAX_SAFE_SEQUENCE_VALUE) {
    incCounter("tellus_action_generated_sequence_exhausted_total");
    throw new Error(
      `Generated sequence '${source.sequenceKey}' is outside the supported range`,
    );
  }
  const value = numericValue.toString();
  const pad = effectivePadLength(source.padLength, source.sequenceKey);
  return `${source.prefix}${value.padStart(pad, "0")}`;
}

/** Stable, non-reserving identifier used only by validate/preview flows. */
export function previewGeneratedSequence(source: GeneratedSequenceSource): string {
  const value = BigInt(source.startAt ?? 1).toString();
  const pad = effectivePadLength(source.padLength, source.sequenceKey);
  return `${source.prefix}${value.padStart(pad, "0")}`;
}
