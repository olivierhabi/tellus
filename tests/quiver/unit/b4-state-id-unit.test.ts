// Quiver B4 — generateStateId unit tests.
// Coverage:
//   B4 C-07: 10-char base36 ID; 1000 random allocations have <0.001% collision.

import { describe, expect, it } from "vitest";
import { generateStateId } from "../../../src/services/quiver/workingStateService";

const RE = /^[a-z0-9]{10}$/;

describe("generateStateId (B4 C-07)", () => {
  it("matches [a-z0-9]{10}", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateStateId()).toMatch(RE);
    }
  });

  it("1000 random allocations have no collisions", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = generateStateId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });
});
