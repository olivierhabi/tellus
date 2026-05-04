/**
 * B5 — Stub backends.
 *
 * v1 register-only stubs that produce deterministic output based on inputs.
 * B6 (OBJECT_SET / OSS), B7 (TRANSFORM_TABLE / MATERIALIZATION / Polars-Spark),
 * B8 (TIME_SERIES / Codex), B9 (AIP) replace these with real implementations.
 *
 * Stubs are deliberately shape-correct: their `resultType` matches the card's
 * declared output type per the registry, and their `contentHash` is stable
 * across calls with identical inputs (so cache-key derivation can be
 * exercised end-to-end before B6+ ship).
 */

import { sha256Hex, canonicalJson } from './cacheKey';
import type { CardBackend, BackendExecuteInput, BackendExecuteOutput, CardResultStatus } from './types';
import { getCardType } from '../dag/cardTypeRegistry';
import type { CardType, OutputType } from '../types';

function deterministicPayload(cardType: string, input: BackendExecuteInput): unknown {
  // Echo of (cardType, config, upstream content hashes, parameter overrides).
  return {
    backend: 'stub',
    cardType,
    cardId: input.cardId,
    branch: input.branch,
    config: input.config,
    upstream: Array.from(input.upstreamResults.entries()).map(([id, r]) => ({
      cardId: id,
      contentHash: r.contentHash,
      resultType: r.resultType,
    })),
    parameterOverrides: input.parameterOverrides,
  };
}

function makeStub(cardType: CardType, backendName: string): CardBackend {
  const entry = getCardType(cardType);
  if (!entry) {
    throw new Error(`stub backend declared for unknown cardType=${cardType}`);
  }
  const declaredOutput: OutputType | 'ANY' = entry.output;
  return {
    cardType,
    backendName,
    async execute(input: BackendExecuteInput): Promise<BackendExecuteOutput> {
      const payload = deterministicPayload(cardType, input);
      const status: CardResultStatus = 'OK';
      // ANY output for FUNCTION_CALL etc. — synthesize a TRANSFORM_TABLE-shaped echo.
      const resultType = declaredOutput === 'ANY' ? 'TRANSFORM_TABLE' : (declaredOutput as string);
      return {
        resultType,
        payload,
        status,
        contentHash: sha256Hex(canonicalJson(payload)),
      };
    },
  };
}

/**
 * Map every registry cardType → its v1 stub backend, with the appropriate
 * `backendName` label (bounded set per G-09).
 *
 * Mapping:
 *   OBJECT_SET, FILTER_OBJECT_SET, SEARCH_AROUND, AGGREGATION, JOIN_OBJECT_SETS → OSS
 *   TRANSFORM_TABLE                                                                     → POLARS
 *   MATERIALIZATION                                                                     → MMDP
 *   TIME_SERIES, ROLLING_AGGREGATE, EVENT_SET, TIME_SERIES_PLOT                          → CODEX
 *   FUNCTION_CALL                                                                       → FUNCTIONS
 *   AIP_GENERATE_RESULT*, AIP_*                                                          → AIP_LOGIC
 *   PARAMETER_*, BOOLEAN_FORMULA, EXPRESSION, CHART, MAP, OBJECT_TABLE, OBJECT_DETAIL,
 *   ACTION_BUTTON, MARKDOWN                                                              → INLINE
 */
const BACKEND_MAP: Record<string, string> = {
  // OSS-bound (Object Set Service)
  OBJECT_SET: 'OSS',
  FILTER_OBJECT_SET: 'OSS',
  SEARCH_AROUND: 'OSS',
  AGGREGATION: 'OSS',
  PROPERTY_VALUE_SELECT: 'OSS',
  // Materialization
  TRANSFORM_TABLE: 'POLARS',
  PIVOT_TABLE: 'POLARS',
  MATERIALIZATION: 'MMDP',
  JOIN_MATERIALIZATION: 'MMDP',
  // Time-series (Codex)
  ROLLING_AGGREGATE: 'CODEX',
  EVENT_SET: 'CODEX',
  TIME_SERIES_PLOT: 'CODEX',
  TIME_SERIES_FORMULA: 'CODEX',
  // Functions / Actions
  FUNCTION_CALL: 'FUNCTIONS',
  VISUAL_FUNCTION_CALL: 'FUNCTIONS',
  ACTION_BUTTON: 'FUNCTIONS',
  // Inline (CPU-only formulae and presentation cards)
  PARAMETER_STRING: 'INLINE',
  PARAMETER_NUMBER: 'INLINE',
  PARAMETER_DATETIME: 'INLINE',
  PARAMETER_BOOLEAN: 'INLINE',
  BOOLEAN_FORMULA: 'INLINE',
  NUMERIC_FORMULA: 'INLINE',
  EXPRESSION: 'INLINE',
  CATEGORICAL_CHART: 'INLINE',
  TIME_SERIES_CHART: 'INLINE',
  VEGA_PLOT: 'INLINE',
};

export function buildAllStubBackends(): CardBackend[] {
  const out: CardBackend[] = [];
  for (const [type, backendName] of Object.entries(BACKEND_MAP)) {
    out.push(makeStub(type as CardType, backendName));
  }
  return out;
}

export { BACKEND_MAP as STUB_BACKEND_MAP };
