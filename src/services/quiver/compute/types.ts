/**
 * B5 — Compute coordinator types.
 */

export type CacheBehavior = 'READ_WRITE' | 'READ_ONLY' | 'BYPASS' | 'REFRESH';

export interface ComputeCardRequest {
  analysisRid: string;
  cardId: string;
  parameterOverrides: Record<string, unknown>;
  branch: string;
  /** Relative deadline budget, ms — body-side fallback when X-Deadline absent. */
  deadlineMs?: number;
  cacheBehavior: CacheBehavior;
}

export type CardResultStatus = 'OK' | 'PARTIAL' | 'EMPTY';

export interface CardResult {
  cardId: string;
  cardType: string;
  resultType: string;
  status: CardResultStatus;
  payload: unknown;
  /** Stable hash over result payload — used as upstream input to dependents. */
  contentHash: string;
  computedAtMs: number;
  cacheOutcome: 'hit' | 'miss' | 'bypass';
  ontologyVersion: string;
  branch: string;
}

export interface BackendExecuteInput {
  cardId: string;
  cardType: string;
  config: Record<string, unknown>;
  upstreamResults: ReadonlyMap<string, CardResult>;
  branch: string;
  parameterOverrides: Record<string, unknown>;
  /** Remaining deadline budget at the moment dispatch begins. */
  remainingMs: number;
  /** Original analysis RID, propagated to backends that audit by analysis. */
  analysisRid: string;
}

export interface BackendExecuteOutput {
  resultType: string;
  payload: unknown;
  /** Optional override hash; defaults to SHA256(canonicalJson(payload)). */
  contentHash?: string;
  status?: CardResultStatus;
}

export interface CardBackend {
  readonly cardType: string;
  /** Backend display name for metrics labels (bounded set). */
  readonly backendName: string;
  execute(input: BackendExecuteInput): Promise<BackendExecuteOutput>;
}
