// B07 — chaos: cycle injection across filter dependency graphs.
//
// Spec §B07 acceptance: "Cycle injection — a filter variable transitively
// references its own consumer through chained filterByVariable constraints.
// Detected with `Tellus:Workshop:CircularFilterReference` 400."
//
// We fuzz random DAGs of size up to 20 nodes, then inject one back-edge
// that closes a cycle of random length. The detector MUST find a cycle
// every time, and the cycle path it returns MUST start and end on the
// same node and MUST consist of nodes that are reachable from the root.
//
// Contract IDs:
//   B07 chaos C-01 — random injected cycle is always detected
//   B07 chaos C-02 — acyclic random graph is never reported as cyclic
//   B07 chaos C-03 — the detector throws Tellus:Workshop:CircularFilterReference
//                    with `parameters.cycle` set to the cycle path

import { describe, expect, it } from "vitest";
import {
  assertNoFilterCycle,
  findFilterCycle,
  type FilterDependencyGraph,
} from "../../../src/services/workshop/filterCompiler";

function mkNodeId(i: number): string {
  return `v_${i}`;
}

function buildRandomDag(
  rng: () => number,
  size: number,
): { edges: Map<string, string[]>; nodes: string[] } {
  const nodes = Array.from({ length: size }, (_, i) => mkNodeId(i));
  const edges = new Map<string, string[]>();
  for (let i = 0; i < size; i++) edges.set(nodes[i], []);
  // Edges only point from lower index → higher index → guaranteed acyclic.
  for (let i = 0; i < size; i++) {
    const fanout = Math.floor(rng() * 3);
    for (let k = 0; k < fanout; k++) {
      const j = i + 1 + Math.floor(rng() * Math.max(1, size - i - 1));
      if (j < size) edges.get(nodes[i])!.push(nodes[j]);
    }
  }
  return { edges, nodes };
}

function injectCycle(
  edges: Map<string, string[]>,
  nodes: string[],
  rng: () => number,
): { from: string; to: string; expectedLength: number } {
  // Pick from > to to create a back-edge.
  const fromIdx = 1 + Math.floor(rng() * (nodes.length - 1));
  const toIdx = Math.floor(rng() * fromIdx);
  const from = nodes[fromIdx];
  const to = nodes[toIdx];
  edges.get(from)!.push(to);
  // To ensure the cycle is reachable from `to`, we ensure there's a
  // forward path from `to` to `from` by adding direct edges along the
  // chain to → to+1 → ... → from. That's the "expectedLength" of the
  // simplest cycle.
  for (let k = toIdx; k < fromIdx; k++) {
    if (!edges.get(nodes[k])!.includes(nodes[k + 1])) {
      edges.get(nodes[k])!.push(nodes[k + 1]);
    }
  }
  return { from, to, expectedLength: fromIdx - toIdx + 1 };
}

function makeGraph(edges: Map<string, string[]>): FilterDependencyGraph {
  return { edges };
}

// Tiny seeded RNG so the fuzz is reproducible.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("B07 chaos — filter dependency cycle injection", () => {
  it("B07 chaos C-01: 200 random injected cycles are always detected", () => {
    const rng = lcg(0xc0ffee);
    let detected = 0;
    for (let trial = 0; trial < 200; trial++) {
      const size = 5 + Math.floor(rng() * 15);
      const { edges, nodes } = buildRandomDag(rng, size);
      const { to } = injectCycle(edges, nodes, rng);
      const cycle = findFilterCycle(to, makeGraph(edges));
      expect(cycle, `cycle from root=${to} on trial ${trial}`).not.toBeNull();
      expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
      detected++;
    }
    expect(detected).toBe(200);
  });

  it("B07 chaos C-02: 200 acyclic random graphs are never reported as cyclic", () => {
    const rng = lcg(0xfeed);
    for (let trial = 0; trial < 200; trial++) {
      const size = 5 + Math.floor(rng() * 15);
      const { edges, nodes } = buildRandomDag(rng, size);
      // Test from every node — none should report a cycle since the
      // construction is strictly forward.
      for (const root of nodes) {
        const cycle = findFilterCycle(root, makeGraph(edges));
        expect(cycle, `unexpected cycle root=${root} trial=${trial}`).toBeNull();
      }
    }
  });

  it(
    "B07 chaos C-03: assertNoFilterCycle throws Tellus:Workshop:CircularFilterReference",
    () => {
      const edges = new Map<string, string[]>([
        ["v_a", ["v_b"]],
        ["v_b", ["v_c"]],
        ["v_c", ["v_a"]], // back-edge — closes the cycle
      ]);
      try {
        assertNoFilterCycle("v_a", { edges });
        throw new Error("expected throw");
      } catch (err) {
        const e = err as {
          errorName: string;
          httpStatus: number;
          parameters: { cycle: string[] };
        };
        expect(e.errorName).toBe("Tellus:Workshop:CircularFilterReference");
        expect(e.httpStatus).toBe(400);
        expect(e.parameters.cycle).toEqual(["v_a", "v_b", "v_c", "v_a"]);
      }
    },
  );

  it(
    "B07 chaos C-04: assertNoFilterCycle is a no-op on a strictly forward DAG",
    () => {
      const edges = new Map<string, string[]>([
        ["v_a", ["v_b", "v_c"]],
        ["v_b", ["v_d"]],
        ["v_c", ["v_d"]],
        ["v_d", []],
      ]);
      // No throw → contract met.
      assertNoFilterCycle("v_a", { edges });
    },
  );

  it("B07 chaos C-05: self-loop is detected with cycle = [n, n]", () => {
    const edges = new Map<string, string[]>([
      ["v_self", ["v_self"]],
    ]);
    const cycle = findFilterCycle("v_self", { edges });
    expect(cycle).toEqual(["v_self", "v_self"]);
  });
});
