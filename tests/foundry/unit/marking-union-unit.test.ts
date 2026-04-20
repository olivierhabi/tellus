// ---------------------------------------------------------------------------
// PB-B7 — unionMarkings property-based checks (unit).
//
// The Funnel mergeStage + Pipeline Builder deploy path both import
// this helper. The risk callout in the PB-B7 spec says "propagation
// MUST be union, not intersection — get this wrong and you leak data".
// This suite exhaustively exercises random marking sets against the
// known set-union invariants.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  unionMarkings,
  userHasAllMarkings,
  missingMarkings,
} from "../../../src/services/markingUnion";

function randomSet(seed: number, vocab: string[]): string[] {
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  return vocab.filter(() => rng() > 0.5);
}

describe("unionMarkings", () => {
  it("drops duplicates and sorts", () => {
    expect(unionMarkings(["B", "A", "B"])).toEqual(["A", "B"]);
  });

  it("ignores null / undefined / empty inputs", () => {
    expect(unionMarkings(null, undefined, [], ["A"])).toEqual(["A"]);
  });

  it("trims whitespace-only strings", () => {
    expect(unionMarkings(["  ", "A", ""])).toEqual(["A"]);
  });

  it("is commutative — order of sources doesn't matter", () => {
    const a = unionMarkings(["A"], ["B"]);
    const b = unionMarkings(["B"], ["A"]);
    expect(a).toEqual(b);
  });

  it("is idempotent — unioning the result again is a no-op", () => {
    const a = unionMarkings(["A", "B"], ["B", "C"]);
    const b = unionMarkings(a, a);
    expect(b).toEqual(a);
  });

  it("is associative over set-union for 1000 random ternary partitions", () => {
    const vocab = ["RESTRICTED", "PII", "SOX", "HR", "LEGAL", "FINANCE"];
    for (let seed = 1; seed <= 1000; seed++) {
      const a = randomSet(seed * 3, vocab);
      const b = randomSet(seed * 5, vocab);
      const c = randomSet(seed * 7, vocab);
      const left = unionMarkings(unionMarkings(a, b), c);
      const right = unionMarkings(a, unionMarkings(b, c));
      expect(left).toEqual(right);
    }
  });

  it("NEVER produces an intersection — worst-case safety check", () => {
    // The intersection of these sets is empty; the union is {A,B}.
    expect(unionMarkings(["A"], ["B"])).toEqual(["A", "B"]);
    // If the helper ever regressed to intersection, this assertion
    // would fail loudly — intended as a tripwire.
  });
});

describe("userHasAllMarkings", () => {
  it("true when required is empty", () => {
    expect(userHasAllMarkings([], ["A"])).toBe(true);
    expect(userHasAllMarkings([], [])).toBe(true);
  });

  it("true when user possesses every required marking", () => {
    expect(userHasAllMarkings(["A", "B"], ["A", "B", "C"])).toBe(true);
  });

  it("false when user is missing any single required marking", () => {
    expect(userHasAllMarkings(["A", "B"], ["A"])).toBe(false);
  });
});

describe("missingMarkings", () => {
  it("reports only the required markings the user lacks", () => {
    expect(missingMarkings(["A", "B", "C"], ["A", "D"])).toEqual(["B", "C"]);
  });
});
