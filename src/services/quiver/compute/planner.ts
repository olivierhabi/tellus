/**
 * B5 — Planner.
 *
 * Per B5 C-02: given a `Dag` (or AnalysisDocument) and a target cardId,
 * return the upstream subgraph in topological order, deduplicated. On
 * cycle, throw — defensive; B2's validator should have prevented it.
 */

import type { AnalysisDocument } from '../types';

export class CyclicDagError extends Error {
  readonly code = 'CYCLIC_DAG';
  constructor(message: string) {
    super(message);
    this.name = 'CyclicDagError';
  }
}

export class UnknownCardError extends Error {
  readonly code = 'UNKNOWN_CARD';
  constructor(public readonly cardId: string) {
    super(`unknown cardId: ${cardId}`);
    this.name = 'UnknownCardError';
  }
}

export interface PlannedNode {
  cardId: string;
  cardType: string;
  upstream: ReadonlyArray<string>;
}

/**
 * Collect upstream cardIds from a card's input slot bindings.
 *
 * Per `Card` zod schema, `inputs` is `Record<string, CardId>` — every value is
 * already a CardId. We dedupe and skip empty strings defensively.
 */
export function upstreamOf(card: any): string[] {
  const inputs = (card?.inputs ?? {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of Object.values(inputs)) {
    if (typeof v === 'string' && v.length > 0 && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Returns the topological order of the upstream subgraph rooted at
 * `targetCardId`, deduplicated, with the target last.
 *
 * Uses iterative DFS (no recursion stack overflow at 500 cards) with
 * grey/black state to detect cycles.
 */
export function planSubgraph(doc: AnalysisDocument, targetCardId: string): PlannedNode[] {
  const cards = (doc.cards ?? {}) as Record<string, any>;
  if (!cards[targetCardId]) {
    throw new UnknownCardError(targetCardId);
  }

  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  // Iterative post-order DFS.
  const stack: Array<{ cardId: string; phase: 'enter' | 'exit' }> = [
    { cardId: targetCardId, phase: 'enter' },
  ];

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.phase === 'enter') {
      if (visited.has(top.cardId)) {
        stack.pop();
        continue;
      }
      if (visiting.has(top.cardId)) {
        // back-edge → cycle
        throw new CyclicDagError(`cycle through ${top.cardId}`);
      }
      const card = cards[top.cardId];
      if (!card) {
        throw new UnknownCardError(top.cardId);
      }
      visiting.add(top.cardId);
      top.phase = 'exit';
      const upstream = upstreamOf(card);
      for (const u of upstream) {
        if (!visited.has(u)) {
          stack.push({ cardId: u, phase: 'enter' });
        }
      }
    } else {
      visiting.delete(top.cardId);
      visited.add(top.cardId);
      order.push(top.cardId);
      stack.pop();
    }
  }

  return order.map((cardId) => {
    const card = cards[cardId];
    return {
      cardId,
      cardType: String(card.type),
      upstream: upstreamOf(card),
    };
  });
}
