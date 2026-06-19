/**
 * B5 — Executor.
 *
 * Orchestrates the per-card compute path:
 *   1. Plan upstream subgraph (Planner).
 *   2. For each node in topo order:
 *      - derive cache key from upstream contentHashes + this card's config.
 *      - if cacheBehavior allows read and cache has a fresh row → use it.
 *      - otherwise dispatch through BackendRouter (deadline-bounded).
 *      - if cacheBehavior allows write → put.
 *   3. Return the target node's CardResult.
 *
 * Deadlines are honored at the boundary (B5 C-09): if the remaining budget
 * is non-positive entering a dispatch, throw DEADLINE_EXCEEDED before the
 * backend ever sees the call.
 */

import type { AnalysisDocument } from '../types';
import { planSubgraph, CyclicDagError, UnknownCardError, type PlannedNode } from './planner';
import { computeCacheKey, computeConfigHash } from './cacheKey';
import type { BackendRouter } from './backendRouter';
import type { CacheRepository } from './cache';
import {
  parseDeadlineHeader,
  deadlineFromBudget,
  remainingMs,
  DeadlineExceededError,
  type Deadline,
} from './deadline';
import type {
  CacheBehavior,
  ComputeCardRequest,
  CardResult,
  BackendExecuteInput,
} from './types';
import { CircuitOpenError } from './circuitBreaker';

export interface ExecutorDeps {
  router: BackendRouter;
  cache: CacheRepository;
  /** Resolves the active ontology version for a (analysisRid, branch). */
  ontologyVersionResolver: (analysisRid: string, branch: string) => Promise<string>;
  /** Resolves the parameter dependencies of a card (CardId list). */
  parameterDependencies?: (cardId: string, doc: AnalysisDocument) => string[];
  /** Optional clock for tests. */
  now?: () => number;
}

export interface ExecuteOptions {
  /** Optional X-Deadline header value (ISO instant). */
  deadlineHeader?: string;
  /** Body fallback. */
  deadlineMs?: number;
}

export class ComputeExecutor {
  private readonly now: () => number;
  constructor(private readonly deps: ExecutorDeps) {
    this.now = deps.now ?? Date.now;
  }

  async execute(
    doc: AnalysisDocument,
    req: ComputeCardRequest,
    opts: ExecuteOptions = {},
  ): Promise<CardResult> {
    // 1. Compute the deadline (header > body > infinite).
    const deadline = this.resolveDeadline(opts);

    // 2. Plan.
    const plan = planSubgraph(doc, req.cardId);

    // 3. Resolve ontology version once for the branch.
    const ontologyVersion = await this.deps.ontologyVersionResolver(req.analysisRid, req.branch);

    // 4. Walk in topo order. Memoize per-cardId CardResult.
    const memo = new Map<string, CardResult>();

    for (const node of plan) {
      this.assertBudget(deadline);
      const card = (doc.cards as Record<string, any>)[node.cardId];
      const upstreamResults = new Map<string, CardResult>();
      for (const u of node.upstream) {
        const r = memo.get(u);
        if (!r) throw new Error(`planner invariant: missing upstream ${u} before ${node.cardId}`);
        upstreamResults.set(u, r);
      }

      const upstreamHashes = node.upstream.map((u) => upstreamResults.get(u)!.contentHash);
      const parameterDeps = this.deps.parameterDependencies
        ? this.deps.parameterDependencies(node.cardId, doc)
        : [];
      const configHash = computeConfigHash({
        config: card.config ?? {},
        parameterOverrides: req.parameterOverrides,
        parameterDependencies: parameterDeps,
      });
      const cacheKey = computeCacheKey({
        cardId: node.cardId,
        configHash,
        upstreamHashes,
        branch: req.branch,
        ontologyVersionForBranch: ontologyVersion,
      });

      let result: CardResult;
      if (allowsRead(req.cacheBehavior)) {
        const row = await this.deps.cache.getAndTouch(cacheKey);
        if (row) {
          result = {
            cardId: node.cardId,
            cardType: node.cardType,
            resultType: row.resultType,
            status: 'OK',
            payload: row.payload,
            contentHash: row.contentHash,
            computedAtMs: row.computedAt.getTime(),
            cacheOutcome: 'hit',
            ontologyVersion,
            branch: req.branch,
          };
          memo.set(node.cardId, result);
          continue;
        }
      }

      // Cache miss → dispatch.
      this.assertBudget(deadline);
      const remaining = remainingMs(deadline, this.now());
      const input: BackendExecuteInput = {
        cardId: node.cardId,
        cardType: node.cardType,
        config: (card.config ?? {}) as Record<string, unknown>,
        upstreamResults,
        branch: req.branch,
        parameterOverrides: req.parameterOverrides,
        remainingMs: remaining,
        analysisRid: req.analysisRid,
        userSubject: (req as any).userSubject,
      };

      let out;
      try {
        // B5 C-09 / G-06: race the dispatch against the remaining budget so
        // DEADLINE_EXCEEDED is returned at the boundary (not at completion).
        const { withDeadline } = await import('./deadline');
        out = await withDeadline(deadline, async () => this.deps.router.dispatch(node.cardType, input), this.now);
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          throw err;
        }
        if (err instanceof DeadlineExceededError) {
          throw err;
        }
        throw err;
      }

      result = {
        cardId: node.cardId,
        cardType: node.cardType,
        resultType: out.resultType,
        status: out.status ?? 'OK',
        payload: out.payload,
        contentHash: out.contentHash ?? '',
        computedAtMs: this.now(),
        cacheOutcome: req.cacheBehavior === 'BYPASS' ? 'bypass' : 'miss',
        ontologyVersion,
        branch: req.branch,
      };

      if (allowsWrite(req.cacheBehavior)) {
        try {
          const row = await this.deps.cache.put({
            cacheKey,
            analysisRid: req.analysisRid,
            cardId: node.cardId,
            cardType: node.cardType,
            branchRid: req.branch,
            ontologyVersion,
            resultType: out.resultType,
            payload: out.payload,
            contentHash: out.contentHash,
          });
          result.contentHash = row.contentHash;
        } catch (err) {
          // Cache put failures are non-fatal; result still returned.
          // (Surfaced via metrics in routes/quiver/compute.ts.)
        }
      } else if (!result.contentHash) {
        result.contentHash = await sha256OfPayload(result.payload);
      }

      memo.set(node.cardId, result);
    }

    const target = memo.get(req.cardId);
    if (!target) throw new Error(`planner invariant: target ${req.cardId} not memoized`);
    return target;
  }

  private resolveDeadline(opts: ExecuteOptions): Deadline {
    const fromHeader = parseDeadlineHeader(opts.deadlineHeader, this.now());
    if (fromHeader) return fromHeader;
    if (typeof opts.deadlineMs === 'number') return deadlineFromBudget(opts.deadlineMs, this.now());
    // No deadline supplied → very generous budget (5 min) so cache + planner aren't blocked.
    return deadlineFromBudget(300_000, this.now());
  }

  private assertBudget(deadline: Deadline): void {
    const r = remainingMs(deadline, this.now());
    if (r <= 0) {
      throw new DeadlineExceededError(`remaining budget ${r}ms <= 0 at boundary`);
    }
  }
}

function allowsRead(cb: CacheBehavior): boolean {
  return cb === 'READ_WRITE' || cb === 'READ_ONLY';
}

function allowsWrite(cb: CacheBehavior): boolean {
  return cb === 'READ_WRITE' || cb === 'REFRESH';
}

async function sha256OfPayload(payload: unknown): Promise<string> {
  const { canonicalJson, sha256Hex } = await import('./cacheKey');
  return sha256Hex(canonicalJson(payload));
}

export {
  CyclicDagError,
  UnknownCardError,
  DeadlineExceededError,
  CircuitOpenError,
  type PlannedNode,
};
