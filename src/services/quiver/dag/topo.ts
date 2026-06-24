// Quiver B2 — DAG topological order (Kahn's algorithm) + canvas pruning.
//
// Determinism (B2 C-11): when multiple cards are at the same frontier
// (zero in-degree), we sort by cardId ascending so the output is stable
// across calls.

import type { Card } from "../types";
import { cyclicDag } from "../errors";

export interface DagNode {
  card: Card;
  upstream: string[]; // cardIds
  downstream: string[]; // cardIds
}

export type Dag = ReadonlyMap<string, DagNode>;

export function buildDag(cards: Record<string, Card>): Dag {
  const nodes = new Map<string, DagNode>();
  for (const id of Object.keys(cards)) {
    nodes.set(id, { card: cards[id], upstream: [], downstream: [] });
  }
  for (const id of Object.keys(cards)) {
    const card = cards[id];
    for (const slot of Object.keys(card.inputs ?? {})) {
      const upstreamId = card.inputs[slot];
      if (upstreamId === id) {
        // Self-loop is a cycle.
        throw cyclicDag({ cyclePath: [id] });
      }
      const upNode = nodes.get(upstreamId);
      const cur = nodes.get(id)!;
      if (upNode) {
        cur.upstream.push(upstreamId);
        upNode.downstream.push(id);
      }
      // If upstreamId is not in cards, the validator (separate pass)
      // surfaces an "unknown card" error; topo just skips edges to
      // nonexistent targets so it can still produce a partial order.
    }
  }
  // Stable order on the adjacency lists.
  for (const node of nodes.values()) {
    node.upstream.sort();
    node.downstream.sort();
  }
  return nodes;
}

/**
 * Kahn's algorithm. Throws CYCLIC_DAG with a representative cycle path
 * when no topological order exists.
 *
 * Determinism (B2 C-11): the frontier is sorted by cardId at every step.
 */
export function topologicalOrder(dag: Dag): string[] {
  const inDeg = new Map<string, number>();
  for (const [id, node] of dag) {
    inDeg.set(id, node.upstream.length);
  }
  const frontier: string[] = [];
  for (const [id, deg] of inDeg) if (deg === 0) frontier.push(id);
  frontier.sort();

  const order: string[] = [];
  while (frontier.length > 0) {
    const id = frontier.shift()!;
    order.push(id);
    const node = dag.get(id)!;
    for (const downId of node.downstream) {
      inDeg.set(downId, inDeg.get(downId)! - 1);
      if (inDeg.get(downId) === 0) {
        // Insertion-sorted frontier for stability.
        const i = frontier.findIndex((x) => x > downId);
        if (i < 0) frontier.push(downId);
        else frontier.splice(i, 0, downId);
      }
    }
  }

  if (order.length !== dag.size) {
    // Walk the residual to extract a representative cycle.
    const cycle = findOneCycle(dag, inDeg);
    throw cyclicDag({ cyclePath: cycle });
  }
  return order;
}

function findOneCycle(dag: Dag, inDeg: Map<string, number>): string[] {
  // Pick any node still with in-degree > 0.
  const start = [...inDeg.entries()].find(([, d]) => d > 0)?.[0];
  if (!start) return [];
  const seen = new Set<string>();
  const stack: string[] = [];
  function dfs(node: string): string[] | null {
    if (stack.includes(node)) {
      const i = stack.indexOf(node);
      return [...stack.slice(i), node];
    }
    if (seen.has(node)) return null;
    seen.add(node);
    stack.push(node);
    for (const down of dag.get(node)?.downstream ?? []) {
      if ((inDeg.get(down) ?? 0) > 0) {
        const c = dfs(down);
        if (c) return c;
      }
    }
    stack.pop();
    return null;
  }
  return dfs(start) ?? [start];
}

/**
 * Reachability from `roots` ∪ canvas roots. Returns the set of cardIds
 * NOT reachable — these are candidates for pruning per B2 C-12.
 */
export function pruneUnreferencedCards(
  dag: Dag,
  retainedRoots: readonly string[],
): string[] {
  const reach = new Set<string>();
  function visit(id: string): void {
    if (reach.has(id)) return;
    reach.add(id);
    const node = dag.get(id);
    if (!node) return;
    for (const up of node.upstream) visit(up);
  }
  for (const r of retainedRoots) visit(r);
  const orphans: string[] = [];
  for (const id of dag.keys()) {
    if (!reach.has(id)) orphans.push(id);
  }
  orphans.sort();
  return orphans;
}
