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
  return `${source.prefix}${value.padStart(source.padLength, "0")}`;
}

/** Stable, non-reserving identifier used only by validate/preview flows. */
export function previewGeneratedSequence(source: GeneratedSequenceSource): string {
  const value = BigInt(source.startAt ?? 1).toString();
  return `${source.prefix}${value.padStart(source.padLength, "0")}`;
}
