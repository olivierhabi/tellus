/**
 * B5 — Cache key + config hash unit tests.
 *
 * Contracts covered:
 *   B5 C-04 — cache key stable under upstream-hash reordering at input
 *             (1000 random shuffles → identical cache keys).
 *   B5 C-05 — configHash uses canonicalJson; ignores parameterOverrides
 *             not in the card's parameter dependencies.
 */

import { describe, it, expect } from "vitest";
import { computeCacheKey, computeConfigHash, canonicalJson, sha256Hex } from "../../../src/services/quiver/compute/cacheKey";

describe("B5 C-04: cacheKey stable under upstream-hash reorder", () => {
  it("1000 random permutations produce identical cache keys", () => {
    const upstreamHashes = Array.from({ length: 7 }, (_, i) => sha256Hex(`u-${i}`));
    const base = computeCacheKey({
      cardId: "$A",
      configHash: "abc",
      upstreamHashes,
      branch: "master",
      ontologyVersionForBranch: "v1",
    });
    for (let i = 0; i < 1000; i++) {
      const shuffled = [...upstreamHashes].sort(() => Math.random() - 0.5);
      const k = computeCacheKey({
        cardId: "$A",
        configHash: "abc",
        upstreamHashes: shuffled,
        branch: "master",
        ontologyVersionForBranch: "v1",
      });
      expect(k).toBe(base);
    }
  });

  it("changing branch → different cache key", () => {
    const a = computeCacheKey({ cardId: "$A", configHash: "x", upstreamHashes: [], branch: "master", ontologyVersionForBranch: "v1" });
    const b = computeCacheKey({ cardId: "$A", configHash: "x", upstreamHashes: [], branch: "feature", ontologyVersionForBranch: "v1" });
    expect(a).not.toBe(b);
  });

  it("changing ontology version → different cache key", () => {
    const a = computeCacheKey({ cardId: "$A", configHash: "x", upstreamHashes: [], branch: "m", ontologyVersionForBranch: "v1" });
    const b = computeCacheKey({ cardId: "$A", configHash: "x", upstreamHashes: [], branch: "m", ontologyVersionForBranch: "v2" });
    expect(a).not.toBe(b);
  });

  it("changing cardId → different cache key", () => {
    const a = computeCacheKey({ cardId: "$A", configHash: "x", upstreamHashes: [], branch: "m", ontologyVersionForBranch: "v" });
    const b = computeCacheKey({ cardId: "$B", configHash: "x", upstreamHashes: [], branch: "m", ontologyVersionForBranch: "v" });
    expect(a).not.toBe(b);
  });
});

describe("B5 C-05: configHash uses canonicalJson; ignores irrelevant overrides", () => {
  it("configHash deterministic under key reorder in config", () => {
    const a = computeConfigHash({ config: { x: 1, y: 2 }, parameterOverrides: {}, parameterDependencies: [] });
    const b = computeConfigHash({ config: { y: 2, x: 1 }, parameterOverrides: {}, parameterDependencies: [] });
    expect(a).toBe(b);
  });

  it("parameter override not in dependencies does not affect hash", () => {
    const deps = ["$P_FILTER"];
    const a = computeConfigHash({ config: {}, parameterOverrides: { $P_OTHER: "val" }, parameterDependencies: deps });
    const b = computeConfigHash({ config: {}, parameterOverrides: {}, parameterDependencies: deps });
    expect(a).toBe(b);
  });

  it("parameter override in dependencies affects hash", () => {
    const deps = ["$P_FILTER"];
    const a = computeConfigHash({ config: {}, parameterOverrides: { $P_FILTER: "x" }, parameterDependencies: deps });
    const b = computeConfigHash({ config: {}, parameterOverrides: { $P_FILTER: "y" }, parameterDependencies: deps });
    expect(a).not.toBe(b);
  });
});

describe("canonicalJson basic invariants", () => {
  it("sorts object keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson(NaN)).toThrow();
    expect(() => canonicalJson(Infinity)).toThrow();
  });
});
